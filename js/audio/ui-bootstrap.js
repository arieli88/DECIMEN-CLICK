/* Lightweight UI toggle — runs even if audio engine scripts fail to load */
(function () {
  function mode() {
    const el = document.querySelector('input[name="transport-mode"]:checked');
    return el ? el.value : "CAMERAONLY";
  }
  function apply() {
    const m = mode();
    const audio = m !== "CAMERAONLY";
    document.body.classList.toggle("decimen-audio-mode", audio);
    const paneRx = document.getElementById("audio-recv-pane");
    const paneTx = document.getElementById("audio-send-pane");
    if (paneRx) {
      paneRx.hidden = !audio;
      if (audio) paneRx.removeAttribute("hidden");
    }
    if (paneTx) {
      paneTx.hidden = !audio;
      if (audio) paneTx.removeAttribute("hidden");
    }
    const start = document.getElementById("start");
    if (start) {
      if (!start.dataset.labelCamera) start.dataset.labelCamera = start.textContent || "Start camera";
      if (m === "CAMERAONLY") start.textContent = start.dataset.labelCamera;
      else if (m === "SOUNDONLY") start.textContent = "התחל מיקרופון (SOUNDONLY)";
      else if (m === "COMBINE") start.textContent = "התחל מצלמה + מיקרופון (COMBINE)";
      else start.textContent = "התחל מצלמה + NACK שמע";
    }
    const waveTx = document.getElementById("audio-wave-tx-wrap");
    const waveRx = document.getElementById("audio-wave-rx-wrap");
    if (waveTx) {
      waveTx.hidden = !(m === "SOUNDONLY" || m === "COMBINE" || m === "CAM_SOUND_FB");
      if (!waveTx.hidden) waveTx.removeAttribute("hidden");
    }
    if (waveRx) {
      waveRx.hidden = !audio;
      if (audio) waveRx.removeAttribute("hidden");
    }
  }
  function wire() {
    document.querySelectorAll('input[name="transport-mode"]').forEach(function (el) {
      el.addEventListener("change", apply);
      el.addEventListener("click", function () {
        setTimeout(apply, 0);
      });
    });
    apply();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
