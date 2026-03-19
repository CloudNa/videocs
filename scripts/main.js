(function () {
  var runtimeConfigUrl = "/config/runtime.json";
  var configEventsUrl = "/events/config";
  var proxyVideoUrl = "/proxy/video";
  var defaultConfig = {
    pageTitle: "绿源三十年茶源结茶缘",
    redirectUrl: "http://xclycj.com/",
    video: {
      provider: "bilibili",
      url: "",
      quality: "720p",
      headers: {}
    }
  };

  var stage = document.getElementById("stage");
  var video = document.getElementById("introVideo");
  var bgCanvas = document.getElementById("bgCanvas");
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
  var sourceNonce = 0;
  var streamConnected = false;
  var pendingResumeTime = 0;
  var endThreshold = 0.25;
  var uiIdleMs = 3500;
  var autoplayRetryMs = 1200;
  var reconnectRetryMs = 1800;
  var uiHideTimer = null;
  var autoplayRetryTimer = null;
  var reconnectTimer = null;
  var endWatchTimer = null;
  var configEventSource = null;
  var configReloadPending = false;
  var warmStarted = false;

  var gl = null;
  var glProgram = null;
  var glBuffer = null;
  var glTexture = null;
  var glLocPosition = null;
  var glLocTexture = null;
  var glLocVideoSize = null;
  var glLocCanvasSize = null;
  var glReady = false;
  var glRaf = 0;
  var useWebglBackground = true;

  function cloneConfig(source) {
    return {
      pageTitle: source.pageTitle,
      redirectUrl: source.redirectUrl,
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
    showLoadingState("配置已更新，正在刷新...");
    window.setTimeout(function () {
      window.location.reload();
    }, 120);
  }

  function watchConfigChanges() {
    if (configEventSource || !("EventSource" in window)) return;

    configEventSource = new window.EventSource(configEventsUrl);

    configEventSource.addEventListener("config", function (event) {
      if (redirected || configReloadPending) return;

      var payload = null;
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
  }

  function goNext() {
    if (redirected) return;
    redirected = true;

    clearUiTimer();
    clearAutoplayRetry();
    clearReconnectRetry();

    if (endWatchTimer) {
      window.clearInterval(endWatchTimer);
      endWatchTimer = null;
    }

    try {
      video.pause();
    } catch (error) {}

    stopWebglLoop();
    destroyWebgl();
    window.location.replace(targetUrl);
  }

  function warmTarget() {
    if (warmStarted) return;
    warmStarted = true;
  }

  function showLoadingState(text) {
    if (text) {
      startBtn.textContent = text;
    }
    startBtn.style.display = "inline-flex";
  }

  function hideLoadingState() {
    startBtn.style.display = "none";
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

  function buildProxyUrl(forceFresh) {
    if (forceFresh) {
      sourceNonce += 1;
    }
    return proxyVideoUrl + "?_=" + sourceNonce;
  }

  function applyPendingResume() {
    if (video.readyState < 1) return;

    var nextTime = Number.isFinite(pendingResumeTime) ? pendingResumeTime : 0;
    if (nextTime <= 0) {
      pendingResumeTime = 0;
      return;
    }

    var duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : nextTime;
    var capped = Math.max(0, Math.min(nextTime, Math.max(0, duration - endThreshold)));

    pendingResumeTime = 0;

    try {
      video.currentTime = capped;
    } catch (error) {}
  }

  function connectVideo(forceFresh, resetToStart) {
    clearReconnectRetry();

    pendingResumeTime = resetToStart ? 0 : (Number.isFinite(video.currentTime) ? video.currentTime : pendingResumeTime);
    showLoadingState(forceFresh ? "正在重连视频..." : "正在连接视频...");

    try {
      video.pause();
    } catch (error) {}

    try {
      video.src = buildProxyUrl(forceFresh);
      video.load();
      streamConnected = true;
      if (resetToStart) {
        pendingResumeTime = 0;
      }
      tryAutoplay(false);
    } catch (error) {
      streamConnected = false;
      showLoadingState("视频连接失败，正在重试...");
      scheduleReconnect(resetToStart);
    }
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
    var m = Math.floor(whole / 60);
    var s = whole % 60;
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
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
    if (!Number.isFinite(duration) || duration <= 0) return;

    var p = Math.max(0, Math.min(100, percent));
    var nextTime = (p / 100) * duration;

    try {
      video.currentTime = nextTime;
    } catch (error) {}

    setProgressUI(nextTime, duration);
  }

  function togglePlayPause() {
    if (video.paused) {
      video.play().catch(function () {});
      return;
    }
    video.pause();
  }

  function unlockSoundFromGesture() {
    if (soundUnlocked) return;
    soundUnlocked = true;
    video.muted = false;
    try {
      video.volume = 1;
    } catch (error) {}
    video.play().catch(function () {});
  }

  function tryAutoplay(resetToStart) {
    if (!streamConnected) {
      connectVideo(false, resetToStart);
      return;
    }

    if (resetToStart && !hasBootstrapped) {
      pendingResumeTime = 0;
    }

    warmTarget();
    showLoadingState("正在加载视频...");

    video.play().then(function () {
      hasBootstrapped = true;
      clearAutoplayRetry();
      hideLoadingState();
      updateRangeEnabled();
      setProgressUI(video.currentTime, video.duration);
      updateCenterStateByPlayback();
      startEndWatch();
      startWebglLoop();
      hideUi();
    }).catch(function () {
      showLoadingState("正在等待浏览器允许播放...");
      updateCenterStateByPlayback();
      scheduleAutoplayRetry();
    });
  }

  function createShader(type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }

    return shader;
  }

  function initWebglBackground() {
    if (!useWebglBackground) return false;
    if (glReady) return true;

    gl = bgCanvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false
    });

    if (!gl) return false;

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    var vsSource = [
      "attribute vec2 a_position;",
      "varying vec2 v_uv;",
      "void main(){",
      "  v_uv = (a_position + 1.0) * 0.5;",
      "  gl_Position = vec4(a_position, 0.0, 1.0);",
      "}"
    ].join("");

    var fsSource = [
      "precision mediump float;",
      "uniform sampler2D u_texture;",
      "uniform vec2 u_videoSize;",
      "uniform vec2 u_canvasSize;",
      "varying vec2 v_uv;",
      "vec2 coverUV(vec2 uv){",
      "  float va = u_videoSize.x / max(u_videoSize.y, 1.0);",
      "  float ca = u_canvasSize.x / max(u_canvasSize.y, 1.0);",
      "  vec2 outUV = uv;",
      "  if (ca > va) {",
      "    float s = va / ca;",
      "    outUV.y = (uv.y - 0.5) * s + 0.5;",
      "  } else {",
      "    float s = ca / va;",
      "    outUV.x = (uv.x - 0.5) * s + 0.5;",
      "  }",
      "  return clamp(outUV, 0.0, 1.0);",
      "}",
      "void main(){",
      "  vec2 uv = coverUV(v_uv);",
      "  vec2 px = 1.0 / max(u_videoSize, vec2(1.0));",
      "  vec3 c = texture2D(u_texture, uv).rgb * 0.06;",
      "  c += texture2D(u_texture, uv + vec2(px.x * 18.0, 0.0)).rgb * 0.11;",
      "  c += texture2D(u_texture, uv - vec2(px.x * 18.0, 0.0)).rgb * 0.11;",
      "  c += texture2D(u_texture, uv + vec2(0.0, px.y * 18.0)).rgb * 0.11;",
      "  c += texture2D(u_texture, uv - vec2(0.0, px.y * 18.0)).rgb * 0.11;",
      "  c += texture2D(u_texture, uv + vec2(px.x * 32.0, 0.0)).rgb * 0.08;",
      "  c += texture2D(u_texture, uv - vec2(px.x * 32.0, 0.0)).rgb * 0.08;",
      "  c += texture2D(u_texture, uv + vec2(0.0, px.y * 32.0)).rgb * 0.08;",
      "  c += texture2D(u_texture, uv - vec2(0.0, px.y * 32.0)).rgb * 0.08;",
      "  c += texture2D(u_texture, uv + vec2(px.x * 24.0, px.y * 24.0)).rgb * 0.05;",
      "  c += texture2D(u_texture, uv - vec2(px.x * 24.0, px.y * 24.0)).rgb * 0.05;",
      "  c += texture2D(u_texture, uv + vec2(-px.x * 24.0, px.y * 24.0)).rgb * 0.05;",
      "  c += texture2D(u_texture, uv + vec2(px.x * 24.0, -px.y * 24.0)).rgb * 0.05;",
      "  float luma = dot(c, vec3(0.299, 0.587, 0.114));",
      "  c = mix(c, vec3(luma), 0.16);",
      "  c *= vec3(0.88, 0.89, 0.92);",
      "  c *= 1.46;",
      "  c += vec3(0.02, 0.02, 0.024);",
      "  float dCenter = distance(v_uv, vec2(0.50, 0.50));",
      "  float vignette = smoothstep(1.08, 0.12, dCenter);",
      "  c *= mix(0.96, 1.08, vignette);",
      "  c = clamp(c, 0.0, 1.0);",
      "  gl_FragColor = vec4(c, 1.0);",
      "}"
    ].join("");

    var vertexShader = createShader(gl.VERTEX_SHADER, vsSource);
    var fragmentShader = createShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vertexShader || !fragmentShader) return false;

    glProgram = gl.createProgram();
    gl.attachShader(glProgram, vertexShader);
    gl.attachShader(glProgram, fragmentShader);
    gl.linkProgram(glProgram);

    if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) {
      return false;
    }

    glBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
       1,  1
    ]), gl.STATIC_DRAW);

    glTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    glLocPosition = gl.getAttribLocation(glProgram, "a_position");
    glLocTexture = gl.getUniformLocation(glProgram, "u_texture");
    glLocVideoSize = gl.getUniformLocation(glProgram, "u_videoSize");
    glLocCanvasSize = gl.getUniformLocation(glProgram, "u_canvasSize");

    resizeBgCanvas();
    glReady = true;
    stage.classList.add("bg-ready");
    return true;
  }

  function resizeBgCanvas() {
    if (!bgCanvas) return;

    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    var renderScale = 0.28;
    var w = Math.max(1, Math.floor(bgCanvas.clientWidth * dpr * renderScale));
    var h = Math.max(1, Math.floor(bgCanvas.clientHeight * dpr * renderScale));

    if (bgCanvas.width !== w || bgCanvas.height !== h) {
      bgCanvas.width = w;
      bgCanvas.height = h;
    }
  }

  function drawWebglBackground() {
    if (!glReady || !gl || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
      return;
    }

    resizeBgCanvas();
    gl.viewport(0, 0, bgCanvas.width, bgCanvas.height);
    gl.useProgram(glProgram);

    gl.bindBuffer(gl.ARRAY_BUFFER, glBuffer);
    gl.enableVertexAttribArray(glLocPosition);
    gl.vertexAttribPointer(glLocPosition, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, glTexture);

    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch (error) {
      return;
    }

    gl.uniform1i(glLocTexture, 0);
    gl.uniform2f(glLocVideoSize, video.videoWidth, video.videoHeight);
    gl.uniform2f(glLocCanvasSize, bgCanvas.width, bgCanvas.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function webglTick() {
    if (redirected) return;

    if (!document.hidden) {
      drawWebglBackground();
    }

    glRaf = window.requestAnimationFrame(webglTick);
  }

  function startWebglLoop() {
    if (!initWebglBackground()) return;
    if (glRaf) return;
    glRaf = window.requestAnimationFrame(webglTick);
  }

  function stopWebglLoop() {
    if (!glRaf) return;
    window.cancelAnimationFrame(glRaf);
    glRaf = 0;
  }

  function destroyWebgl() {
    if (!gl) return;

    if (glTexture) gl.deleteTexture(glTexture);
    if (glBuffer) gl.deleteBuffer(glBuffer);
    if (glProgram) gl.deleteProgram(glProgram);

    glTexture = null;
    glBuffer = null;
    glProgram = null;
    gl = null;
    glReady = false;
  }

  function syncBgToMain() {
    drawWebglBackground();
  }

  video.removeAttribute("loop");
  video.loop = false;

  video.addEventListener("loadedmetadata", function () {
    applyPendingResume();
    updateRangeEnabled();
    setProgressUI(video.currentTime, video.duration);
  });

  video.addEventListener("durationchange", function () {
    applyPendingResume();
    updateRangeEnabled();
    setProgressUI(video.currentTime, video.duration);
  });

  video.addEventListener("canplay", function () {
    applyPendingResume();
    hideLoadingState();
    syncBgToMain();
    startWebglLoop();
  });

  video.addEventListener("waiting", function () {
    if (!redirected) {
      showLoadingState("正在缓冲视频...");
    }
  });

  video.addEventListener("stalled", function () {
    if (!redirected) {
      showLoadingState("视频缓冲中...");
    }
  });

  video.addEventListener("playing", function () {
    hideLoadingState();
    updateCenterStateByPlayback();
    startWebglLoop();
  });

  video.addEventListener("timeupdate", function () {
    checkAndGoNext();
    syncBgToMain();
    updateRangeEnabled();

    if (!isUserSeeking) {
      setProgressUI(video.currentTime, video.duration);
    }
  });

  video.addEventListener("play", function () {
    clearAutoplayRetry();
    hideLoadingState();
    updateCenterStateByPlayback();
    startEndWatch();
    startWebglLoop();
    scheduleUiHide();
  });

  video.addEventListener("pause", function () {
    syncBgToMain();
    updateCenterStateByPlayback();
    showUi();
  });

  video.addEventListener("ended", goNext);

  video.addEventListener("error", function () {
    if (redirected) return;

    streamConnected = false;
    showLoadingState("视频异常，正在重试...");
    scheduleReconnect(false);
  });

  skipBtn.addEventListener("click", goNext, { passive: true });

  centerState.addEventListener("click", function (event) {
    event.stopPropagation();
    unlockSoundFromGesture();
    togglePlayPause();
    showUi();
  });

  stage.addEventListener("click", function (event) {
    if (event.target.closest("#skipBtn") || event.target.closest("#dyProgress")) {
      return;
    }

    unlockSoundFromGesture();
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

  window.addEventListener("resize", resizeBgCanvas, { passive: true });
  window.addEventListener("beforeunload", function () {
    if (!configEventSource) return;
    configEventSource.close();
    configEventSource = null;
  });

  function boot() {
    setProgressUI(0, 0);
    updateRangeEnabled();
    updateCenterStateByPlayback();
    hideUi();
    showLoadingState("正在加载配置...");

    loadRuntimeConfig().then(function (config) {
      applyRuntimeConfig(config);
    }).catch(function () {
      applyRuntimeConfig(defaultConfig);
    }).finally(function () {
      watchConfigChanges();
      showLoadingState("正在连接视频...");
      connectVideo(false, true);
    });
  }

  boot();
})();
