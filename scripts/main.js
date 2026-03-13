    (function () {
      var targetUrl = "http://xclycj.com/";
      var streamUrl = "./video/hls/index.m3u8";
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

      var redirected = false;
      var endThreshold = 0.25;
      var endWatchTimer = null;
      var warmStarted = false;
      var isUserSeeking = false;
      var hasBootstrapped = false;
      var uiHideTimer = null;
      var uiIdleMs = 3500;
      var mainHls = null;
      var soundUnlocked = false;
      var gl = null;
      var glProgram = null;
      var glBuffer = null;
      var glTexture = null;
      var glLocPosition = null;
      var glLocTexture = null;
      var glLocVideoSize = null;
      var glLocCanvasSize = null;
      var glRaf = 0;
      var glReady = false;
      var streamAttached = false;
      var streamAttachPending = false;
      var autoplayRetryTimer = null;
      var streamRetryTimer = null;
      var autoplayRetryMs = 1200;
      var streamRetryMs = 1600;

      function goNext() {
        if (redirected) return;
        redirected = true;

        if (endWatchTimer) {
          window.clearInterval(endWatchTimer);
          endWatchTimer = null;
        }

        if (autoplayRetryTimer) {
          window.clearTimeout(autoplayRetryTimer);
          autoplayRetryTimer = null;
        }

        if (streamRetryTimer) {
          window.clearTimeout(streamRetryTimer);
          streamRetryTimer = null;
        }

        streamAttachPending = false;
        streamAttached = false;

        try {
          video.pause();
        } catch (e) {}

        stopWebglLoop();
        destroyWebgl();

        if (mainHls) {
          mainHls.destroy();
          mainHls = null;
        }

        window.location.replace(targetUrl);
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

        // Keep native orientation to match the foreground video on mobile browsers.
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
          "  vec3 c = texture2D(u_texture, uv).rgb * 0.08;",
          "  c += texture2D(u_texture, uv + vec2(px.x * 14.0, 0.0)).rgb * 0.11;",
          "  c += texture2D(u_texture, uv - vec2(px.x * 14.0, 0.0)).rgb * 0.11;",
          "  c += texture2D(u_texture, uv + vec2(0.0, px.y * 14.0)).rgb * 0.11;",
          "  c += texture2D(u_texture, uv - vec2(0.0, px.y * 14.0)).rgb * 0.11;",
          "  c += texture2D(u_texture, uv + vec2(px.x * 28.0, 0.0)).rgb * 0.07;",
          "  c += texture2D(u_texture, uv - vec2(px.x * 28.0, 0.0)).rgb * 0.07;",
          "  c += texture2D(u_texture, uv + vec2(0.0, px.y * 28.0)).rgb * 0.07;",
          "  c += texture2D(u_texture, uv - vec2(0.0, px.y * 28.0)).rgb * 0.07;",
          "  c += texture2D(u_texture, uv + vec2(px.x * 22.0, px.y * 22.0)).rgb * 0.05;",
          "  c += texture2D(u_texture, uv - vec2(px.x * 22.0, px.y * 22.0)).rgb * 0.05;",
          "  c += texture2D(u_texture, uv + vec2(-px.x * 22.0, px.y * 22.0)).rgb * 0.05;",
          "  c += texture2D(u_texture, uv + vec2(px.x * 22.0, -px.y * 22.0)).rgb * 0.05;",
          "  float luma = dot(c, vec3(0.299, 0.587, 0.114));",
          "  c = mix(c, vec3(luma), 0.18);",
          "  c *= vec3(0.84, 0.85, 0.88);",
          "  c += vec3(0.012, 0.014, 0.018);",
          "  c *= 1.36;",
          "  float dCenter = distance(v_uv, vec2(0.50, 0.50));",
          "  float vignette = smoothstep(1.08, 0.14, dCenter);",
          "  c *= mix(0.95, 1.06, vignette);",
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
        if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) return false;

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
        var renderScale = 0.34;
        var w = Math.max(1, Math.floor(bgCanvas.clientWidth * dpr * renderScale));
        var h = Math.max(1, Math.floor(bgCanvas.clientHeight * dpr * renderScale));
        if (bgCanvas.width !== w || bgCanvas.height !== h) {
          bgCanvas.width = w;
          bgCanvas.height = h;
        }
      }

      function drawWebglBackground() {
        if (!glReady || !gl || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;
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
        } catch (e) {
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

      function attachStream(videoEl) {
        return new Promise(function (resolve, reject) {
          if (videoEl.canPlayType("application/vnd.apple.mpegurl")) {
            videoEl.src = streamUrl;
            resolve();
            return;
          }

          if (window.Hls && window.Hls.isSupported()) {
            var hls = new window.Hls({
              enableWorker: true,
              lowLatencyMode: false,
              backBufferLength: 30,
              maxBufferLength: 8,
              maxMaxBufferLength: 16
            });

            mainHls = hls;

            hls.loadSource(streamUrl);
            hls.attachMedia(videoEl);
            hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
              resolve();
            });
            hls.on(window.Hls.Events.ERROR, function (_, data) {
              if (data && data.fatal) {
                reject(new Error("HLS fatal error: " + data.type));
              }
            });
            return;
          }

          reject(new Error("This browser does not support HLS playback"));
        });
      }

      function warmTarget() {
        if (warmStarted) return;
        warmStarted = true;

        if (window.fetch) {
          fetch(targetUrl, {
            mode: "no-cors",
            credentials: "include"
          }).catch(function () {});
        }

        try {
          var img = new Image();
          img.src = targetUrl + (targetUrl.indexOf("?") === -1 ? "?" : "&") + "_warm=" + Date.now();
        } catch (e) {}
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

      function clearAutoplayRetry() {
        if (!autoplayRetryTimer) return;
        window.clearTimeout(autoplayRetryTimer);
        autoplayRetryTimer = null;
      }

      function scheduleAutoplayRetry() {
        clearAutoplayRetry();
        autoplayRetryTimer = window.setTimeout(function () {
          if (redirected || !streamAttached || !video.paused) return;
          tryAutoplay(false);
        }, autoplayRetryMs);
      }

      function clearStreamRetry() {
        if (!streamRetryTimer) return;
        window.clearTimeout(streamRetryTimer);
        streamRetryTimer = null;
      }

      function scheduleStreamRetry(resetToStart) {
        clearStreamRetry();
        streamRetryTimer = window.setTimeout(function () {
          if (redirected) return;
          attachStreamWithRetry(resetToStart);
        }, streamRetryMs);
      }

      function attachStreamWithRetry(resetToStart) {
        if (redirected || streamAttachPending) return;

        streamAttachPending = true;
        clearStreamRetry();

        if (mainHls) {
          mainHls.destroy();
          mainHls = null;
        }

        showLoadingState("正在连接视频...");

        attachStream(video).then(function () {
          streamAttachPending = false;
          streamAttached = true;
          showLoadingState("正在加载视频...");
          tryAutoplay(resetToStart);
        }).catch(function () {
          streamAttachPending = false;
          streamAttached = false;
          showLoadingState("视频连接失败，正在重试...");
          scheduleStreamRetry(resetToStart);
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

      function syncBgToMain() {
        drawWebglBackground();
      }

      function unlockSoundFromGesture() {
        if (soundUnlocked) return;
        soundUnlocked = true;
        video.muted = false;
        try {
          video.volume = 1;
        } catch (e) {}
        video.play().catch(function () {});
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
          if (!isUserSeeking) {
            hideUi();
          } else {
            scheduleUiHide();
          }
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

      function seekByPercent(percent) {
        var duration = video.duration;
        if (!Number.isFinite(duration) || duration <= 0) return;

        var p = Math.min(100, Math.max(0, percent));
        var nextTime = (p / 100) * duration;

        try {
          video.currentTime = nextTime;
        } catch (e) {}

        setProgressUI(nextTime, duration);
      }

      function updateRangeEnabled() {
        var duration = video.duration;
        progressRange.disabled = !(Number.isFinite(duration) && duration > 0);
      }

      function togglePlayPause() {
        if (video.paused) {
          video.play().catch(function () {});
        } else {
          video.pause();
        }
      }

      function tryAutoplay(resetToStart) {
        if (!streamAttached) {
          attachStreamWithRetry(resetToStart);
          return;
        }

        if (resetToStart && !hasBootstrapped) {
          try {
            video.currentTime = 0;
          } catch (e) {}
        }

        warmTarget();
        showLoadingState("正在加载视频...");

        video.play().then(function () {
          hasBootstrapped = true;
          clearAutoplayRetry();
          hideLoadingState();
          startEndWatch();
          syncBgToMain();
          setProgressUI(video.currentTime, video.duration);
          updateCenterStateByPlayback();
          startWebglLoop();
          hideUi();
        }).catch(function () {
          showLoadingState("正在等待浏览器允许播放...");
          updateCenterStateByPlayback();
          scheduleAutoplayRetry();
        });
      }

      video.removeAttribute("loop");
      video.loop = false;

      video.addEventListener("ended", goNext);
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
        startWebglLoop();
        updateCenterStateByPlayback();
        scheduleUiHide();
      });
      video.addEventListener("pause", function () {
        drawWebglBackground();
        updateCenterStateByPlayback();
        showUi();
      });
      video.addEventListener("loadedmetadata", function () {
        updateRangeEnabled();
        setProgressUI(video.currentTime, video.duration);
      });
      video.addEventListener("canplay", function () {
        startWebglLoop();
        syncBgToMain();
      });
      video.addEventListener("durationchange", function () {
        updateRangeEnabled();
        setProgressUI(video.currentTime, video.duration);
      });

      video.addEventListener("error", function () {
        if (redirected) return;
        streamAttached = false;
        showLoadingState("视频异常，正在重试...");
        attachStreamWithRetry(false);
      });

      skipBtn.addEventListener("click", goNext, { passive: true });
      centerState.addEventListener("click", function (evt) {
        evt.stopPropagation();
        unlockSoundFromGesture();
        togglePlayPause();
        showUi();
      });

      stage.addEventListener("click", function (evt) {
        if (evt.target.closest("#skipBtn") || evt.target.closest("#dyProgress")) {
          return;
        }
        unlockSoundFromGesture();
        showUi();
      }, { passive: true });

      progressRange.addEventListener("pointerdown", function (evt) {
        evt.stopPropagation();
        unlockSoundFromGesture();
        isUserSeeking = true;
        showUi();
      });
      progressRange.addEventListener("touchstart", function (evt) {
        evt.stopPropagation();
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
      progressRange.addEventListener("click", function (evt) {
        evt.stopPropagation();
      }, { passive: true });

      document.addEventListener("visibilitychange", function () {
        if (!document.hidden && video.paused && !redirected) {
          tryAutoplay(!hasBootstrapped);
        }
      });

      window.addEventListener("pageshow", function () {
        if (!redirected && video.paused) {
          tryAutoplay(!hasBootstrapped);
        }
      });
      window.addEventListener("resize", resizeBgCanvas, { passive: true });

      setProgressUI(0, 0);
      updateRangeEnabled();
      updateCenterStateByPlayback();
      hideUi();
      showLoadingState("正在连接视频...");
      attachStreamWithRetry(true);
    })();
