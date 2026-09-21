/* Decimen — receiver bridge for audio / hybrid transport modes */
(function () {
  const DA = window.DecimenAudio;
  if (!DA) return;

  const state = {
    mode: "CAMERAONLY",
    bandOverride: "auto",
    session: null,
    listen: null,
    camStream: null,
    camTimer: null,
    running: false,
    nackBusy: false,
    viz: null,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(msg, isError) {
    const el = $("stats");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("error", !!isError);
  }

  function currentMode() {
    const checked = document.querySelector('input[name="transport-mode"]:checked');
    return checked ? checked.value : "CAMERAONLY";
  }

  function ensureViz() {
    const canvas = $("audio-wave-rx");
    if (!canvas || !DA.WaveViz) return null;
    if (!state.viz) {
      state.viz = DA.WaveViz.attach(canvas, { height: 140, levelEl: $("audio-wave-rx-level") });
      state.viz.start();
    }
    return state.viz;
  }

  function applyModeUi() {
    state.mode = currentMode();
    const audio = state.mode !== "CAMERAONLY";
    if (document.body) {
      document.body.classList.toggle("decimen-audio-mode", audio);
      document.body.setAttribute("data-transport", state.mode);
    }
    const pane = $("audio-recv-pane");
    if (pane) {
      pane.hidden = !audio;
      if (audio) pane.removeAttribute("hidden");
    }
    const waveWrap = $("audio-wave-rx-wrap");
    if (waveWrap) {
      waveWrap.hidden = !audio;
      if (audio) waveWrap.removeAttribute("hidden");
    }
    if (audio) ensureViz();
    const preview = $("preview");
    if (preview && state.mode === "SOUNDONLY") {
      // hide camera box until hybrid needs it
      if (!state.camStream) preview.style.display = "none";
    }
    const startCam = $("start");
    if (startCam) {
      if (!startCam.dataset.labelCamera) {
        startCam.dataset.labelCamera = startCam.textContent || "Start camera";
      }
      startCam.style.display = "";
      if (state.mode === "CAMERAONLY") {
        startCam.textContent = startCam.dataset.labelCamera;
        startCam.setAttribute("data-i18n", "receive.startCamera");
      } else if (state.mode === "SOUNDONLY") {
        startCam.textContent = "התחל מיקרופון (SOUNDONLY)";
        startCam.removeAttribute("data-i18n");
      } else if (state.mode === "COMBINE") {
        startCam.textContent = "התחל מצלמה + מיקרופון (COMBINE)";
        startCam.removeAttribute("data-i18n");
      } else {
        startCam.textContent = "התחל מצלמה + NACK שמע";
        startCam.removeAttribute("data-i18n");
      }
    }
    const band = $("audio-band-label-rx");
    if (band) {
      const p = DA.resolveBandProfile(state.bandOverride === "auto" ? null : state.bandOverride);
      band.textContent = DA.bandLabel(p, state.bandOverride === "auto");
    }
    const hint = $("transport-hint-rx");
    if (hint) {
      const map = {
        CAMERAONLY: "מצלמה בלבד — כמו תמיד.",
        SOUNDONLY: "שמע בלבד — לחצו התחל; יוצגו גלי הקול מהמיקרופון.",
        COMBINE: "שילוב — מצלמה + מיקרופון + גלי קול.",
        CAM_SOUND_FB: "מצלמה עיקרית; רמקול שולח NACK על חוסרים.",
      };
      hint.textContent = map[state.mode] || "";
    }
    updateProgressUi();
  }

  function assertMicAvailable() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      throw new Error(
        "אין גישה למיקרופון בדפדפן זה (file:// או הקשר לא מאובטח). פתחו דרך http://localhost."
      );
    }
  }

  function ensureSessionFromFrame(frame) {
    if (state.session && state.session.sessionId === frame.sessionId) return state.session;
    const profile = DA.resolveBandProfile(state.bandOverride === "auto" ? null : state.bandOverride);
    // Create empty session skeleton matching frame params
    const k = frame.k || 1;
    const blockLen = frame.blockLen || 40;
    const totalLen = frame.totalLen || k * blockLen;
    const placeholder = new Uint8Array(totalLen);
    state.session = DA.TransferEngine.createSession(placeholder, {
      mode: state.mode,
      profile,
      sessionId: frame.sessionId,
      blockLen,
    });
    // Override blocks with empty received tracking only — blocks array unused on RX
    state.session.k = k;
    state.session.blockLen = blockLen;
    state.session.totalLen = totalLen;
    state.session.received = new Array(k).fill(null);
    return state.session;
  }

  function updateProgressUi() {
    const s = state.session;
    const label = $("audio-progress-label");
    const missEl = $("audio-missing-label");
    if (!s) {
      if (label) label.textContent = "—";
      if (missEl) missEl.textContent = "—";
      return;
    }
    const solved = s.solvedCount();
    const pct = Math.floor((100 * solved) / s.k);
    if (label) label.textContent = pct + "% · " + solved + "/" + s.k + " blocks";
    const missing = s.missing();
    if (missEl) missEl.textContent = missing.length ? "Missing: " + missing.slice(0, 24).join(",") + (missing.length > 24 ? "…" : "") : "Complete";
    const bar = $("audio-bar");
    if (bar) bar.style.width = pct + "%";
    const nackBtn = $("audio-nack-speak");
    if (nackBtn) nackBtn.disabled = !missing.length || state.nackBusy;
  }

  async function finishIfComplete() {
    const s = state.session;
    if (!s || s.solvedCount() < s.k) return;
    try {
      const assembled = s.assemble();
      const parsed = await DA.parseContainer(assembled);
      setStatus("Done: " + parsed.name + " (" + parsed.payload.length + " bytes)");
      showResult(parsed);
      stopListen();
    } catch (err) {
      setStatus(String(err.message || err), true);
    }
  }

  function showResult(parsed) {
    const result = $("result");
    if (!result) return;
    result.innerHTML = "";
    const blob = new Blob([parsed.payload], { type: parsed.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = parsed.name;
    a.className = "download";
    a.textContent = "Download " + parsed.name;
    result.appendChild(a);
    if ((parsed.mime || "").startsWith("image/")) {
      const img = document.createElement("img");
      img.className = "received";
      img.src = url;
      result.appendChild(img);
    } else if ((parsed.mime || "").startsWith("text/") || parsed.mime === "application/vnd.decimen.snippet") {
      const pre = document.createElement("pre");
      pre.className = "received-note";
      pre.textContent = new TextDecoder().decode(parsed.payload);
      result.appendChild(pre);
    }
  }

  function onFrame(frame) {
    if (frame.kind === DA.FRAME_META) {
      const s = ensureSessionFromFrame(frame);
      // payload: bandLen | bandId | nameLen | name
      try {
        const p = frame.payload;
        if (p && p.length >= 2) {
          const bandLen = p[0];
          const bandId = new TextDecoder().decode(p.subarray(1, 1 + bandLen));
          if (DA.BAND_PROFILES[bandId]) {
            s.profile = DA.BAND_PROFILES[bandId];
            $("audio-band-label-rx") && ($("audio-band-label-rx").textContent = "From sender: " + DA.bandLabel(s.profile, false));
            // restart listen on matching band
            if (state.listen) {
              state.listen.stop();
              state.listen = null;
            }
            DA.AudioIO.startListenLoop(s.profile, onFrame, {
              windowSec: 12,
              maxBurstSec: 14,
              maxBytes: 8192,
            }).then((l) => {
              state.listen = l;
            });
          }
        }
      } catch (_) {}
      updateProgressUi();
      return;
    }
    if (frame.kind === DA.FRAME_DATA) {
      const s = ensureSessionFromFrame(frame);
      s.acceptBlock(frame.seq, frame.payload);
      updateProgressUi();
      finishIfComplete();
    }
  }

  function stopListen() {
    state.running = false;
    if (state.listen) {
      state.listen.stop();
      state.listen = null;
    }
    if (state.camTimer) {
      clearInterval(state.camTimer);
      state.camTimer = null;
    }
    if (state.camStream) {
      state.camStream.getTracks().forEach((t) => t.stop());
      state.camStream = null;
    }
    if (state.viz) {
      state.viz.connectAnalyser(null);
      state.viz.setMode("idle");
    }
  }

  async function startSoundListen() {
    assertMicAvailable();
    setStatus("מבקש הרשאת מיקרופון…");
    const profile = DA.resolveBandProfile(state.bandOverride === "auto" ? null : state.bandOverride);
    if (state.session) state.session.profile = profile;
    $("audio-band-label-rx") && ($("audio-band-label-rx").textContent = DA.bandLabel(profile, state.bandOverride === "auto"));
    if (state.listen) {
      state.listen.stop();
      state.listen = null;
    }
    const waveWrap = $("audio-wave-rx-wrap");
    if (waveWrap) {
      waveWrap.hidden = false;
      waveWrap.removeAttribute("hidden");
    }
    const viz = ensureViz();
    if (viz) viz.setMode("rx");
    await DA.AudioIO.ensureContext();
    state.listen = await DA.AudioIO.startListenLoop(profile, onFrame, {
      windowSec: 12,
      maxBurstSec: 14,
      maxBytes: 8192,
      onAnalyser(a) {
        if (viz) viz.connectAnalyser(a);
      },
    });
    setStatus("מאזין במיקרופון · גלי הקול אמורים לזוז אם יש אות · " + DA.bandLabel(profile, state.bandOverride === "auto"));
  }

  async function startHybridCamera() {
    const preview = $("preview");
    const video = $("video");
    if (!video) return;
    if (preview) preview.style.display = "";
    state.camStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "environment", width: { ideal: 1280 } },
    });
    video.srcObject = state.camStream;
    await video.play();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    state.camTimer = setInterval(async () => {
      if (!state.running || video.readyState < 2) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      if (!canvas.width) return;
      ctx.drawImage(video, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let raw = null;
      if (typeof jsQR === "function") {
        const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "dontInvert" });
        if (code && code.data) raw = code.data;
      }
      if (!raw && "BarcodeDetector" in window) {
        try {
          const det = new BarcodeDetector({ formats: ["qr_code"] });
          const codes = await det.detect(canvas);
          if (codes[0]) raw = codes[0].rawValue;
        } catch (_) {}
      }
      if (!raw || typeof raw !== "string" || !raw.startsWith("DCA1:")) return;
      try {
        const bin = atob(raw.slice(5));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const frame = DA.unpackFrame(bytes);
        if (frame) onFrame(frame);
      } catch (_) {}
    }, 120);
  }

  async function onStartAudioRecv() {
    try {
      applyModeUi();
      if (state.mode === "CAMERAONLY") {
        setStatus("למצב CAMERAONLY השתמשו ב-Start camera הרגיל.");
        return;
      }
      stopListen();
      state.running = true;
      state.session = null;
      updateProgressUi();
      if (state.mode === "SOUNDONLY" || state.mode === "COMBINE" || state.mode === "CAM_SOUND_FB") {
        await startSoundListen();
      }
      if (state.mode === "COMBINE" || state.mode === "CAM_SOUND_FB") {
        await startHybridCamera();
      }
      setStatus("Receiving (" + state.mode + ")…");
    } catch (err) {
      const mapped = (window.__decimenMapError && window.__decimenMapError(err)) || String((err && err.message) || err);
      setStatus(mapped, true);
      if (window.__decimenLog) window.__decimenLog("Recv error: " + mapped, true);
    }
  }

  async function speakNack() {
    if (!state.session) {
      setStatus("No session yet — receive some blocks first", true);
      return;
    }
    const missing = state.session.missing();
    if (!missing.length) {
      setStatus("Nothing missing");
      return;
    }
    state.nackBusy = true;
    updateProgressUi();
    try {
      const profile = state.session.profile;
      const frame = state.session.packNackFrame(missing);
      // Pause listen briefly to avoid self-echo confusion
      const wasListen = state.listen;
      if (wasListen) {
        wasListen.stop();
        state.listen = null;
      }
      const ctx = await DA.AudioIO.ensureContext();
      const { pcm } = DA.Modem.encodePcm(frame, profile, ctx.sampleRate);
      setStatus("Speaking NACK (" + missing.length + " blocks)…");
      for (let attempt = 0; attempt < 3; attempt++) {
        await DA.AudioIO.playPcm(pcm, ctx.sampleRate);
        await new Promise((r) => setTimeout(r, 200));
      }
      if (state.running && (state.mode === "SOUNDONLY" || state.mode === "COMBINE" || state.mode === "CAM_SOUND_FB")) {
        await startSoundListen();
      }
      setStatus("NACK sent · waiting for prioritized blocks");
    } catch (err) {
      setStatus(String(err.message || err), true);
    } finally {
      state.nackBusy = false;
      updateProgressUi();
    }
  }

  function wire() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", wire);
      return;
    }
    document.querySelectorAll('input[name="transport-mode"]').forEach((el) => {
      el.addEventListener("change", () => {
        stopListen();
        applyModeUi();
      });
      el.addEventListener("click", () => {
        setTimeout(applyModeUi, 0);
      });
    });
    const bandSel = $("cfg-audio-band-rx");
    if (bandSel) {
      bandSel.addEventListener("change", () => {
        state.bandOverride = bandSel.value;
        applyModeUi();
      });
    }
    $("audio-recv-start") && $("audio-recv-start").addEventListener("click", onStartAudioRecv);
    $("audio-recv-stop") &&
      $("audio-recv-stop").addEventListener("click", () => {
        stopListen();
        setStatus("Stopped");
      });
    $("audio-nack-speak") && $("audio-nack-speak").addEventListener("click", speakNack);

    // Hijack primary Start button for audio modes so SOUNDONLY requests mic
    const startBtn = $("start");
    if (startBtn) {
      startBtn.addEventListener(
        "click",
        (ev) => {
          if (currentMode() === "CAMERAONLY") return;
          ev.preventDefault();
          ev.stopImmediatePropagation();
          onStartAudioRecv();
        },
        true
      );
    }
    applyModeUi();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();

  DA.ReceiverBridge = { state, speakNack, stopListen, applyModeUi };
})();
