import { firebaseConfig, recaptchaSiteKey, isFirebaseConfigured } from "./firebase-config.js";

const TIME_ZONE = "America/Detroit";
const MAX_TEXT = 500;
const MAX_NICK = 40;

function detroitDayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatTime(ts) {
  const date = ts?.toDate ? ts.toDate() : ts instanceof Date ? ts : null;
  if (!date) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function sanitizeNickname(value) {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_NICK);
}

function sanitizeText(value) {
  return value.replace(/\r\n/g, "\n").trim().slice(0, MAX_TEXT);
}

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function renderFeed(feed, docs) {
  feed.replaceChildren();
  if (!docs.length) {
    feed.append(node("p", "feed-empty", "No notes for this day yet."));
    return;
  }
  for (const data of docs) {
    const article = node("article", "comment");
    article.append(
      node("p", "comment-name", data.nickname || "Anonymous"),
      node("p", "comment-time", formatTime(data.createdAt)),
      node("p", "comment-body", data.text)
    );
    feed.append(article);
  }
}

export function createDayGuestbook(dayKey) {
  const wrap = node("div", "tile-guestbook");
  wrap.append(node("h3", "guestbook-title", "Leaving note about this day"));

  const feed = node("div", "comment-feed");
  feed.dataset.commentFeed = dayKey;
  feed.append(node("p", "feed-loading", "Loading notes…"));
  wrap.append(feed);

  const form = node("form", "day-comment-form");
  form.dataset.day = dayKey;
  form.setAttribute("novalidate", "");

  const hpLabel = node("label", "hp", "Company");
  const hp = document.createElement("input");
  hp.className = "hp";
  hp.name = "company";
  hp.type = "text";
  hp.tabIndex = -1;
  hp.autocomplete = "off";
  form.append(hpLabel, hp);

  const nameLabel = node("label", null, "Name ");
  nameLabel.append(node("span", "optional", "(optional)"));
  const nameInput = document.createElement("input");
  nameInput.name = "nickname";
  nameInput.type = "text";
  nameInput.maxLength = MAX_NICK;
  nameInput.placeholder = "Anonymous";
  nameInput.autocomplete = "nickname";
  form.append(nameLabel, nameInput);

  const textLabel = node("label", null, "Comment");
  const textarea = document.createElement("textarea");
  textarea.name = "text";
  textarea.maxLength = MAX_TEXT;
  textarea.rows = 3;
  textarea.required = true;
  textarea.placeholder = "Wind, water, beach, dinner…";
  form.append(textLabel, textarea);

  const count = node("p", "char-count", "");
  const countValue = node("span", "js-count", "0");
  count.append(countValue, document.createTextNode(`/${MAX_TEXT}`));
  form.append(count);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "comment-submit";
  submit.textContent = "Post to this day";
  form.append(submit);
  form.append(node("p", "form-status", ""));

  wrap.append(form);

  const photos = node("div", "photo-block");

  const uploadBtn = document.createElement("button");
  uploadBtn.type = "button";
  uploadBtn.className = "comment-submit photo-upload-btn";
  uploadBtn.textContent = "Upload a picture";
  photos.append(uploadBtn);

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.className = "file-input";
  fileInput.accept = "image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,image/*";
  fileInput.dataset.photoInput = dayKey;
  photos.append(fileInput);

  photos.append(node("p", "form-status photo-status", ""));

  const list = node("div", "photo-list");
  list.dataset.photoList = dayKey;
  list.append(node("p", "feed-loading", "Loading pictures…"));
  photos.append(list);

  wrap.append(photos);
  return wrap;
}

const DATA_JPEG_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
const MAX_INLINE_CHARS = 900000;

function isSafeImageSrc(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > MAX_INLINE_CHARS) return false;
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

function renderPhotos(list, docs) {
  list.replaceChildren();
  if (!docs.length) {
    list.append(node("p", "feed-empty", "No pictures yet."));
    return;
  }
  for (const data of docs) {
    if (!isSafeImageSrc(data.url)) continue;
    const img = document.createElement("img");
    img.src = data.url;
    img.alt = "Photo from this day";
    img.loading = "lazy";
    list.append(img);
  }
  if (!list.children.length) {
    list.append(node("p", "feed-empty", "No pictures yet."));
  }
}

function paintPhotos(docs) {
  const byDay = new Map();
  for (const data of docs) {
    const key = data.dayKey || "";
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(data);
  }
  for (const list of document.querySelectorAll("[data-photo-list]")) {
    renderPhotos(list, byDay.get(list.dataset.photoList) || []);
  }
}

function paintFeeds(docs) {
  const byDay = new Map();
  for (const data of docs) {
    const key = data.dayKey || "";
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(data);
  }
  for (const feed of document.querySelectorAll("[data-comment-feed]")) {
    renderFeed(feed, byDay.get(feed.dataset.commentFeed) || []);
  }
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_INLINE_BINARY = 180 * 1024;
const UPLOAD_MS = 45000;

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

function blobToJpegDataUrl(blob) {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
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

function canvasToJpegBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("compress-failed"));
      },
      "image/jpeg",
      quality
    );
  });
}

async function compressToInlineJpeg(fileBytes, mimeType) {
  const blob = new Blob([fileBytes], { type: mimeType || "image/jpeg" });
  const source = await bitmapFromBlob(blob);
  const origW = source.width;
  const origH = source.height;
  if (!origW || !origH) throw new Error("unreadable");

  const attempts = [
    { maxSide: 1024, quality: 0.7 },
    { maxSide: 960, quality: 0.56 },
    { maxSide: 800, quality: 0.48 },
    { maxSide: 640, quality: 0.4 },
  ];

  let lastBlob = null;
  for (const attempt of attempts) {
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
    lastBlob = await canvasToJpegBlob(canvas, attempt.quality);
    if (lastBlob.size <= MAX_INLINE_BINARY) break;
  }

  if (source.close) source.close();
  if (!lastBlob || lastBlob.size > MAX_INLINE_BINARY) throw new Error("too-large");
  const dataUrl = await blobToJpegDataUrl(lastBlob);
  if (dataUrl.length > MAX_INLINE_CHARS) throw new Error("too-large");
  return dataUrl;
}

function uploadErrorMessage(error) {
  const code = String(error?.code || error?.message || "");
  if (code.includes("permission") || code.includes("PERMISSION")) {
    return "Could not save the picture. Publish the latest firestore.rules from this repo in the Firebase console.";
  }
  if (code.includes("unauthenticated") || code.includes("anonymous")) {
    return "Could not start an anonymous session for uploads.";
  }
  if (code.includes("app-check") || code.includes("recaptcha") || code.includes("AppCheck")) {
    return "Could not save the picture. Check App Check and the reCAPTCHA site key for this domain.";
  }
  if (code.includes("timeout") || code.includes("timed out")) {
    return "The picture took too long to save. Try a smaller photo or another network.";
  }
  if (code.includes("unreadable") || code.includes("compress-failed")) {
    return "Could not read that picture. Try a JPEG or PNG.";
  }
  if (code.includes("too-large")) {
    return "That picture is still too large after shrinking. Try another photo.";
  }
  return "Could not save the picture. Try again in a moment.";
}

function bindUploads({ addDoc, collection, db, serverTimestamp, auth }) {
  let lastUpload = 0;

  for (const btn of document.querySelectorAll(".photo-upload-btn")) {
    const block = btn.closest(".photo-block");
    const fileInput = block.querySelector(".file-input");
    const status = block.querySelector(".photo-status");
    const dayKey = fileInput.dataset.photoInput;

    const setStatus = (message, isError = false) => {
      status.textContent = message;
      status.classList.toggle("is-error", isError);
    };

    btn.addEventListener("click", () => {
      if (!addDoc) {
        setStatus("Firebase is not configured yet, so pictures cannot be saved.", true);
        return;
      }
      fileInput.click();
    });

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;

      const mimeType = file.type || "";
      const looksLikeImage = mimeType.startsWith("image/") || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name || "");
      if (!looksLikeImage) {
        fileInput.value = "";
        setStatus("Use a photo file (JPEG, PNG, WebP, HEIC, or GIF).", true);
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        fileInput.value = "";
        setStatus("That picture is over 20 MB.", true);
        return;
      }

      const now = Date.now();
      if (now - lastUpload < 4000) {
        fileInput.value = "";
        setStatus("Wait a few seconds before uploading again.", true);
        return;
      }

      const uid = auth?.currentUser?.uid;
      if (!uid) {
        fileInput.value = "";
        setStatus("Could not start an anonymous session for uploads.", true);
        return;
      }

      btn.disabled = true;
      setStatus("Reading picture…");

      try {
        const fileBytes = new Uint8Array(await file.arrayBuffer());
        fileInput.value = "";
        setStatus("Shrinking picture…");
        const url = await withTimeout(
          compressToInlineJpeg(fileBytes, mimeType),
          UPLOAD_MS,
          "timeout"
        );
        setStatus("Saving picture…");
        await withTimeout(
          addDoc(collection(db, "photos"), {
            dayKey,
            url,
            path: `days/${dayKey}/${uid}_${now}.jpg`,
            createdAt: serverTimestamp(),
          }),
          UPLOAD_MS,
          "timeout"
        );
        lastUpload = now;
        setStatus("Uploaded.");
      } catch (error) {
        console.error(error);
        fileInput.value = "";
        setStatus(uploadErrorMessage(error), true);
      } finally {
        btn.disabled = false;
      }
    });
  }
}

function bindForms({ addDoc, collection, db, serverTimestamp }) {
  let lastSubmit = 0;

  for (const form of document.querySelectorAll(".day-comment-form")) {
    const textarea = form.querySelector('textarea[name="text"]');
    const count = form.querySelector(".js-count");
    const status = form.querySelector(".form-status");
    const submit = form.querySelector(".comment-submit");
    const honeypot = form.querySelector('input[name="company"]');

    const setStatus = (message, isError = false) => {
      status.textContent = message;
      status.classList.toggle("is-error", isError);
    };

    textarea.addEventListener("input", () => {
      count.textContent = String(textarea.value.length);
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (honeypot.value) {
        setStatus("Thanks.");
        form.reset();
        count.textContent = "0";
        return;
      }

      const nickname = sanitizeNickname(form.querySelector('input[name="nickname"]').value);
      const text = sanitizeText(textarea.value);
      if (!text) {
        setStatus("Write a comment first.", true);
        return;
      }

      const now = Date.now();
      if (now - lastSubmit < 8000) {
        setStatus("Wait a few seconds before posting again.", true);
        return;
      }

      if (!addDoc) {
        setStatus("Firebase is not configured yet, so comments cannot be saved.", true);
        return;
      }

      submit.disabled = true;
      setStatus("Posting…");

      try {
        await addDoc(collection(db, "comments"), {
          nickname,
          text,
          createdAt: serverTimestamp(),
          dayKey: form.dataset.day || detroitDayKey(),
        });
        lastSubmit = now;
        form.reset();
        count.textContent = "0";
        setStatus("Posted.");
      } catch (error) {
        console.error(error);
        setStatus(
          "Could not post. If App Check is enforced, the reCAPTCHA site key must be set and the domain allowed.",
          true
        );
      } finally {
        submit.disabled = false;
      }
    });
  }
}

export async function initComments({ closed }) {
  const forms = document.querySelectorAll(".day-comment-form");
  const feeds = document.querySelectorAll("[data-comment-feed]");
  const photoLists = document.querySelectorAll("[data-photo-list]");

  if (closed || !forms.length) return;

  const setupMessage =
    "Notes and pictures are not connected yet. Add your Firebase keys in firebase-config.js (see README).";

  if (!isFirebaseConfigured()) {
    for (const feed of feeds) {
      feed.replaceChildren();
      feed.append(node("p", "feed-setup", setupMessage));
    }
    for (const list of photoLists) {
      list.replaceChildren();
      list.append(node("p", "feed-setup", setupMessage));
    }
    bindForms({});
    bindUploads({});
    return;
  }

  const [
    { initializeApp },
    { getAuth, signInAnonymously },
    { getFirestore, collection, addDoc, query, orderBy, onSnapshot, serverTimestamp, limit },
    { initializeAppCheck, ReCaptchaV3Provider },
  ] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js"),
    import("https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js"),
    import("https://www.gstatic.com/firebasejs/11.0.2/firebase-app-check.js"),
  ]);

  const app = initializeApp(firebaseConfig);
  if (recaptchaSiteKey) {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(recaptchaSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  }

  const auth = getAuth(app);
  const db = getFirestore(app);

  try {
    await signInAnonymously(auth);
  } catch (error) {
    console.error(error);
    for (const feed of feeds) {
      feed.replaceChildren();
      feed.append(
        node(
          "p",
          "feed-setup",
          "Could not start an anonymous session. Check Auth is enabled and pmcculfor.github.io is an authorized domain."
        )
      );
    }
  }

  onSnapshot(
    query(collection(db, "comments"), orderBy("createdAt", "desc"), limit(200)),
    (snap) => paintFeeds(snap.docs.map((doc) => doc.data())),
    (error) => {
      console.error(error);
      for (const feed of feeds) {
        feed.replaceChildren();
        feed.append(node("p", "feed-setup", "Could not load notes. Check Firestore rules and App Check."));
      }
    }
  );

  onSnapshot(
    query(collection(db, "photos"), orderBy("createdAt", "desc"), limit(60)),
    (snap) => paintPhotos(snap.docs.map((doc) => doc.data())),
    (error) => {
      console.error(error);
      for (const list of photoLists) {
        list.replaceChildren();
        list.append(node("p", "feed-setup", "Could not load pictures. Check Firestore rules and App Check."));
      }
    }
  );

  bindForms({ addDoc, collection, db, serverTimestamp });
  bindUploads({ addDoc, collection, db, serverTimestamp, auth });
}
