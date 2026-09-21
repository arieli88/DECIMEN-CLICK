/* Decimen audio — play PCM / capture mic to PCM */
(function (g) {
  const DA = (g.DecimenAudio = g.DecimenAudio || {});

  DA.AudioIO = {
    async ensureContext() {
      if (!DA._ctx || DA._ctx.state === "closed") {
        DA._ctx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (DA._ctx.state === "suspended") await DA._ctx.resume();
      return DA._ctx;
    },

    async playPcm(pcm, sampleRate, opts) {
      opts = opts || {};
      const ctx = await DA.AudioIO.ensureContext();
      await ctx.resume();
      const rate = sampleRate || ctx.sampleRate;
      // Resample-friendly: always use context sampleRate buffer length at given rate
      const buffer = ctx.createBuffer(1, pcm.length, rate);
      const ch = buffer.getChannelData(0);
      const srcPcm = pcm instanceof Float32Array ? pcm : Float32Array.from(pcm);
      // Soft boost + clip for audible laptop speakers
      const boost = opts.boost != null ? opts.boost : 2.2;
      for (let i = 0; i < srcPcm.length; i++) {
        let x = srcPcm[i] * boost;
        ch[i] = x > 1 ? 1 : x < -1 ? -1 : x;
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = opts.gain != null ? opts.gain : 1.0;
      src.connect(gain);

      let analyser = null;
      if (opts.analyser || opts.onAnalyser) {
        analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        gain.connect(analyser);
        analyser.connect(ctx.destination);
        if (opts.onAnalyser) opts.onAnalyser(analyser);
      } else {
        gain.connect(ctx.destination);
      }

      return new Promise((resolve) => {
        src.onended = () => resolve({ analyser });
        try {
          src.start();
        } catch (err) {
          resolve({ analyser, error: err });
          return;
        }
        DA._activeSource = src;
        DA._activeGain = gain;
      });
    },

    stopPlayback() {
      try {
        DA._activeSource && DA._activeSource.stop();
      } catch (_) {}
      DA._activeSource = null;
    },

    async openMic(constraints) {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
        throw new Error(
          "הדפדפן לא מאפשר מיקרופון כאן. נסו Chrome דרך http://localhost או הפעילו הרשאות מיקרופון."
        );
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: Object.assign(
          {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1,
          },
          constraints || {}
        ),
        video: false,
      });
      const ctx = await DA.AudioIO.ensureContext();
      const source = ctx.createMediaStreamSource(stream);
      return { stream, ctx, source };
    },

    async captureSeconds(seconds, onProgress) {
      const { stream, ctx, source } = await DA.AudioIO.openMic();
      const sampleRate = ctx.sampleRate;
      const total = Math.ceil(seconds * sampleRate);
      const pcm = new Float32Array(total);
      let offset = 0;
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(processor);
      processor.connect(mute);
      mute.connect(ctx.destination);

      await new Promise((resolve, reject) => {
        processor.onaudioprocess = (ev) => {
          if (offset >= total) return;
          const input = ev.inputBuffer.getChannelData(0);
          const n = Math.min(input.length, total - offset);
          pcm.set(input.subarray(0, n), offset);
          offset += n;
          if (onProgress) onProgress(offset / total);
          if (offset >= total) {
            cleanup();
            resolve();
          }
        };
        const t = setTimeout(() => {
          cleanup();
          if (offset > sampleRate * 0.2) resolve();
          else reject(new Error("Mic capture timeout"));
        }, (seconds + 2) * 1000);
        function cleanup() {
          clearTimeout(t);
          try {
            processor.disconnect();
            source.disconnect();
            mute.disconnect();
          } catch (_) {}
          stream.getTracks().forEach((tr) => tr.stop());
        }
        DA._captureCleanup = cleanup;
      });
      return { pcm: pcm.subarray(0, offset), sampleRate };
    },

    /**
     * Live listen loop with optional analyser for waveform UI.
     */
    async startListenLoop(profile, onFrame, options) {
      options = options || {};
      const windowSec = options.windowSec || 2.5;
      const { stream, ctx, source } = await DA.AudioIO.openMic();
      const sampleRate = ctx.sampleRate;
      const bufLen = Math.ceil(windowSec * sampleRate);
      const ring = new Float32Array(bufLen);
      let writePos = 0;
      let filled = 0;
      const processor = ctx.createScriptProcessor(2048, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      source.connect(processor);
      processor.connect(mute);
      mute.connect(ctx.destination);
      if (options.onAnalyser) options.onAnalyser(analyser);
      let lastTry = 0;
      let stopped = false;

      processor.onaudioprocess = (ev) => {
        if (stopped) return;
        const input = ev.inputBuffer.getChannelData(0);
        for (let i = 0; i < input.length; i++) {
          ring[writePos] = input[i];
          writePos = (writePos + 1) % bufLen;
          if (filled < bufLen) filled++;
        }
        const now = performance.now();
        if (now - lastTry < (options.intervalMs || 400)) return;
        lastTry = now;
        if (filled < sampleRate * 0.4) return;
        const snap = new Float32Array(filled);
        const start = (writePos - filled + bufLen) % bufLen;
        for (let i = 0; i < filled; i++) snap[i] = ring[(start + i) % bufLen];
        try {
          const result = DA.Modem.decodePcm(snap, profile, sampleRate, { maxBytes: options.maxBytes || 8192 });
          if (result && result.frame) onFrame(result.frame, result);
        } catch (err) {
          console.warn("decode", err);
        }
      };

      return {
        sampleRate,
        analyser,
        stop() {
          stopped = true;
          try {
            processor.disconnect();
            source.disconnect();
            mute.disconnect();
            analyser.disconnect();
          } catch (_) {}
          stream.getTracks().forEach((tr) => tr.stop());
        },
      };
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
