/* Decimen audio — play / capture with burst + rolling-window decode */
(function (g) {
  const DA = (g.DecimenAudio = g.DecimenAudio || {});

  function rmsOf(buf) {
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / Math.max(1, buf.length));
  }

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
      const buffer = ctx.createBuffer(1, pcm.length, rate);
      const ch = buffer.getChannelData(0);
      const srcPcm = pcm instanceof Float32Array ? pcm : Float32Array.from(pcm);
      // Default boost 1.0 — previous 2.6 hard-clipped MFSK and broke FEC over speakers/mic
      const boost = opts.boost != null ? opts.boost : 1.0;
      for (let i = 0; i < srcPcm.length; i++) {
        let x = srcPcm[i] * boost;
        ch[i] = x > 1 ? 1 : x < -1 ? -1 : x;
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = opts.gain != null ? opts.gain : 1.0;
      src.connect(gain);
      if (opts.loopDest) gain.connect(opts.loopDest);

      let analyser = null;
      if (opts.analyser || opts.onAnalyser) {
        analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        gain.connect(analyser);
        if (!opts.silent) analyser.connect(ctx.destination);
        else if (!opts.loopDest) analyser.connect(ctx.destination);
        if (opts.onAnalyser) opts.onAnalyser(analyser);
      } else if (!opts.silent) {
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
      });
    },

    stopPlayback() {
      try {
        DA._activeSource && DA._activeSource.stop();
      } catch (_) {}
      DA._activeSource = null;
    },

    async createLoopback() {
      const ctx = await DA.AudioIO.ensureContext();
      const dest = ctx.createMediaStreamDestination();
      return { ctx, dest, stream: dest.stream };
    },

    async openMic(constraints) {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
        throw new Error("הדפדפן לא מאפשר מיקרופון כאן.");
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
      return { stream, ctx, source: ctx.createMediaStreamSource(stream) };
    },

    async openStreamAsMic(mediaStream) {
      const ctx = await DA.AudioIO.ensureContext();
      return {
        stream: mediaStream,
        ctx,
        source: ctx.createMediaStreamSource(mediaStream),
        virtual: true,
      };
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
      });
      return { pcm: pcm.subarray(0, offset), sampleRate };
    },

    /**
     * Listen with (1) energy-burst decode and (2) rolling 12s window decode.
     * Frame duration is ~4–6s — window MUST be longer than one frame.
     */
    async startListenLoop(profile, onFrame, options) {
      options = options || {};
      const opened = options.inputStream
        ? await DA.AudioIO.openStreamAsMic(options.inputStream)
        : await DA.AudioIO.openMic();
      const { stream, ctx, source } = opened;
      const sampleRate = ctx.sampleRate;
      const maxBurstSec = options.maxBurstSec || 14;
      const maxBurst = Math.ceil(maxBurstSec * sampleRate);
      const ringLen = Math.ceil((options.windowSec || 12) * sampleRate);
      const ring = new Float32Array(ringLen);
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

      let stopped = false;
      let inBurst = false;
      let quietChunks = 0;
      let burst = null;
      let burstPos = 0;
      let noiseFloor = 0.002;
      let lastRoll = 0;
      const seen = new Set();
      // NEVER run Goertzel decode inside onaudioprocess — it drops mic samples and corrupts frames.
      let decodeQueue = [];
      let decodeScheduled = false;
      let decoding = false;

      function emit(result) {
        if (!result || !result.frame) return;
        const f = result.frame;
        const key = f.sessionId + ":" + f.kind + ":" + f.seq + ":" + (result.bytes && result.bytes.length);
        if (seen.has(key)) return;
        seen.add(key);
        if (seen.size > 800) seen.clear();
        onFrame(f, result);
      }

      function enqueueDecode(pcmSnap, delayMs) {
        if (!pcmSnap || pcmSnap.length < sampleRate * 0.15) return;
        if (decodeQueue.length >= 3) decodeQueue.shift();
        decodeQueue.push(pcmSnap);
        if (!decodeScheduled) {
          decodeScheduled = true;
          // Delay so ScriptProcessor can keep draining without competing with Goertzel
          setTimeout(pumpDecode, delayMs != null ? delayMs : 40);
        }
      }

      function pumpDecode() {
        decodeScheduled = false;
        if (stopped && !decodeQueue.length) return;
        if (decoding) {
          decodeScheduled = true;
          setTimeout(pumpDecode, 30);
          return;
        }
        const snap = decodeQueue.shift();
        if (!snap) return;
        decoding = true;
        try {
          emit(
            DA.Modem.decodePcm(snap, profile, sampleRate, {
              maxBytes: options.maxBytes || 8192,
              searchSec: options.searchSec || 1.2,
            })
          );
        } catch (err) {
          console.warn("decode", err);
        } finally {
          decoding = false;
          if (decodeQueue.length && !stopped) {
            decodeScheduled = true;
            setTimeout(pumpDecode, 20);
          }
        }
      }

      function finishBurst() {
        if (!burst || burstPos < sampleRate * 0.2) {
          burst = null;
          burstPos = 0;
          inBurst = false;
          return;
        }
        const snap = burst.slice(0, burstPos);
        const padded = new Float32Array(snap.length + Math.floor(sampleRate * 0.04));
        padded.set(snap, Math.floor(sampleRate * 0.015));
        enqueueDecode(padded, 60);
        burst = null;
        burstPos = 0;
        inBurst = false;
      }

      processor.onaudioprocess = (ev) => {
        if (stopped) return;
        const input = ev.inputBuffer.getChannelData(0);
        for (let i = 0; i < input.length; i++) {
          ring[writePos] = input[i];
          writePos = (writePos + 1) % ringLen;
          if (filled < ringLen) filled++;
        }

        const r = rmsOf(input);
        if (!inBurst) noiseFloor = noiseFloor * 0.95 + r * 0.05;
        const thresh = Math.max(0.004, noiseFloor * 3.5);

        if (r > thresh) {
          if (!inBurst) {
            inBurst = true;
            burst = new Float32Array(maxBurst);
            burstPos = 0;
            quietChunks = 0;
          }
          const n = Math.min(input.length, maxBurst - burstPos);
          if (n > 0) {
            burst.set(input.subarray(0, n), burstPos);
            burstPos += n;
          }
          quietChunks = 0;
          if (burstPos >= maxBurst) finishBurst();
        } else if (inBurst) {
          const n = Math.min(input.length, maxBurst - burstPos);
          if (n > 0) {
            burst.set(input.subarray(0, n), burstPos);
            burstPos += n;
          }
          quietChunks++;
          // ~0.5s quiet at 2048/48k — end of frame
          if (quietChunks >= 12) finishBurst();
        }

        const now = performance.now();
        // Rolling is opt-in; burst-end decode is the reliable path.
        if (
          options.rolling === true &&
          !inBurst &&
          !decoding &&
          now - lastRoll >= (options.intervalMs || 1200) &&
          filled > sampleRate * 4
        ) {
          lastRoll = now;
          const snap = new Float32Array(Math.min(filled, Math.ceil(sampleRate * 11)));
          const take = snap.length;
          const start = (writePos - take + ringLen) % ringLen;
          for (let i = 0; i < take; i++) snap[i] = ring[(start + i) % ringLen];
          enqueueDecode(snap, 80);
        }
      };

      return {
        sampleRate,
        analyser,
        virtual: !!opened.virtual,
        stop() {
          stopped = true;
          if (inBurst) finishBurst();
          // Drain any queued snapshots off the audio thread
          while (decodeQueue.length) {
            const snap = decodeQueue.shift();
            try {
              emit(
                DA.Modem.decodePcm(snap, profile, sampleRate, {
                  maxBytes: options.maxBytes || 8192,
                })
              );
            } catch (_) {}
          }
          try {
            processor.disconnect();
            source.disconnect();
            mute.disconnect();
            analyser.disconnect();
          } catch (_) {}
          if (!opened.virtual) stream.getTracks().forEach((tr) => tr.stop());
        },
      };
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
