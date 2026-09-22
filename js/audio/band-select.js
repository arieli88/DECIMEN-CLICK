/* Decimen audio — band profiles tuned for phone mic/speaker (slow + mid-band) */
(function (g) {
  const DA = (g.DecimenAudio = g.DecimenAudio || {});

  // Shared acoustic profile: TX and RX must match. Slow symbols, mid-band only.
  DA.BAND_PROFILES = {
    shared: {
      id: "shared",
      label: "Slow shared",
      fMin: 1400,
      fMax: 4600,
      carriers: 8,
      symbolMs: 52,
      bitsPerCarrier: 1,
    },
    slow: {
      id: "slow",
      label: "Extra slow",
      fMin: 1400,
      fMax: 4200,
      carriers: 8,
      symbolMs: 68,
      bitsPerCarrier: 1,
    },
    laptop: {
      id: "laptop",
      label: "Laptop (=shared)",
      fMin: 1400,
      fMax: 4600,
      carriers: 8,
      symbolMs: 52,
      bitsPerCarrier: 1,
    },
    phone: {
      id: "phone",
      label: "Phone (=slow)",
      fMin: 1400,
      fMax: 4200,
      carriers: 8,
      symbolMs: 68,
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

  DA.resolveBandProfile = function resolveBandProfile(override, opts) {
    opts = opts || {};
    if (override && DA.BAND_PROFILES[override]) return DA.BAND_PROFILES[override];
    // SOUNDONLY must use the SAME profile on every device (META retune is best-effort).
    // Default: extra-slow for reliability over phone speakers/mics.
    return DA.BAND_PROFILES.slow;
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
      "ms/sym"
    );
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
