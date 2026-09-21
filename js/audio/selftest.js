/* In-browser SOUNDONLY self-test — offline encode/decode of each frame (fast) */
(function (g) {
  const DA = (g.DecimenAudio = g.DecimenAudio || {});

  DA.runSoundOnlySelfTest = async function runSoundOnlySelfTest(opts) {
    opts = opts || {};
    const text = opts.text || "SOUNDONLY-SELFTEST-" + Date.now();
    const raw = new TextEncoder().encode(text);
    const container = await DA.buildContainer("selftest.txt", "text/plain", raw);
    const base = DA.resolveBandProfile(opts.band || null);
    const profile = Object.assign({}, base);
    const sampleRate = 48000;
    const tx = DA.TransferEngine.createSession(container, {
      mode: "SOUNDONLY",
      profile,
      blockLen: 28,
      sessionId: (Math.random() * 0xffff) | 1,
    });

    const rx = DA.TransferEngine.createSession(new Uint8Array(tx.totalLen), {
      mode: "SOUNDONLY",
      profile,
      blockLen: tx.blockLen,
      sessionId: tx.sessionId,
    });
    rx.k = tx.k;
    rx.blockLen = tx.blockLen;
    rx.totalLen = tx.totalLen;
    rx.received = new Array(tx.k).fill(null);

    function roundTrip(bytes, noiseAmp) {
      const { pcm } = DA.Modem.encodePcm(bytes, profile, sampleRate);
      // pad silence like mic buffer edges
      const padded = new Float32Array(pcm.length + Math.floor(sampleRate * 0.08));
      padded.set(pcm, Math.floor(sampleRate * 0.03));
      if (noiseAmp) {
        for (let i = 0; i < padded.length; i++) padded[i] += (Math.random() - 0.5) * noiseAmp;
      }
      return DA.Modem.decodePcm(padded, profile, sampleRate, { maxBytes: 8192 });
    }

    // META
    const metaDec = roundTrip(tx.packMetaFrame({ name: "selftest.txt", bandId: profile.id }), 0.01);
    if (!metaDec || !metaDec.frame || metaDec.frame.kind !== DA.FRAME_META) {
      return { ok: false, message: "Self-test FAIL: META frame not recovered" };
    }

    let fails = 0;
    for (let seq = 0; seq < tx.k; seq++) {
      const bytes = tx.packDataFrame(seq);
      let got = null;
      // up to 3 attempts with light noise (simulates acoustic)
      for (let attempt = 0; attempt < 3 && !got; attempt++) {
        const d = roundTrip(bytes, 0.012 + attempt * 0.004);
        if (d && d.frame && d.frame.kind === DA.FRAME_DATA && d.frame.seq === seq) {
          got = d.frame;
        }
      }
      if (!got) {
        fails++;
        continue;
      }
      rx.acceptBlock(got.seq, got.payload);
    }

    if (rx.solvedCount() < rx.k) {
      return {
        ok: false,
        message: "Self-test FAIL: " + rx.solvedCount() + "/" + rx.k + " (frameFails=" + fails + ")",
        solved: rx.solvedCount(),
        k: tx.k,
      };
    }
    const parsed = await DA.parseContainer(rx.assemble());
    const gotText = new TextDecoder().decode(parsed.payload);
    if (gotText !== text) {
      return { ok: false, message: "Self-test FAIL: payload mismatch" };
    }
    return {
      ok: true,
      message: "Self-test PASS · \"" + text.slice(0, 28) + "\" · " + tx.k + " blocks",
      recovered: gotText,
      k: tx.k,
    };
  };

  /** Full SOUNDONLY file transfer offline (encode all blocks → decode → assemble). */
  DA.transferSoundOnlyOffline = async function transferSoundOnlyOffline(fileBytes, fileName, mime) {
    const container = await DA.buildContainer(fileName || "file.bin", mime || "application/octet-stream", fileBytes);
    const profile = DA.resolveBandProfile(null);
    const sampleRate = 48000;
    const tx = DA.TransferEngine.createSession(container, {
      mode: "SOUNDONLY",
      profile,
      blockLen: 28,
      sessionId: (Math.random() * 0xffff) | 1,
    });
    const rx = DA.TransferEngine.createSession(new Uint8Array(tx.totalLen), {
      mode: "SOUNDONLY",
      profile,
      blockLen: tx.blockLen,
      sessionId: tx.sessionId,
    });
    rx.k = tx.k;
    rx.blockLen = tx.blockLen;
    rx.totalLen = tx.totalLen;
    rx.received = new Array(tx.k).fill(null);

    function send(bytes) {
      const { pcm } = DA.Modem.encodePcm(bytes, profile, sampleRate);
      const padded = new Float32Array(pcm.length + Math.floor(sampleRate * 0.1));
      padded.set(pcm, Math.floor(sampleRate * 0.04));
      for (let i = 0; i < padded.length; i++) padded[i] += (Math.random() - 0.5) * 0.008;
      return DA.Modem.decodePcm(padded, profile, sampleRate, { maxBytes: 8192 });
    }

    send(tx.packMetaFrame({ name: fileName || "file.bin", bandId: profile.id }));
    for (let seq = 0; seq < tx.k; seq++) {
      let ok = false;
      for (let a = 0; a < 5 && !ok; a++) {
        const d = send(tx.packDataFrame(seq));
        if (d && d.frame && d.frame.kind === DA.FRAME_DATA && d.frame.sessionId === tx.sessionId) {
          rx.acceptBlock(d.frame.seq, d.frame.payload);
          ok = rx.received[seq] != null;
        }
      }
      if (!ok) {
        return { ok: false, message: "block " + seq + " lost", solved: rx.solvedCount(), k: tx.k };
      }
    }
    const parsed = await DA.parseContainer(rx.assemble());
    return { ok: true, name: parsed.name, mime: parsed.mime, payload: parsed.payload, k: tx.k };
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
