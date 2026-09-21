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
