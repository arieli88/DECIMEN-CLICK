/* End-to-end SOUNDONLY codec test: build container, TX all blocks, RX assemble */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname);
const files = [
  "crc32.js",
  "fec.js",
  "band-select.js",
  "framer.js",
  "modem.js",
  "nack.js",
  "transfer-engine.js",
];

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
  performance: { now: () => Date.now() },
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;

for (const f of files) {
  vm.runInNewContext(fs.readFileSync(path.join(root, f), "utf8"), sandbox);
}
const DA = sandbox.DecimenAudio;

function addNoise(pcm, amp) {
  for (let i = 0; i < pcm.length; i++) pcm[i] += (Math.random() - 0.5) * amp;
}

(async () => {
  const payload = new TextEncoder().encode("HELLO-SOUNDONLY-" + "x".repeat(200));
  const container = await DA.buildContainer("test.txt", "text/plain", payload);
  const profile = DA.BAND_PROFILES.laptop;
  const sampleRate = 48000;
  const session = DA.TransferEngine.createSession(container, {
    mode: "SOUNDONLY",
    profile,
    blockLen: 40,
    sessionId: 1234,
  });

  console.log("K=", session.k, "totalLen=", session.totalLen, "container=", container.length);

  // Simulate receiver session
  const rxPlace = new Uint8Array(session.totalLen);
  const rx = DA.TransferEngine.createSession(rxPlace, {
    mode: "SOUNDONLY",
    profile,
    blockLen: session.blockLen,
    sessionId: session.sessionId,
  });
  rx.k = session.k;
  rx.blockLen = session.blockLen;
  rx.totalLen = session.totalLen;
  rx.received = new Array(session.k).fill(null);

  let okFrames = 0;
  let failFrames = 0;

  // META
  {
    const meta = session.packMetaFrame({ name: "test.txt", bandId: profile.id });
    const { pcm } = DA.Modem.encodePcm(meta, profile, sampleRate);
    addNoise(pcm, 0.01);
    const d = DA.Modem.decodePcm(pcm, profile, sampleRate, { maxBytes: 8192 });
    console.log("META decode:", d && d.frame ? "OK kind="+d.frame.kind : "FAIL", d && !d.frame ? Object.keys(d) : "");
  }

  for (let seq = 0; seq < session.k; seq++) {
    const frame = session.packDataFrame(seq);
    const { pcm } = DA.Modem.encodePcm(frame, profile, sampleRate);
    addNoise(pcm, 0.015);
    // pad silence like mic ring buffer
    const padded = new Float32Array(pcm.length + sampleRate * 0.2);
    padded.set(pcm, Math.floor(sampleRate * 0.05));
    const d = DA.Modem.decodePcm(padded, profile, sampleRate, { maxBytes: 8192 });
    if (d && d.frame && d.frame.kind === DA.FRAME_DATA) {
      rx.acceptBlock(d.frame.seq, d.frame.payload);
      okFrames++;
    } else {
      failFrames++;
      console.log("FAIL seq", seq, d && d.raw ? "rawLen="+d.raw.length : d);
    }
  }

  console.log("okFrames", okFrames, "failFrames", failFrames, "solved", rx.solvedCount(), "/", rx.k);

  if (rx.solvedCount() < rx.k) {
    console.error("INCOMPLETE");
    process.exit(2);
  }
  const assembled = rx.assemble();
  const parsed = await DA.parseContainer(assembled);
  const text = new TextDecoder().decode(parsed.payload);
  console.log("RECOVERED", parsed.name, text.slice(0, 40), "... len", text.length);
  if (!text.startsWith("HELLO-SOUNDONLY-")) {
    console.error("CONTENT MISMATCH");
    process.exit(3);
  }
  console.log("E2E SOUNDONLY PASS");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
