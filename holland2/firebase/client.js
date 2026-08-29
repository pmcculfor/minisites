import { CONFIG } from "../config.js";
import { firebaseConfig, recaptchaSiteKey, isFirebaseConfigured } from "../firebase-config.js";

let inflight = null;
let cachedOk = null;
let cachedUnconfigured = null;

async function loadSdk() {
  const version = CONFIG.firebaseCdnVersion;
  const base = `https://www.gstatic.com/firebasejs/${version}`;
  const [
    { initializeApp },
    { getAuth, signInAnonymously },
    { getFirestore, collection, addDoc, query, orderBy, onSnapshot, serverTimestamp, limit },
    { initializeAppCheck, ReCaptchaV3Provider },
  ] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-firestore.js`),
    import(`${base}/firebase-app-check.js`),
  ]);
  return {
    initializeApp,
    getAuth,
    signInAnonymously,
    getFirestore,
    collection,
    addDoc,
    query,
    orderBy,
    onSnapshot,
    serverTimestamp,
    limit,
    initializeAppCheck,
    ReCaptchaV3Provider,
  };
}

async function doConnect() {
  if (!isFirebaseConfigured()) {
    return { ok: false, reason: "unconfigured" };
  }

  const sdk = await loadSdk();
  const app = sdk.initializeApp(firebaseConfig);
  if (recaptchaSiteKey) {
    sdk.initializeAppCheck(app, {
      provider: new sdk.ReCaptchaV3Provider(recaptchaSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  }

  const auth = sdk.getAuth(app);
  const db = sdk.getFirestore(app);

  try {
    await sdk.signInAnonymously(auth);
  } catch (error) {
    console.error(error);
  }

  return {
    ok: true,
    app,
    auth,
    db,
    canWrite: Boolean(auth.currentUser),
    firestore: {
      collection: sdk.collection,
      addDoc: sdk.addDoc,
      query: sdk.query,
      orderBy: sdk.orderBy,
      onSnapshot: sdk.onSnapshot,
      serverTimestamp: sdk.serverTimestamp,
      limit: sdk.limit,
    },
  };
}

export async function connectFirebase() {
  if (cachedUnconfigured) return cachedUnconfigured;
  if (cachedOk) return cachedOk;
  if (inflight) return inflight;

  inflight = doConnect().then(
    (result) => {
      inflight = null;
      if (!result.ok && result.reason === "unconfigured") {
        cachedUnconfigured = result;
      } else if (result.ok) {
        cachedOk = result;
      }
      return result;
    },
    (error) => {
      inflight = null;
      throw error;
    }
  );
  return inflight;
}
