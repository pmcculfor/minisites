# Holland, Michigan weather & waves

Static minisite at `holland/` on this repo. Intended URL after GitHub Pages is on:

`https://pmcculfor.github.io/minisites/holland/`

Open through **the end of September 3, 2026, America/Detroit**. After that the page shows a closed message and Firestore rejects new comments.

Weather and waves are fetched **once on page load** (no polling). A loading indicator shows until those requests finish.

## 1. Enable GitHub Pages

1. Push this folder to `main`.
2. GitHub → **Settings → Pages**.
3. Source: **Deploy from a branch**.
4. Branch: `main`, folder: `/ (root)`.
5. Wait a minute, then open `/minisites/holland/`.

The repo root has a `.nojekyll` file so GitHub does not run Jekyll.

## 2. Firebase (comments and pictures)

GitHub Pages cannot store comments or pictures. You need a free Firebase project.

Do this **in order**. If you enforce App Check before the site key is in `firebase-config.js`, every post will fail.

### Create the project

1. Open [Firebase Console](https://console.firebase.google.com/) and create a project.
2. Add a **Web** app. Copy the `firebaseConfig` object into [`firebase-config.js`](firebase-config.js) (`apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`).
3. **Authentication → Sign-in method → Anonymous → Enable**.
4. **Authentication → Settings → Authorized domains**: keep `localhost` and add `pmcculfor.github.io`.
5. **Build → Firestore Database → Create**. Start in production mode (or test mode, then replace the rules immediately).
6. Paste the contents of [`firestore.rules`](firestore.rules) into **Firestore → Rules** and publish. **Do this again whenever `firestore.rules` changes** — picture uploads will fail until the published rules allow the larger `url` field.

Rules allow public reads, anonymous creates only, no updates/deletes, length/size limits, and no writes after September 3, 2026 24:00 Eastern. Pictures are compressed in the browser (JPEG, about 1024px on the long side) and stored on the `photos` document itself, so Firebase Storage is not required.

Firebase Storage is unused. You do not need to enable it, and you do not need to enforce App Check on Cloud Storage.

### App Check (so casual off-site writes fail)

This is not a perfect lock — someone can still copy a token from this live page — but curl/Postman/another website should fail once App Check is **enforced**.

1. Open [reCAPTCHA admin](https://www.google.com/recaptcha/admin) and create a **reCAPTCHA v3** key.
2. Allowed domains: `pmcculfor.github.io` and `localhost`.
3. Copy the **site key** (not the secret) into `recaptchaSiteKey` in [`firebase-config.js`](firebase-config.js).
4. Firebase → **App Check → Get started → Web** → reCAPTCHA v3 → paste the same site key.
5. App Check → **APIs → Cloud Firestore → Enforce**.
   - You can leave it in **monitoring** until you confirm a comment and a picture work from the live page, then switch to **Enforce**.

Do **not** commit a service-account JSON file or the reCAPTCHA **secret** key.

### Local testing with App Check

If App Check is already enforced, localhost needs either:

- `localhost` on the reCAPTCHA key **and** the same site key in `firebase-config.js`, or
- a debug token: in the browser console on localhost, enable debug mode as described in [Firebase App Check web docs](https://firebase.google.com/docs/app-check/web/debug-provider), then register that token under App Check → Apps → Manage debug tokens.

## 3. What the page does

- **Weather:** Open-Meteo for Holland city (`42.7875, -86.1089`), °F and mph, Eastern Time.
- **Waves:** Open-Meteo ECMWF WAM just offshore (`42.90, -86.50`). GFS Wave on Lake Michigan often returns zeros, so it is only a backup. If both miss, National Weather Service gridpoint `GRR/21,43` (Holland buoy area) is used. Labeled as a **forecast**.
- **Comments:** each day’s tile has its own notes. Optional name, 500-character text, honeypot. Stored with that day’s `dayKey`. Rendered as text only (no HTML).
- **Pictures:** upload button above a vertical list on that day. The browser shrinks the photo and saves it in the `photos` Firestore collection. Phone HEIC/JPEG files are accepted. Uploads time out with an error instead of spinning forever.

Query `?previewClosed=1` to see the post–September 3 closed screen without waiting.

## 4. After close

On September 4, 2026 Eastern, visitors see the closed message. You can still delete leftover comments and pictures in the Firebase console. You can also disable Anonymous Auth or delete the Firebase project.
