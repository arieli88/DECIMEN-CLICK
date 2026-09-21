/* Decimen audio — band profiles: enough parallel bits, wide Hz gaps */
(function (g) {
  const DA = (g.DecimenAudio = g.DecimenAudio || {});

  // 12 carriers = 6 bit/symbol. Keep Hz step ≥ ~400 Hz for Goertzel.
  DA.BAND_PROFILES = {
    laptop: {
      id: "laptop",
      label: "Laptop",
      fMin: 1500,
      fMax: 6000,
      carriers: 12,
      symbolMs: 36,
      bitsPerCarrier: 1,
    },
    phone: {
      id: "phone",
      label: "Phone",
      fMin: 1700,
      fMax: 7200,
      carriers: 12,
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
    return DA.BAND_PROFILES[DA.detectDeviceKind()];
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
    return (auto ? "Auto: " : "") + profile.label + " · " + profile.fMin + "–" + profile.fMax + " Hz";
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
