import { firebaseConfig, recaptchaSiteKey, isFirebaseConfigured } from "./firebase-config.js";

const FEED = document.getElementById("comment-feed");
const FORM = document.getElementById("comment-form");
const STATUS = document.getElementById("comment-status");
const SUBMIT = document.getElementById("comment-submit");
const TEXT = document.getElementById("comment-text");
const COUNT = document.getElementById("char-count");
const HONEYPOT = document.getElementById("company");

const TIME_ZONE = "America/Detroit";
const MAX_TEXT = 500;
const MAX_NICK = 40;

function setStatus(message, isError = false) {
  STATUS.textContent = message;
  STATUS.classList.toggle("is-error", isError);
}

function detroitDayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatDayHeading(dayKey) {
  const today = detroitDayKey();
  if (dayKey === today) return "Today";
  const [year, month, day] = dayKey.split("-").map(Number);
  const noonUtc = new Date(Date.UTC(year, month - 1, day, 16));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(noonUtc);
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

function renderComments(docs) {
  FEED.replaceChildren();
  if (!docs.length) {
    const empty = document.createElement("p");
    empty.className = "feed-empty";
    empty.textContent = "No comments yet. Be the first.";
    FEED.append(empty);
    return;
  }

  let currentDay = null;
  let group = null;
  for (const data of docs) {
    if (data.dayKey !== currentDay) {
      currentDay = data.dayKey;
      group = document.createElement("div");
      group.className = "day-group";
      const heading = document.createElement("h3");
      heading.className = "day-label";
      heading.textContent = formatDayHeading(data.dayKey);
      group.append(heading);
      FEED.append(group);
    }

    const article = document.createElement("article");
    article.className = "comment";

    const name = document.createElement("p");
    name.className = "comment-name";
    name.textContent = data.nickname || "Anonymous";

    const time = document.createElement("p");
    time.className = "comment-time";
    time.textContent = formatTime(data.createdAt);

    const body = document.createElement("p");
    body.className = "comment-body";
    body.textContent = data.text;

    article.append(name, time, body);
    group.append(article);
  }
}

export async function initComments({ closed }) {
  TEXT.addEventListener("input", () => {
    COUNT.textContent = String(TEXT.value.length);
  });

  if (closed) {
    FORM.hidden = true;
    FEED.replaceChildren();
    const note = document.createElement("p");
    note.className = "feed-setup";
    note.textContent = "The guestbook closed at the end of September 3, 2026.";
    FEED.append(note);
    return;
  }

  if (!isFirebaseConfigured()) {
    FEED.replaceChildren();
    const note = document.createElement("p");
    note.className = "feed-setup";
    note.textContent =
      "Comments are not connected yet. Add your Firebase keys in firebase-config.js (see README).";
    FEED.append(note);
    FORM.addEventListener("submit", (event) => {
      event.preventDefault();
      setStatus("Firebase is not configured yet, so comments cannot be saved.", true);
    });
    return;
  }

  const [
    { initializeApp },
    { getAuth, signInAnonymously },
    {
      getFirestore,
      collection,
      addDoc,
      query,
      orderBy,
      onSnapshot,
      serverTimestamp,
      limit,
    },
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
    setStatus(
      "Could not start an anonymous session. Check Auth is enabled and pmcculfor.github.io is an authorized domain.",
      true
    );
  }

  const commentsQuery = query(
    collection(db, "comments"),
    orderBy("createdAt", "desc"),
    limit(100)
  );

  onSnapshot(
    commentsQuery,
    (snap) => {
      const docs = snap.docs.map((doc) => doc.data());
      renderComments(docs);
    },
    (error) => {
      console.error(error);
      FEED.replaceChildren();
      const note = document.createElement("p");
      note.className = "feed-setup";
      note.textContent = "Could not load comments. Check Firestore rules and App Check.";
      FEED.append(note);
    }
  );

  let lastSubmit = 0;

  FORM.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (HONEYPOT.value) {
      setStatus("Thanks.");
      FORM.reset();
      COUNT.textContent = "0";
      return;
    }

    const nickname = sanitizeNickname(document.getElementById("nickname").value);
    const text = sanitizeText(TEXT.value);
    if (!text) {
      setStatus("Write a comment first.", true);
      return;
    }

    const now = Date.now();
    if (now - lastSubmit < 8000) {
      setStatus("Wait a few seconds before posting again.", true);
      return;
    }

    SUBMIT.disabled = true;
    setStatus("Posting…");

    try {
      await addDoc(collection(db, "comments"), {
        nickname,
        text,
        createdAt: serverTimestamp(),
        dayKey: detroitDayKey(),
      });
      lastSubmit = now;
      FORM.reset();
      COUNT.textContent = "0";
      setStatus("Posted.");
    } catch (error) {
      console.error(error);
      setStatus(
        "Could not post. If App Check is enforced, the reCAPTCHA site key must be set and the domain allowed.",
        true
      );
    } finally {
      SUBMIT.disabled = false;
    }
  });
}
