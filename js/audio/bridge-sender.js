/* Decimen — sender bridge for audio / hybrid transport modes */
(function () {
  const DA = window.DecimenAudio;
  if (!DA) return;

  const state = {
    mode: "CAMERAONLY",
    bandOverride: "auto",
    session: null,
    running: false,
    listen: null,
    file: null,
    txTimer: null,
    qrTimer: null,
    soundIter: null,
    camIter: null,
    viz: null,
    interceptLegacy: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(msg, isError) {
    const el = $("specs");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("error", !!isError);
  }

  function currentMode() {
    const checked = document.querySelector('input[name="transport-mode"]:checked');
    return checked ? checked.value : "CAMERAONLY";
  }

  function ensureViz() {
    const canvas = $("audio-wave-tx");
    if (!canvas || !DA.WaveViz) return null;
    if (!state.viz) {
      state.viz = DA.WaveViz.attach(canvas, { height: 140, levelEl: $("audio-wave-tx-level") });
      state.viz.start();
    }
    return state.viz;
  }

  function showStageForMode() {
    const stage = $("stage");
    const waveWrap = $("audio-wave-tx-wrap");
    const qrHolder = $("audio-qr-holder");
    const qrCanvas = $("qr");
    if (!stage) return;
    const m = state.mode;
    if (m === "CAMERAONLY") {
      // Restore legacy QR canvas — never leave it sticky-hidden after audio modes
      if (waveWrap) {
        waveWrap.hidden = true;
        waveWrap.setAttribute("hidden", "");
      }
      if (qrHolder) {
        qrHolder.hidden = true;
        qrHolder.setAttribute("hidden", "");
      }
      if (qrCanvas) {
        qrCanvas.hidden = false;
        qrCanvas.removeAttribute("hidden");
      }
      return;
    }
    stage.hidden = false;
    stage.removeAttribute("hidden");
    stage.classList.add("audio-stage-flex");
    if (waveWrap) {
      waveWrap.hidden = false;
      waveWrap.removeAttribute("hidden");
    }
    const showQr = m === "COMBINE" || m === "CAM_SOUND_FB";
    if (qrHolder) {
      qrHolder.hidden = !showQr;
      if (showQr) qrHolder.removeAttribute("hidden");
    }
    // Hybrid draws on audio-qr-holder; keep legacy #qr out of the way only in pure SOUNDONLY
    if (qrCanvas) {
      if (m === "SOUNDONLY") {
        qrCanvas.hidden = true;
      } else if (m === "COMBINE" || m === "CAM_SOUND_FB") {
        qrCanvas.hidden = true;
      }
    }
    ensureViz();
  }

  function applyModeUi() {
    state.mode = currentMode();
    const audio = state.mode !== "CAMERAONLY";
    state.interceptLegacy = audio;
    if (document.body) document.body.classList.toggle("decimen-audio-mode", audio);
    const pane = $("audio-send-pane");
    if (pane) {
      pane.hidden = !audio;
      if (audio) pane.removeAttribute("hidden");
    }
    // Re-enable normal file picker in audio modes (same upload path as QR)
    const paneFile = $("pane-file");
    const folderRow = $("folder-row");
    if (paneFile) {
      paneFile.style.opacity = "";
      paneFile.style.pointerEvents = audio ? "auto" : "";
    }
    if (folderRow) {
      folderRow.style.opacity = audio ? "0.45" : "";
      folderRow.style.pointerEvents = audio ? "none" : "";
    }
    const band = $("audio-band-label");
    if (band) {
      const p = DA.resolveBandProfile(state.bandOverride === "auto" ? null : state.bandOverride);
      band.textContent = DA.bandLabel(p, state.bandOverride === "auto");
    }
    const hint = $("transport-hint");
    if (hint) {
      const map = {
        CAMERAONLY: "מצלמה בלבד — בחרו קובץ וה-QR יתחיל כמו תמיד.",
        SOUNDONLY: "שמע בלבד — בחרו קובץ (אותו בורר) והרמקול ישדר; יוצגו גלי קול.",
        COMBINE: "שילוב — אותו בורר קובץ; QR + גלי קול יחד.",
        CAM_SOUND_FB: "מצלמה + שמע ל-NACK — בחרו קובץ כרגיל.",
      };
      hint.textContent = map[state.mode] || "";
    }
    showStageForMode();
    if (!audio && state.viz) state.viz.setMode("idle");
  }

  async function buildFromFile(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    return DA.buildContainer(file.name, file.type || "application/octet-stream", buf);
  }

  async function buildFromText(text) {
    const raw = new TextEncoder().encode(text);
    return DA.buildContainer("snippet.txt", "application/vnd.decimen.snippet", raw);
  }

  async function playFrameBytes(bytes) {
    const profile = state.session.profile;
    const ctx = await DA.AudioIO.ensureContext();
    await ctx.resume();
    const { pcm } = DA.Modem.encodePcm(bytes, profile, ctx.sampleRate);
    const lead = Math.floor(ctx.sampleRate * 0.04);
    const trail = Math.floor(ctx.sampleRate * 0.35);
    const padded = new Float32Array(pcm.length + lead + trail);
    padded.set(pcm, lead);
    const viz = ensureViz();
    if (viz) {
      viz.setMode("tx");
      viz.showPcm(padded);
    }
    const opts = {
      boost: 1.05,
      profileId: profile.id,
      busFast: !!state.busFast,
      silent: !!state.busFast,
      onAnalyser(a) {
        if (viz) viz.connectAnalyser(a);
      },
    };
    if (state.loopback && state.loopback.dest) {
      opts.loopDest = state.loopback.dest;
    }
    await DA.AudioIO.playPcm(padded, ctx.sampleRate, opts);
    // Quiet gap between frames (skip when busFast)
    if (opts.busFast) return;
    const gap = state.soundGapMs != null ? state.soundGapMs : 700;
    await new Promise((r) => setTimeout(r, gap));
  }

  function updateTxProgress(seq) {
    const s = state.session;
    if (!s) return;
    const el = $("audio-tx-status");
    const bar = $("audio-tx-bar");
    const label = $("audio-tx-progress-label");
    const pct = Math.floor((100 * ((seq % s.k) + 1)) / s.k);
    const msg =
      "שולח בלוק " +
      ((seq % s.k) + 1) +
      "/" +
      s.k +
      " · " +
      s.profile.label +
      (state._soundBlocksSent ? " · מחזורים≈" + Math.floor(state._soundBlocksSent / s.k) : "");
    if (el) el.textContent = msg;
    if (label) label.textContent = pct + "% במחזור הנוכחי · K=" + s.k;
    if (bar) bar.style.width = pct + "%";
  }

  async function startNackListen() {
    if (state.listen) return;
    try {
      const profile = state.session.profile;
      state.listen = await DA.AudioIO.startListenLoop(
        profile,
        (frame) => {
          if (!state.session || frame.sessionId !== state.session.sessionId) return;
          if (frame.kind !== DA.FRAME_NACK) return;
          const missing = DA.decodeNackPayload(frame.payload, frame.k || state.session.k);
          state.session.setPriority(missing);
          setStatus("NACK: " + missing.length + " blocks prioritized");
          $("audio-nack-status") && ($("audio-nack-status").textContent = "NACK ← " + missing.length + " missing");
        },
        { windowSec: 3, intervalMs: 350, maxBytes: 2048 }
      );
      $("audio-nack-status") && ($("audio-nack-status").textContent = "NACK listen: on");
    } catch (err) {
      $("audio-nack-status") &&
        ($("audio-nack-status").textContent = "NACK listen: off (" + ((err && err.message) || "no mic") + ")");
    }
  }

  function stopAll() {
    state.running = false;
    if (state.txTimer) {
      clearTimeout(state.txTimer);
      state.txTimer = null;
    }
    if (state.qrTimer) {
      clearInterval(state.qrTimer);
      state.qrTimer = null;
    }
    DA.AudioIO.stopPlayback();
    if (state.listen) {
      state.listen.stop();
      state.listen = null;
    }
    if (state.viz) state.viz.setMode("idle");
  }

  function drawQrBlock(seq) {
    const stage = $("stage");
    if (!stage || !state.session) return;
    stage.hidden = false;
    showStageForMode();
    const frame = state.session.packDataFrame(seq);
    let b64 = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < frame.length; i += CHUNK) {
      b64 += String.fromCharCode.apply(null, frame.subarray(i, i + CHUNK));
    }
    b64 = btoa(b64);
    const text = "DCA1:" + b64;
    let holder = $("audio-qr-holder");
    if (!holder) {
      holder = document.createElement("div");
      holder.id = "audio-qr-holder";
      stage.appendChild(holder);
    }
    holder.hidden = false;
    holder.innerHTML = "";
    const qrCanvas = $("qr");
    if (qrCanvas) qrCanvas.hidden = true;
    if (typeof QRCode === "undefined") {
      holder.textContent = "QR vendor missing";
      return;
    }
    // eslint-disable-next-line no-new
    new QRCode(holder, {
      text,
      width: 280,
      height: 280,
      correctLevel: QRCode.CorrectLevel.M,
    });
  }

  async function soundTxLoop() {
    if (!state.running || !state.session) return;
    const mode = state.session.mode;
    if (mode === "CAMERAONLY") return;
    if (mode === "CAM_SOUND_FB" && !state.session.getPriority()) {
      state.txTimer = setTimeout(soundTxLoop, 400);
      return;
    }
    if (!state.soundIter) state.soundIter = state.session.makeTxIterator("sound");
    let seq;
    const pri = state.session.getPriority();
    if (mode === "CAM_SOUND_FB" && pri && pri.length) {
      seq = pri[Math.floor(Math.random() * pri.length)];
    } else if (mode === "COMBINE" || mode === "SOUNDONLY") {
      seq = state.soundIter.next();
    } else {
      state.txTimer = setTimeout(soundTxLoop, 400);
      return;
    }
    try {
      const bytes = state.session.packDataFrame(seq);
      updateTxProgress(seq);
      // Double-send each chunk
      await playFrameBytes(bytes);
      await playFrameBytes(bytes);
      state._soundBlocksSent = (state._soundBlocksSent || 0) + 1;
      if (state._soundBlocksSent % 3 === 0) {
        await playFrameBytes(
          state.session.packMetaFrame({
            name: (state._meta && state._meta.name) || "file",
            bandId: state.session.profile.id,
          })
        );
      }
    } catch (err) {
      setStatus(String(err.message || err), true);
    }
    if (state.running) state.txTimer = setTimeout(soundTxLoop, 120);
  }

  function cameraTxLoop() {
    if (!state.running || !state.session) return;
    const mode = state.session.mode;
    if (mode === "SOUNDONLY") return;
    if (!state.camIter) state.camIter = state.session.makeTxIterator("camera");
    let seq;
    const pri = state.session.getPriority();
    if (pri && pri.length && (mode === "CAM_SOUND_FB" || mode === "COMBINE")) {
      const camPri = pri.filter((i) => state.session.channelFor(i) === "camera" || mode === "CAM_SOUND_FB");
      seq = (camPri.length ? camPri : pri)[0];
    } else {
      seq = state.camIter.next();
    }
    drawQrBlock(seq);
  }

  async function startTransfer(containerBytes, meta) {
    stopAll();
    // Prefer fast UA profile so speakers start immediately (skip mic probe)
    const profile =
      state.bandOverride === "auto"
        ? DA.resolveBandProfile(null, { mode: state.mode, preferShared: true })
        : DA.resolveBandProfile(state.bandOverride);
    state.session = DA.TransferEngine.createSession(containerBytes, {
      mode: state.mode,
      profile,
      bandOverride: state.bandOverride,
      // Small chunks for phone decode; slightly larger than 16 to cut overhead
      blockLen: state.mode === "SOUNDONLY" ? 36 : 40,
    });
    state.soundIter = null;
    state.camIter = null;
    state.running = true;
    state._soundBlocksSent = 0;
    state._meta = meta || {};
    showStageForMode();
    const viz = ensureViz();
    if (viz) viz.setMode("tx");

    setStatus(
      "משדר שמע · Session " +
        state.session.sessionId +
        " · K=" +
        state.session.k +
        " · " +
        DA.bandLabel(profile, state.bandOverride === "auto")
    );
    $("audio-band-label") && ($("audio-band-label").textContent = DA.bandLabel(profile, state.bandOverride === "auto"));

    // Unlock audio on user gesture, play a short beep so user hears speakers work
    const ctx = await DA.AudioIO.ensureContext();
    await ctx.resume();
    const beep = new Float32Array(Math.floor(ctx.sampleRate * 0.12));
    for (let i = 0; i < beep.length; i++) {
      const env = i < 200 ? i / 200 : i > beep.length - 200 ? (beep.length - i) / 200 : 1;
      beep[i] = Math.sin((2 * Math.PI * 1200 * i) / ctx.sampleRate) * 0.5 * env;
    }
    await DA.AudioIO.playPcm(beep, ctx.sampleRate, { boost: 1.5 });
    setStatus("רמקול פעיל — מתחיל שידור נתונים…");

    if (state.mode !== "CAMERAONLY") {
      try {
        const metaBytes = state.session.packMetaFrame({ name: meta && meta.name, bandId: profile.id });
        await playFrameBytes(metaBytes);
        await playFrameBytes(metaBytes); // double META for late/phone receivers
      } catch (err) {
        setStatus("שגיאת שידור META: " + (err.message || err), true);
      }
    }

    // Start TX first; NACK mic is optional and must not block speakers
    if (state.mode === "SOUNDONLY" || state.mode === "COMBINE" || state.mode === "CAM_SOUND_FB") {
      soundTxLoop();
    }
    if (state.mode === "COMBINE" || state.mode === "CAM_SOUND_FB") {
      cameraTxLoop();
      state.qrTimer = setInterval(cameraTxLoop, 180);
    }
    startNackListen(); // non-blocking failure
  }

  async function onStartAudioSend(fileOverride) {
    try {
      applyModeUi();
      if (state.mode === "CAMERAONLY") return;
      let container;
      let meta = {};
      const sendMode = document.querySelector('input[name="send-mode"]:checked');
      if (sendMode && sendMode.value === "snippet") {
        const text = ($("snippet-text") && $("snippet-text").value) || "";
        if (!text.trim()) throw new Error("Empty text");
        container = await buildFromText(text);
        meta.name = "snippet.txt";
      } else {
        const cfg = $("cfg-file");
        const file = fileOverride || state.file || (cfg && cfg.files && cfg.files[0]);
        if (!file) throw new Error("בחרו קובץ קודם (אותו בורר כמו ל-QR)");
        state.file = file;
        const label = $("file-picker-label");
        if (label) label.textContent = file.name;

        if (state.mode === "SOUNDONLY" || state.mode === "COMBINE") {
          setStatus("מכין קובץ לשמע (דחיסת תמונה אם צריך)…");
          const prepared = await DA.prepareSoundPayload(file, { maxBytes: 1200, maxEdge: 240 });
          if (prepared.note) setStatus(prepared.note);
          container = await DA.buildContainer(prepared.name, prepared.mime, prepared.bytes);
          meta.name = prepared.name;
          const profileGuess = DA.resolveBandProfile(state.bandOverride === "auto" ? null : state.bandOverride);
          const eta = DA.estimateSoundSeconds(container.length, {
            blockLen: 36,
            profile: profileGuess,
            reps: 2,
            gapMs: 700,
          });
          const etaMin = Math.max(1, Math.round(eta / 60));
          setStatus(
            (prepared.note ? prepared.note + " · " : "") +
              "שידור " +
              container.length +
              "B · ~" +
              etaMin +
              " דק׳ · K≈" +
              Math.ceil(container.length / 36)
          );
          if (window.__decimenLog) {
            window.__decimenLog(
              "SOUND prep " +
                prepared.originalBytes +
                "→" +
                prepared.bytes.length +
                " container=" +
                container.length +
                " etaSec≈" +
                eta
            );
          }
        } else {
          container = await buildFromFile(file);
          meta.name = file.name;
        }
      }
      await startTransfer(container, meta);
    } catch (err) {
      const mapped = (window.__decimenMapError && window.__decimenMapError(err)) || String(err.message || err);
      setStatus(mapped, true);
      if (window.__decimenLog) window.__decimenLog("Send error: " + mapped, true);
    }
  }

  function wire() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", wire);
      return;
    }
    document.querySelectorAll('input[name="transport-mode"]').forEach((el) => {
      el.addEventListener("change", () => {
        const next = currentMode();
        if (next === "CAMERAONLY") {
          // Stop audio only — leave legacy QR engine alone
          stopAll();
          applyModeUi();
          showStageForMode();
          setStatus("מצב מצלמה (QR) — כמו בהתחלה");
          return;
        }
        stopAll();
        applyModeUi();
      });
      el.addEventListener("click", () => setTimeout(applyModeUi, 0));
    });
    const bandSel = $("cfg-audio-band");
    if (bandSel) {
      bandSel.addEventListener("change", () => {
        state.bandOverride = bandSel.value;
        applyModeUi();
      });
    }
    $("audio-send-start") && $("audio-send-start").addEventListener("click", () => onStartAudioSend());
    $("audio-send-stop") &&
      $("audio-send-stop").addEventListener("click", () => {
        stopAll();
        setStatus("Stopped");
      });
    $("audio-test-speaker") &&
      $("audio-test-speaker").addEventListener("click", async () => {
        try {
          const ctx = await DA.AudioIO.ensureContext();
          await ctx.resume();
          const beep = new Float32Array(Math.floor(ctx.sampleRate * 0.25));
          for (let i = 0; i < beep.length; i++) {
            const env = i < 300 ? i / 300 : i > beep.length - 300 ? (beep.length - i) / 300 : 1;
            beep[i] = Math.sin((2 * Math.PI * 880 * i) / ctx.sampleRate) * 0.55 * env;
          }
          const viz = ensureViz();
          showStageForMode();
          if (viz) {
            viz.setMode("tx");
            viz.showPcm(beep);
          }
          await DA.AudioIO.playPcm(beep, ctx.sampleRate, { boost: 2.5 });
          setStatus("בדיקת רמקול — אם שמעתם צפצוף, הרמקול עובד");
          if (window.__decimenLog) window.__decimenLog("Speaker test OK");
        } catch (err) {
          const mapped = (window.__decimenMapError && window.__decimenMapError(err)) || String(err.message || err);
          setStatus(mapped, true);
          if (window.__decimenLog) window.__decimenLog("Speaker test FAIL: " + mapped, true);
        }
      });

    $("audio-selftest") &&
      $("audio-selftest").addEventListener("click", async () => {
        try {
          setStatus("רץ Self-test (loopback וירטואלי)…");
          if (!DA.runSoundOnlySelfTest) throw new Error("selftest module missing");
          const result = await DA.runSoundOnlySelfTest({});
          setStatus(result.message, !result.ok);
          if (window.__decimenLog) window.__decimenLog(result.message, !result.ok);
          if (!result.ok) throw new Error(result.message);
        } catch (err) {
          const mapped = (window.__decimenMapError && window.__decimenMapError(err)) || String(err.message || err);
          setStatus(mapped, true);
          if (window.__decimenLog) window.__decimenLog("Self-test error: " + mapped, true);
        }
      });

    // Same file picker as QR — intercept in audio modes
    const cfg = $("cfg-file");
    if (cfg) {
      cfg.addEventListener(
        "change",
        (ev) => {
          if (!state.interceptLegacy && currentMode() === "CAMERAONLY") return;
          if (currentMode() === "CAMERAONLY") return;
          const file = cfg.files && cfg.files[0];
          if (!file) return;
          ev.stopImmediatePropagation();
          state.file = file;
          onStartAudioSend(file);
        },
        true
      );
    }

    const sendSnippet = $("send-snippet");
    if (sendSnippet) {
      sendSnippet.addEventListener(
        "click",
        (ev) => {
          if (currentMode() === "CAMERAONLY") return;
          ev.preventDefault();
          ev.stopImmediatePropagation();
          onStartAudioSend();
        },
        true
      );
    }
    applyModeUi();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();

  DA.SenderBridge = { state, startTransfer, stopAll, applyModeUi };
})();
