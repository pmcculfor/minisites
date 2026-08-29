import { CONFIG } from "../config.js";
import { withTimeout } from "../lib/timeout.js";

export function looksLikeImage(file) {
  const mimeType = file.type || "";
  return mimeType.startsWith("image/") || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name || "");
}

function blobToJpegDataUrl(blob, chunkSize) {
  const chunk = chunkSize || 0x8000;
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return `data:image/jpeg;base64,${btoa(binary)}`;
  });
}

async function bitmapFromBlob(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(blob);
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("unreadable"));
      };
      img.src = objectUrl;
    });
  }
}

function canvasToJpegBlob(canvas, quality, mimeOut) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("compress-failed"));
      },
      mimeOut || "image/jpeg",
      quality
    );
  });
}

export async function fileToInlineJpeg(file, opts) {
  const options = opts || {};
  const limits = options.limits || CONFIG.limits;
  const ladder = options.ladder || CONFIG.image.ladder;
  const timeoutMs = options.timeoutMs || CONFIG.timeouts.uploadMs;
  const chunkSize = options.chunkSize || CONFIG.image.base64Chunk;
  const mimeOut = CONFIG.image.mimeOut;

  const work = (async () => {
    if (!looksLikeImage(file)) throw new Error("not-image");
    if (file.size > limits.sourceFileBytes) throw new Error("file-too-large");

    const mimeType = file.type || "image/jpeg";
    const blob = file instanceof Blob ? file : new Blob([file], { type: mimeType });
    const source = await bitmapFromBlob(blob);
    const origW = source.width;
    const origH = source.height;
    if (!origW || !origH) throw new Error("unreadable");

    let lastBlob = null;
    for (const attempt of ladder) {
      const scale = Math.min(1, attempt.maxSide / Math.max(origW, origH));
      const width = Math.max(1, Math.round(origW * scale));
      const height = Math.max(1, Math.round(origH * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("compress-failed");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(source, 0, 0, width, height);
      lastBlob = await canvasToJpegBlob(canvas, attempt.quality, mimeOut);
      if (lastBlob.size <= limits.inlineJpegBytes) break;
    }

    if (source.close) source.close();
    if (!lastBlob || lastBlob.size > limits.inlineJpegBytes) throw new Error("too-large");
    const dataUrl = await blobToJpegDataUrl(lastBlob, chunkSize);
    if (dataUrl.length > limits.photoUrlChars) throw new Error("too-large");
    return dataUrl;
  })();

  return withTimeout(work, timeoutMs, "timeout");
}
