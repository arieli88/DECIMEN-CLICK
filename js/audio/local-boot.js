/* Local/file:// boot + diagnostics + live UI adaptation */
(function () {
  function $(id) {
    return document.getElementById(id);
  }

  function ensureDiag() {
    var el = $("audio-diag");
    if (el) return el;
    el = document.createElement("pre");
    el.id = "audio-diag";
    el.dir = "ltr";
    el.style.cssText =
      "display:none;width:100%;max-width:720px;margin:8px auto;padding:10px 12px;background:#1a1020;color:#ffb4a8;border:1px solid #ff7b72;border-radius:8px;font:12px/1.45 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow:auto;max-height:220px";
    var anchor = document.querySelector(".send-shell, .receiver-primary, main") || document.body;
    anchor.insertBefore(el, anchor.firstChild);
    return el;
  }

  function logDiag(msg, isErr) {
    var el = ensureDiag();
    el.style.display = "block";
    el.hidden = false;
    var line = "[" + new Date().toLocaleTimeString() + "] " + msg;
    el.textContent = (el.textContent ? el.textContent + "\n" : "") + line;
    if (isErr) console.error(msg);
    else console.log(msg);
  }

  function mapError(err) {
    if (!err) return "שגיאה לא ידועה";
    var name = err.name || "";
    var msg = err.message || String(err);
    if (name === "NotAllowedError" || /Permission|denied/i.test(msg))
      return "הרשאה נדחתה — אשרו מיקרופון/רמקול בדפדפן.";
    if (name === "NotFoundError") return "לא נמצא מיקרופון במכשיר.";
    if (name === "NotReadableError") return "המיקרופון תפוס ע״י אפליקציה אחרת.";
    if (name === "SecurityError" || /secure|https|file:/i.test(msg))
      return "הדפדפן חוסם מדיה בכתובת מקומית. נסו Chrome, או הריצו start-local.bat.";
    if (/AudioContext|audio/i.test(msg)) return "בעיית AudioContext: " + msg;
    return msg;
  }

  window.__decimenLog = logDiag;
  window.__decimenMapError = mapError;

  window.addEventListener("error", function (ev) {
    logDiag("JS error: " + (ev.message || ev.error || "unknown") + (ev.filename ? " @ " + ev.filename + ":" + ev.lineno : ""), true);
  });
  window.addEventListener("unhandledrejection", function (ev) {
    logDiag("Promise: " + mapError(ev.reason), true);
  });

  function mode() {
    var el = document.querySelector('input[name="transport-mode"]:checked');
    return el ? el.value : "CAMERAONLY";
  }

  function adaptUi() {
    var m = mode();
    var audio = m !== "CAMERAONLY";
    document.body.classList.toggle("decimen-audio-mode", audio);
    document.body.setAttribute("data-transport", m);

    ["audio-send-pane", "audio-recv-pane"].forEach(function (id) {
      var p = $(id);
      if (!p) return;
      p.hidden = !audio;
      if (audio) p.removeAttribute("hidden");
    });

    var waveTx = $("audio-wave-tx-wrap");
    var waveRx = $("audio-wave-rx-wrap");
    if (waveTx) {
      waveTx.hidden = !audio;
      if (audio) waveTx.removeAttribute("hidden");
    }
    if (waveRx) {
      waveRx.hidden = !audio;
      if (audio) waveRx.removeAttribute("hidden");
    }

    var stage = $("stage");
    if (stage && audio) {
      stage.hidden = false;
      stage.classList.add("audio-stage-flex");
    }

    var qrHolder = $("audio-qr-holder");
    if (qrHolder) qrHolder.hidden = !(m === "COMBINE" || m === "CAM_SOUND_FB");

    // Hide QR-only settings noise in sound modes
    var settings = document.querySelector("details.settings");
    if (settings && document.body.classList.contains("tool-page")) {
      settings.style.opacity = audio && m === "SOUNDONLY" ? "0.35" : "";
    }

    var start = $("start");
    if (start) {
      if (!start.dataset.labelCamera) start.dataset.labelCamera = start.textContent || "Start camera";
      if (m === "CAMERAONLY") start.textContent = start.dataset.labelCamera;
      else if (m === "SOUNDONLY") start.textContent = "התחל מיקרופון (SOUNDONLY)";
      else if (m === "COMBINE") start.textContent = "התחל מצלמה+מיקרופון";
      else start.textContent = "התחל מצלמה + NACK";
    }

    var hint = $("transport-hint") || $("transport-hint-rx");
    if (hint) {
      var map = {
        CAMERAONLY: "מצלמה בלבד — QR כמו קודם.",
        SOUNDONLY: "שמע בלבד — בחרו קובץ / התחל מיקרופון. יוצגו גלי קול (בלי QR).",
        COMBINE: "שילוב — QR + גלי קול יחד.",
        CAM_SOUND_FB: "מצלמה עיקרית + שמע לחוסרים.",
      };
      hint.textContent = map[m] || "";
    }

    var specs = $("specs") || $("stats");
    if (specs && audio) {
      var da = window.DecimenAudio;
      if (!da) specs.textContent = "מצב שמע נבחר — ממתין לטעינת מנוע השמע…";
      else if (!window.__DECIMEN_AUDIO_BUNDLE_OK && !da.Modem)
        specs.textContent = "מנוע שמע לא נטען במלואו — ראו תיבת השגיאות.";
    }
  }

  function selfCheck() {
    var da = window.DecimenAudio;
    if (window.__DECIMEN_AUDIO_BUNDLE_ERR) {
      logDiag("Bundle failed: " + mapError(window.__DECIMEN_AUDIO_BUNDLE_ERR), true);
      return;
    }
    if (!da) {
      logDiag("DecimenAudio חסר — קבצי js/audio לא נטענו. ודאו שהתיקייה js נמצאת ליד ה-HTML.", true);
      return;
    }
    var need = ["crc32", "fecEncode", "Modem", "AudioIO", "TransferEngine", "WaveViz", "packFrame"];
    var missing = [];
    need.forEach(function (k) {
      if (typeof da[k] !== "function" && typeof da[k] !== "object") missing.push(k);
    });
    // Modem/AudioIO/TransferEngine/WaveViz are objects
    if (!da.Modem) missing.push("Modem");
    if (!da.AudioIO) missing.push("AudioIO");
    if (!da.TransferEngine) missing.push("TransferEngine");
    if (!da.WaveViz) missing.push("WaveViz");
    if (!da.crc32) missing.push("crc32");
    if (!da.fecEncode) missing.push("fecEncode");
    if (!da.packFrame) missing.push("packFrame");

    if (missing.length) logDiag("חסרים במנוע: " + missing.join(", "), true);
    else logDiag("מנוע שמע תקין · protocol=" + location.protocol + " · secure=" + !!window.isSecureContext);

    if (!window.AudioContext && !window.webkitAudioContext) logDiag("אין AudioContext בדפדפן", true);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      logDiag("אין getUserMedia — מיקרופון לא זמין בכתובת זו", true);

    if (location.protocol === "file:") {
      logDiag("נפתח מ-file:// (מקומי). אם מיקרופון נחסם — הריצו start-local.bat");
    }
  }

  function wire() {
    document.querySelectorAll('input[name="transport-mode"]').forEach(function (el) {
      el.addEventListener("change", adaptUi);
      el.addEventListener("click", function () {
        setTimeout(adaptUi, 0);
      });
    });
    adaptUi();
    // Delay check until bundle likely loaded
    setTimeout(selfCheck, 50);
    setTimeout(selfCheck, 400);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
