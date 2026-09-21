/* Live waveform / level visualizer for Decimen audio */
(function (g) {
  const DA = (g.DecimenAudio = g.DecimenAudio || {});

  DA.WaveViz = {
    attach(canvas, opts) {
      opts = opts || {};
      const ctx2d = canvas.getContext("2d");
      let analyser = null;
      let raf = 0;
      let mode = "idle"; // idle | tx | rx
      let lastPcm = null;
      let levelEl = opts.levelEl || null;

      function resize() {
        const w = Math.max(280, canvas.clientWidth || 480);
        const h = opts.height || 120;
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
      }

      function drawIdle() {
        resize();
        const w = canvas.width;
        const h = canvas.height;
        ctx2d.fillStyle = "#0a1628";
        ctx2d.fillRect(0, 0, w, h);
        ctx2d.strokeStyle = "rgba(157,194,234,0.25)";
        ctx2d.beginPath();
        ctx2d.moveTo(0, h / 2);
        ctx2d.lineTo(w, h / 2);
        ctx2d.stroke();
        ctx2d.fillStyle = "#8aa4c4";
        ctx2d.font = "13px Rubik, sans-serif";
        ctx2d.fillText(mode === "tx" ? "Waiting to transmit…" : "No signal yet", 12, 22);
        if (levelEl) levelEl.textContent = "Level: —";
      }

      function drawFromAnalyser() {
        if (!analyser) {
          drawIdle();
          return;
        }
        resize();
        const w = canvas.width;
        const h = canvas.height;
        const buf = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(buf);
        ctx2d.fillStyle = "#0a1628";
        ctx2d.fillRect(0, 0, w, h);
        // grid
        ctx2d.strokeStyle = "rgba(157,194,234,0.12)";
        ctx2d.beginPath();
        ctx2d.moveTo(0, h / 2);
        ctx2d.lineTo(w, h / 2);
        ctx2d.stroke();

        ctx2d.strokeStyle = mode === "tx" ? "#5fe0b0" : "#9dc2ea";
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        let peak = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          peak = Math.max(peak, Math.abs(v));
          const x = (i / (buf.length - 1)) * w;
          const y = h / 2 + v * (h * 0.42);
          if (i === 0) ctx2d.moveTo(x, y);
          else ctx2d.lineTo(x, y);
        }
        ctx2d.stroke();

        // level bar
        const pct = Math.min(100, Math.round(peak * 140));
        ctx2d.fillStyle = pct > 8 ? (mode === "tx" ? "#5fe0b0" : "#9dc2ea") : "#5e7696";
        ctx2d.fillRect(0, h - 4, (w * pct) / 100, 4);
        if (levelEl) {
          levelEl.textContent =
            (mode === "tx" ? "TX" : "RX") + " Level: " + pct + "%" + (pct < 5 ? " · שקט / אין קליטה" : " · אות פעיל");
        }
      }

      function drawFromPcm(pcm) {
        lastPcm = pcm;
        resize();
        const w = canvas.width;
        const h = canvas.height;
        ctx2d.fillStyle = "#0a1628";
        ctx2d.fillRect(0, 0, w, h);
        if (!pcm || !pcm.length) return;
        ctx2d.strokeStyle = "#5fe0b0";
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        const step = Math.max(1, Math.floor(pcm.length / w));
        let peak = 0;
        for (let x = 0; x < w; x++) {
          const i = Math.min(pcm.length - 1, x * step);
          const v = pcm[i];
          peak = Math.max(peak, Math.abs(v));
          const y = h / 2 + v * (h * 0.42);
          if (x === 0) ctx2d.moveTo(x, y);
          else ctx2d.lineTo(x, y);
        }
        ctx2d.stroke();
        const pct = Math.min(100, Math.round(peak * 100));
        ctx2d.fillStyle = "#5fe0b0";
        ctx2d.fillRect(0, h - 4, (w * pct) / 100, 4);
        if (levelEl) levelEl.textContent = "TX Level: " + pct + "% · משדר";
      }

      function loop() {
        if (analyser) drawFromAnalyser();
        else if (lastPcm) drawFromPcm(lastPcm);
        else drawIdle();
        raf = requestAnimationFrame(loop);
      }

      return {
        setMode(m) {
          mode = m || "idle";
        },
        connectAnalyser(a) {
          analyser = a || null;
        },
        showPcm(pcm) {
          drawFromPcm(pcm);
        },
        start() {
          cancelAnimationFrame(raf);
          loop();
        },
        stop() {
          cancelAnimationFrame(raf);
          analyser = null;
          lastPcm = null;
          drawIdle();
        },
      };
    },

    /** Create AnalyserNode tapped from a node graph. */
    async tapPlayback(ctx, sourceNode) {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      sourceNode.connect(analyser);
      return analyser;
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
