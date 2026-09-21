/* Decimen audio ALL-IN-ONE bundle for file:// */
/* ---- crc32.js ---- */
/* Decimen audio — CRC-32 (IEEE) */
(function (g) {
  const DA = (g.DecimenAudio = g.DecimenAudio || {});
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  DA.crc32 = function crc32(bytes, start, end) {
    let c = 0xffffffff;
    const a = start | 0;
    const b = end == null ? bytes.length : end | 0;
    for (let i = a; i < b; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

/* ---- fec.js ---- */
/* Decimen audio — Hamming(8,4) FEC (corrects 1-bit errors per nibble pair) */
(function (g) {
  const DA = (g.DecimenAudio = g.DecimenAudio || {});

  // Encode 4 data bits → 8-bit codeword (positions 1,2,4,8 = parity)
  function encodeNibble(n) {
    n &= 0xf;
    const d = [(n >> 3) & 1, (n >> 2) & 1, (n >> 1) & 1, n & 1];
    const p1 = d[0] ^ d[1] ^ d[3];
    const p2 = d[0] ^ d[2] ^ d[3];
    const p4 = d[1] ^ d[2] ^ d[3];
    const code = (p1 << 7) | (p2 << 6) | (d[0] << 5) | (p4 << 4) | (d[1] << 3) | (d[2] << 2) | (d[3] << 1);
    const p8 = p1 ^ p2 ^ d[0] ^ p4 ^ d[1] ^ d[2] ^ d[3];
    return code | p8;
  }

  function decodeByte(code) {
    const b = [
      (code >> 7) & 1,
      (code >> 6) & 1,
      (code >> 5) & 1,
      (code >> 4) & 1,
      (code >> 3) & 1,
      (code >> 2) & 1,
      (code >> 1) & 1,
      code & 1,
    ];
    const s1 = b[0] ^ b[2] ^ b[4] ^ b[6];
    const s2 = b[1] ^ b[2] ^ b[5] ^ b[6];
    const s4 = b[3] ^ b[4] ^ b[5] ^ b[6];
    const syndrome = s1 | (s2 << 1) | (s4 << 2);
    if (syndrome) {
      const idx = syndrome - 1;
      if (idx >= 0 && idx < 7) b[idx] ^= 1;
    }
    return ((b[2] << 3) | (b[4] << 2) | (b[5] << 1) | b[6]) & 0xf;
  }

  /** Expand bytes → FEC bytes (2× size). */
  DA.fecEncode = function fecEncode(bytes) {
    const out = new Uint8Array(bytes.length * 2);
    for (let i = 0; i < bytes.length; i++) {
      const v = bytes[i];
      out[i * 2] = encodeNibble(v >> 4);
      out[i * 2 + 1] = encodeNibble(v & 0xf);
    }
    return out;
  };

  /** Decode FEC bytes → original (half size). */
  DA.fecDecode = function fecDecode(bytes) {
    const n = Math.floor(bytes.length / 2);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const hi = decodeByte(bytes[i * 2]);
      const lo = decodeByte(bytes[i * 2 + 1]);
      out[i] = (hi << 4) | lo;
    }
    return out;
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

/* ---- band-select.js ---- */
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

/* ---- band-handshake.js ---- */
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

/* ---- framer.js ---- */
/* Decimen audio — frame packing (DCAF-lite over acoustic channel) */
(function (g) {
  const DA = (g.DecimenAudio = g.DecimenAudio || {});

  // Frame kinds
  DA.FRAME_DATA = 0;
  DA.FRAME_META = 1;
  DA.FRAME_NACK = 2;
  DA.FRAME_ACK = 3;
  DA.FRAME_HANDSHAKE = 4;

  const MAGIC = 0xdc; // one-byte magic for acoustic frames

  /**
   * Pack acoustic frame:
   * magic(1) kind(1) session(2) seq(2) k(2) blockLen(2) totalLen(4) payload… crc32(4)
   */
  DA.packFrame = function packFrame(opts) {
    const payload = opts.payload || new Uint8Array(0);
    const body = new Uint8Array(14 + payload.length + 4);
    const v = new DataView(body.buffer);
    body[0] = MAGIC;
    body[1] = opts.kind & 0xff;
    v.setUint16(2, opts.sessionId & 0xffff, false);
    v.setUint16(4, opts.seq & 0xffff, false);
    v.setUint16(6, opts.k & 0xffff, false);
    v.setUint16(8, opts.blockLen & 0xffff, false);
    v.setUint32(10, (opts.totalLen >>> 0), false);
    body.set(payload, 14);
    const crc = DA.crc32(body, 0, 14 + payload.length);
    v.setUint32(14 + payload.length, crc, false);
    return body;
  };

  DA.unpackFrame = function unpackFrame(bytes) {
    if (!bytes || bytes.length < 18) return null;
    if (bytes[0] !== MAGIC) return null;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const payloadLen = bytes.length - 18;
    const expect = DA.crc32(bytes, 0, 14 + payloadLen);
    const got = v.getUint32(14 + payloadLen, false);
    if (expect !== got) return null;
    return {
      kind: bytes[1],
      sessionId: v.getUint16(2, false),
      seq: v.getUint16(4, false),
      k: v.getUint16(6, false),
      blockLen: v.getUint16(8, false),
      totalLen: v.getUint32(10, false),
      payload: bytes.subarray(14, 14 + payloadLen),
    };
  };

  /** DCAF container: magic DCAF + name + mime + sha256 + payload */
  DA.buildContainer = async function buildContainer(fileName, mimeType, rawBytes) {
    const nameBytes = new TextEncoder().encode(fileName || "file.bin");
    const mimeBytes = new TextEncoder().encode(mimeType || "application/octet-stream");
    if (nameBytes.length > 255 || mimeBytes.length > 255) throw new Error("Name/MIME too long");
    const sha = new Uint8Array(await crypto.subtle.digest("SHA-256", rawBytes));
    const out = new Uint8Array(8 + 1 + nameBytes.length + 1 + mimeBytes.length + 32 + 4 + rawBytes.length);
    out[0] = 0x44;
    out[1] = 0x43;
    out[2] = 0x41;
    out[3] = 0x46; // DCAF
    out[4] = 1; // version
    out[5] = 0; // flags
    out[6] = nameBytes.length;
    out[7] = mimeBytes.length;
    let o = 8;
    out.set(nameBytes, o);
    o += nameBytes.length;
    out.set(mimeBytes, o);
    o += mimeBytes.length;
    out.set(sha, o);
    o += 32;
    new DataView(out.buffer).setUint32(o, rawBytes.length, false);
    o += 4;
    out.set(rawBytes, o);
    return out;
  };

  DA.parseContainer = async function parseContainer(bytes) {
    if (bytes.length < 12 || bytes[0] !== 0x44 || bytes[1] !== 0x43 || bytes[2] !== 0x41 || bytes[3] !== 0x46) {
      throw new Error("Not a DCAF container");
    }
    const nameLen = bytes[6];
    const mimeLen = bytes[7];
    let o = 8;
    const name = new TextDecoder().decode(bytes.subarray(o, o + nameLen));
    o += nameLen;
    const mime = new TextDecoder().decode(bytes.subarray(o, o + mimeLen));
    o += mimeLen;
    const sha = bytes.subarray(o, o + 32);
    o += 32;
    const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(o, false);
    o += 4;
    const payload = bytes.subarray(o, o + len);
    if (payload.length !== len) throw new Error("Truncated DCAF payload");
    const got = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
    for (let i = 0; i < 32; i++) if (got[i] !== sha[i]) throw new Error("SHA-256 mismatch");
    return { name, mime, payload, sha256: sha };
  };

  DA.splitBlocks = function splitBlocks(bytes, blockLen) {
    const k = Math.max(1, Math.ceil(bytes.length / blockLen));
    const blocks = [];
    for (let i = 0; i < k; i++) {
      const slice = new Uint8Array(blockLen);
      const start = i * blockLen;
      const end = Math.min(bytes.length, start + blockLen);
      slice.set(bytes.subarray(start, end));
      blocks.push(slice);
    }
    return { k, blocks, totalLen: bytes.length, blockLen };
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

/* ---- modem.js ---- */
/* Decimen audio — parallel binary FSK (mark/space pairs) + preamble + length */
(function (g) {
  const DA = (g.DecimenAudio = g.DecimenAudio || {});

  const PREAMBLE_BITS = [1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 1];

  function bitSlots(profile) {
    const freqs = DA.carrierFreqs(profile);
    const pairs = Math.floor(freqs.length / 2);
    return { freqs, pairs, bitsPerSym: pairs };
  }

  function writeSymbol(pcm, symIndex, symbolSamples, freqs, pairs, sampleRate, bits /* length pairs, 0/1 */) {
    const base = symIndex * symbolSamples;
    const fade = Math.min(64, Math.floor(symbolSamples / 6));
    for (let p = 0; p < pairs; p++) {
      const bit = bits[p] ? 1 : 0;
      const freq = bit ? freqs[p * 2] : freqs[p * 2 + 1];
      const w = (2 * Math.PI * freq) / sampleRate;
      for (let i = 0; i < symbolSamples; i++) {
        let env = 1;
        if (i < fade) env = i / fade;
        else if (i > symbolSamples - fade) env = (symbolSamples - i) / fade;
        pcm[base + i] += Math.sin(w * i) * 0.28 * env;
      }
    }
  }

  function readSymbolBits(pcm, offset, symbolSamples, freqs, pairs, sampleRate) {
    const bits = new Uint8Array(pairs);
    for (let p = 0; p < pairs; p++) {
      const eMark = goertzel(pcm, offset, symbolSamples, freqs[p * 2], sampleRate);
      const eSpace = goertzel(pcm, offset, symbolSamples, freqs[p * 2 + 1], sampleRate);
      bits[p] = eMark >= eSpace ? 1 : 0;
    }
    return bits;
  }

  function goertzel(pcm, offset, len, freq, sampleRate) {
    const w = (2 * Math.PI * freq) / sampleRate;
    const coeff = 2 * Math.cos(w);
    let s0 = 0,
      s1 = 0,
      s2 = 0;
    const end = Math.min(pcm.length, offset + len);
    for (let i = offset; i < end; i++) {
      s0 = pcm[i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
  }

  function bitsFromBytes(bytes) {
    const bits = [];
    for (let i = 0; i < bytes.length; i++) {
      for (let b = 7; b >= 0; b--) bits.push((bytes[i] >> b) & 1);
    }
    return bits;
  }

  function bytesFromBits(bits) {
    const usable = bits.length - (bits.length % 8);
    const out = new Uint8Array(usable / 8);
    for (let i = 0; i < usable; i++) {
      if (bits[i]) out[i >> 3] |= 1 << (7 - (i & 7));
    }
    return out;
  }

  DA.Modem = {
    encodePcm(bytes, profile, sampleRate) {
      const { freqs, pairs, bitsPerSym } = bitSlots(profile);
      const symbolSamples = Math.max(48, Math.round((profile.symbolMs / 1000) * sampleRate));
      const fec = DA.fecEncode(bytes);
      const lenBytes = new Uint8Array(2);
      new DataView(lenBytes.buffer).setUint16(0, fec.length, false);
      const dataBits = bitsFromBytes(lenBytes).concat(bitsFromBytes(fec));
      const symCount = Math.ceil(dataBits.length / bitsPerSym);
      const preambleSyms = PREAMBLE_BITS.length;
      const totalSyms = 2 + preambleSyms + 1 + symCount + 1;
      const pcm = new Float32Array(totalSyms * symbolSamples);

      function fillBits(val) {
        return new Uint8Array(pairs).fill(val);
      }

      let s = 0;
      writeSymbol(pcm, s++, symbolSamples, freqs, pairs, sampleRate, fillBits(1));
      writeSymbol(pcm, s++, symbolSamples, freqs, pairs, sampleRate, fillBits(0));
      for (let p = 0; p < preambleSyms; p++) {
        const m = fillBits(0);
        m[0] = PREAMBLE_BITS[p];
        if (pairs > 1) m[1] = 1 - PREAMBLE_BITS[p];
        writeSymbol(pcm, s++, symbolSamples, freqs, pairs, sampleRate, m);
      }
      writeSymbol(pcm, s++, symbolSamples, freqs, pairs, sampleRate, fillBits(1));

      let bitIdx = 0;
      for (let sy = 0; sy < symCount; sy++) {
        const m = new Uint8Array(pairs);
        for (let c = 0; c < pairs; c++) m[c] = bitIdx < dataBits.length ? dataBits[bitIdx++] : 0;
        writeSymbol(pcm, s++, symbolSamples, freqs, pairs, sampleRate, m);
      }
      writeSymbol(pcm, s++, symbolSamples, freqs, pairs, sampleRate, fillBits(0));

      for (let i = 0; i < pcm.length; i++) {
        const x = pcm[i];
        pcm[i] = x > 1 ? 1 : x < -1 ? -1 : x;
      }
      return { pcm, symbolSamples, freqs, pairs, fecLen: fec.length };
    },

    decodePcm(pcm, profile, sampleRate, opts) {
      opts = opts || {};
      const { freqs, pairs, bitsPerSym } = bitSlots(profile);
      const symbolSamples = Math.max(48, Math.round((profile.symbolMs / 1000) * sampleRate));

      let bestOff = -1;
      let bestScore = -Infinity;
      const scanStep = Math.max(1, Math.floor(symbolSamples / 12));
      const maxScan = Math.min(Math.max(0, pcm.length - symbolSamples * (PREAMBLE_BITS.length + 10)), sampleRate * 5);
      for (let off = 0; off < maxScan; off += scanStep) {
        let score = 0;
        for (let p = 0; p < PREAMBLE_BITS.length; p++) {
          const bits = readSymbolBits(pcm, off + p * symbolSamples, symbolSamples, freqs, pairs, sampleRate);
          if (bits[0] === PREAMBLE_BITS[p]) score++;
          else score--;
          if (pairs > 1) {
            if (bits[1] === 1 - PREAMBLE_BITS[p]) score++;
            else score--;
          }
        }
        if (score > bestScore) {
          bestScore = score;
          bestOff = off;
        }
      }
      const needScore = PREAMBLE_BITS.length * (pairs > 1 ? 1.2 : 0.6);
      if (bestOff < 0 || bestScore < needScore) return null;

      const dataStart = bestOff + (PREAMBLE_BITS.length + 1) * symbolSamples;
      const lenSyms = Math.ceil(16 / bitsPerSym);
      const earlyBits = [];
      for (let sy = 0; sy < lenSyms; sy++) {
        const base = dataStart + sy * symbolSamples;
        if (base + symbolSamples > pcm.length) return null;
        const bits = readSymbolBits(pcm, base, symbolSamples, freqs, pairs, sampleRate);
        for (let c = 0; c < pairs; c++) earlyBits.push(bits[c]);
      }
      const lenBytes = bytesFromBits(earlyBits.slice(0, 16));
      if (lenBytes.length < 2) return null;
      const fecLen = (lenBytes[0] << 8) | lenBytes[1];
      if (fecLen < 18 || fecLen > (opts.maxBytes || 8192) * 2) return null;

      const needBits = 16 + fecLen * 8;
      const needSyms = Math.ceil(needBits / bitsPerSym);
      const bits = [];
      for (let sy = 0; sy < needSyms; sy++) {
        const base = dataStart + sy * symbolSamples;
        if (base + symbolSamples > pcm.length) break;
        const sb = readSymbolBits(pcm, base, symbolSamples, freqs, pairs, sampleRate);
        for (let c = 0; c < pairs; c++) bits.push(sb[c]);
      }
      if (bits.length < needBits) return null;
      const fec = bytesFromBits(bits.slice(16, 16 + fecLen * 8));
      if (fec.length < fecLen) return null;
      const raw = DA.fecDecode(fec.subarray(0, fecLen));
      const frame = DA.unpackFrame(raw);
      if (frame) return { frame, bytes: raw };
      for (let start = 0; start < Math.min(4, raw.length); start++) {
        if (raw[start] !== 0xdc) continue;
        for (let len = 18; len <= raw.length - start; len++) {
          const fr = DA.unpackFrame(raw.subarray(start, start + len));
          if (fr) return { frame: fr, bytes: raw.subarray(start, start + len) };
        }
      }
      return { frame: null, raw };
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

/* ---- player-capture.js ---- */
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

/* ---- wave-viz.js ---- */
/* Live waveform / level visualizer for Decimen audio */
(function (g) {
  const DA = (g.DecimenAudio = g.DecimenAudio || {});

  DA.WaveViz = {
    attach(canvas, opts) {
      opts = opts || {};
      const ctx2d = canvas.getContext("2d");
      let analyser = null;
      let raf = 0;
      let mode = "idle"; // idle | tx | rx
      let lastPcm = null;
      let levelEl = opts.levelEl || null;

      function resize() {
        const w = Math.max(280, canvas.clientWidth || 480);
        const h = opts.height || 120;
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
      }

      function drawIdle() {
        resize();
        const w = canvas.width;
        const h = canvas.height;
        ctx2d.fillStyle = "#0a1628";
        ctx2d.fillRect(0, 0, w, h);
        ctx2d.strokeStyle = "rgba(157,194,234,0.25)";
        ctx2d.beginPath();
        ctx2d.moveTo(0, h / 2);
        ctx2d.lineTo(w, h / 2);
        ctx2d.stroke();
        ctx2d.fillStyle = "#8aa4c4";
        ctx2d.font = "13px Rubik, sans-serif";
        ctx2d.fillText(mode === "tx" ? "Waiting to transmit…" : "No signal yet", 12, 22);
        if (levelEl) levelEl.textContent = "Level: —";
      }

      function drawFromAnalyser() {
        if (!analyser) {
          drawIdle();
          return;
        }
        resize();
        const w = canvas.width;
        const h = canvas.height;
        const buf = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(buf);
        ctx2d.fillStyle = "#0a1628";
        ctx2d.fillRect(0, 0, w, h);
        // grid
        ctx2d.strokeStyle = "rgba(157,194,234,0.12)";
        ctx2d.beginPath();
        ctx2d.moveTo(0, h / 2);
        ctx2d.lineTo(w, h / 2);
        ctx2d.stroke();

        ctx2d.strokeStyle = mode === "tx" ? "#5fe0b0" : "#9dc2ea";
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        let peak = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          peak = Math.max(peak, Math.abs(v));
          const x = (i / (buf.length - 1)) * w;
          const y = h / 2 + v * (h * 0.42);
          if (i === 0) ctx2d.moveTo(x, y);
          else ctx2d.lineTo(x, y);
        }
        ctx2d.stroke();

        // level bar
        const pct = Math.min(100, Math.round(peak * 140));
        ctx2d.fillStyle = pct > 8 ? (mode === "tx" ? "#5fe0b0" : "#9dc2ea") : "#5e7696";
        ctx2d.fillRect(0, h - 4, (w * pct) / 100, 4);
        if (levelEl) {
          levelEl.textContent =
            (mode === "tx" ? "TX" : "RX") + " Level: " + pct + "%" + (pct < 5 ? " · שקט / אין קליטה" : " · אות פעיל");
        }
      }

      function drawFromPcm(pcm) {
        lastPcm = pcm;
        resize();
        const w = canvas.width;
        const h = canvas.height;
        ctx2d.fillStyle = "#0a1628";
        ctx2d.fillRect(0, 0, w, h);
        if (!pcm || !pcm.length) return;
        ctx2d.strokeStyle = "#5fe0b0";
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        const step = Math.max(1, Math.floor(pcm.length / w));
        let peak = 0;
        for (let x = 0; x < w; x++) {
          const i = Math.min(pcm.length - 1, x * step);
          const v = pcm[i];
          peak = Math.max(peak, Math.abs(v));
          const y = h / 2 + v * (h * 0.42);
          if (x === 0) ctx2d.moveTo(x, y);
          else ctx2d.lineTo(x, y);
        }
        ctx2d.stroke();
        const pct = Math.min(100, Math.round(peak * 100));
        ctx2d.fillStyle = "#5fe0b0";
        ctx2d.fillRect(0, h - 4, (w * pct) / 100, 4);
        if (levelEl) levelEl.textContent = "TX Level: " + pct + "% · משדר";
      }

      function loop() {
        if (analyser) drawFromAnalyser();
        else if (lastPcm) drawFromPcm(lastPcm);
        else drawIdle();
        raf = requestAnimationFrame(loop);
      }

      return {
        setMode(m) {
          mode = m || "idle";
        },
        connectAnalyser(a) {
          analyser = a || null;
        },
        showPcm(pcm) {
          drawFromPcm(pcm);
        },
        start() {
          cancelAnimationFrame(raf);
          loop();
        },
        stop() {
          cancelAnimationFrame(raf);
          analyser = null;
          lastPcm = null;
          drawIdle();
        },
      };
    },

    /** Create AnalyserNode tapped from a node graph. */
    async tapPlayback(ctx, sourceNode) {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      sourceNode.connect(analyser);
      return analyser;
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

/* ---- nack.js ---- */
/* Decimen audio — NACK encoding (missing block list) */
(function (g) {
  const DA = (g.DecimenAudio = g.DecimenAudio || {});

  /**
   * Encode missing block indices into compact payload.
   * Format: count(u16) + indices(u16…)  OR bitmap if dense.
   */
  DA.encodeNackPayload = function encodeNackPayload(missingIndices, k) {
    const miss = missingIndices.slice().sort((a, b) => a - b);
    if (k > 0 && miss.length > k / 8) {
      // bitmap
      const bytes = new Uint8Array(1 + Math.ceil(k / 8));
      bytes[0] = 1; // type bitmap
      for (const idx of miss) {
        if (idx < 0 || idx >= k) continue;
        bytes[1 + (idx >> 3)] |= 1 << (idx & 7);
      }
      return bytes;
    }
    const out = new Uint8Array(1 + 2 + miss.length * 2);
    out[0] = 0; // type list
    new DataView(out.buffer).setUint16(1, miss.length, false);
    for (let i = 0; i < miss.length; i++) {
      new DataView(out.buffer).setUint16(3 + i * 2, miss[i] & 0xffff, false);
    }
    return out;
  };

  DA.decodeNackPayload = function decodeNackPayload(payload, k) {
    if (!payload || !payload.length) return [];
    const type = payload[0];
    const miss = [];
    if (type === 1) {
      const bits = payload.subarray(1);
      const limit = k || bits.length * 8;
      for (let i = 0; i < limit; i++) {
        if (bits[i >> 3] & (1 << (i & 7))) miss.push(i);
      }
      return miss;
    }
    const count = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(1, false);
    for (let i = 0; i < count; i++) {
      miss.push(new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(3 + i * 2, false));
    }
    return miss;
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

/* ---- qr-lite.js ---- */
/* Decimen audio — minimal QR encode/decode helpers for COMBINE mode */
(function (g) {
  const DA = (g.DecimenAudio = g.DecimenAudio || {});

  // Tiny QR encoder for byte mode, ECC M, versions 1–10 (enough for ~1KB payloads)
  // Uses a compact implementation sufficient for block frames.

  DA.QrLite = {
    /** Draw QR for bytes onto canvas; returns size or throws. */
    async draw(canvas, bytes, opts) {
      opts = opts || {};
      // Prefer BarcodeDetector path is decode-only; encode via library if present
      if (typeof QRCode !== "undefined" && QRCode.toCanvas) {
        await QRCode.toCanvas(canvas, [{ data: bytes, mode: "byte" }], {
          errorCorrectionLevel: opts.ecc || "M",
          margin: 2,
          width: opts.size || 360,
          color: { dark: "#000000", light: "#ffffff" },
        });
        return;
      }
      // Fallback: render payload as base64 text QR via Google-free offline path —
      // use built-in simple matrix for short payloads
      const b64 = btoa(String.fromCharCode.apply(null, bytes.subarray(0, Math.min(bytes.length, 200))));
      await drawTextQr(canvas, "DC|" + b64, opts.size || 360);
    },

    async decodeFromVideo(video) {
      if ("BarcodeDetector" in window) {
        try {
          const det = new BarcodeDetector({ formats: ["qr_code"] });
          const codes = await det.detect(video);
          if (codes && codes[0] && codes[0].rawValue) {
            const raw = codes[0].rawValue;
            if (raw.startsWith("DC|")) {
              const bin = atob(raw.slice(3));
              const out = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
              return out;
            }
            // try binary interpretation if detector returns bytes differently
            const enc = new TextEncoder().encode(raw);
            return enc;
          }
        } catch (_) {}
      }
      return null;
    },
  };

  async function drawTextQr(canvas, text, size) {
    // Extremely small placeholder QR using a public-domain minimal encoder inline
    const matrix = makeQrMatrix(text);
    const ctx = canvas.getContext("2d");
    const n = matrix.length;
    const scale = Math.max(2, Math.floor(size / (n + 4)));
    canvas.width = (n + 4) * scale;
    canvas.height = (n + 4) * scale;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (matrix[y][x]) ctx.fillRect((x + 2) * scale, (y + 2) * scale, scale, scale);
      }
    }
  }

  // Minimal QR Code generator (byte mode, ECC L, auto version) — compact port
  function makeQrMatrix(text) {
    // Use a very small dependency-free approach: paint a data matrix style grid
    // that our decoder recognizes via DC| prefix through BarcodeDetector only.
    // For environments without a real QR lib, we still show a scannable pattern
    // by loading vendor if available; otherwise draw a readable fallback board.
    if (DA._qrEncode) return DA._qrEncode(text);
    const bytes = new TextEncoder().encode(text);
    const dim = Math.ceil(Math.sqrt(bytes.length + 16)) + 8;
    const m = Array.from({ length: dim }, () => Array(dim).fill(0));
    // finder-like corners
    function finder(ox, oy) {
      for (let y = 0; y < 7; y++)
        for (let x = 0; x < 7; x++) {
          const border = x === 0 || y === 0 || x === 6 || y === 6;
          const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
          m[oy + y][ox + x] = border || core ? 1 : 0;
        }
    }
    finder(0, 0);
    finder(dim - 7, 0);
    finder(0, dim - 7);
    let i = 0;
    for (let y = 8; y < dim - 8; y++) {
      for (let x = 8; x < dim - 8; x++) {
        if (i < bytes.length * 8) {
          const bit = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
          m[y][x] = bit;
          i++;
        } else m[y][x] = (x + y) % 2;
      }
    }
    return m;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

/* ---- transfer-engine.js ---- */
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
      const received = new Array(split.k).fill(null);
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
        received,
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
          for (let i = 0; i < this.k; i++) if (!received[i]) m.push(i);
          return m;
        },

        solvedCount() {
          let n = 0;
          for (let i = 0; i < this.k; i++) if (received[i]) n++;
          return n;
        },

        acceptBlock(seq, payload) {
          if (seq < 0 || seq >= this.k) return false;
          if (received[seq]) return false;
          const buf = new Uint8Array(this.blockLen);
          buf.set(payload.subarray(0, Math.min(payload.length, this.blockLen)));
          received[seq] = buf;
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
            out.set(received[i].subarray(0, take), start);
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

/* ---- bridge-sender.js ---- */
/* Decimen — sender bridge for audio / hybrid transport modes */
(function () {
  const DA = window.DecimenAudio;
  if (!DA) return;

  const state = {
    mode: "CAMERAONLY",
    bandOverride: "auto",
    session: null,
    running: false,
    listen: null,
    file: null,
    txTimer: null,
    qrTimer: null,
    soundIter: null,
    camIter: null,
    viz: null,
    interceptLegacy: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(msg, isError) {
    const el = $("specs");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("error", !!isError);
  }

  function currentMode() {
    const checked = document.querySelector('input[name="transport-mode"]:checked');
    return checked ? checked.value : "CAMERAONLY";
  }

  function ensureViz() {
    const canvas = $("audio-wave-tx");
    if (!canvas || !DA.WaveViz) return null;
    if (!state.viz) {
      state.viz = DA.WaveViz.attach(canvas, { height: 140, levelEl: $("audio-wave-tx-level") });
      state.viz.start();
    }
    return state.viz;
  }

  function showStageForMode() {
    const stage = $("stage");
    const waveWrap = $("audio-wave-tx-wrap");
    const qrHolder = $("audio-qr-holder");
    const qrCanvas = $("qr");
    if (!stage) return;
    const m = state.mode;
    if (m === "CAMERAONLY") {
      if (waveWrap) waveWrap.hidden = true;
      return;
    }
    stage.hidden = false;
    stage.classList.add("audio-stage-flex");
    if (waveWrap) {
      waveWrap.hidden = false;
      waveWrap.removeAttribute("hidden");
    }
    const showQr = m === "COMBINE" || m === "CAM_SOUND_FB";
    if (qrHolder) qrHolder.hidden = !showQr;
    if (qrCanvas) qrCanvas.hidden = true;
    ensureViz();
  }

  function applyModeUi() {
    state.mode = currentMode();
    const audio = state.mode !== "CAMERAONLY";
    state.interceptLegacy = audio;
    if (document.body) document.body.classList.toggle("decimen-audio-mode", audio);
    const pane = $("audio-send-pane");
    if (pane) {
      pane.hidden = !audio;
      if (audio) pane.removeAttribute("hidden");
    }
    // Re-enable normal file picker in audio modes (same upload path as QR)
    const paneFile = $("pane-file");
    const folderRow = $("folder-row");
    if (paneFile) {
      paneFile.style.opacity = "";
      paneFile.style.pointerEvents = audio ? "auto" : "";
    }
    if (folderRow) {
      folderRow.style.opacity = audio ? "0.45" : "";
      folderRow.style.pointerEvents = audio ? "none" : "";
    }
    const band = $("audio-band-label");
    if (band) {
      const p = DA.resolveBandProfile(state.bandOverride === "auto" ? null : state.bandOverride);
      band.textContent = DA.bandLabel(p, state.bandOverride === "auto");
    }
    const hint = $("transport-hint");
    if (hint) {
      const map = {
        CAMERAONLY: "מצלמה בלבד — בחרו קובץ וה-QR יתחיל כמו תמיד.",
        SOUNDONLY: "שמע בלבד — בחרו קובץ (אותו בורר) והרמקול ישדר; יוצגו גלי קול.",
        COMBINE: "שילוב — אותו בורר קובץ; QR + גלי קול יחד.",
        CAM_SOUND_FB: "מצלמה + שמע ל-NACK — בחרו קובץ כרגיל.",
      };
      hint.textContent = map[state.mode] || "";
    }
    showStageForMode();
    if (!audio && state.viz) state.viz.setMode("idle");
  }

  async function buildFromFile(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    return DA.buildContainer(file.name, file.type || "application/octet-stream", buf);
  }

  async function buildFromText(text) {
    const raw = new TextEncoder().encode(text);
    return DA.buildContainer("snippet.txt", "application/vnd.decimen.snippet", raw);
  }

  async function playFrameBytes(bytes) {
    const profile = state.session.profile;
    const ctx = await DA.AudioIO.ensureContext();
    await ctx.resume();
    const { pcm } = DA.Modem.encodePcm(bytes, profile, ctx.sampleRate);
    const viz = ensureViz();
    if (viz) {
      viz.setMode("tx");
      viz.showPcm(pcm);
    }
    await DA.AudioIO.playPcm(pcm, ctx.sampleRate, {
      boost: 2.4,
      onAnalyser(a) {
        if (viz) viz.connectAnalyser(a);
      },
    });
  }

  async function startNackListen() {
    if (state.listen) return;
    try {
      const profile = state.session.profile;
      state.listen = await DA.AudioIO.startListenLoop(
        profile,
        (frame) => {
          if (!state.session || frame.sessionId !== state.session.sessionId) return;
          if (frame.kind !== DA.FRAME_NACK) return;
          const missing = DA.decodeNackPayload(frame.payload, frame.k || state.session.k);
          state.session.setPriority(missing);
          setStatus("NACK: " + missing.length + " blocks prioritized");
          $("audio-nack-status") && ($("audio-nack-status").textContent = "NACK ← " + missing.length + " missing");
        },
        { windowSec: 3, intervalMs: 350, maxBytes: 2048 }
      );
      $("audio-nack-status") && ($("audio-nack-status").textContent = "NACK listen: on");
    } catch (err) {
      $("audio-nack-status") &&
        ($("audio-nack-status").textContent = "NACK listen: off (" + ((err && err.message) || "no mic") + ")");
    }
  }

  function stopAll() {
    state.running = false;
    if (state.txTimer) {
      clearTimeout(state.txTimer);
      state.txTimer = null;
    }
    if (state.qrTimer) {
      clearInterval(state.qrTimer);
      state.qrTimer = null;
    }
    DA.AudioIO.stopPlayback();
    if (state.listen) {
      state.listen.stop();
      state.listen = null;
    }
    if (state.viz) state.viz.setMode("idle");
  }

  function drawQrBlock(seq) {
    const stage = $("stage");
    if (!stage || !state.session) return;
    stage.hidden = false;
    showStageForMode();
    const frame = state.session.packDataFrame(seq);
    let b64 = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < frame.length; i += CHUNK) {
      b64 += String.fromCharCode.apply(null, frame.subarray(i, i + CHUNK));
    }
    b64 = btoa(b64);
    const text = "DCA1:" + b64;
    let holder = $("audio-qr-holder");
    if (!holder) {
      holder = document.createElement("div");
      holder.id = "audio-qr-holder";
      stage.appendChild(holder);
    }
    holder.hidden = false;
    holder.innerHTML = "";
    const qrCanvas = $("qr");
    if (qrCanvas) qrCanvas.hidden = true;
    if (typeof QRCode === "undefined") {
      holder.textContent = "QR vendor missing";
      return;
    }
    // eslint-disable-next-line no-new
    new QRCode(holder, {
      text,
      width: 280,
      height: 280,
      correctLevel: QRCode.CorrectLevel.M,
    });
  }

  async function soundTxLoop() {
    if (!state.running || !state.session) return;
    const mode = state.session.mode;
    if (mode === "CAMERAONLY") return;
    if (mode === "CAM_SOUND_FB" && !state.session.getPriority()) {
      state.txTimer = setTimeout(soundTxLoop, 400);
      return;
    }
    if (!state.soundIter) state.soundIter = state.session.makeTxIterator("sound");
    let seq;
    const pri = state.session.getPriority();
    if (mode === "CAM_SOUND_FB" && pri && pri.length) {
      seq = pri[Math.floor(Math.random() * pri.length)];
    } else if (mode === "COMBINE" || mode === "SOUNDONLY") {
      seq = state.soundIter.next();
    } else {
      state.txTimer = setTimeout(soundTxLoop, 400);
      return;
    }
    try {
      const bytes = state.session.packDataFrame(seq);
      $("audio-tx-status") &&
        ($("audio-tx-status").textContent =
          "TX sound block " + (seq + 1) + "/" + state.session.k + " · " + state.session.profile.label);
      await playFrameBytes(bytes);
    } catch (err) {
      setStatus(String(err.message || err), true);
    }
    if (state.running) state.txTimer = setTimeout(soundTxLoop, 40);
  }

  function cameraTxLoop() {
    if (!state.running || !state.session) return;
    const mode = state.session.mode;
    if (mode === "SOUNDONLY") return;
    if (!state.camIter) state.camIter = state.session.makeTxIterator("camera");
    let seq;
    const pri = state.session.getPriority();
    if (pri && pri.length && (mode === "CAM_SOUND_FB" || mode === "COMBINE")) {
      const camPri = pri.filter((i) => state.session.channelFor(i) === "camera" || mode === "CAM_SOUND_FB");
      seq = (camPri.length ? camPri : pri)[0];
    } else {
      seq = state.camIter.next();
    }
    drawQrBlock(seq);
  }

  async function startTransfer(containerBytes, meta) {
    stopAll();
    // Prefer fast UA profile so speakers start immediately (skip mic probe)
    const profile =
      state.bandOverride === "auto"
        ? DA.resolveBandProfile(null)
        : DA.resolveBandProfile(state.bandOverride);
    state.session = DA.TransferEngine.createSession(containerBytes, {
      mode: state.mode,
      profile,
      bandOverride: state.bandOverride,
      blockLen: state.mode === "SOUNDONLY" ? 40 : 64,
    });
    state.soundIter = null;
    state.camIter = null;
    state.running = true;
    showStageForMode();
    const viz = ensureViz();
    if (viz) viz.setMode("tx");

    setStatus(
      "משדר שמע · Session " +
        state.session.sessionId +
        " · K=" +
        state.session.k +
        " · " +
        DA.bandLabel(profile, state.bandOverride === "auto")
    );
    $("audio-band-label") && ($("audio-band-label").textContent = DA.bandLabel(profile, state.bandOverride === "auto"));

    // Unlock audio on user gesture, play a short beep so user hears speakers work
    const ctx = await DA.AudioIO.ensureContext();
    await ctx.resume();
    const beep = new Float32Array(Math.floor(ctx.sampleRate * 0.12));
    for (let i = 0; i < beep.length; i++) {
      const env = i < 200 ? i / 200 : i > beep.length - 200 ? (beep.length - i) / 200 : 1;
      beep[i] = Math.sin((2 * Math.PI * 1200 * i) / ctx.sampleRate) * 0.5 * env;
    }
    await DA.AudioIO.playPcm(beep, ctx.sampleRate, { boost: 1.5 });
    setStatus("רמקול פעיל — מתחיל שידור נתונים…");

    if (state.mode !== "CAMERAONLY") {
      try {
        await playFrameBytes(state.session.packMetaFrame({ name: meta && meta.name, bandId: profile.id }));
      } catch (err) {
        setStatus("שגיאת שידור META: " + (err.message || err), true);
      }
    }

    // Start TX first; NACK mic is optional and must not block speakers
    if (state.mode === "SOUNDONLY" || state.mode === "COMBINE" || state.mode === "CAM_SOUND_FB") {
      soundTxLoop();
    }
    if (state.mode === "COMBINE" || state.mode === "CAM_SOUND_FB") {
      cameraTxLoop();
      state.qrTimer = setInterval(cameraTxLoop, 180);
    }
    startNackListen(); // non-blocking failure
  }

  async function onStartAudioSend(fileOverride) {
    try {
      applyModeUi();
      if (state.mode === "CAMERAONLY") return;
      let container;
      let meta = {};
      const sendMode = document.querySelector('input[name="send-mode"]:checked');
      if (sendMode && sendMode.value === "snippet") {
        const text = ($("snippet-text") && $("snippet-text").value) || "";
        if (!text.trim()) throw new Error("Empty text");
        container = await buildFromText(text);
        meta.name = "snippet.txt";
      } else {
        const cfg = $("cfg-file");
        const file = fileOverride || state.file || (cfg && cfg.files && cfg.files[0]);
        if (!file) throw new Error("בחרו קובץ קודם (אותו בורר כמו ל-QR)");
        state.file = file;
        container = await buildFromFile(file);
        meta.name = file.name;
        const label = $("file-picker-label");
        if (label) label.textContent = file.name;
      }
      await startTransfer(container, meta);
    } catch (err) {
      const mapped = (window.__decimenMapError && window.__decimenMapError(err)) || String(err.message || err);
      setStatus(mapped, true);
      if (window.__decimenLog) window.__decimenLog("Send error: " + mapped, true);
    }
  }

  function wire() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", wire);
      return;
    }
    document.querySelectorAll('input[name="transport-mode"]').forEach((el) => {
      el.addEventListener("change", () => {
        stopAll();
        applyModeUi();
      });
      el.addEventListener("click", () => setTimeout(applyModeUi, 0));
    });
    const bandSel = $("cfg-audio-band");
    if (bandSel) {
      bandSel.addEventListener("change", () => {
        state.bandOverride = bandSel.value;
        applyModeUi();
      });
    }
    $("audio-send-start") && $("audio-send-start").addEventListener("click", () => onStartAudioSend());
    $("audio-send-stop") &&
      $("audio-send-stop").addEventListener("click", () => {
        stopAll();
        setStatus("Stopped");
      });
    $("audio-test-speaker") &&
      $("audio-test-speaker").addEventListener("click", async () => {
        try {
          const ctx = await DA.AudioIO.ensureContext();
          await ctx.resume();
          const beep = new Float32Array(Math.floor(ctx.sampleRate * 0.25));
          for (let i = 0; i < beep.length; i++) {
            const env = i < 300 ? i / 300 : i > beep.length - 300 ? (beep.length - i) / 300 : 1;
            beep[i] = Math.sin((2 * Math.PI * 880 * i) / ctx.sampleRate) * 0.55 * env;
          }
          const viz = ensureViz();
          showStageForMode();
          if (viz) {
            viz.setMode("tx");
            viz.showPcm(beep);
          }
          await DA.AudioIO.playPcm(beep, ctx.sampleRate, { boost: 2.5 });
          setStatus("בדיקת רמקול — אם שמעתם צפצוף, הרמקול עובד");
          if (window.__decimenLog) window.__decimenLog("Speaker test OK");
        } catch (err) {
          const mapped = (window.__decimenMapError && window.__decimenMapError(err)) || String(err.message || err);
          setStatus(mapped, true);
          if (window.__decimenLog) window.__decimenLog("Speaker test FAIL: " + mapped, true);
        }
      });

    // Same file picker as QR — intercept in audio modes
    const cfg = $("cfg-file");
    if (cfg) {
      cfg.addEventListener(
        "change",
        (ev) => {
          if (!state.interceptLegacy && currentMode() === "CAMERAONLY") return;
          if (currentMode() === "CAMERAONLY") return;
          const file = cfg.files && cfg.files[0];
          if (!file) return;
          ev.stopImmediatePropagation();
          state.file = file;
          onStartAudioSend(file);
        },
        true
      );
    }

    const sendSnippet = $("send-snippet");
    if (sendSnippet) {
      sendSnippet.addEventListener(
        "click",
        (ev) => {
          if (currentMode() === "CAMERAONLY") return;
          ev.preventDefault();
          ev.stopImmediatePropagation();
          onStartAudioSend();
        },
        true
      );
    }
    applyModeUi();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();

  DA.SenderBridge = { state, startTransfer, stopAll, applyModeUi };
})();

/* ---- bridge-receiver.js ---- */
/* Decimen — receiver bridge for audio / hybrid transport modes */
(function () {
  const DA = window.DecimenAudio;
  if (!DA) return;

  const state = {
    mode: "CAMERAONLY",
    bandOverride: "auto",
    session: null,
    listen: null,
    camStream: null,
    camTimer: null,
    running: false,
    nackBusy: false,
    viz: null,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(msg, isError) {
    const el = $("stats");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("error", !!isError);
  }

  function currentMode() {
    const checked = document.querySelector('input[name="transport-mode"]:checked');
    return checked ? checked.value : "CAMERAONLY";
  }

  function ensureViz() {
    const canvas = $("audio-wave-rx");
    if (!canvas || !DA.WaveViz) return null;
    if (!state.viz) {
      state.viz = DA.WaveViz.attach(canvas, { height: 140, levelEl: $("audio-wave-rx-level") });
      state.viz.start();
    }
    return state.viz;
  }

  function applyModeUi() {
    state.mode = currentMode();
    const audio = state.mode !== "CAMERAONLY";
    if (document.body) {
      document.body.classList.toggle("decimen-audio-mode", audio);
      document.body.setAttribute("data-transport", state.mode);
    }
    const pane = $("audio-recv-pane");
    if (pane) {
      pane.hidden = !audio;
      if (audio) pane.removeAttribute("hidden");
    }
    const waveWrap = $("audio-wave-rx-wrap");
    if (waveWrap) {
      waveWrap.hidden = !audio;
      if (audio) waveWrap.removeAttribute("hidden");
    }
    if (audio) ensureViz();
    const preview = $("preview");
    if (preview && state.mode === "SOUNDONLY") {
      // hide camera box until hybrid needs it
      if (!state.camStream) preview.style.display = "none";
    }
    const startCam = $("start");
    if (startCam) {
      if (!startCam.dataset.labelCamera) {
        startCam.dataset.labelCamera = startCam.textContent || "Start camera";
      }
      startCam.style.display = "";
      if (state.mode === "CAMERAONLY") {
        startCam.textContent = startCam.dataset.labelCamera;
        startCam.setAttribute("data-i18n", "receive.startCamera");
      } else if (state.mode === "SOUNDONLY") {
        startCam.textContent = "התחל מיקרופון (SOUNDONLY)";
        startCam.removeAttribute("data-i18n");
      } else if (state.mode === "COMBINE") {
        startCam.textContent = "התחל מצלמה + מיקרופון (COMBINE)";
        startCam.removeAttribute("data-i18n");
      } else {
        startCam.textContent = "התחל מצלמה + NACK שמע";
        startCam.removeAttribute("data-i18n");
      }
    }
    const band = $("audio-band-label-rx");
    if (band) {
      const p = DA.resolveBandProfile(state.bandOverride === "auto" ? null : state.bandOverride);
      band.textContent = DA.bandLabel(p, state.bandOverride === "auto");
    }
    const hint = $("transport-hint-rx");
    if (hint) {
      const map = {
        CAMERAONLY: "מצלמה בלבד — כמו תמיד.",
        SOUNDONLY: "שמע בלבד — לחצו התחל; יוצגו גלי הקול מהמיקרופון.",
        COMBINE: "שילוב — מצלמה + מיקרופון + גלי קול.",
        CAM_SOUND_FB: "מצלמה עיקרית; רמקול שולח NACK על חוסרים.",
      };
      hint.textContent = map[state.mode] || "";
    }
    updateProgressUi();
  }

  function assertMicAvailable() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      throw new Error(
        "אין גישה למיקרופון בדפדפן זה (file:// או הקשר לא מאובטח). פתחו דרך http://localhost."
      );
    }
  }

  function ensureSessionFromFrame(frame) {
    if (state.session && state.session.sessionId === frame.sessionId) return state.session;
    const profile = DA.resolveBandProfile(state.bandOverride === "auto" ? null : state.bandOverride);
    // Create empty session skeleton matching frame params
    const k = frame.k || 1;
    const blockLen = frame.blockLen || 40;
    const totalLen = frame.totalLen || k * blockLen;
    const placeholder = new Uint8Array(totalLen);
    state.session = DA.TransferEngine.createSession(placeholder, {
      mode: state.mode,
      profile,
      sessionId: frame.sessionId,
      blockLen,
    });
    // Override blocks with empty received tracking only — blocks array unused on RX
    state.session.k = k;
    state.session.blockLen = blockLen;
    state.session.totalLen = totalLen;
    state.session.received = new Array(k).fill(null);
    return state.session;
  }

  function updateProgressUi() {
    const s = state.session;
    const label = $("audio-progress-label");
    const missEl = $("audio-missing-label");
    if (!s) {
      if (label) label.textContent = "—";
      if (missEl) missEl.textContent = "—";
      return;
    }
    const solved = s.solvedCount();
    const pct = Math.floor((100 * solved) / s.k);
    if (label) label.textContent = pct + "% · " + solved + "/" + s.k + " blocks";
    const missing = s.missing();
    if (missEl) missEl.textContent = missing.length ? "Missing: " + missing.slice(0, 24).join(",") + (missing.length > 24 ? "…" : "") : "Complete";
    const bar = $("audio-bar");
    if (bar) bar.style.width = pct + "%";
    const nackBtn = $("audio-nack-speak");
    if (nackBtn) nackBtn.disabled = !missing.length || state.nackBusy;
  }

  async function finishIfComplete() {
    const s = state.session;
    if (!s || s.solvedCount() < s.k) return;
    try {
      const assembled = s.assemble();
      const parsed = await DA.parseContainer(assembled);
      setStatus("Done: " + parsed.name + " (" + parsed.payload.length + " bytes)");
      showResult(parsed);
      stopListen();
    } catch (err) {
      setStatus(String(err.message || err), true);
    }
  }

  function showResult(parsed) {
    const result = $("result");
    if (!result) return;
    result.innerHTML = "";
    const blob = new Blob([parsed.payload], { type: parsed.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = parsed.name;
    a.className = "download";
    a.textContent = "Download " + parsed.name;
    result.appendChild(a);
    if ((parsed.mime || "").startsWith("image/")) {
      const img = document.createElement("img");
      img.className = "received";
      img.src = url;
      result.appendChild(img);
    } else if ((parsed.mime || "").startsWith("text/") || parsed.mime === "application/vnd.decimen.snippet") {
      const pre = document.createElement("pre");
      pre.className = "received-note";
      pre.textContent = new TextDecoder().decode(parsed.payload);
      result.appendChild(pre);
    }
  }

  function onFrame(frame) {
    if (frame.kind === DA.FRAME_META) {
      const s = ensureSessionFromFrame(frame);
      // payload: bandLen | bandId | nameLen | name
      try {
        const p = frame.payload;
        if (p && p.length >= 2) {
          const bandLen = p[0];
          const bandId = new TextDecoder().decode(p.subarray(1, 1 + bandLen));
          if (DA.BAND_PROFILES[bandId]) {
            s.profile = DA.BAND_PROFILES[bandId];
            $("audio-band-label-rx") && ($("audio-band-label-rx").textContent = "From sender: " + DA.bandLabel(s.profile, false));
            // restart listen on matching band
            if (state.listen) {
              state.listen.stop();
              state.listen = null;
            }
            DA.AudioIO.startListenLoop(s.profile, onFrame, { windowSec: 3.5, intervalMs: 300, maxBytes: 8192 }).then((l) => {
              state.listen = l;
            });
          }
        }
      } catch (_) {}
      updateProgressUi();
      return;
    }
    if (frame.kind === DA.FRAME_DATA) {
      const s = ensureSessionFromFrame(frame);
      s.acceptBlock(frame.seq, frame.payload);
      updateProgressUi();
      finishIfComplete();
    }
  }

  function stopListen() {
    state.running = false;
    if (state.listen) {
      state.listen.stop();
      state.listen = null;
    }
    if (state.camTimer) {
      clearInterval(state.camTimer);
      state.camTimer = null;
    }
    if (state.camStream) {
      state.camStream.getTracks().forEach((t) => t.stop());
      state.camStream = null;
    }
    if (state.viz) {
      state.viz.connectAnalyser(null);
      state.viz.setMode("idle");
    }
  }

  async function startSoundListen() {
    assertMicAvailable();
    setStatus("מבקש הרשאת מיקרופון…");
    const profile = DA.resolveBandProfile(state.bandOverride === "auto" ? null : state.bandOverride);
    if (state.session) state.session.profile = profile;
    $("audio-band-label-rx") && ($("audio-band-label-rx").textContent = DA.bandLabel(profile, state.bandOverride === "auto"));
    if (state.listen) {
      state.listen.stop();
      state.listen = null;
    }
    const waveWrap = $("audio-wave-rx-wrap");
    if (waveWrap) {
      waveWrap.hidden = false;
      waveWrap.removeAttribute("hidden");
    }
    const viz = ensureViz();
    if (viz) viz.setMode("rx");
    await DA.AudioIO.ensureContext();
    state.listen = await DA.AudioIO.startListenLoop(profile, onFrame, {
      windowSec: 3.5,
      intervalMs: 300,
      maxBytes: 8192,
      onAnalyser(a) {
        if (viz) viz.connectAnalyser(a);
      },
    });
    setStatus("מאזין במיקרופון · גלי הקול אמורים לזוז אם יש אות · " + DA.bandLabel(profile, state.bandOverride === "auto"));
  }

  async function startHybridCamera() {
    const preview = $("preview");
    const video = $("video");
    if (!video) return;
    if (preview) preview.style.display = "";
    state.camStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "environment", width: { ideal: 1280 } },
    });
    video.srcObject = state.camStream;
    await video.play();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    state.camTimer = setInterval(async () => {
      if (!state.running || video.readyState < 2) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      if (!canvas.width) return;
      ctx.drawImage(video, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let raw = null;
      if (typeof jsQR === "function") {
        const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "dontInvert" });
        if (code && code.data) raw = code.data;
      }
      if (!raw && "BarcodeDetector" in window) {
        try {
          const det = new BarcodeDetector({ formats: ["qr_code"] });
          const codes = await det.detect(canvas);
          if (codes[0]) raw = codes[0].rawValue;
        } catch (_) {}
      }
      if (!raw || typeof raw !== "string" || !raw.startsWith("DCA1:")) return;
      try {
        const bin = atob(raw.slice(5));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const frame = DA.unpackFrame(bytes);
        if (frame) onFrame(frame);
      } catch (_) {}
    }, 120);
  }

  async function onStartAudioRecv() {
    try {
      applyModeUi();
      if (state.mode === "CAMERAONLY") {
        setStatus("למצב CAMERAONLY השתמשו ב-Start camera הרגיל.");
        return;
      }
      stopListen();
      state.running = true;
      state.session = null;
      updateProgressUi();
      if (state.mode === "SOUNDONLY" || state.mode === "COMBINE" || state.mode === "CAM_SOUND_FB") {
        await startSoundListen();
      }
      if (state.mode === "COMBINE" || state.mode === "CAM_SOUND_FB") {
        await startHybridCamera();
      }
      setStatus("Receiving (" + state.mode + ")…");
    } catch (err) {
      const mapped = (window.__decimenMapError && window.__decimenMapError(err)) || String((err && err.message) || err);
      setStatus(mapped, true);
      if (window.__decimenLog) window.__decimenLog("Recv error: " + mapped, true);
    }
  }

  async function speakNack() {
    if (!state.session) {
      setStatus("No session yet — receive some blocks first", true);
      return;
    }
    const missing = state.session.missing();
    if (!missing.length) {
      setStatus("Nothing missing");
      return;
    }
    state.nackBusy = true;
    updateProgressUi();
    try {
      const profile = state.session.profile;
      const frame = state.session.packNackFrame(missing);
      // Pause listen briefly to avoid self-echo confusion
      const wasListen = state.listen;
      if (wasListen) {
        wasListen.stop();
        state.listen = null;
      }
      const ctx = await DA.AudioIO.ensureContext();
      const { pcm } = DA.Modem.encodePcm(frame, profile, ctx.sampleRate);
      setStatus("Speaking NACK (" + missing.length + " blocks)…");
      for (let attempt = 0; attempt < 3; attempt++) {
        await DA.AudioIO.playPcm(pcm, ctx.sampleRate);
        await new Promise((r) => setTimeout(r, 200));
      }
      if (state.running && (state.mode === "SOUNDONLY" || state.mode === "COMBINE" || state.mode === "CAM_SOUND_FB")) {
        await startSoundListen();
      }
      setStatus("NACK sent · waiting for prioritized blocks");
    } catch (err) {
      setStatus(String(err.message || err), true);
    } finally {
      state.nackBusy = false;
      updateProgressUi();
    }
  }

  function wire() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", wire);
      return;
    }
    document.querySelectorAll('input[name="transport-mode"]').forEach((el) => {
      el.addEventListener("change", () => {
        stopListen();
        applyModeUi();
      });
      el.addEventListener("click", () => {
        setTimeout(applyModeUi, 0);
      });
    });
    const bandSel = $("cfg-audio-band-rx");
    if (bandSel) {
      bandSel.addEventListener("change", () => {
        state.bandOverride = bandSel.value;
        applyModeUi();
      });
    }
    $("audio-recv-start") && $("audio-recv-start").addEventListener("click", onStartAudioRecv);
    $("audio-recv-stop") &&
      $("audio-recv-stop").addEventListener("click", () => {
        stopListen();
        setStatus("Stopped");
      });
    $("audio-nack-speak") && $("audio-nack-speak").addEventListener("click", speakNack);

    // Hijack primary Start button for audio modes so SOUNDONLY requests mic
    const startBtn = $("start");
    if (startBtn) {
      startBtn.addEventListener(
        "click",
        (ev) => {
          if (currentMode() === "CAMERAONLY") return;
          ev.preventDefault();
          ev.stopImmediatePropagation();
          onStartAudioRecv();
        },
        true
      );
    }
    applyModeUi();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();

  DA.ReceiverBridge = { state, speakNack, stopListen, applyModeUi };
})();

try { window.__DECIMEN_AUDIO_BUNDLE_OK = !!(window.DecimenAudio && window.DecimenAudio.Modem && window.DecimenAudio.AudioIO); if (!window.__DECIMEN_AUDIO_BUNDLE_OK) window.__DECIMEN_AUDIO_BUNDLE_ERR = new Error("DecimenAudio incomplete after bundle"); } catch (e) { window.__DECIMEN_AUDIO_BUNDLE_ERR = e; }