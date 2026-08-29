# McCulfor vacation — Holland, Michigan (holland2)

Static minisite at `holland2/` on this repo. Intended URL after GitHub Pages is on:

`https://pmcculfor.github.io/minisites/holland2/`

This is a rebuild of `holland/` with the same product, copy, visual language, and the **same Firebase project and Firestore collections**. `holland/` and `holland2/` are dual writers of `comments` and `photos`. Do not invent new collection names.

Open through **the end of September 3, 2026, America/Detroit**. After that the page shows a closed message and Firestore rejects new comments.

The carousel covers the trip window in `config.js` (`firstOpenDay` through `lastOpenDay`), not only the next seven forecast days. Past days stay in the strip so notes and pictures remain reachable. The view starts on **today**; swipe left for earlier days.

Weather and waves are fetched **once on page load** (no polling). A loading indicator shows until those requests finish.

Pinch-zoom is locked on purpose (`maximum-scale=1` plus `touch-action: manipulation` on `html, body`) so the day carousel can own horizontal swipes. That is an intentional product constraint, not an oversight.

## 1. Enable GitHub Pages

1. Push this folder to `main`.
2. GitHub → **Settings → Pages**.
3. Source: **Deploy from a branch**.
4. Branch: `main`, folder: `/ (root)`.
5. Wait a minute, then open `/minisites/holland2/`.

The repo root has a `.nojekyll` file so GitHub does not run Jekyll.

## 2. Firebase (comments and pictures)

GitHub Pages cannot store comments or pictures. This site uses the existing **holland-vacation** Firebase project.

**holland/ and holland2/ share `comments` and `photos`.** A bug in either site can write into the live guestbook. Field shapes stay:

- comments: `{ nickname, text, createdAt, dayKey }`
- photos: `{ dayKey, url, path, createdAt }`

Do this **in order**. If you enforce App Check before the site key is in `firebase-config.js`, every post will fail.

### Create / reuse the project

1. Open [Firebase Console](https://console.firebase.google.com/). The live project is `holland-vacation`.
2. Web app config lives in [`firebase-config.js`](firebase-config.js) (`apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`).
3. **Authentication → Sign-in method → Anonymous → Enable**.
4. **Authentication → Settings → Authorized domains**: keep `localhost` and add `pmcculfor.github.io`.
5. **Build → Firestore Database**.
6. Paste the contents of [`firestore.rules`](firestore.rules) into **Firestore → Rules** and publish. **Do this again whenever `firestore.rules` changes** — picture uploads will fail until the published rules allow the larger `url` field.

Rules allow public reads, anonymous creates only, no updates/deletes, length/size limits, and no writes after September 3, 2026 24:00 Eastern. Pictures are compressed in the browser (JPEG, about 1024px on the long side) and stored on the `photos` document itself, so Firebase Storage is not required.

Firebase Storage is unused. You do not need to enable it, and you do not need to enforce App Check on Cloud Storage. [`storage.rules`](storage.rules) is copied for documentation only.

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

Serve this folder as static files (any local server). ES modules require HTTP, not `file://`.

## 3. What the page does

- **Weather:** Open-Meteo for Holland city (`42.7875, -86.1089`), °F and mph, Eastern Time.
- **Waves:** Open-Meteo ECMWF WAM just offshore (`42.90, -86.50`). GFS Wave is a backup. If both miss, National Weather Service gridpoint data for the Holland buoy area is used. Labeled as a **forecast**.
- **Comments:** each day’s tile has its own notes, including days already past in the trip window. Optional name, 500-character text, honeypot. Stored with that day’s `dayKey`. Rendered as text only (no HTML).
- **Pictures:** upload button above a vertical list on that day. The browser shrinks the photo and saves it in the `photos` Firestore collection. Phone HEIC/JPEG files are accepted. Uploads time out with an error instead of spinning forever. Photos stack full width; the **page** is the vertical scroller (no inner photo list scrollbar).

Query `?previewClosed=1` to see the post–September 3 closed screen without waiting.

## 4. Keep these in sync

Client close date and Firestore rules are **one policy expressed twice**. They cannot share a runtime.

| Policy | Client | Server (console-published) |
|---|---|---|
| Close instant | `CONFIG.lastOpenDay` (`2026-09-03`) + Detroit day key in `config.js` / `lib/time.js` | `firestore.rules` `stillOpen()`: `request.time < timestamp.date(2026, 9, 4) + duration.value(4, 'h')` (end of 2026-09-03 EDT = 2026-09-04 04:00 UTC) |
| Trip window | `CONFIG.firstOpenDay` (`2026-08-22`) through `lastOpenDay`; Open-Meteo `past_days` is derived | n/a (reads still work; writes stop at close) |
| Comment lengths | `CONFIG.limits` + Guestbook sanitize | `validComment()` |
| Photo URL size | image pipeline on write; `isSafeImageSrc` on **display** | `validPhoto()` |

If `holland2/firestore.rules` and `holland/firestore.rules` ever diverge, that is a product bug. Publishing rules is a Firebase console action. Identical files → no need to republish if holland/ rules are already live.

**Shared collections:** do not change `comments` / `photos` names or field shapes without a migration that also updates holland/.

## 5. After close

On September 4, 2026 Eastern, visitors see the closed message. You can still delete leftover comments and pictures in the Firebase console. You can also disable Anonymous Auth or delete the Firebase project.
