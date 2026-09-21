/* Decimen audio — device band profiles + auto-detect */
(function (g) {
  const DA = (g.DecimenAudio = g.DecimenAudio || {});

  DA.BAND_PROFILES = {
    laptop: {
      id: "laptop",
      label: "Laptop",
      fMin: 1800,
      fMax: 5500,
      carriers: 12,
      symbolMs: 28,
      bitsPerCarrier: 1,
    },
    phone: {
      id: "phone",
      label: "Phone",
      fMin: 2000,
      fMax: 7500,
      carriers: 16,
      symbolMs: 22,
      bitsPerCarrier: 1,
    },
  };

  function uaLooksPhone() {
    const ua = navigator.userAgent || "";
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
    if (navigator.userAgentData && Array.isArray(navigator.userAgentData.mobile)) {
      /* unused */
    }
    if (navigator.userAgentData && navigator.userAgentData.mobile) return true;
    if ((navigator.maxTouchPoints || 0) > 1 && Math.min(screen.width, screen.height) < 900) return true;
    return false;
  }

  DA.detectDeviceKind = function detectDeviceKind() {
    return uaLooksPhone() ? "phone" : "laptop";
  };

  DA.resolveBandProfile = function resolveBandProfile(override) {
    if (override && DA.BAND_PROFILES[override]) return DA.BAND_PROFILES[override];
    const kind = DA.detectDeviceKind();
    return DA.BAND_PROFILES[kind];
  };

  /** Build evenly spaced carrier frequencies for a profile. */
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
    return (auto ? "Auto: " : "") + profile.label + " · " + profile.fMin + "–" + profile.fMax + " Hz";
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
