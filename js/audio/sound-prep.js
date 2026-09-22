/* Decimen audio — prepare payloads for slow acoustic channel */
(function (g) {
  const DA = (g.DecimenAudio = g.DecimenAudio || {});

  function bytesToBase64(bytes) {
    let s = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  DA.bytesToBase64 = bytesToBase64;
  DA.base64ToBytes = base64ToBytes;

  /** Estimate acoustic TX time (seconds) for container size. */
  DA.estimateSoundSeconds = function estimateSoundSeconds(byteLen, opts) {
    opts = opts || {};
    const blockLen = opts.blockLen || 20;
    const symbolMs = (opts.profile && opts.profile.symbolMs) || 48;
    const reps = opts.reps || 2;
    const gapMs = opts.gapMs || 1200;
    const k = Math.max(1, Math.ceil(byteLen / blockLen));
    // ~header+FEC ≈ 2.2× payload + ~22 symbols framing
    const bitsPerSym = Math.max(1, Math.floor(((opts.profile && opts.profile.carriers) || 8) / 2));
    const frameBytes = 18 + blockLen;
    const fecBytes = Math.ceil(frameBytes * 2.05);
    const dataSyms = Math.ceil((16 + fecBytes * 8) / bitsPerSym);
    const totalSyms = 22 + dataSyms;
    const frameMs = totalSyms * symbolMs + gapMs;
    return Math.ceil(((k + 2) * reps * frameMs) / 1000);
  };

  /**
   * For SOUNDONLY: shrink images so transfer is practical over speakers/mic.
   * Non-images pass through (caller should warn if huge).
   */
  DA.prepareSoundPayload = async function prepareSoundPayload(file, opts) {
    opts = opts || {};
    const maxBytes = opts.maxBytes || 5500;
    const maxEdge = opts.maxEdge || 420;
    const quality = opts.quality != null ? opts.quality : 0.42;
    const name = file.name || "file.bin";
    const mime = file.type || "application/octet-stream";
    const raw = new Uint8Array(await file.arrayBuffer());

    const isImage = /^image\/(jpeg|jpg|png|webp|gif)$/i.test(mime) || /\.(jpe?g|png|webp|gif)$/i.test(name);
    if (!isImage) {
      return {
        bytes: raw,
        name,
        mime,
        compressed: false,
        originalBytes: raw.length,
        note: raw.length > maxBytes ? "קובץ גדול לשמע — שקלו תמונה/טקסט קטן" : null,
      };
    }

    if (typeof createImageBitmap !== "function" && typeof Image === "undefined") {
      return { bytes: raw, name, mime, compressed: false, originalBytes: raw.length };
    }

    let bitmap;
    try {
      bitmap = await createImageBitmap(new Blob([raw], { type: mime }));
    } catch (_) {
      return { bytes: raw, name, mime, compressed: false, originalBytes: raw.length };
    }

    let w = bitmap.width;
    let h = bitmap.height;
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    try {
      bitmap.close && bitmap.close();
    } catch (_) {}

    let q = quality;
    let blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", q));
    while (blob && blob.size > maxBytes && q > 0.16) {
      q -= 0.06;
      blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", q));
    }
    // Still too big? shrink canvas further
    let edge = Math.min(w, h);
    while (blob && blob.size > maxBytes && edge > 120) {
      edge = Math.floor(edge * 0.75);
      const c2 = document.createElement("canvas");
      const scale2 = edge / Math.max(w, h);
      c2.width = Math.max(1, Math.round(w * scale2));
      c2.height = Math.max(1, Math.round(h * scale2));
      const ctx2 = c2.getContext("2d");
      ctx2.fillStyle = "#fff";
      ctx2.fillRect(0, 0, c2.width, c2.height);
      ctx2.drawImage(canvas, 0, 0, c2.width, c2.height);
      w = c2.width;
      h = c2.height;
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(c2, 0, 0);
      q = Math.min(q, 0.4);
      blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", q));
    }
    if (!blob) {
      return { bytes: raw, name, mime, compressed: false, originalBytes: raw.length };
    }
    const out = new Uint8Array(await blob.arrayBuffer());
    const outName = name.replace(/\.[^.]+$/, "") + ".sound.jpg";
    return {
      bytes: out,
      name: outName,
      mime: "image/jpeg",
      compressed: true,
      originalBytes: raw.length,
      width: w,
      height: h,
      quality: q,
      note: "דחוס לשמע: " + raw.length + "→" + out.length + " בתים (" + w + "×" + h + ")",
    };
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
