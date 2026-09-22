/* Decimen audio — same-origin TX→RX PCM bus (BroadcastChannel) + optional speakers */
(function (g) {
  const DA = (g.DecimenAudio = g.DecimenAudio || {});
  const BUS = "decimen-pcm-v1";

  DA.AudioBus = {
    enabled: true,
    _bc: null,
    _handlers: [],

    _channel() {
      if (typeof BroadcastChannel === "undefined") return null;
      if (!this._bc) {
        this._bc = new BroadcastChannel(BUS);
        this._bc.onmessage = (ev) => {
          const msg = ev && ev.data;
          if (!msg || msg.t !== "pcm") return;
          this._handlers.forEach((fn) => {
            try {
              fn(msg);
            } catch (err) {
              console.warn("AudioBus handler", err);
            }
          });
        };
      }
      return this._bc;
    },

    publishPcm(pcm, sampleRate, profileId) {
      if (!this.enabled) return;
      const ch = this._channel();
      if (!ch) return;
      // Copy to transferable-friendly plain array for structured clone
      const copy = Float32Array.from(pcm);
      ch.postMessage({ t: "pcm", sampleRate: sampleRate, profileId: profileId || "slow", pcm: copy });
    },

    subscribe(fn) {
      this._handlers.push(fn);
      this._channel();
      return () => {
        this._handlers = this._handlers.filter((x) => x !== fn);
      };
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
