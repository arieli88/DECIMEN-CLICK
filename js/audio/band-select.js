/* Decimen audio — band profiles: balanced speed vs phone reliability */
(function (g) {
  const DA = (g.DecimenAudio = g.DecimenAudio || {});

  // Default "balanced": shorter symbols so frames finish (~3–5s) and phones can decode.
  // "slow" kept for noisy rooms. TX+RX must use the same id (META carries it).
  DA.BAND_PROFILES = {
    balanced: {
      id: "balanced",
      label: "Balanced",
      fMin: 1500,
      fMax: 5400,
      carriers: 12,
      symbolMs: 28,
      bitsPerCarrier: 1,
    },
    shared: {
      id: "shared",
      label: "Shared",
      fMin: 1500,
      fMax: 5200,
      carriers: 10,
      symbolMs: 32,
      bitsPerCarrier: 1,
    },
    slow: {
      id: "slow",
      label: "Extra slow",
      fMin: 1400,
      fMax: 4600,
      carriers: 8,
      symbolMs: 48,
      bitsPerCarrier: 1,
    },
    laptop: {
      id: "laptop",
      label: "Laptop",
      fMin: 1500,
      fMax: 5400,
      carriers: 12,
      symbolMs: 28,
      bitsPerCarrier: 1,
    },
    phone: {
      id: "phone",
      label: "Phone",
      fMin: 1500,
      fMax: 5200,
      carriers: 10,
      symbolMs: 32,
      bitsPerCarrier: 1,
    },
  };

  function uaLooksPhone() {
    const ua = navigator.userAgent || "";
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
    if (navigator.userAgentData && navigator.userAgentData.mobile) return true;
    if ((navigator.maxTouchPoints || 0) > 1 && Math.min(screen.width, screen.height) < 900) return true;
    return false;
  }

  DA.detectDeviceKind = function detectDeviceKind() {
    return uaLooksPhone() ? "phone" : "laptop";
  };

  DA.resolveBandProfile = function resolveBandProfile(override) {
    if (override && DA.BAND_PROFILES[override]) return DA.BAND_PROFILES[override];
    // Same default on every device so META is not required for first frames
    return DA.BAND_PROFILES.balanced;
  };

  DA.carrierFreqs = function carrierFreqs(profile) {
    const n = profile.carriers;
    const freqs = new Float64Array(n);
    if (n === 1) {
      freqs[0] = (profile.fMin + profile.fMax) / 2;
      return freqs;
    }
    const step = (profile.fMax - profile.fMin) / (n - 1);
    for (let i = 0; i < n; i++) freqs[i] = profile.fMin + step * i;
    return freqs;
  };

  DA.bandLabel = function bandLabel(profile, auto) {
    return (
      (auto ? "Auto: " : "") +
      profile.label +
      " · " +
      profile.fMin +
      "–" +
      profile.fMax +
      " Hz · " +
      profile.symbolMs +
      "ms"
    );
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
