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
  wrap.append(node("h3", "guestbook-title", "Notes for this day"));
  wrap.append(node("p", "comments-intro", "Anyone can leave a public note about this day. No account."));

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
  return wrap;
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

  if (closed || !forms.length) return;

  if (!isFirebaseConfigured()) {
    for (const feed of feeds) {
      feed.replaceChildren();
      feed.append(
        node(
          "p",
          "feed-setup",
          "Notes are not connected yet. Add your Firebase keys in firebase-config.js (see README)."
        )
      );
    }
    bindForms({});
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

  bindForms({ addDoc, collection, db, serverTimestamp });
}
