/* Decimen audio — transfer session engine (blocks + modes) */
(function (g) {
  const DA = (g.DecimenAudio = g.DecimenAudio || {});

  const DEFAULT_BLOCK = 48; // small acoustic payload per frame for reliability

  DA.TransferEngine = {
    createSession(containerBytes, options) {
      options = options || {};
      const blockLen = options.blockLen || DEFAULT_BLOCK;
      const split = DA.splitBlocks(containerBytes, blockLen);
      const sessionId = (options.sessionId != null ? options.sessionId : (Math.random() * 0xffff) | 1) & 0xffff;
      const mode = options.mode || "SOUNDONLY";
      let priority = null; // missing list from NACK

      // Channel assignment for COMBINE: even → sound, odd → camera (or by range)
      function channelFor(i) {
        if (mode === "SOUNDONLY") return "sound";
        if (mode === "CAMERAONLY" || mode === "CAM_SOUND_FB") return "camera";
        if (mode === "COMBINE") return i % 2 === 0 ? "sound" : "camera";
        return "sound";
      }

      return {
        sessionId,
        mode,
        k: split.k,
        blockLen: split.blockLen,
        totalLen: split.totalLen,
        blocks: split.blocks,
        received: new Array(split.k).fill(null),
        profile: options.profile || DA.resolveBandProfile(options.bandOverride),
        bandOverride: options.bandOverride || "auto",

        setPriority(indices) {
          priority = indices && indices.length ? indices.slice() : null;
        },

        getPriority() {
          return priority;
        },

        missing() {
          const m = [];
          for (let i = 0; i < this.k; i++) if (!this.received[i]) m.push(i);
          return m;
        },

        solvedCount() {
          let n = 0;
          for (let i = 0; i < this.k; i++) if (this.received[i]) n++;
          return n;
        },

        acceptBlock(seq, payload) {
          if (seq < 0 || seq >= this.k) return false;
          if (this.received[seq]) return false;
          const buf = new Uint8Array(this.blockLen);
          buf.set(payload.subarray(0, Math.min(payload.length, this.blockLen)));
          this.received[seq] = buf;
          if (priority) {
            priority = priority.filter((x) => x !== seq);
            if (!priority.length) priority = null;
          }
          return true;
        },

        assemble() {
          if (this.solvedCount() < this.k) return null;
          const out = new Uint8Array(this.totalLen);
          for (let i = 0; i < this.k; i++) {
            const start = i * this.blockLen;
            const take = Math.min(this.blockLen, this.totalLen - start);
            out.set(this.received[i].subarray(0, take), start);
          }
          return out;
        },

        nextTxIndex(channel) {
          const prefer = priority;
          if (prefer && prefer.length) {
            for (const idx of prefer) {
              if (channelFor(idx) === channel || mode === "SOUNDONLY" || mode === "CAM_SOUND_FB") return idx;
            }
          }
          // round-robin unsent preference then all
          for (let pass = 0; pass < 2; pass++) {
            for (let i = 0; i < this.k; i++) {
              if (channelFor(i) !== channel && mode === "COMBINE") continue;
              if (pass === 0 && received[i]) continue; // sender doesn't know received — ignore on TX
              return i;
            }
          }
          return 0;
        },

        /** Sender-side: iterate block indices for a channel, respecting NACK priority. */
        makeTxIterator(channel) {
          let cursor = 0;
          const self = this;
          return {
            next() {
              if (priority && priority.length) {
                const idx = priority[cursor % priority.length];
                cursor++;
                return idx;
              }
              const indices = [];
              for (let i = 0; i < self.k; i++) {
                if (mode === "COMBINE" && channelFor(i) !== channel) continue;
                if (mode === "CAM_SOUND_FB" && channel === "sound") continue; // sound only for NACK replies as data? data stays camera
                indices.push(i);
              }
              if (mode === "CAM_SOUND_FB" && channel === "camera") {
                for (let i = 0; i < self.k; i++) indices.push(i);
              }
              if (mode === "SOUNDONLY") {
                for (let i = 0; i < self.k; i++) indices.push(i);
              }
              if (!indices.length) {
                for (let i = 0; i < self.k; i++) indices.push(i);
              }
              const idx = indices[cursor % indices.length];
              cursor++;
              return idx;
            },
          };
        },

        packDataFrame(seq) {
          return DA.packFrame({
            kind: DA.FRAME_DATA,
            sessionId: this.sessionId,
            seq,
            k: this.k,
            blockLen: this.blockLen,
            totalLen: this.totalLen,
            payload: this.blocks[seq],
          });
        },

        packMetaFrame(extra) {
          const name = extra && extra.name ? new TextEncoder().encode(extra.name) : new Uint8Array(0);
          const bandId = (extra && extra.bandId) || (this.profile && this.profile.id) || "laptop";
          const bandBytes = new TextEncoder().encode(bandId);
          const payload = new Uint8Array(2 + bandBytes.length + 1 + name.length);
          payload[0] = bandBytes.length;
          payload.set(bandBytes, 1);
          payload[1 + bandBytes.length] = name.length;
          payload.set(name, 2 + bandBytes.length);
          return DA.packFrame({
            kind: DA.FRAME_META,
            sessionId: this.sessionId,
            seq: 0,
            k: this.k,
            blockLen: this.blockLen,
            totalLen: this.totalLen,
            payload,
          });
        },

        packNackFrame(missing) {
          const payload = DA.encodeNackPayload(missing, this.k);
          return DA.packFrame({
            kind: DA.FRAME_NACK,
            sessionId: this.sessionId,
            seq: 0,
            k: this.k,
            blockLen: this.blockLen,
            totalLen: this.totalLen,
            payload,
          });
        },

        channelFor,
      };
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
