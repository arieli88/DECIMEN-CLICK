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
