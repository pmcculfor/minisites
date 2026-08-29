import { CONFIG } from "../config.js";

const DATA_JPEG_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;

export function isSafeImageSrc(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > CONFIG.limits.photoUrlChars) {
    return false;
  }
  if (DATA_JPEG_RE.test(value)) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    return (
      url.hostname === "firebasestorage.googleapis.com" ||
      url.hostname.endsWith(".firebasestorage.app") ||
      url.hostname.endsWith(".googleapis.com")
    );
  } catch {
    return false;
  }
}
