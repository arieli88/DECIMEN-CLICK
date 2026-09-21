/* Simulate burst RX of concatenated TX frames with gaps (no WebAudio) */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname);
const sandbox = {
  console,
  Uint8Array,
  Float32Array,
  Float64Array,
  DataView,
  Math,
  Array,
  Object,
  TextEncoder,
  TextDecoder,
  crypto: require("crypto").webcrypto,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
for (const f of ["crc32.js", "fec.js", "band-select.js", "framer.js", "modem.js", "nack.js", "transfer-engine.js"]) {
  vm.runInNewContext(fs.readFileSync(path.join(root, f), "utf8"), sandbox);
}
const DA = sandbox.DecimenAudio;

function rms(buf, a, b) {
  let s = 0;
  for (let i = a; i < b; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

/** Split continuous PCM into energy bursts and decode each. */
function decodeBursts(pcm, profile, sampleRate) {
  const frames = [];
  const win = Math.floor(sampleRate * 0.04);
  let i = 0;
  let noise = 0.002;
  while (i + win < pcm.length) {
    const r = rms(pcm, i, i + win);
    noise = noise * 0.98 + r * 0.02;
    const thresh = Math.max(0.01, noise * 5);
    if (r > thresh) {
      const start = Math.max(0, i - win);
      let j = i;
      let quiet = 0;
      while (j + win < pcm.length) {
        const rj = rms(pcm, j, j + win);
        if (rj < thresh * 0.7) {
          quiet++;
          if (quiet > 8) break;
        } else quiet = 0;
        j += win;
      }
      const end = Math.min(pcm.length, j + win * 2);
      const burst = pcm.subarray(start, end);
      const d = DA.Modem.decodePcm(burst, profile, sampleRate, { maxBytes: 8192 });
      if (d && d.frame) frames.push(d.frame);
      i = end;
    } else i += win;
  }
  return frames;
}

(async () => {
  const raw = new TextEncoder().encode("BURST-E2E-" + "y".repeat(100));
  const container = await DA.buildContainer("b.txt", "text/plain", raw);
  const profile = DA.BAND_PROFILES.laptop;
  const sr = 48000;
  const tx = DA.TransferEngine.createSession(container, {
    mode: "SOUNDONLY",
    profile,
    blockLen: 32,
    sessionId: 99,
  });

  const gap = new Float32Array(Math.floor(sr * 0.4));
  const parts = [];
  function pushFrame(bytes) {
    const { pcm } = DA.Modem.encodePcm(bytes, profile, sr);
    parts.push(pcm);
    parts.push(gap);
  }
  pushFrame(tx.packMetaFrame({ name: "b.txt", bandId: "laptop" }));
  for (let s = 0; s < tx.k; s++) {
    pushFrame(tx.packDataFrame(s));
    pushFrame(tx.packDataFrame(s)); // repeat
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const pcm = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    pcm.set(p, o);
    o += p.length;
  }
  // light noise
  for (let i = 0; i < pcm.length; i++) pcm[i] += (Math.random() - 0.5) * 0.012;

  const frames = decodeBursts(pcm, profile, sr);
  console.log("bursts decoded", frames.length, "K", tx.k);

  const rx = DA.TransferEngine.createSession(new Uint8Array(tx.totalLen), {
    mode: "SOUNDONLY",
    profile,
    blockLen: tx.blockLen,
    sessionId: 99,
  });
  rx.k = tx.k;
  rx.blockLen = tx.blockLen;
  rx.totalLen = tx.totalLen;
  rx.received = new Array(tx.k).fill(null);
  for (const f of frames) {
    if (f.kind === DA.FRAME_DATA) rx.acceptBlock(f.seq, f.payload);
  }
  console.log("solved", rx.solvedCount(), "/", rx.k);
  if (rx.solvedCount() < rx.k) {
    console.error("BURST E2E FAIL");
    process.exit(2);
  }
  const parsed = await DA.parseContainer(rx.assemble());
  console.log("BURST E2E PASS", new TextDecoder().decode(parsed.payload).slice(0, 20));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
