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
    // Keep peak ≤ ~0.85 even if all carriers align (avoids TX clip → RX FEC fail)
    const amp = 0.82 / Math.max(1, pairs);
    for (let p = 0; p < pairs; p++) {
      const bit = bits[p] ? 1 : 0;
      const freq = bit ? freqs[p * 2] : freqs[p * 2 + 1];
      const w = (2 * Math.PI * freq) / sampleRate;
      for (let i = 0; i < symbolSamples; i++) {
        let env = 1;
        if (i < fade) env = i / fade;
        else if (i > symbolSamples - fade) env = (symbolSamples - i) / fade;
        pcm[base + i] += Math.sin(w * i) * amp * env;
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

      let peak = 0;
      for (let i = 0; i < pcm.length; i++) {
        const a = Math.abs(pcm[i]);
        if (a > peak) peak = a;
      }
      if (peak > 1e-6) {
        const scale = 0.88 / peak;
        for (let i = 0; i < pcm.length; i++) pcm[i] *= scale;
      }
      return { pcm, symbolSamples, freqs, pairs, fecLen: fec.length };
    },

    decodePcm(pcm, profile, sampleRate, opts) {
      opts = opts || {};
      const { freqs, pairs, bitsPerSym } = bitSlots(profile);
      const symbolSamples = Math.max(48, Math.round((profile.symbolMs / 1000) * sampleRate));

      let bestOff = -1;
      let bestScore = -Infinity;
      const coarse = Math.max(12, Math.floor(symbolSamples / 4));
      const searchSec = opts.searchSec != null ? opts.searchSec : 1.5;
      // Bursts start at energy onset — preamble is near the front.
      const regions = [[0, Math.min(pcm.length, Math.floor(sampleRate * searchSec))]];
      if (opts.scanTail && pcm.length > sampleRate * 5) {
        regions.push([
          Math.max(0, pcm.length - Math.floor(sampleRate * 9)),
          pcm.length,
        ]);
      }
      for (const [r0, r1] of regions) {
        // Offsets may sit early; frame body can extend past the search window into pcm.
        const absLimit = Math.max(0, pcm.length - symbolSamples * (PREAMBLE_BITS.length + 10));
        const limit = Math.min(absLimit, r1);
        for (let off = r0; off < limit; off += coarse) {
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
      }
      if (bestOff >= 0) {
        const lo = Math.max(0, bestOff - coarse);
        const hi = bestOff + coarse;
        for (let off = lo; off <= hi; off += Math.max(4, Math.floor(coarse / 6))) {
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
