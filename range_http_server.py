#!/usr/bin/env python3
import copy
import gzip
import hashlib
import http.cookiejar
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


BASE_DIR = os.path.dirname(__file__)
CONFIG_PATH = os.path.join(BASE_DIR, "video-config.json")
RUNTIME_CONFIG_PATH = "/config/runtime.json"
CONFIG_EVENTS_PATH = "/events/config"
VIDEO_PROXY_PATH = "/proxy/video"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/146.0.0.0 Safari/537.36"
)

DEFAULT_CONFIG = {
    "pageTitle": "绿源三十年茶源结茶缘",
    "redirectUrl": "http://xclycj.com/",
    "video": {
        "provider": "auto",
        "url": "https://www.bilibili.com/video/BV1RYwCziE4N?t=1.2",
        "quality": "720p",
        "headers": {},
    },
}
DEFAULT_CONFIG_VERSION = hashlib.sha1(
    json.dumps(DEFAULT_CONFIG, ensure_ascii=False, sort_keys=True).encode("utf-8")
).hexdigest()

BILIBILI_CACHE_TTL = 600
FEISHU_CACHE_TTL = 600

_bilibili_cache = {}
_bilibili_cache_lock = threading.Lock()
_feishu_cache = {}
_feishu_cache_lock = threading.Lock()


def _extract_match(pattern, text, label):
    match = re.search(pattern, text, re.S)
    if not match:
        raise ValueError(f"Could not extract {label}")
    return match.group(1)


def _decode_response_body(response, body):
    if response.headers.get("Content-Encoding") == "gzip":
        return gzip.decompress(body)
    return body


def _fetch_text(url, headers):
    request = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(request, timeout=30) as response:
        body = _decode_response_body(response, response.read())
    return body.decode("utf-8", errors="ignore")


def _fetch_json(url, headers):
    return json.loads(_fetch_text(url, headers))


def _read_raw_config():
    if not os.path.exists(CONFIG_PATH):
        return {}, None, DEFAULT_CONFIG_VERSION

    try:
        with open(CONFIG_PATH, "rb") as file_handle:
            raw_bytes = file_handle.read()
        config_version = hashlib.sha1(raw_bytes).hexdigest()
        payload = json.loads(raw_bytes.decode("utf-8"))
    except Exception as exc:
        return {}, str(exc), config_version if "config_version" in locals() else DEFAULT_CONFIG_VERSION

    if not isinstance(payload, dict):
        return {}, "Config root must be an object", config_version

    return payload, None, config_version


def _clean_headers(raw_headers):
    headers = {}
    if not isinstance(raw_headers, dict):
        return headers

    for key, value in raw_headers.items():
        header_name = str(key).strip()
        header_value = str(value).strip()
        if header_name and header_value:
            headers[header_name] = header_value
    return headers


def _detect_provider(url):
    if not url:
        return "direct"

    host = urllib.parse.urlsplit(url).netloc.lower()
    if "bilibili.com" in host:
        return "bilibili"
    if "feishu.cn" in host:
        return "feishu"
    return "direct"


def _resolve_provider(provider, url):
    value = str(provider or "").strip().lower()
    if not value or value == "auto":
        return _detect_provider(url)
    return value


def _normalize_config(raw_payload, load_error=None):
    normalized = copy.deepcopy(DEFAULT_CONFIG)

    page_title = str(raw_payload.get("pageTitle") or raw_payload.get("title") or "").strip()
    redirect_url = str(raw_payload.get("redirectUrl") or raw_payload.get("targetUrl") or "").strip()

    if page_title:
        normalized["pageTitle"] = page_title
    if redirect_url:
        normalized["redirectUrl"] = redirect_url

    video_payload = raw_payload.get("video")
    if not isinstance(video_payload, dict):
        video_payload = {}

    if not video_payload:
        legacy_bilibili = str(raw_payload.get("bilibiliVideoUrl") or "").strip()
        legacy_feishu = str(raw_payload.get("feishuVideoUrl") or "").strip()
        if legacy_bilibili:
            video_payload = {"provider": "bilibili", "url": legacy_bilibili}
        elif legacy_feishu:
            video_payload = {"provider": "feishu", "url": legacy_feishu}

    video_url = str(video_payload.get("url") or video_payload.get("videoUrl") or "").strip()
    provider = _resolve_provider(video_payload.get("provider"), video_url)
    quality = str(video_payload.get("quality") or "").strip()

    if not video_url:
        if provider == "feishu":
            video_url = "https://ycnnzi3curx1.feishu.cn/wiki/AXUzwb1gii4SPakrmn8ckY98nse"
        else:
            video_url = DEFAULT_CONFIG["video"]["url"]

    if not quality:
        quality = "480p" if provider == "feishu" else "720p"

    normalized["video"] = {
        "provider": provider,
        "url": video_url,
        "quality": quality,
        "headers": _clean_headers(video_payload.get("headers")),
    }

    if load_error:
        normalized["configError"] = load_error

    return normalized


def _load_runtime_config():
    raw_payload, load_error, config_version = _read_raw_config()
    normalized = _normalize_config(raw_payload, load_error=load_error)
    normalized["configVersion"] = config_version
    return normalized


def _quality_to_bilibili_qn(quality):
    value = str(quality or "").strip().lower()
    mapping = {
        "16": "16",
        "360": "16",
        "360p": "16",
        "32": "32",
        "480": "32",
        "480p": "32",
        "64": "64",
        "720": "64",
        "720p": "64",
        "80": "80",
        "1080": "80",
        "1080p": "80",
    }
    return mapping.get(value, "64")


def _extract_bilibili_video_ref(page_url):
    parsed = urllib.parse.urlsplit(page_url)
    page_number = 1
    query = urllib.parse.parse_qs(parsed.query)
    raw_page = query.get("p", [None])[0]
    if raw_page and str(raw_page).isdigit():
        page_number = max(1, int(raw_page))

    path = parsed.path or ""
    bvid_match = re.search(r"/video/(BV[0-9A-Za-z]+)", path, re.I)
    aid_match = re.search(r"/video/av(\d+)", path, re.I)
    ref = {"page": page_number}
    if bvid_match:
        ref["bvid"] = bvid_match.group(1)
        return ref
    if aid_match:
        ref["aid"] = aid_match.group(1)
        return ref
    raise ValueError("Could not extract Bilibili bvid or aid from URL")


def _resolve_bilibili_video(video_config, force_refresh=False):
    page_url = video_config["url"]
    qn = _quality_to_bilibili_qn(video_config["quality"])
    cache_key = (page_url, qn)

    with _bilibili_cache_lock:
        cached = _bilibili_cache.get(cache_key)
        if cached and not force_refresh and time.time() < cached["expires_at"]:
            return cached

    api_headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Accept-Encoding": "gzip",
        "Referer": page_url,
        "Origin": "https://www.bilibili.com",
    }
    video_ref = _extract_bilibili_video_ref(page_url)
    id_params = {}
    if video_ref.get("bvid"):
        id_params["bvid"] = video_ref["bvid"]
    elif video_ref.get("aid"):
        id_params["avid"] = video_ref["aid"]
    else:
        raise ValueError("Could not resolve Bilibili video identifier")

    pagelist_url = "https://api.bilibili.com/x/player/pagelist?" + urllib.parse.urlencode(id_params)
    pagelist_payload = _fetch_json(pagelist_url, api_headers)
    if pagelist_payload.get("code") != 0:
        raise ValueError(
            "Bilibili pagelist API failed: "
            f"code={pagelist_payload.get('code')} message={pagelist_payload.get('message')}"
        )

    pages = pagelist_payload.get("data") or []
    if not pages:
        raise ValueError("Bilibili pagelist API returned no pages")

    selected_page = None
    requested_page = video_ref.get("page", 1)
    for page_info in pages:
        if int(page_info.get("page") or 0) == requested_page:
            selected_page = page_info
            break
    if selected_page is None:
        selected_page = pages[0]

    cid = selected_page.get("cid")
    if not cid:
        raise ValueError("Could not resolve Bilibili cid")

    playurl_params = dict(id_params)
    playurl_params.update(
        {
            "cid": str(cid),
            "qn": qn,
            "fnver": "0",
            "fnval": "0",
            "fourk": "0",
            "platform": "html5",
        }
    )
    playurl_url = "https://api.bilibili.com/x/player/playurl?" + urllib.parse.urlencode(playurl_params)
    payload = _fetch_json(playurl_url, api_headers)
    if payload.get("code") != 0:
        raise ValueError(
            f"Bilibili playurl API failed: code={payload.get('code')} message={payload.get('message')}"
        )

    durl_list = payload.get("data", {}).get("durl", [])
    if not durl_list:
        raise ValueError("Bilibili did not return a progressive MP4 stream")

    stream_url = durl_list[0].get("url")
    if not stream_url:
        raise ValueError("Bilibili stream URL is empty")

    stream_query = urllib.parse.parse_qs(urllib.parse.urlsplit(stream_url).query)
    deadline = stream_query.get("deadline", [None])[0]
    if deadline and str(deadline).isdigit():
        expires_at = max(time.time() + 60, int(deadline) - 60)
    else:
        expires_at = time.time() + BILIBILI_CACHE_TTL

    resolved = {
        "expires_at": expires_at,
        "headers": {
            "User-Agent": USER_AGENT,
            "Referer": page_url,
            "Origin": "https://www.bilibili.com",
            "Accept": "*/*",
        },
        "stream_url": stream_url,
    }

    with _bilibili_cache_lock:
        _bilibili_cache[cache_key] = resolved

    return resolved


def _clear_bilibili_cache(video_config):
    cache_key = (video_config["url"], _quality_to_bilibili_qn(video_config["quality"]))
    with _bilibili_cache_lock:
        _bilibili_cache.pop(cache_key, None)


def _build_feishu_opener():
    cookie_jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))
    opener.addheaders = [
        ("User-Agent", USER_AGENT),
        ("Accept-Language", "zh-CN,zh;q=0.9"),
    ]
    return opener, cookie_jar


def _cookie_header(cookie_jar):
    return "; ".join(f"{cookie.name}={cookie.value}" for cookie in cookie_jar)


def _resolve_feishu_video(video_config, force_refresh=False):
    wiki_url = video_config["url"]
    quality = video_config["quality"]
    cache_key = (wiki_url, quality)

    with _feishu_cache_lock:
        cached = _feishu_cache.get(cache_key)
        if (
            cached
            and not force_refresh
            and time.time() - cached["resolved_at"] < FEISHU_CACHE_TTL
        ):
            return cached

    parsed = urllib.parse.urlsplit(wiki_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    path_parts = [part for part in parsed.path.split("/") if part]
    if not path_parts:
        raise ValueError("Feishu wiki URL does not include a token")

    wiki_token = path_parts[-1]
    opener, cookie_jar = _build_feishu_opener()

    with opener.open(wiki_url, timeout=30) as response:
        html = response.read().decode("utf-8", errors="ignore")

    file_token = _extract_match(
        r'"file":\{"token":"([A-Za-z0-9]+)"',
        html,
        "Feishu file token",
    )
    mount_node_token = _extract_match(
        r'"([A-Za-z0-9]{20,})":\{"id":"\1","version":\d+,"data":\{"type":"file"',
        html,
        "Feishu mount node token",
    )

    body = json.dumps(
        {
            "file_token": file_token,
            "mount_point": "docx_file",
            "mount_node_token": mount_node_token,
            "option_params": ["preview_meta", "check_cipher"],
        }
    ).encode("utf-8")

    request = urllib.request.Request(
        f"{origin}/space/api/box/file/info/",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Origin": origin,
            "Referer": wiki_url,
            "doc-platform": "web",
            "doc-os": "windows",
            "doc-biz": "Lark",
            "x-lsc-terminal": "web",
            "x-lsc-version": "1",
            "x-lsc-bizid": "2",
            "x-lgw-terminal-type": "2",
            "x-lgw-os-type": "1",
            "docs-host-id": wiki_token,
            "docs-host-type": "Wiki",
            "x-command": "space.api.box.file.info",
        },
        method="POST",
    )

    with opener.open(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))

    transcode_urls = (
        payload.get("data", {})
        .get("preview_meta", {})
        .get("data", {})
        .get("3", {})
        .get("content", {})
        .get("transcode_urls", {})
    )

    stream_url = (
        transcode_urls.get(quality)
        or transcode_urls.get("480p")
        or transcode_urls.get("360p")
    )
    if not stream_url:
        stream_url = (
            f"https://api3-eeft-drive.feishu.cn/space/api/box/stream/download/video/"
            f"{file_token}/?quality={quality}"
        )

    resolved = {
        "headers": {
            "Cookie": _cookie_header(cookie_jar),
            "Referer": origin + "/",
            "User-Agent": USER_AGENT,
        },
        "resolved_at": time.time(),
        "stream_url": stream_url,
    }

    with _feishu_cache_lock:
        _feishu_cache[cache_key] = resolved

    return resolved


def _clear_feishu_cache(video_config):
    cache_key = (video_config["url"], video_config["quality"])
    with _feishu_cache_lock:
        _feishu_cache.pop(cache_key, None)


def _resolve_direct_video(video_config, _force_refresh=False):
    stream_url = str(video_config["url"]).strip()
    if not stream_url:
        raise ValueError("Direct video URL is empty")

    headers = {"User-Agent": USER_AGENT}
    headers.update(video_config.get("headers", {}))
    return {
        "headers": headers,
        "stream_url": stream_url,
    }


def _resolve_video_source(video_config, force_refresh=False):
    provider = video_config["provider"]
    if provider == "bilibili":
        return _resolve_bilibili_video(video_config, force_refresh=force_refresh)
    if provider == "feishu":
        return _resolve_feishu_video(video_config, force_refresh=force_refresh)
    if provider == "direct":
        return _resolve_direct_video(video_config, _force_refresh=force_refresh)
    raise ValueError(f"Unsupported video provider: {provider}")


def _clear_video_cache(video_config):
    provider = video_config["provider"]
    if provider == "bilibili":
        _clear_bilibili_cache(video_config)
    elif provider == "feishu":
        _clear_feishu_cache(video_config)


class RangeRequestHandler(SimpleHTTPRequestHandler):
    """Static file server with byte-range support and multi-platform video proxy."""

    _range = None

    def do_HEAD(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == RUNTIME_CONFIG_PATH:
            self.handle_runtime_config(head_only=True)
            return
        if parsed.path == CONFIG_EVENTS_PATH:
            self.send_error(405, "Config events do not support HEAD")
            return
        if parsed.path == VIDEO_PROXY_PATH:
            self.handle_video_proxy(head_only=True)
            return
        super().do_HEAD()

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == RUNTIME_CONFIG_PATH:
            self.handle_runtime_config(head_only=False)
            return
        if parsed.path == CONFIG_EVENTS_PATH:
            self.handle_config_events()
            return
        if parsed.path == VIDEO_PROXY_PATH:
            self.handle_video_proxy(head_only=False)
            return
        super().do_GET()

    def handle_runtime_config(self, head_only=False):
        payload = json.dumps(_load_runtime_config(), ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if not head_only:
            self.wfile.write(payload)

    def handle_config_events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        current_config = _load_runtime_config()
        last_version = current_config.get("configVersion")
        heartbeat_at = time.time()

        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()

            while True:
                time.sleep(0.8)
                next_config = _load_runtime_config()
                next_version = next_config.get("configVersion")

                if next_version != last_version:
                    payload = json.dumps(
                        {
                            "configVersion": next_version,
                            "hasError": bool(next_config.get("configError")),
                        },
                        ensure_ascii=False,
                    ).encode("utf-8")
                    self.wfile.write(b"event: config\n")
                    self.wfile.write(b"data: " + payload + b"\n\n")
                    self.wfile.flush()
                    last_version = next_version
                    heartbeat_at = time.time()
                    continue

                if time.time() - heartbeat_at >= 15:
                    self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
                    heartbeat_at = time.time()
        except (BrokenPipeError, ConnectionResetError):
            return

    def handle_video_proxy(self, head_only=False):
        parsed = urllib.parse.urlsplit(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        runtime_config = _load_runtime_config()
        video_config = copy.deepcopy(runtime_config["video"])

        if params.get("provider"):
            video_config["provider"] = _resolve_provider(params["provider"][0], video_config["url"])
        if params.get("url"):
            video_config["url"] = str(params["url"][0]).strip()
        if params.get("quality"):
            video_config["quality"] = str(params["quality"][0]).strip()

        video_config["provider"] = _resolve_provider(video_config.get("provider"), video_config["url"])

        try:
            upstream = None
            for attempt in range(2):
                resolved = _resolve_video_source(video_config, force_refresh=attempt > 0)
                request_headers = dict(resolved.get("headers", {}))
                range_header = self.headers.get("Range")
                if range_header:
                    request_headers["Range"] = range_header

                request = urllib.request.Request(
                    resolved["stream_url"],
                    headers=request_headers,
                    method="GET",
                )

                try:
                    upstream = urllib.request.urlopen(request, timeout=60)
                    break
                except urllib.error.HTTPError as exc:
                    if exc.code in (401, 403) and attempt == 0:
                        _clear_video_cache(video_config)
                        continue
                    raise

            if upstream is None:
                raise ValueError("Unable to open upstream video stream")

            with upstream:
                self.send_response(upstream.status)
                for header_name in (
                    "Accept-Ranges",
                    "Content-Disposition",
                    "Content-Length",
                    "Content-Range",
                    "Content-Type",
                    "Last-Modified",
                ):
                    header_value = upstream.headers.get(header_name)
                    if header_value:
                        self.send_header(header_name, header_value)

                self.send_header("Cache-Control", "no-store")
                self.end_headers()

                if head_only:
                    return

                while True:
                    chunk = upstream.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except Exception as exc:
            self.send_error(502, f"Video proxy error: {exc}")

    def send_head(self):
        path = self.translate_path(self.path.split("?", 1)[0].split("#", 1)[0])

        if os.path.isdir(path):
            return super().send_head()

        ctype = self.guess_type(path)
        try:
            file_handle = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        stat = os.fstat(file_handle.fileno())
        size = stat.st_size
        range_header = self.headers.get("Range")

        if range_header:
            match = re.match(r"bytes=(\d*)-(\d*)$", range_header.strip())
            if match:
                start_str, end_str = match.groups()
                start = int(start_str) if start_str else 0
                end = int(end_str) if end_str else size - 1

                if start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Accept-Ranges", "bytes")
                    self.end_headers()
                    file_handle.close()
                    return None

                end = min(end, size - 1)
                length = end - start + 1
                self._range = (start, end)

                self.send_response(206)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.send_header("Content-Length", str(length))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Last-Modified", self.date_time_string(stat.st_mtime))
                self.end_headers()
                file_handle.seek(start)
                return file_handle

        self._range = None
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Last-Modified", self.date_time_string(stat.st_mtime))
        self.end_headers()
        return file_handle

    def copyfile(self, source, outputfile):
        if self._range is None:
            return super().copyfile(source, outputfile)

        start, end = self._range
        remaining = end - start + 1
        chunk_size = 64 * 1024

        while remaining > 0:
            chunk = source.read(min(chunk_size, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)


def main():
    port = 8080
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print("Port must be an integer, e.g. python range_http_server.py 8080")
            sys.exit(1)

    server = ThreadingHTTPServer(("0.0.0.0", port), RangeRequestHandler)
    print(f"Serving site and video proxy at http://127.0.0.1:{port}/")
    server.serve_forever()


if __name__ == "__main__":
    main()
