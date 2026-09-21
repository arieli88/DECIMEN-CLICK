/* Decimen audio — band profiles tuned for phone mic/speaker (slow + mid-band) */
(function (g) {
  const DA = (g.DecimenAudio = g.DecimenAudio || {});

  // Shared acoustic profile: both laptop and phone MUST use the same for SOUNDONLY.
  // Fewer carriers, lower fMax (phone mics roll off above ~5 kHz), longer symbols.
  DA.BAND_PROFILES = {
    shared: {
      id: "shared",
      label: "Shared (phone-safe)",
      fMin: 1400,
      fMax: 4800,
      carriers: 8, // 4 bit/symbol — slower but robust
      symbolMs: 56,
      bitsPerCarrier: 1,
    },
    laptop: {
      id: "laptop",
      label: "Laptop",
      fMin: 1400,
      fMax: 4800,
      carriers: 8,
      symbolMs: 52,
      bitsPerCarrier: 1,
    },
    phone: {
      id: "phone",
      label: "Phone",
      fMin: 1400,
      fMax: 4800,
      carriers: 8,
      symbolMs: 60,
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

  /**
   * For SOUNDONLY always prefer shared profile so TX/RX match across devices.
   * Override still honored when user picks laptop/phone explicitly.
   */
  DA.resolveBandProfile = function resolveBandProfile(override, opts) {
    opts = opts || {};
    if (override && DA.BAND_PROFILES[override]) return DA.BAND_PROFILES[override];
    if (opts.mode === "SOUNDONLY" || opts.preferShared) return DA.BAND_PROFILES.shared;
    return DA.BAND_PROFILES.shared; // default: shared (was device-split; mismatched bands broke phones)
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
    return (auto ? "Auto: " : "") + profile.label + " · " + profile.fMin + "–" + profile.fMax + " Hz · " + profile.symbolMs + "ms";
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
