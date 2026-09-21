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
