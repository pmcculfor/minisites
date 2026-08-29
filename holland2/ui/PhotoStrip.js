import { CONFIG } from "../config.js";
import { el, clear } from "../lib/dom.js";
import { isSafeImageSrc } from "../lib/safe-url.js";
import { ERRORS, mapPhotoError } from "./errors.js";

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export class PhotoStrip {
  constructor(props) {
    this.dayKey = props.dayKey;
    this._store = props.store || null;
    this._pipeline = props.pipeline;
    this._rateLimiter = props.rateLimiter;

    this._uploadBtn = el("button", {
      type: "button",
      class: "comment-submit photo-upload-btn",
      text: "Upload a picture",
    });
    this._fileInput = el("input", {
      type: "file",
      class: "file-input",
      accept: "image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,image/*",
    });
    this._fileInput.dataset.photoInput = this.dayKey;
    this._status = el("p", { class: "form-status photo-status" });
    this._list = el("div", { class: "photo-list" }, [
      el("p", { class: "feed-loading", text: ERRORS.feedLoadingPictures }),
    ]);

    this._root = el("div", { class: "photo-block" }, [
      this._uploadBtn,
      this._fileInput,
      this._status,
      this._list,
    ]);

    this._onClick = () => this._handleClick();
    this._onChange = () => this._handleFile();
    this._uploadBtn.addEventListener("click", this._onClick);
    this._fileInput.addEventListener("change", this._onChange);
  }

  get element() {
    return this._root;
  }

  attachStore(store) {
    this._store = store;
  }

  setItems(items) {
    const list = items || [];
    const safe = list.filter((item) => isSafeImageSrc(item.url));
    if (!safe.length) {
      this.setListState("empty");
      return;
    }
    clear(this._list);
    for (const item of safe) {
      this._list.append(
        el("img", {
          src: item.url,
          alt: "Photo from this day",
          loading: "lazy",
        })
      );
    }
  }

  setListState(state, message) {
    if (state === "ready") return;
    clear(this._list);
    const text =
      message ||
      (state === "loading"
        ? ERRORS.feedLoadingPictures
        : state === "empty"
          ? ERRORS.feedEmptyPictures
          : state === "setup"
            ? ERRORS.firebaseUnconfigured
            : state === "error"
              ? ERRORS.photosSnapshot
              : "");
    const className =
      state === "loading" ? "feed-loading" : state === "empty" ? "feed-empty" : "feed-setup";
    this._list.append(el("p", { class: className, text }));
  }

  destroy() {
    this._uploadBtn.removeEventListener("click", this._onClick);
    this._fileInput.removeEventListener("change", this._onChange);
  }

  _setStatus(message, isError) {
    this._status.textContent = message;
    this._status.classList.toggle("is-error", Boolean(isError));
  }

  _handleClick() {
    if (!this._store) {
      this._setStatus(ERRORS.firebaseUnconfiguredPhoto, true);
      return;
    }
    if (!this._store.canWrite) {
      this._setStatus(ERRORS.photoAuth, true);
      return;
    }
    this._fileInput.click();
  }

  async _handleFile() {
    const file = this._fileInput.files?.[0];
    if (!file) return;

    const mimeType = file.type || "";
    const looksLikeImage =
      mimeType.startsWith("image/") || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name || "");
    if (!looksLikeImage) {
      this._fileInput.value = "";
      this._setStatus(ERRORS.photoNotImage, true);
      return;
    }
    if (file.size > CONFIG.limits.sourceFileBytes) {
      this._fileInput.value = "";
      this._setStatus(ERRORS.photoFileTooLarge, true);
      return;
    }
    if (this._rateLimiter && this._rateLimiter.isBlocked()) {
      this._fileInput.value = "";
      this._setStatus(ERRORS.photoCooldown, true);
      return;
    }
    if (!this._store) {
      this._fileInput.value = "";
      this._setStatus(ERRORS.firebaseUnconfiguredPhoto, true);
      return;
    }
    if (!this._store.canWrite) {
      this._fileInput.value = "";
      this._setStatus(ERRORS.photoAuth, true);
      return;
    }

    this._uploadBtn.disabled = true;
    this._setStatus(ERRORS.photoReading, false);
    try {
      this._fileInput.value = "";
      this._setStatus(ERRORS.photoShrinking, false);
      const url = await withTimeout(
        this._pipeline(file, {
          limits: CONFIG.limits,
          ladder: CONFIG.image.ladder,
          timeoutMs: CONFIG.timeouts.uploadMs,
          chunkSize: CONFIG.image.base64Chunk,
        }),
        CONFIG.timeouts.uploadMs,
        "timeout"
      );
      this._setStatus(ERRORS.photoSaving, false);
      await withTimeout(
        this._store.addPhoto({ dayKey: this.dayKey, url }),
        CONFIG.timeouts.uploadMs,
        "timeout"
      );
      if (this._rateLimiter) this._rateLimiter.stamp();
      this._setStatus(ERRORS.photoUploaded, false);
    } catch (error) {
      console.error(error);
      this._fileInput.value = "";
      this._setStatus(mapPhotoError(error), true);
    } finally {
      this._uploadBtn.disabled = false;
    }
  }
}
