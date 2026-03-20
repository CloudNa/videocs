(function () {
  var runtimeConfigUrl = "/config/runtime.json";
  var configEventsUrl = "/events/config";
  var videoSourceUrl = "/video/source";
  var proxyVideoUrl = "/proxy/video";
  var defaultConfig = {
    pageTitle: "绿源三十年茶源结茶缘",
    redirectUrl: "http://xclycj.com/",
    configEventsEnabled: null,
    video: {
      provider: "bilibili",
      url: "",
      quality: "720p",
      headers: {}
    }
  };

  var stage = document.getElementById("stage");
  var video = document.getElementById("introVideo");
  var startBtn = document.getElementById("startBtn");
  var skipBtn = document.getElementById("skipBtn");
  var centerState = document.getElementById("centerState");
  var dyProgress = document.getElementById("dyProgress");
  var progressRange = document.getElementById("progressRange");
  var currentTimeText = document.getElementById("currentTimeText");
  var totalTimeText = document.getElementById("totalTimeText");

  var runtimeConfig = defaultConfig;
  var runtimeConfigVersion = null;
  var targetUrl = defaultConfig.redirectUrl;
  var redirected = false;
  var soundUnlocked = false;
  var isUserSeeking = false;
  var hasBootstrapped = false;
  var pageOpenId = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  var sourceNonce = 0;
  var streamConnected = false;
  var pendingResumeTime = 0;
  var endThreshold = 0.25;
  var uiIdleMs = 3500;
  var autoplayRetryMs = 1200;
  var reconnectRetryMs = 1800;
  var proxyWarmupWaitMs = 320;
  var uiHideTimer = null;
  var autoplayRetryTimer = null;
  var reconnectTimer = null;
  var endWatchTimer = null;
  var configEventSource = null;
  var configReloadPending = false;
  var warmStarted = false;
  var pendingGesturePlayback = false;
  var gesturePlaybackRequired = false;
  var hasStartedPlayback = false;
  var playRequestPending = false;
  var autoplayGuardTimer = null;
  var connectAttemptId = 0;
  var connectInFlight = false;
  var playbackPreconnectOrigin = "";
  var bufferingHintTimer = null;
  var bufferingHintDelayMs = 650;

  function cloneConfig(source) {
    return {
      pageTitle: source.pageTitle,
      redirectUrl: source.redirectUrl,
      configEventsEnabled: typeof source.configEventsEnabled === "boolean" ? source.configEventsEnabled : null,
      video: {
        provider: source.video && source.video.provider ? source.video.provider : defaultConfig.video.provider,
        url: source.video && source.video.url ? source.video.url : defaultConfig.video.url,
        quality: source.video && source.video.quality ? source.video.quality : defaultConfig.video.quality,
        headers: source.video && source.video.headers ? source.video.headers : {}
      }
    };
  }

  function normalizeConfig(payload) {
    var normalized = cloneConfig(defaultConfig);
    var source = payload && typeof payload === "object" ? payload : {};
    var videoSource = source.video && typeof source.video === "object" ? source.video : {};

    if (!videoSource.url && source.bilibiliVideoUrl) {
      videoSource = {
        provider: "bilibili",
        url: String(source.bilibiliVideoUrl),
        quality: "720p"
      };
    }

    if (!videoSource.url && source.feishuVideoUrl) {
      videoSource = {
        provider: "feishu",
        url: String(source.feishuVideoUrl),
        quality: "480p"
      };
    }

    if (typeof source.pageTitle === "string" && source.pageTitle.trim()) {
      normalized.pageTitle = source.pageTitle.trim();
    }
    if (typeof source.title === "string" && source.title.trim()) {
      normalized.pageTitle = source.title.trim();
    }
    if (typeof source.redirectUrl === "string" && source.redirectUrl.trim()) {
      normalized.redirectUrl = source.redirectUrl.trim();
    }
    if (typeof source.targetUrl === "string" && source.targetUrl.trim()) {
      normalized.redirectUrl = source.targetUrl.trim();
    }
    if (typeof source.configEventsEnabled === "boolean") {
      normalized.configEventsEnabled = source.configEventsEnabled;
    }

    if (typeof videoSource.provider === "string" && videoSource.provider.trim()) {
      normalized.video.provider = videoSource.provider.trim().toLowerCase();
    }
    if (typeof videoSource.url === "string" && videoSource.url.trim()) {
      normalized.video.url = videoSource.url.trim();
    }
    if (typeof videoSource.quality === "string" && videoSource.quality.trim()) {
      normalized.video.quality = videoSource.quality.trim();
    }
    if (videoSource.headers && typeof videoSource.headers === "object" && !Array.isArray(videoSource.headers)) {
      normalized.video.headers = Object.assign({}, videoSource.headers);
    }

    if (typeof source.configVersion === "string" && source.configVersion.trim()) {
      normalized.configVersion = source.configVersion.trim();
    }
    if (typeof source.configError === "string" && source.configError.trim()) {
      normalized.configError = source.configError.trim();
    }

    return normalized;
  }

  function loadRuntimeConfig() {
    return fetch(runtimeConfigUrl + "?_=" + Date.now(), {
      cache: "no-store"
    }).then(function (response) {
      if (!response.ok) {
        throw new Error("Config request failed");
      }
      return response.json();
    }).then(normalizeConfig);
  }

  function applyRuntimeConfig(config) {
    runtimeConfig = normalizeConfig(config);
    runtimeConfigVersion = runtimeConfig.configVersion || runtimeConfigVersion;
    targetUrl = runtimeConfig.redirectUrl;
    document.title = runtimeConfig.pageTitle;
    stage.setAttribute("aria-label", runtimeConfig.pageTitle || "开场视频");
  }

  function sortedObject(value) {
    var output = {};
    Object.keys(value || {}).sort().forEach(function (key) {
      output[key] = value[key];
    });
    return output;
  }

  function getVideoConfigKey(config) {
    var normalized = normalizeConfig(config);
    return JSON.stringify({
      provider: normalized.video.provider || "",
      url: normalized.video.url || "",
      quality: normalized.video.quality || "",
      headers: sortedObject(normalized.video.headers || {})
    });
  }

  function reloadForConfigChange() {
    if (configReloadPending || redirected) return;
    configReloadPending = true;
    showLoadingState("配置已更新，正在刷新...", "loading");
    window.setTimeout(function () {
      window.location.reload();
    }, 120);
  }

  function isLocalDevHost() {
    var hostname = String(window.location.hostname || "").trim().toLowerCase();
    var match = null;
    var octets = null;
    var first = 0;
    var second = 0;

    if (!hostname) return false;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
      return true;
    }
    if (/\.local$/i.test(hostname)) {
      return true;
    }

    match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) {
      return false;
    }

    octets = match.slice(1).map(function (value) {
      return parseInt(value, 10);
    });

    if (octets.some(function (value) { return value < 0 || value > 255; })) {
      return false;
    }

    first = octets[0];
    second = octets[1];
    return first === 10
      || first === 127
      || (first === 192 && second === 168)
      || (first === 172 && second >= 16 && second <= 31);
  }

  function shouldWatchConfigChanges() {
    if (typeof runtimeConfig.configEventsEnabled === "boolean") {
      return runtimeConfig.configEventsEnabled;
    }
    return isLocalDevHost();
  }

  function watchConfigChanges() {
    if (configEventSource || !("EventSource" in window) || !shouldWatchConfigChanges()) return;

    configEventSource = new window.EventSource(configEventsUrl);

    configEventSource.addEventListener("config", function (event) {
      var payload = null;

      if (redirected || configReloadPending) return;

      try {
        payload = JSON.parse(event.data);
      } catch (error) {
        return;
      }

      if (!payload || !payload.configVersion || payload.configVersion === runtimeConfigVersion) {
        return;
      }

      loadRuntimeConfig().then(function (nextConfig) {
        if (nextConfig.configError) return;

        if (!runtimeConfigVersion) {
          runtimeConfigVersion = nextConfig.configVersion || null;
          return;
        }

        if (nextConfig.configVersion && nextConfig.configVersion !== runtimeConfigVersion) {
          if (getVideoConfigKey(nextConfig) !== getVideoConfigKey(runtimeConfig)) {
            reloadForConfigChange();
            return;
          }
          applyRuntimeConfig(nextConfig);
        }
      }).catch(function () {});
    });

    configEventSource.addEventListener("error", function () {
      if (!configEventSource || shouldWatchConfigChanges()) return;
      configEventSource.close();
      configEventSource = null;
    });
  }

  function setPlaybackState(state) {
    stage.dataset.playback = state;
    updateAmbientBackdrop();
  }

  function updateAmbientBackdrop() {
    var time = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    var duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
    var progress = Math.max(0, Math.min(1, time / duration));
    var phaseA = Math.sin(time * 0.22);
    var phaseB = Math.cos(time * 0.17);
    var phaseC = Math.sin(time * 0.09 + 0.8);
    var playback = stage.dataset.playback || "loading";
    var energy = 0.62;
    var highlight = 0.6;

    if (playback === "playing") {
      energy = 0.9;
      highlight = 0.68;
    } else if (playback === "paused" || playback === "prompt") {
      energy = 0.72;
      highlight = 0.64;
    } else if (playback === "buffering") {
      energy = 0.66;
      highlight = 0.7;
    }

    if (video.readyState < 3) {
      energy -= 0.05;
    }

    stage.style.setProperty("--ambient-energy", energy.toFixed(3));
    stage.style.setProperty("--ambient-highlight", (highlight + phaseC * 0.04 + progress * 0.03).toFixed(3));
    stage.style.setProperty("--ambient-shift-x", (phaseA * 18 + progress * 16).toFixed(2) + "px");
    stage.style.setProperty("--ambient-shift-y", (phaseB * 14 - progress * 9).toFixed(2) + "px");
    stage.style.setProperty("--ambient-tilt", (phaseA * 3.4).toFixed(2) + "deg");
    stage.style.setProperty("--ambient-scale", (1 + phaseB * 0.018).toFixed(3));
  }

  function goNext() {
    if (redirected) return;
    redirected = true;

    clearUiTimer();
    clearAutoplayRetry();
    clearReconnectRetry();
    clearAutoplayPromptGuard();

    if (endWatchTimer) {
      window.clearInterval(endWatchTimer);
      endWatchTimer = null;
    }

    if (configEventSource) {
      configEventSource.close();
      configEventSource = null;
    }

    try {
      video.pause();
    } catch (error) {}

    window.location.replace(targetUrl);
  }

  function warmTarget() {
    var img = null;

    if (warmStarted) return;
    warmStarted = true;

    if (window.fetch) {
      fetch(targetUrl, {
        mode: "no-cors",
        credentials: "include"
      }).catch(function () {});
    }

    try {
      img = new Image();
      img.src = targetUrl + (targetUrl.indexOf("?") === -1 ? "?" : "&") + "_warm=" + Date.now();
    } catch (error) {}
  }

  function showLoadingState(text, mode) {
    if (text) {
      startBtn.textContent = text;
    }
    startBtn.dataset.mode = mode || "loading";
    startBtn.style.display = "inline-flex";
  }

  function hideLoadingState() {
    clearBufferingHintTimer();
    delete startBtn.dataset.mode;
    startBtn.style.display = "none";
  }

  function showTapToPlayPrompt() {
    clearAutoplayPromptGuard();
    clearBufferingHintTimer();
    gesturePlaybackRequired = true;
    pendingGesturePlayback = false;
    setPlaybackState("prompt");
    showLoadingState("轻触屏幕，开始播放", "prompt");
  }

  function clearAutoplayPromptGuard() {
    if (!autoplayGuardTimer) return;
    window.clearTimeout(autoplayGuardTimer);
    autoplayGuardTimer = null;
  }

  function scheduleAutoplayPromptGuard() {
    clearAutoplayPromptGuard();
    autoplayGuardTimer = window.setTimeout(function () {
      autoplayGuardTimer = null;
      if (redirected || hasStartedPlayback || soundUnlocked || gesturePlaybackRequired || pendingGesturePlayback) {
        return;
      }
      if (video.paused && video.readyState >= 2) {
        showTapToPlayPrompt();
      }
    }, 900);
  }

  function clearBufferingHintTimer() {
    if (!bufferingHintTimer) return;
    window.clearTimeout(bufferingHintTimer);
    bufferingHintTimer = null;
  }

  function shouldShowBufferingHint() {
    if (redirected || gesturePlaybackRequired || pendingGesturePlayback) {
      return false;
    }
    if (!streamConnected || video.ended || video.seeking || isUserSeeking) {
      return false;
    }
    if (hasStartedPlayback) {
      return false;
    }
    return video.readyState < 3 || video.networkState === video.NETWORK_LOADING;
  }

  function scheduleBufferingHint() {
    clearBufferingHintTimer();
    bufferingHintTimer = window.setTimeout(function () {
      bufferingHintTimer = null;
      if (!shouldShowBufferingHint()) {
        return;
      }
      showLoadingState("正在加载视频...", "loading");
      setPlaybackState("buffering");
    }, bufferingHintDelayMs);
  }

  function clearUiTimer() {
    if (!uiHideTimer) return;
    window.clearTimeout(uiHideTimer);
    uiHideTimer = null;
  }

  function hideUi() {
    clearUiTimer();
    stage.classList.remove("ui-visible");
  }

  function scheduleUiHide() {
    clearUiTimer();
    uiHideTimer = window.setTimeout(function () {
      if (isUserSeeking) {
        scheduleUiHide();
        return;
      }
      hideUi();
    }, uiIdleMs);
  }

  function updateCenterStateByPlayback() {
    var isPaused = video.paused;
    centerState.dataset.state = isPaused ? "play" : "pause";
    centerState.setAttribute("aria-label", isPaused ? "播放" : "暂停");
  }

  function showUi() {
    stage.classList.add("ui-visible");
    updateCenterStateByPlayback();
    scheduleUiHide();
  }

  function clearAutoplayRetry() {
    if (!autoplayRetryTimer) return;
    window.clearTimeout(autoplayRetryTimer);
    autoplayRetryTimer = null;
  }

  function scheduleAutoplayRetry() {
    clearAutoplayRetry();
    autoplayRetryTimer = window.setTimeout(function () {
      if (redirected || !streamConnected || !video.paused) return;
      tryAutoplay(false);
    }, autoplayRetryMs);
  }

  function clearReconnectRetry() {
    if (!reconnectTimer) return;
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect(resetToStart) {
    clearReconnectRetry();
    reconnectTimer = window.setTimeout(function () {
      if (redirected) return;
      connectVideo(true, resetToStart);
    }, reconnectRetryMs);
  }

  function buildVideoSourceUrl(forceFresh) {
    if (forceFresh) {
      sourceNonce += 1;
    }
    return videoSourceUrl
      + "?open=" + encodeURIComponent(pageOpenId)
      + "&_=" + sourceNonce
      + (forceFresh ? "&refresh=1" : "");
  }

  function buildProxyUrl() {
    return proxyVideoUrl + "?_=" + sourceNonce;
  }

  function wait(ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, ms);
    });
  }

  function warmProxyUrl(url) {
    return fetch(url, {
      cache: "no-store",
      headers: {
        Range: "bytes=0-0"
      }
    }).then(function (response) {
      if (!response.ok && response.status !== 206) {
        throw new Error("Warm request failed");
      }
      return response.arrayBuffer().catch(function () {
        return null;
      });
    }).catch(function () {
      return null;
    });
  }

  function normalizePlaybackSource(payload) {
    var source = payload && typeof payload === "object" ? payload : {};
    var deliveryMode = source.deliveryMode === "direct" ? "direct" : "proxy";
    var resolvedUrl = typeof source.url === "string" && source.url.trim() ? source.url.trim() : "";

    if (!resolvedUrl) {
      resolvedUrl = deliveryMode === "direct" ? "" : buildProxyUrl();
    }

    return {
      deliveryMode: deliveryMode,
      provider: typeof source.provider === "string" ? source.provider : runtimeConfig.video.provider,
      url: resolvedUrl,
      expiresAt: Number.isFinite(source.expiresAt) ? source.expiresAt : null
    };
  }

  function resolvePlaybackSource(forceFresh) {
    return fetch(buildVideoSourceUrl(forceFresh), {
      cache: "no-store"
    }).then(function (response) {
      if (!response.ok) {
        throw new Error("Video source request failed");
      }
      return response.json();
    }).then(normalizePlaybackSource);
  }

  function getUrlOrigin(url) {
    try {
      return new window.URL(url, window.location.href).origin;
    } catch (error) {
      return "";
    }
  }

  function ensurePlaybackPreconnect(url) {
    var origin = getUrlOrigin(url);
    var link = null;

    if (!origin || origin === window.location.origin || origin === playbackPreconnectOrigin) {
      return;
    }

    playbackPreconnectOrigin = origin;
    link = document.createElement("link");
    link.rel = "preconnect";
    link.href = origin;
    link.crossOrigin = "";
    document.head.appendChild(link);
  }

  function updateDeliveryMode(sourceInfo) {
    stage.dataset.delivery = sourceInfo && sourceInfo.deliveryMode ? sourceInfo.deliveryMode : "proxy";
  }

  function applyPendingResume() {
    var nextTime = 0;
    var duration = 0;
    var capped = 0;

    if (video.readyState < 1) return;

    nextTime = Number.isFinite(pendingResumeTime) ? pendingResumeTime : 0;
    if (nextTime <= 0) {
      pendingResumeTime = 0;
      return;
    }

    duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : nextTime;
    capped = Math.max(0, Math.min(nextTime, Math.max(0, duration - endThreshold)));
    pendingResumeTime = 0;

    try {
      video.currentTime = capped;
    } catch (error) {}
  }

  function connectVideo(forceFresh, resetToStart) {
    var attemptId = 0;
    var sourceInfo = null;
    var shouldWarmProxy = false;

    if (connectInFlight && !forceFresh) {
      return;
    }

    clearReconnectRetry();
    playRequestPending = false;
    connectInFlight = true;
    attemptId = ++connectAttemptId;
    pendingResumeTime = resetToStart ? 0 : (Number.isFinite(video.currentTime) ? video.currentTime : pendingResumeTime);
    showLoadingState(forceFresh ? "正在重连视频..." : "正在连接视频...", "loading");
    setPlaybackState("loading");

    try {
      video.pause();
    } catch (error) {}

    function beginLoad() {
      if (attemptId !== connectAttemptId || redirected) {
        return;
      }

      try {
        updateDeliveryMode(sourceInfo);
        if (sourceInfo.deliveryMode === "direct") {
          ensurePlaybackPreconnect(sourceInfo.url);
        }

        video.src = sourceInfo.url;
        video.load();
        streamConnected = true;
        if (resetToStart) {
          pendingResumeTime = 0;
        }
        tryAutoplay(false, { fromGesture: pendingGesturePlayback && soundUnlocked });
        if (!soundUnlocked) {
          scheduleAutoplayPromptGuard();
        }
        connectInFlight = false;
      } catch (error) {
        streamConnected = false;
        connectInFlight = false;
        clearAutoplayPromptGuard();
        showLoadingState("视频连接失败，正在重试...", "loading");
        setPlaybackState("loading");
        scheduleReconnect(resetToStart);
      }
    }

    resolvePlaybackSource(forceFresh).then(function (nextSourceInfo) {
      if (attemptId !== connectAttemptId || redirected) {
        connectInFlight = false;
        return;
      }

      sourceInfo = nextSourceInfo;
      shouldWarmProxy = sourceInfo.deliveryMode === "proxy"
        && !hasStartedPlayback
        && !pendingGesturePlayback
        && !soundUnlocked;

      if (!shouldWarmProxy) {
        beginLoad();
        return;
      }

      Promise.race([
        warmProxyUrl(sourceInfo.url),
        wait(proxyWarmupWaitMs)
      ]).finally(beginLoad);
    }).catch(function () {
      if (attemptId !== connectAttemptId || redirected) {
        connectInFlight = false;
        return;
      }

      streamConnected = false;
      connectInFlight = false;
      clearAutoplayPromptGuard();
      showLoadingState("视频连接失败，正在重试...", "loading");
      setPlaybackState("loading");
      scheduleReconnect(resetToStart);
    });
  }

  function isNearEnd() {
    var duration = video.duration;
    return Number.isFinite(duration) && duration > 0 && video.currentTime >= duration - endThreshold;
  }

  function checkAndGoNext() {
    if (redirected) return;
    if (isNearEnd()) {
      goNext();
    }
  }

  function startEndWatch() {
    if (endWatchTimer) return;
    endWatchTimer = window.setInterval(checkAndGoNext, 200);
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "00:00";
    var whole = Math.floor(sec);
    var minutes = Math.floor(whole / 60);
    var seconds = whole % 60;
    return String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
  }

  function setProgressUI(current, duration) {
    var safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    var safeCurrent = Number.isFinite(current) && current > 0 ? current : 0;
    var progress = safeDuration > 0 ? (safeCurrent / safeDuration) * 100 : 0;
    var capped = Math.min(100, Math.max(0, progress));

    progressRange.value = capped.toFixed(2);
    dyProgress.style.setProperty("--progress", capped + "%");
    currentTimeText.textContent = formatTime(safeCurrent);
    totalTimeText.textContent = formatTime(safeDuration);
  }

  function updateRangeEnabled() {
    var duration = video.duration;
    progressRange.disabled = !(Number.isFinite(duration) && duration > 0);
  }

  function seekByPercent(percent) {
    var duration = video.duration;
    var clamped = 0;
    var nextTime = 0;

    if (!Number.isFinite(duration) || duration <= 0) return;

    clamped = Math.max(0, Math.min(100, percent));
    nextTime = (clamped / 100) * duration;

    try {
      video.currentTime = nextTime;
    } catch (error) {}

    setProgressUI(nextTime, duration);
    updateAmbientBackdrop();
  }

  function unlockSoundFromGesture() {
    if (soundUnlocked) return;
    soundUnlocked = true;
    video.muted = false;
    try {
      video.volume = 1;
    } catch (error) {}
    if (!video.paused) {
      video.play().catch(function () {});
    }
  }

  function removeGlobalSoundUnlockListeners() {
    if (!soundGestureEventsBound) return;
    soundGestureEventsBound = false;
    document.removeEventListener("pointerdown", handleGlobalSoundGesture, true);
    document.removeEventListener("touchstart", handleGlobalSoundGesture, true);
    document.removeEventListener("mousedown", handleGlobalSoundGesture, true);
    document.removeEventListener("keydown", handleGlobalSoundGesture, true);
    document.removeEventListener("click", handleGlobalSoundGesture, true);
  }

  function handleGlobalSoundGesture() {
    if (redirected || soundUnlocked) {
      removeGlobalSoundUnlockListeners();
      return;
    }

    unlockSoundFromGesture();

    if (streamConnected || hasStartedPlayback || pendingGesturePlayback || gesturePlaybackRequired) {
      video.play().catch(function () {});
    }

    removeGlobalSoundUnlockListeners();
  }

  function bindGlobalSoundUnlockListeners() {
    if (soundGestureEventsBound) return;
    soundGestureEventsBound = true;
    document.addEventListener("pointerdown", handleGlobalSoundGesture, true);
    document.addEventListener("touchstart", handleGlobalSoundGesture, true);
    document.addEventListener("mousedown", handleGlobalSoundGesture, true);
    document.addEventListener("keydown", handleGlobalSoundGesture, true);
    document.addEventListener("click", handleGlobalSoundGesture, true);
  }

  function isAutoplayBlockedError(error) {
    var name = String(error && error.name || "");
    var message = String(error && error.message || "").toLowerCase();
    return name === "NotAllowedError"
      || message.indexOf("gesture") !== -1
      || message.indexOf("user activation") !== -1
      || message.indexOf("allowed") !== -1;
  }

  function requestGesturePlayback(resetToStart) {
    clearAutoplayPromptGuard();
    unlockSoundFromGesture();
    pendingGesturePlayback = true;
    gesturePlaybackRequired = false;
    tryAutoplay(Boolean(resetToStart), { fromGesture: true });
  }

  function togglePlayPause() {
    if (video.paused) {
      tryAutoplay(false, { fromGesture: true });
      return;
    }
    video.pause();
  }

  function tryAutoplay(resetToStart, options) {
    var playbackPromise = null;
    var fromGesture = false;

    options = options || {};
    fromGesture = Boolean(options.fromGesture);

    if (!streamConnected) {
      if (connectInFlight) {
        if (fromGesture) {
          pendingGesturePlayback = true;
        }
        return;
      }
      if (fromGesture) {
        pendingGesturePlayback = true;
      }
      connectVideo(false, resetToStart);
      return;
    }

    if (resetToStart && !hasBootstrapped) {
      pendingResumeTime = 0;
    }

    if (playRequestPending) {
      return;
    }

    if (!fromGesture && gesturePlaybackRequired) {
      return;
    }

    warmTarget();
    if (!hasStartedPlayback && (!gesturePlaybackRequired || fromGesture)) {
      showLoadingState("正在加载视频...", "loading");
      setPlaybackState("buffering");
    }

    try {
      playRequestPending = true;
      playbackPromise = video.play();
    } catch (error) {
      playRequestPending = false;
      clearAutoplayPromptGuard();
      if (isAutoplayBlockedError(error)) {
        clearAutoplayRetry();
        showTapToPlayPrompt();
        return;
      }
      if (fromGesture) {
        pendingGesturePlayback = true;
        if (!hasStartedPlayback) {
          showLoadingState("正在加载视频...", "loading");
          setPlaybackState("buffering");
        }
        return;
      }
      if (!hasStartedPlayback) {
        showLoadingState("正在加载视频...", "loading");
        setPlaybackState("buffering");
      }
      scheduleAutoplayRetry();
      return;
    }

    if (!playbackPromise || typeof playbackPromise.then !== "function") {
      clearAutoplayPromptGuard();
      clearBufferingHintTimer();
      playRequestPending = false;
      hasBootstrapped = true;
      hasStartedPlayback = true;
      pendingGesturePlayback = false;
      gesturePlaybackRequired = false;
      clearAutoplayRetry();
      hideLoadingState();
      updateRangeEnabled();
      setProgressUI(video.currentTime, video.duration);
      updateCenterStateByPlayback();
      startEndWatch();
      setPlaybackState("playing");
      hideUi();
      return;
    }

    playbackPromise.then(function () {
      clearAutoplayPromptGuard();
      clearBufferingHintTimer();
      playRequestPending = false;
      hasBootstrapped = true;
      hasStartedPlayback = true;
      pendingGesturePlayback = false;
      gesturePlaybackRequired = false;
      clearAutoplayRetry();
      hideLoadingState();
      updateRangeEnabled();
      setProgressUI(video.currentTime, video.duration);
      updateCenterStateByPlayback();
      startEndWatch();
      setPlaybackState("playing");
      hideUi();
    }).catch(function (error) {
      clearAutoplayPromptGuard();
      clearBufferingHintTimer();
      playRequestPending = false;
      if (isAutoplayBlockedError(error)) {
        clearAutoplayRetry();
        showTapToPlayPrompt();
        return;
      }

      if (fromGesture) {
        pendingGesturePlayback = true;
        if (!hasStartedPlayback) {
          showLoadingState("正在加载视频...", "loading");
          setPlaybackState("buffering");
        }
        return;
      }

      if (!hasStartedPlayback) {
        showLoadingState("正在加载视频...", "loading");
        setPlaybackState("buffering");
      }
      updateCenterStateByPlayback();
      scheduleAutoplayRetry();
    });
  }

  video.removeAttribute("loop");
  video.loop = false;

  video.addEventListener("loadedmetadata", function () {
    applyPendingResume();
    updateRangeEnabled();
    setProgressUI(video.currentTime, video.duration);
    updateAmbientBackdrop();
  });

  video.addEventListener("durationchange", function () {
    applyPendingResume();
    updateRangeEnabled();
    setProgressUI(video.currentTime, video.duration);
    updateAmbientBackdrop();
  });

  video.addEventListener("canplay", function () {
    applyPendingResume();
    if (pendingGesturePlayback && video.paused && !playRequestPending) {
      tryAutoplay(false, { fromGesture: true });
      return;
    }
    if (!gesturePlaybackRequired) {
      hideLoadingState();
    }
    updateAmbientBackdrop();
  });

  video.addEventListener("seeking", function () {
    clearBufferingHintTimer();
  });

  video.addEventListener("waiting", function () {
    if (!redirected && !gesturePlaybackRequired) {
      scheduleBufferingHint();
    }
  });

  video.addEventListener("stalled", function () {
    if (!redirected && !gesturePlaybackRequired) {
      scheduleBufferingHint();
    }
  });

  video.addEventListener("playing", function () {
    clearAutoplayPromptGuard();
    clearBufferingHintTimer();
    playRequestPending = false;
    hasStartedPlayback = true;
    pendingGesturePlayback = false;
    gesturePlaybackRequired = false;
    hideLoadingState();
    updateCenterStateByPlayback();
    setPlaybackState("playing");
  });

  video.addEventListener("timeupdate", function () {
    checkAndGoNext();
    updateRangeEnabled();
    updateAmbientBackdrop();

    if (!isUserSeeking) {
      setProgressUI(video.currentTime, video.duration);
    }
  });

  video.addEventListener("play", function () {
    clearAutoplayRetry();
    hideLoadingState();
    updateCenterStateByPlayback();
    startEndWatch();
    setPlaybackState("playing");
    scheduleUiHide();
  });

  video.addEventListener("pause", function () {
    if (pendingGesturePlayback || gesturePlaybackRequired) {
      return;
    }
    updateCenterStateByPlayback();
    setPlaybackState("paused");
    showUi();
  });

  video.addEventListener("ended", goNext);

  video.addEventListener("error", function () {
    if (redirected) return;

    clearAutoplayPromptGuard();
    clearBufferingHintTimer();
    playRequestPending = false;
    streamConnected = false;
    if (!gesturePlaybackRequired) {
      showLoadingState("视频异常，正在重试...", "loading");
      setPlaybackState("loading");
    }
    scheduleReconnect(false);
  });

  skipBtn.addEventListener("click", goNext, { passive: true });

  stage.addEventListener("pointerdown", function (event) {
    if (event.target.closest("#dyProgress")) {
      return;
    }
    unlockSoundFromGesture();
  }, { passive: true });

  stage.addEventListener("touchstart", function (event) {
    if (event.target.closest("#dyProgress")) {
      return;
    }
    unlockSoundFromGesture();
  }, { passive: true });

  startBtn.addEventListener("click", function (event) {
    event.stopPropagation();
    requestGesturePlayback(!hasBootstrapped);
  });

  centerState.addEventListener("click", function (event) {
    event.stopPropagation();
    unlockSoundFromGesture();
    togglePlayPause();
    showUi();
  });

  stage.addEventListener("click", function (event) {
    unlockSoundFromGesture();

    if (event.target.closest("#skipBtn") || event.target.closest("#dyProgress") || event.target.closest("#centerState")) {
      return;
    }

    if (gesturePlaybackRequired || pendingGesturePlayback || (!hasStartedPlayback && video.paused)) {
      requestGesturePlayback(!hasBootstrapped);
      return;
    }

    showUi();
  }, { passive: true });

  progressRange.addEventListener("pointerdown", function (event) {
    event.stopPropagation();
    unlockSoundFromGesture();
    isUserSeeking = true;
    showUi();
  });

  progressRange.addEventListener("touchstart", function (event) {
    event.stopPropagation();
    unlockSoundFromGesture();
    isUserSeeking = true;
    showUi();
  }, { passive: true });

  progressRange.addEventListener("input", function () {
    isUserSeeking = true;
    seekByPercent(parseFloat(progressRange.value));
    showUi();
  });

  progressRange.addEventListener("change", function () {
    seekByPercent(parseFloat(progressRange.value));
    isUserSeeking = false;
    showUi();
  });

  progressRange.addEventListener("pointerup", function () {
    seekByPercent(parseFloat(progressRange.value));
    isUserSeeking = false;
    showUi();
  });

  progressRange.addEventListener("pointercancel", function () {
    isUserSeeking = false;
    showUi();
  });

  progressRange.addEventListener("touchend", function () {
    seekByPercent(parseFloat(progressRange.value));
    isUserSeeking = false;
    showUi();
  }, { passive: true });

  progressRange.addEventListener("click", function (event) {
    event.stopPropagation();
  }, { passive: true });

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && !redirected && video.paused) {
      tryAutoplay(!hasBootstrapped);
    }
  });

  window.addEventListener("pageshow", function () {
    if (!redirected && video.paused) {
      tryAutoplay(!hasBootstrapped);
    }
  });

  window.addEventListener("beforeunload", function () {
    if (!configEventSource) return;
    configEventSource.close();
    configEventSource = null;
  });

  function boot() {
    setPlaybackState("loading");
    setProgressUI(0, 0);
    updateRangeEnabled();
    updateCenterStateByPlayback();
    updateAmbientBackdrop();
    hideUi();
    bindGlobalSoundUnlockListeners();
    showLoadingState("正在加载配置...", "loading");

    loadRuntimeConfig().then(function (config) {
      applyRuntimeConfig(config);
    }).catch(function () {
      applyRuntimeConfig(defaultConfig);
    }).finally(function () {
      watchConfigChanges();
      showLoadingState("正在连接视频...", "loading");
      connectVideo(false, true);
    });
  }

  boot();
})();









