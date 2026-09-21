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
