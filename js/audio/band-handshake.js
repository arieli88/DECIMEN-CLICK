/* Short acoustic band probe — pick laptop vs phone by mic energy on edge tones */
(function (g) {
  const DA = (g.DecimenAudio = g.DecimenAudio || {});

  function tonePcm(freq, sampleRate, seconds, amp) {
    const n = Math.floor(seconds * sampleRate);
    const pcm = new Float32Array(n);
    const fade = Math.min(128, Math.floor(n / 8));
    const w = (2 * Math.PI * freq) / sampleRate;
    for (let i = 0; i < n; i++) {
      let env = 1;
      if (i < fade) env = i / fade;
      else if (i > n - fade) env = (n - i) / fade;
      pcm[i] = Math.sin(w * i) * amp * env;
    }
    return pcm;
  }

  function goertzelEnergy(buf, freq, sampleRate) {
    const w = (2 * Math.PI * freq) / sampleRate;
    const coeff = 2 * Math.cos(w);
    let s0 = 0,
      s1 = 0,
      s2 = 0;
    for (let i = 0; i < buf.length; i++) {
      s0 = buf[i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
  }

  /**
   * Measure which profile's frequency edges the local speaker+mic reproduce better.
   * Requires mic permission. On failure → UA-based profile.
   */
  DA.probeBandProfile = async function probeBandProfile() {
    const fallback = DA.resolveBandProfile(null);
    try {
      const ctx = await DA.AudioIO.ensureContext();
      const sampleRate = ctx.sampleRate;
      const results = {};

      for (const id of ["laptop", "phone"]) {
        const profile = DA.BAND_PROFILES[id];
        const lo = profile.fMin;
        const hi = profile.fMax;
        const capturePromise = DA.AudioIO.captureSeconds(0.55);
        // slight delay so capture is rolling
        await new Promise((r) => setTimeout(r, 40));
        await DA.AudioIO.playPcm(tonePcm(lo, sampleRate, 0.15, 0.35), sampleRate);
        await DA.AudioIO.playPcm(tonePcm(hi, sampleRate, 0.15, 0.35), sampleRate);
        const { pcm } = await capturePromise;
        const e = goertzelEnergy(pcm, lo, sampleRate) + goertzelEnergy(pcm, hi, sampleRate);
        results[id] = e;
      }

      const pick = results.phone > results.laptop * 1.15 ? "phone" : "laptop";
      return DA.BAND_PROFILES[pick];
    } catch (_) {
      return fallback;
    }
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
