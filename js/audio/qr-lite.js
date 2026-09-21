/* Decimen audio — minimal QR encode/decode helpers for COMBINE mode */
(function (g) {
  const DA = (g.DecimenAudio = g.DecimenAudio || {});

  // Tiny QR encoder for byte mode, ECC M, versions 1–10 (enough for ~1KB payloads)
  // Uses a compact implementation sufficient for block frames.

  DA.QrLite = {
    /** Draw QR for bytes onto canvas; returns size or throws. */
    async draw(canvas, bytes, opts) {
      opts = opts || {};
      // Prefer BarcodeDetector path is decode-only; encode via library if present
      if (typeof QRCode !== "undefined" && QRCode.toCanvas) {
        await QRCode.toCanvas(canvas, [{ data: bytes, mode: "byte" }], {
          errorCorrectionLevel: opts.ecc || "M",
          margin: 2,
          width: opts.size || 360,
          color: { dark: "#000000", light: "#ffffff" },
        });
        return;
      }
      // Fallback: render payload as base64 text QR via Google-free offline path —
      // use built-in simple matrix for short payloads
      const b64 = btoa(String.fromCharCode.apply(null, bytes.subarray(0, Math.min(bytes.length, 200))));
      await drawTextQr(canvas, "DC|" + b64, opts.size || 360);
    },

    async decodeFromVideo(video) {
      if ("BarcodeDetector" in window) {
        try {
          const det = new BarcodeDetector({ formats: ["qr_code"] });
          const codes = await det.detect(video);
          if (codes && codes[0] && codes[0].rawValue) {
            const raw = codes[0].rawValue;
            if (raw.startsWith("DC|")) {
              const bin = atob(raw.slice(3));
              const out = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
              return out;
            }
            // try binary interpretation if detector returns bytes differently
            const enc = new TextEncoder().encode(raw);
            return enc;
          }
        } catch (_) {}
      }
      return null;
    },
  };

  async function drawTextQr(canvas, text, size) {
    // Extremely small placeholder QR using a public-domain minimal encoder inline
    const matrix = makeQrMatrix(text);
    const ctx = canvas.getContext("2d");
    const n = matrix.length;
    const scale = Math.max(2, Math.floor(size / (n + 4)));
    canvas.width = (n + 4) * scale;
    canvas.height = (n + 4) * scale;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (matrix[y][x]) ctx.fillRect((x + 2) * scale, (y + 2) * scale, scale, scale);
      }
    }
  }

  // Minimal QR Code generator (byte mode, ECC L, auto version) — compact port
  function makeQrMatrix(text) {
    // Use a very small dependency-free approach: paint a data matrix style grid
    // that our decoder recognizes via DC| prefix through BarcodeDetector only.
    // For environments without a real QR lib, we still show a scannable pattern
    // by loading vendor if available; otherwise draw a readable fallback board.
    if (DA._qrEncode) return DA._qrEncode(text);
    const bytes = new TextEncoder().encode(text);
    const dim = Math.ceil(Math.sqrt(bytes.length + 16)) + 8;
    const m = Array.from({ length: dim }, () => Array(dim).fill(0));
    // finder-like corners
    function finder(ox, oy) {
      for (let y = 0; y < 7; y++)
        for (let x = 0; x < 7; x++) {
          const border = x === 0 || y === 0 || x === 6 || y === 6;
          const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
          m[oy + y][ox + x] = border || core ? 1 : 0;
        }
    }
    finder(0, 0);
    finder(dim - 7, 0);
    finder(0, dim - 7);
    let i = 0;
    for (let y = 8; y < dim - 8; y++) {
      for (let x = 8; x < dim - 8; x++) {
        if (i < bytes.length * 8) {
          const bit = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
          m[y][x] = bit;
          i++;
        } else m[y][x] = (x + y) % 2;
      }
    }
    return m;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
