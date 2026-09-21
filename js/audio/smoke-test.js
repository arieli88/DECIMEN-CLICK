/* Node smoke test for Decimen audio stack (no Web Audio) */
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

const sandbox = { console, Uint8Array, Float32Array, Float64Array, DataView, Math, Array, Object, TextEncoder, TextDecoder, crypto: require("crypto").webcrypto };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;

for (const f of files) {
  const code = fs.readFileSync(path.join(root, f), "utf8");
  vm.runInNewContext(code, sandbox);
}

const DA = sandbox.DecimenAudio;
let fails = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    fails++;
  } else console.log("OK:", msg);
}

(async () => {
  const payload = new TextEncoder().encode("hello-decimen-audio");
  const frame = DA.packFrame({
    kind: DA.FRAME_DATA,
    sessionId: 42,
    seq: 3,
    k: 10,
    blockLen: 40,
    totalLen: 400,
    payload: (() => {
      const b = new Uint8Array(40);
      b.set(payload);
      return b;
    })(),
  });
  const unpacked = DA.unpackFrame(frame);
  assert(unpacked && unpacked.sessionId === 42 && unpacked.seq === 3, "pack/unpack frame");

  const fec = DA.fecEncode(frame);
  // flip one bit
  fec[10] ^= 0x01;
  const recovered = DA.fecDecode(fec);
  assert(DA.unpackFrame(recovered) !== null, "FEC corrects 1-bit error");

  const miss = [1, 5, 9];
  const nack = DA.encodeNackPayload(miss, 20);
  assert(JSON.stringify(DA.decodeNackPayload(nack, 20)) === JSON.stringify(miss), "nack roundtrip");

  const profile = DA.BAND_PROFILES.laptop;
  const sampleRate = 48000;
  const { pcm } = DA.Modem.encodePcm(frame, profile, sampleRate);
  const decoded = DA.Modem.decodePcm(pcm, profile, sampleRate, { maxBytes: 4096 });
  assert(decoded && decoded.frame && decoded.frame.seq === 3, "modem encode/decode clean PCM");

  // add mild noise
  for (let i = 0; i < pcm.length; i++) pcm[i] += (Math.random() - 0.5) * 0.02;
  const decoded2 = DA.Modem.decodePcm(pcm, profile, sampleRate, { maxBytes: 4096 });
  assert(decoded2 && decoded2.frame && decoded2.frame.sessionId === 42, "modem decode with low noise");

  const container = await DA.buildContainer("t.txt", "text/plain", payload);
  const parsed = await DA.parseContainer(container);
  assert(parsed.name === "t.txt" && parsed.payload.length === payload.length, "DCAF container");

  const session = DA.TransferEngine.createSession(container, { mode: "SOUNDONLY", profile, blockLen: 40 });
  assert(session.k >= 1 && session.channelFor(0) === "sound", "transfer session");

  console.log(fails ? `\n${fails} failed` : "\nAll smoke tests passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
