# holland2 implementation plan

Rebuild `/workspace/holland/` as `/workspace/holland2/` with feature parity and a clean architecture. Do not copy-paste patched modules. Do not import from `holland/`. Leave `holland/` untouched.

This document is the spec for the implementing engineer. Names, file paths, and APIs below are the intended contract unless a later note records a justified deviation. Implement from this file alone; do not consult the review that produced it.

---

## Review resolution (Agent 1 + Agent 2)

Agent 2 requested changes. Agent 1 accepts all six blocking issues. This rewrite is the agreed spec.

1. **Scroll coordinator is one design.** §6.3 is the tighter contract: wheel + touch only, no `matchMedia` / iOS / pointer+touch dual `scrollBy`. Scroller keeps `touch-action: pan-x pan-y`. DayCarousel owns mouse-drag. SiteController does not bind the coordinator.
2. **Store lifetime.** SiteController is the only `connectFirebase` caller. Tiles paint weather first with `store: null`, then `attachStore`. One comments snapshot and one photos snapshot. Firestore SDK functions are returned from `connectFirebase` (store.js may also import the same gstatic 11.0.2 URLs).
3. **Auth-failed still subscribes.** Public reads do not need auth. `canWrite` gates writes. Auth-failed is not a terminal feed state.
4. **DayTile sky copy.** New §5.12. `formatDayLabel` uses the UTC-16 trick. Wave compass is daily-first. `formatWaveFt` Calm threshold is specified. Headline temp/wx come from observations.
5. **Wave chain try/catch.** Each provider is isolated; a throw does not abort GFS/NWS. Original throw message after the list.
6. **One shared RateLimiter.** SiteController owns comment and photo cooldowns and passes the same objects into every Guestbook/PhotoStrip. Not per-tile `Date.now()`.

Non-blocking checklist items from the review are folded in (safe-url, dual upload timeouts, canvas white fill + chunked base64, keyboard form-control guard, full ERRORS strings, no wave-only slice, NWS duration precedence, marine `source` string, `overscroll-behavior-y: auto`, drop `a11y/live.js`, `ui/errors.js` not `status.js`, no `lib/format.js`, no unspecified delegate helpers, README shared collections, connectFirebase cache rules, raw wheel `deltaY`, PhotoStrip no `auth`, no Guestbook `closed` flag, classifier unit tests, one exempt list). No Agent 1 disagreements.

---

## 1. Goals and non-goals

### Goals

- Recreate the McCulfor vacation minisite (Holland, MI, through 2026-09-03 America/Detroit) with the same product, copy, visual language, and UX constraints.
- Same GitHub Pages static hosting: ES modules, no bundler, no framework, no build step.
- Same Firebase project and the same Firestore collections (`comments`, `photos`) so existing live data keeps working. `holland/` and `holland2/` are dual writers of those collections.
- Design as if every requirement (scroll nesting, pinch-zoom lock, photo stacking, upload timeouts, provider fallback, closed date) was known up front.
- One source of truth for configuration, one weather-code table, one wave-provider chain, one nested-scroll policy, one UI state machine.
- Small modules with exclusive ownership: a file either fetches, models, stores, or renders — not all four.

### Non-goals

- New product features (accounts, moderation UI, live buoy, polling, maps, PWA, dark-mode toggle, multi-trip).
- Firebase Storage uploads. Pictures stay as inline JPEG data URLs on `photos` documents (Storage rules may still be copied for documentation; they are unused).
- A React/Vue/Svelte rewrite. Vanilla ES modules are required for GH Pages parity.
- Pixel-perfect cloning of every CSS hack. Match the look (tokens, fonts, tile weather art, layout) via a cleaner CSS model.
- Sharing runtime code with `holland/`. Values may be transcribed (Firebase config, WMO labels, colors); modules must not `import` from `../holland/`.
- Changing Firestore collection names, field shapes, or published rules in a way that breaks existing documents.
- Server-side rendering, TypeScript compilation, or npm scripts unless a later phase proves a single `.d.ts` comment file useful (not required).

---

## 2. Inventory of original features + UX constraints

Read from `holland/index.html`, `app.js`, `comments.js`, `styles.css`, `firebase-config.js`, `README.md`, `firestore.rules`, `storage.rules`.

### Product

| Feature | Original behavior to keep |
|---|---|
| Identity | Title “McCulfor vacation — Holland, Michigan”. Kicker: Holland, Michigan · Lake Michigan · through September 3, 2026. Lede about weather, waves, notes and pictures. |
| Window | Open through **end of 2026-09-03 America/Detroit**. Client: `detroitDayKey() > "2026-09-03"`. Preview: `?previewClosed=1`. Rules: `request.time < 2026-09-04 04:00 UTC`. Do not unify these into one JS expression used by rules (impossible). |
| Weather | Open-Meteo forecast, city `42.7875, -86.1089`, °F, mph, timezone `America/Detroit`, `forecast_days=7`. Current: temp, weather_code, wind speed/dir. Daily: weather_code, max/min temp, max wind, dominant wind dir. Fetched **once** on load (no polling). |
| Waves | Primary Open-Meteo ECMWF WAM `ecmwf_wam025` at offshore `42.90, -86.50`. Backup GFS Wave `ncep_gfswave025`. Fallback NWS gridpoint via `api.weather.gov/points/42.9,-86.27` then `forecastGridData.waveHeight`. Usable-wave filter: null/NaN height is unusable; height `0` with period `0` or missing is unusable; height `0` with a real period **is** usable. Labeled as forecast, not live buoy. Open-Meteo marine `source` is ``Open-Meteo ${model}`` (e.g. `Open-Meteo ecmwf_wam025`). Disclaimer in footer + tile note. |
| Day tiles | One tile per forecast day. Header (sky art) + notes + pictures. “Today” kicker + inset ring on the Detroit calendar day (`day.isCurrent`). Headline temp is current temp on today, else daily high. Sky WMO class + label from `currentWx ?? weatherCode`. Waves: today with a now height shows `Now X ft · max Y ft · DIR` (max bit omitted if missing); other days `Waves X ft · DIR`. Compass from **daily dominant first**. Wind: omitted entirely if speed is null; today prefers current wind. |
| Guestbook | Per-day notes: optional nickname ≤40, text 1–500, honeypot `company`, char counter, “Post to this day”. Render nickname/time/body as text only. Empty: “No notes for this day yet.” |
| Pictures | “Upload a picture” → hidden file input. Accept JPEG/PNG/WebP/GIF/HEIC/HEIF. Compress in-browser to JPEG data URL (~1024px long side, fallback smaller). Store on `photos` doc (`dayKey`, `url`, `path`, `createdAt`). Full-width vertical stack, `height: auto`, **no inner photo scroller**. Timeout instead of infinite spinner. |
| Auth / abuse | Anonymous Auth, App Check reCAPTCHA v3, honeypot, **one page-wide** client rate limit for comments and one for photos, Firestore create-only + size/length rules. Public reads (snapshots run even if anonymous sign-in fails). |
| Closed UI | `#closed` card visible, `#live` hidden. No tiles, no Firebase, no new notes/pictures. Copy: site ran through end of Sept 3, 2026 Eastern. |
| Hosting | Static files under `holland2/`. Intended URL `https://pmcculfor.github.io/minisites/holland2/`. Repo `.nojekyll` already at root. Same App Check domain as holland: `pmcculfor.github.io`. |

### UX constraints (must hold on holland2)

1. **Phone: no pinch-zoom.** Viewport `width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover`. Root `touch-action` must not allow pinch (`manipulation` or `pan-x pan-y`, never `pinch-zoom`).
2. **Vertical page scroll works even while the pointer is over a day card** (sky, notes, pictures, form). The horizontal scroller must not trap vertical pans.
3. **Horizontal swipe between days** on the weather strip (and anywhere on the tile that is not a text field / button). Scroll-snap per tile. Nav chevrons on wide screens; hidden below 600px.
4. **Mouse wheel over a day card scrolls the PAGE**, not the horizontal scroller — including over a focused textarea (original does **not** exempt wheel). Trackpad horizontal gestures / Shift+wheel may still move the carousel.
5. **Photos stack full-width vertically** inside the tile. Tile height grows with content. Page (not an inner list) is the vertical scroller.
6. **Desktop:** grab-drag on the sky header moves days; arrow keys on the focused scroller (not when focus is in a form control); prev/next buttons; snap after drag.
7. **Loading:** spinner “Loading Holland conditions…” until weather/wave requests settle. Error card if both fail. Degraded OK if one of weather or waves succeeds.
8. **Uploads:** status “Reading picture…” / “Shrinking picture…” / “Saving picture…” / “Uploaded.”; 45s timeout on compress **and** on `addDoc` separately; 20 MB pre-compress cap; 4s client cooldown (page-wide); HEIC fallback error if unreadable.

### Visual language to preserve

- Fonts: Fraunces (headings, temps) + Nunito Sans (body), same Google Fonts URL.
- Tokens: sky/water/sand/paper/ink/dune/grass/error from `:root` in `holland/styles.css`.
- Horizon gradient behind the page.
- Paper cards, 18px radius, soft shadow.
- Tile sky weather art via `::before`/`::after` (sun, clouds, rain streaks, snow dots, lightning). Dark text inversion class for rain/thunder.
- Today tile: inset 2px ring.
- Guestbook on sand-tinted comment chips; dashed divider above photos.
- Footer on deep water, light links.

---

## 3. Diagnosis of original architecture problems

Cite original files/functions. holland2 must not repeat these.

### 3.1 Duplicate helpers — `app.js` + `comments.js`

- `detroitDayKey` is defined in both (`app.js:44`, `comments.js:7`).
- `el` (`app.js:243`) and `node` (`comments.js:34`) are the same DOM factory.
- `TIME_ZONE` is duplicated (`app.js:3`, `comments.js:3`).
- Close date lives in `app.js` (`LAST_OPEN_DAY`) **and** `firestore.rules` (`stillOpen`) with no shared comment pointing both at a config module.

**holland2:** `lib/time.js` + `lib/dom.js` + `config.js`. Nothing else reimplements them.

### 3.2 `weatherClass` as if/includes — `app.js:276–290`

Long `if` / `[].includes` chain mapping WMO codes to CSS class names. Labels live in a separate `WMO` object (`app.js:11–40`). Dark-skin list is a third structure (`isDarkWeather`, `app.js:292–294`).

**holland2:** one `WEATHER_SKINS` table. Lookup returns `{ className, label, dark }`. Labels copied verbatim from original `WMO` (including duplicates).

### 3.3 Wave fetch as three ad-hoc functions — `app.js:146–223`

`fetchOpenMeteoWaves`, `fetchNwsWaves`, `fetchWaves` with sequential `if (x) return x`. Parsing (`dailyMapFromOpenMeteo`, `nwsDailyByDate`, `isUsableWave`) is mixed into fetchers. GFS “often returns zeros” knowledge is a comment, not a named predicate used by the chain.

**holland2:** `WaveProvider` interface + ordered `WAVE_PROVIDERS` list + `runProviderChain(providers)` with **per-provider try/catch**.

### 3.4 `paintFeeds` / `paintPhotos` near-duplicates — `comments.js:177–199`

Identical group-by-`dayKey` then querySelectorAll paint loops. Two collections, one idea.

**holland2:** generic `groupBy(docs)` in the store (or `lib/group.js`), and each component receives **its** day’s records. Components do not query the whole document. SiteController holds `tiles[]` and fans out.

### 3.5 Carousel mixing four input systems — `app.js:364–461`

`initCarousel` owns:

- Click nav (`forecast-prev` / `forecast-next`)
- Keyboard arrows
- Pointer-drag (mouse only, and only if `event.target.closest(".tile-sky")`)
- Custom touch-axis interceptor (`touchAxis` x/y, `preventDefault` + `window.scrollBy` for vertical)
- Wheel special-case (`deltaY` vs `deltaX`, `preventDefault` + `window.scrollBy`)

These were bolted on after scroll fights (git: `c9c8c4b`, `8f7b339`, `5ae717b`). There is no named policy.

**holland2:** `DayCarousel` owns snap/nav/keyboard/mouse-drag. `ScrollCoordinator` owns nested-scroll intent (touch + wheel only). One `classify()` function; wheel is a discrete delta **source** into that function, not a second policy and not a second handler in DayCarousel.

### 3.6 Wheel handler special-cases the scroller — `app.js:449–457`

```js
if (Math.abs(event.deltaY) < Math.abs(event.deltaX) || event.deltaY === 0) return;
event.preventDefault();
window.scrollBy(0, event.deltaY);
```

This exists because `overflow-x: auto` makes the scroller a scrollport that eats `deltaY`. Patching the symptom in the carousel file mixed concerns.

**holland2:** coordinator policy: vertical delta never belongs to the horizontal scroller. Wheel events feed the same classifier with raw `deltaY` (no `deltaMode` conversion).

### 3.7 Two-phase guestbook — `createDayGuestbook` then `initComments`

`createDayGuestbook` (`comments.js:58–137`) builds a large DOM tree with `data-*` hooks. `initComments` (`comments.js:489–578`) later `querySelectorAll`s the whole document and binds forms/uploads/snapshots. Closed path calls `initComments({ closed: true })` which returns before tiles exist (`app.js:526–527`). Live path binds only after `loadConditions` paints tiles (`app.js:529`). Fragile if render order changes.

**holland2:** `Guestbook` and `PhotoStrip` construct their DOM and bind **their own** form/upload listeners in the constructor. They do **not** subscribe and do **not** import `firebase/client.js`. `DayTile` composes them with `store: null`. After weather paint, SiteController calls `connectFirebase`, `attachStore`, and runs **one** comments listener + **one** photos listener, then fans snapshots to `tiles[]`. Closed site never mounts tiles (no `closed` flag on Guestbook).

### 3.8 Scattered magic numbers

| Number | Where | Meaning |
|---|---|---|
| 12000 | `app.js:79` | fetch timeout |
| 45000 | `comments.js:203` | upload timeout (compress **and** write, separately) |
| 8000 | `comments.js:452` | comment cooldown (page-wide `lastSubmit`) |
| 4000 | `comments.js:367` | photo cooldown (page-wide `lastUpload`) |
| 200 | `comments.js:553` | comment query limit |
| 60 | `comments.js:565` | photo query limit |
| 500 / 40 | comments + rules | text / nick |
| 900000 / 180*1024 | comments + rules | data-URL / binary size |
| 20*1024*1024 | `comments.js:201` | pre-compress file cap |
| 1024/960/800/640 + qualities | `comments.js:273–278` | compress ladder |
| 8 (px) | `app.js:438` | touch axis threshold |

**holland2:** all in `config.js` (`limits`, `timeouts`, `rateLimit`, `image`, `scroll`). Fetch, store, and UI import them. Cooldowns are one shared `RateLimiter` pair, not per-tile clocks.

### 3.9 CSS tile-count special cases — `styles.css:175–181, 624–648`

Four independent `grid-auto-columns` formulas:

- default 3: `calc((100% - 1.7rem) / 3)`  → 2 × 0.85rem gap
- ≥1400px 4: `calc((100% - 2.55rem) / 4)`
- ≤900px 2: `calc((100% - 0.85rem) / 2)`
- ≤600px 1: `100%` + hide nav

The model is one formula: `(100% - (n - 1) * gap) / n`. It was written four times.

**holland2:** `--tile-gap` + `--visible-tiles`. One `grid-auto-columns` declaration. Breakpoints only change `--visible-tiles`.

### 3.10 Mixed concerns in `comments.js`

One file: DOM factory, guestbook markup, comment render, photo render, image compression, Firebase init, App Check, anonymous auth, two `onSnapshot`s, form bind, upload bind, error-string mapping.

**holland2:** split into `firebase/client.js`, `firebase/store.js`, `media/image-pipeline.js`, `lib/safe-url.js`, `lib/rate-limit.js`, `ui/Guestbook.js`, `ui/PhotoStrip.js`, `ui/errors.js`.

### 3.11 Closed vs live as scattered flags

`applyClosedState` toggles two `hidden` attributes (`app.js:519–522`). `initComments({ closed })` early-returns. Guestbook markup is never built when closed (good) but the closed decision is not a named phase; preview query is inlined in `isSiteClosed`.

**holland2:** `SiteController` with phases `closed | loading | ready | error`. Preview is one input to `resolveClosed({ now, searchParams, lastOpenDay, previewParam })`. CLOSED never mounts tiles and never calls Firebase.

### 3.12 Today special-casing in `buildDays` / `renderTile`

`buildDays` (`app.js:250–274`) stamps `currentTemp` / `currentWx` / `waveNowM` only when `isToday`. `renderTile` (`app.js:325–338`) branches wave copy the same way. “Current observations” is not a field on the day; it is a pile of nullable properties.

**holland2:** `Day { forecast, observations }` where `observations` is `null` unless this day is the Detroit “today” **and** current data exists. One calendar flag `day.isCurrent` drives the `is-today` CSS class and the “Today” kicker. Weather / wave / wind / temp **copy** is driven by presence of `observations` / `waves.now`, not a second `if (isToday)` inside formatters. `buildDays` still uses `isCurrent` to assign those fields (necessary).

### 3.13 CSS overflow trap (root cause of scroll patches)

`styles.css:175–191`: `.forecast-scroller` has `overflow-x: auto; overflow-y: hidden`. CSS spec: if one axis is not `visible`, the other `visible` computes to `auto`. A tall overflow-x scroller on iOS still captures vertical pans. Guestbook/photo `touch-action: pan-y` was a partial fix; JS interceptors finished the job.

**holland2:** treat nested scroll as a first-class design (section 6). CSS containment (`overflow-y: hidden` + original `touch-action: pan-x pan-y` on the scroller) + one intent classifier. Wheel is a delta source into that classifier. No `matchMedia`, no `if (iOS)`, no pointermove+touchmove both calling `scrollBy`.

---

## 4. Proposed module map

```
holland2/
  index.html                 # shell: masthead, #closed, #live, #conditions, footer
  styles.css                 # tokens, layout, weather skins, carousel columns
  firebase-config.js         # same values as holland/; isFirebaseConfigured()
  firestore.rules            # copy of holland/ (must stay in sync with console)
  storage.rules              # copy of holland/ (unused; documentation)
  README.md                  # Pages + Firebase, holland2 URL, shared collections
  app.js                     # bootstrap only: config → SiteController.start()
  config.js                  # ALL product constants
  lib/
    time.js                  # Detroit day keys, close check, formatDayLabel, durationToMs
    dom.js                   # el(), clear()
    http.js                  # fetchJson(url, { timeoutMs, headers })
    group.js                 # groupBy(key)
    safe-url.js              # isSafeImageSrc (DOM sink only)
    rate-limit.js            # shared comment/photo cooldowns
  domain/
    models.js                # Day, Conditions, WaveObservation, Comment, Photo, headlines, formatters
    weather-skins.js         # WMO code → { className, label, dark }
    day-builder.js           # weather + waves → Day[]
  data/
    weather.js               # OpenMeteoWeatherProvider
    waves.js                 # OpenMeteoMarineProvider, NwsWaveProvider, runProviderChain, isUsableWave
  media/
    image-pipeline.js        # File → JPEG data URL (compress ladder)
  firebase/
    client.js                # app, App Check, anonymous auth (once)
    store.js                 # CommentsRepo + PhotosRepo
  ui/
    SiteController.js        # phase machine: closed | loading | ready | error
    ClosedNotice.js
    ConditionsCard.js        # loading/error/as-of/disclaimer chrome around carousel
    DayCarousel.js           # snap, nav buttons, keyboard, drag-on-sky; owns ScrollCoordinator
    DayTile.js               # sky + guestbook + photos for one Day
    Guestbook.js             # feed + form; owns listeners; does not subscribe
    PhotoStrip.js            # upload + vertical list; owns listeners; does not subscribe
    ScrollCoordinator.js     # nested scroll policy (see §6)
    errors.js                # all user-visible error/status strings + mapPhotoError
```

There is no `#app` mount, no `a11y/live.js`, no `ui/status.js`, no `lib/format.js`. Conditions card already has `aria-live="polite"` in HTML.

### One-sentence responsibility each

| Path | Responsibility |
|---|---|
| `index.html` | Static chrome and empty mounts (`#closed`, `#conditions`, `#forecast-scroller`, `#live`). No per-day markup. Reuse original ids. |
| `styles.css` | Visual design and carousel geometry via CSS variables. No JS-driven class soup beyond weather skins and `is-today`. |
| `firebase-config.js` | Public Firebase + reCAPTCHA keys. Copied values from `holland/firebase-config.js`. |
| `config.js` | Location, dates, URLs, limits, timeouts, provider ids, image ladder, query limits. Imports nothing from `ui/` or `data/`. |
| `app.js` | Import css is via HTML. JS: `SiteController.create(document).start()`. Phase 0 temporarily logs “holland2 scaffold” instead. |
| `lib/time.js` | Timezone-aware day keys, `formatDayLabel` UTC-16, `durationToMs`, display timestamps. |
| `lib/dom.js` | `el()` / `clear()`; no product logic; no delegate helpers. |
| `lib/http.js` | Abortable JSON fetch with timeout from config. |
| `lib/group.js` | `groupBy(items, keyFn) → Map`. |
| `lib/safe-url.js` | `isSafeImageSrc(value)` for **display**; never used as a write-time filter. |
| `lib/rate-limit.js` | Page-wide comment and photo cooldowns; stamp after successful write. |
| `domain/models.js` | Normalized objects + `waveHeadline` / `windHeadline` / `tempHeadline` / `formatWaveFt` / `formatTemp` / `compassFromDegrees` + `COMPASS`. Does not import `ui/`. |
| `domain/weather-skins.js` | Data table + `skinForCode(code)`. |
| `domain/day-builder.js` | Merge weather + wave payloads into `Day[]`. |
| `data/weather.js` | One weather provider, one `fetch()` returning `{ current, daily, source, fetchedAt }`. |
| `data/waves.js` | Provider objects with identical `fetch()`; chain runner; `isUsableWave`. |
| `media/image-pipeline.js` | Compress + data-URL encode; throws typed errors (`unreadable`, `too-large`, `timeout`). |
| `firebase/client.js` | Idempotent `connectFirebase()`. Does not import `ui/*`. |
| `firebase/store.js` | `subscribeComments`, `subscribePhotos`, `addComment`, `addPhoto`. Does not import `ui/*`. |
| `ui/SiteController.js` | Owns phase, loads data, mounts children, is the **only** `connectFirebase` caller, fans snapshots. |
| `ui/ClosedNotice.js` | Closed card visibility + copy. |
| `ui/ConditionsCard.js` | Loading / error / ready chrome; hosts carousel. |
| `ui/DayCarousel.js` | Horizontal paging of `DayTile`s; constructs/binds/destroys `ScrollCoordinator`. |
| `ui/DayTile.js` | One day’s presentation; composes sky + Guestbook + PhotoStrip. |
| `ui/Guestbook.js` | Notes for one `dayKey`. Does not subscribe. Does not import `firebase/client.js`. |
| `ui/PhotoStrip.js` | Pictures for one `dayKey`. Does not subscribe. Does not import `firebase/client.js`. |
| `ui/ScrollCoordinator.js` | Axis lock + routing for nested horizontal carousel in a vertical page. Must **not** import DayCarousel. |
| `ui/errors.js` | `ERRORS` table + `mapPhotoError`. |

### Imports

Every import path includes the `.js` extension (required for native ESM on GitHub Pages). Relative imports such as `ui/SiteController.js` → `../firebase/client.js` and `app.js` → `./ui/SiteController.js` work on same-origin static files.

There is no circular import in the intended graph. The risk is SiteController ↔ DayCarousel ↔ ScrollCoordinator if the coordinator imported the carousel. **Coordinator must not import DayCarousel.** `firebase/client.js` does not import `ui/*`. `config.js` imports nothing in `ui/` or `data/`. `domain/models.js` does not import `ui/`.

Firebase CDN modules: gstatic version **11.0.2** (same as original). `connectFirebase` loads them. `store.js` **may** static- or dynamic-import the same `firebase-firestore.js` URL; browser ESM treats it as a singleton. Callers of the store never import `collection()` / `addDoc` themselves.

---

## 5. Core types and public APIs

JavaScript has no types at runtime. Examples below are untyped JS plus `//` comments (JSDoc `@param` / `@returns` in the implementing files is fine). Do not paste TypeScript `function foo(): string` into `.js` files.

### 5.1 Config (`config.js`)

```js
export const CONFIG = {
  timeZone: "America/Detroit",
  lastOpenDay: "2026-09-03",           // inclusive; closed when detroitDayKey() > this
  previewClosedParam: "previewClosed",
  forecastDays: 7,
  city: { lat: 42.7875, lon: -86.1089 },
  wavePoint: { lat: 42.9, lon: -86.5 },
  nwsPoint: { lat: 42.9, lon: -86.27 },
  openMeteoForecast: "https://api.open-meteo.com/v1/forecast",
  openMeteoMarine: "https://marine-api.open-meteo.com/v1/marine",
  nwsPoints: function (lat, lon) {
    return "https://api.weather.gov/points/" + lat + "," + lon;
  },
  collections: { comments: "comments", photos: "photos" },
  limits: {
    nickname: 40,
    commentText: 500,
    photoUrlChars: 900000,
    photoPathChars: 400,
    sourceFileBytes: 20 * 1024 * 1024,
    inlineJpegBytes: 180 * 1024,
    commentsQuery: 200,
    photosQuery: 60,
  },
  timeouts: {
    fetchMs: 12000,
    uploadMs: 45000,
  },
  rateLimit: {
    commentMs: 8000,
    photoMs: 4000,
  },
  image: {
    mimeOut: "image/jpeg",
    ladder: [
      { maxSide: 1024, quality: 0.7 },
      { maxSide: 960, quality: 0.56 },
      { maxSide: 800, quality: 0.48 },
      { maxSide: 640, quality: 0.4 },
    ],
    base64Chunk: 0x8000,
  },
  scroll: {
    axisThresholdPx: 8,
    snapBehavior: "smooth",
    touchExemptSelector: "input, textarea, select, button, a, label",
  },
  firebaseCdnVersion: "11.0.2",
};
```

`lastOpenDay` is the **client** close key. Firestore `stillOpen()` stays in `firestore.rules` (console-published). README must state they are one policy expressed twice.

`CONFIG.scroll.snapBehavior` is the default for nav/keyboard/snap. DayCarousel must read `prefers-reduced-motion` (or a helper) and use `"auto"` when that query matches, rather than always using CONFIG.

### 5.2 Time (`lib/time.js`)

```js
export function detroitDayKey(date, timeZone) {}
// date defaults to new Date(); timeZone defaults to CONFIG.timeZone
// en-CA YYYY-MM-DD in timeZone

export function isAfterLastOpenDay(date, lastOpenDay, timeZone) {}
// detroitDayKey(date) > lastOpenDay

export function resolveClosed(opts) {}
// opts: { now, searchParams, lastOpenDay, previewParam }
// true if searchParams.get(previewParam) === "1" OR isAfterLastOpenDay

export function formatDayLabel(dayKey, opts) {}
// opts: { isCurrent, timeZone }
// Parse dayKey as YYYY-MM-DD numbers.
// Instant: new Date(Date.UTC(year, month - 1, day, 16))
//   (hour 16 UTC is noon Eastern in EDT; avoids UTC-midnight → previous Detroit calendar day)
// weekday = Intl en-US weekday:"short" with timeZone
// date    = Intl en-US month:"short", day:"numeric" with timeZone
// return { kicker: isCurrent ? "Today" : weekday, date: monthDay }

export function formatClock(date, timeZone) {}
// as-of style: weekday short + hour numeric + minute 2-digit (original as-of)

export function formatCommentTime(date, timeZone) {}
// hour:minute

export function durationToMs(duration) {}
// original parseIsoDuration: days*86400000 + hours*3600000 + minutes*60000; missing → 0
```

Do not put `location.search` inside `time.js`. `SiteController` passes `searchParams`.

NWS grid walk **must** keep original operator precedence when combining start + duration:

```js
const end = new Date(start.getTime() + durationToMs(duration) || 3600000);
```

That is `(start.getTime() + durationToMs(duration)) || 3600000`. Do not “fix” it to `start.getTime() + (durationToMs(duration) || 3600000)`.

### 5.3 DOM (`lib/dom.js`)

```js
export function el(tag, attrs, children) {}
// attrs default {}; children default []
// attrs: class, text, dataset, type, name, …
// text via textContent only — never innerHTML
// aria-* via setAttribute (not a property dump that skips the hyphen)

export function clear(node) {}
```

No delegate / `on(el, type, selector, fn)` helper. Bind listeners on the component’s own elements.

### 5.4 HTTP (`lib/http.js`)

```js
export function fetchJson(url, opts) {}
// opts: { timeoutMs, headers, signal }
// AbortController + timeout; throws HttpError with status and message
```

### 5.5 Domain models (`domain/models.js`)

Plain objects from factories (not classes), so they serialize easily in tests. Compass, temp, and wave-ft live **here**, next to the headlines. Do not add `lib/format.js`.

```js
export function conditions(fields) {}
// fields: { weatherCode, tempF, highF, lowF, windMph, windDirDeg }
// missing numbers stay null

export function waveObservation(fields) {}
// fields: { heightM, periodS, directionDeg, source }
// Internal name is directionDeg. Parsers map Open-Meteo wave_direction_dominant /
// wave_direction and NWS (null). Waves are not written to Firestore; do not persist directionDeg.

export function day(fields) {}
// fields: {
//   dayKey,          // "YYYY-MM-DD"
//   isCurrent,       // Detroit today
//   forecast,        // Conditions (daily)
//   observations,    // Conditions | null  (current wx/wind/temp)
//   waves,           // { now: WaveObservation|null, max: WaveObservation|null }
//   weatherSource,
//   waveSource,
// }

export function commentFromDoc(data) {}
// { nickname, text, createdAt, dayKey }

export function photoFromDoc(data) {}
// { dayKey, url, path, createdAt }
```

```js
export const COMPASS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

export function compassFromDegrees(deg) {}
// null / NaN → "" (empty string, not "—")
// else COMPASS[Math.round(Number(deg) / 22.5) % 16]

export function formatTemp(f) {}
// `${Math.round(f)}°`

export function formatWaveFt(meters) {}
// null / NaN → "—"
// else feet = meters * 3.28084
// if feet < 0.15 → "Calm"
// else one decimal + " ft"  (e.g. "1.2 ft")

export function tempHeadline(day) {}
// day.observations?.tempF ?? day.forecast.highF
// both null → "—" else formatTemp

export function windHeadline(day) {}
// speed = observations.windMph ?? forecast.windMph
// dir   = observations.windDirDeg ?? forecast.windDirDeg
// if speed == null → return null (caller omits the line; do not print "Wind —")
// else `Wind ${Math.round(speed)} mph` plus space + compass if compass is non-empty

export function waveHeadline(day) {}
// compass from (waves.max?.directionDeg ?? waves.now?.directionDeg)  // daily first
// if waves.now:
//   bits = [`Now ${formatWaveFt(now.heightM)}`]
//   if waves.max: bits.push(`max ${formatWaveFt(max.heightM)}`)
// else if waves.max:
//   bits = [`Waves ${formatWaveFt(max.heightM)}`]
// else:
//   bits = [`Waves —`]
// if compass: bits.push(compass)
// return bits.join(" · ")
```

Formatters read `observations` / `waves.now`. They do not take an `isToday` argument. The kicker is allowed to use `isCurrent` via `formatDayLabel`.

### 5.6 Weather skins (`domain/weather-skins.js`)

Copy original `WMO` (`app.js:11–40`) verbatim. Duplicate labels are intentional (`Freezing drizzle` on 56 and 57, `Rain showers` on 80 and 81, `Thunderstorm with hail` on 96 and 99).

```js
export const WEATHER_SKINS = [
  { codes: [0], className: "wx-clear", label: "Clear", dark: false },
  { codes: [1], className: "wx-mostly", label: "Mostly clear", dark: false },
  { codes: [2], className: "wx-partly", label: "Partly cloudy", dark: false },
  { codes: [3], className: "wx-overcast", label: "Overcast", dark: false },
  { codes: [45], className: "wx-fog", label: "Fog", dark: false },
  { codes: [48], className: "wx-fog", label: "Icy fog", dark: false },
  { codes: [51], className: "wx-drizzle", label: "Light drizzle", dark: false },
  { codes: [53], className: "wx-drizzle", label: "Drizzle", dark: false },
  { codes: [55], className: "wx-drizzle", label: "Heavy drizzle", dark: false },
  { codes: [56], className: "wx-drizzle", label: "Freezing drizzle", dark: false },
  { codes: [57], className: "wx-drizzle", label: "Freezing drizzle", dark: false },
  { codes: [61], className: "wx-rain", label: "Light rain", dark: true },
  { codes: [63], className: "wx-rain", label: "Rain", dark: true },
  { codes: [65], className: "wx-heavy", label: "Heavy rain", dark: true },
  { codes: [66], className: "wx-rain", label: "Freezing rain", dark: true },
  { codes: [67], className: "wx-rain", label: "Freezing rain", dark: true },
  { codes: [71], className: "wx-snow", label: "Light snow", dark: false },
  { codes: [73], className: "wx-snow", label: "Snow", dark: false },
  { codes: [75], className: "wx-snow", label: "Heavy snow", dark: false },
  { codes: [77], className: "wx-snow", label: "Snow grains", dark: false },
  { codes: [80], className: "wx-showers", label: "Rain showers", dark: true },
  { codes: [81], className: "wx-showers", label: "Rain showers", dark: true },
  { codes: [82], className: "wx-heavy", label: "Heavy showers", dark: true },
  { codes: [85], className: "wx-snow", label: "Snow showers", dark: false },
  { codes: [86], className: "wx-snow", label: "Heavy snow showers", dark: false },
  { codes: [95], className: "wx-thunder", label: "Thunderstorm", dark: true },
  { codes: [96], className: "wx-thunder", label: "Thunderstorm with hail", dark: true },
  { codes: [99], className: "wx-thunder", label: "Thunderstorm with hail", dark: true },
];

export const FALLBACK_SKIN = { className: "wx-overcast", label: "—", dark: false };

export function skinForCode(code) {}
// lookup by Number(code); unknown → FALLBACK_SKIN
```

Dark class names match original `isDarkWeather`: `wx-rain`, `wx-showers`, `wx-heavy`, `wx-thunder`.

### 5.7 Day builder (`domain/day-builder.js`)

```js
export function buildDays(weatherPayload, wavePayload, opts) {}
// opts: { now, timeZone, forecastDays }
```

Algorithm:

1. `dates = weatherPayload?.daily.time slice-copy, else sorted keys of wavePayload.dailyByDate`.
2. **Do not slice** the date list to `forecastDays`. Weather is requested with `forecast_days=7`, so the weather branch is already 7 days. Wave-only fallback (NWS) must keep **all** `dailyByDate` keys, as original `buildDays` does.
3. For each index `i`, `dayKey = dates[i]`.
4. `isCurrent = dayKey === detroitDayKey(now)`.
5. `forecast` from daily arrays at `i` (null-safe). When dates came from waves only, forecast numeric fields are null.
6. `observations = isCurrent ? conditions(from weatherPayload.current) : null` (null if no current).
7. `waves.max` from `wavePayload.dailyByDate[dayKey]`.
8. `waves.now = isCurrent ? (wavePayload.current ?? waves.max) : null`.
9. Attach `weatherSource` / `waveSource` strings for the as-of line (card-level, not per tile). Open-Meteo marine source is ``Open-Meteo ${model}``. NWS source is `"National Weather Service"`. Weather source is `"Open-Meteo"`.

`isCurrent` assignment of observations / `waves.now` is the only calendar branch in the builder. Formatters do not take a second `isToday`.

### 5.8 Providers

```js
// WaveForecast = { current: WaveObservation|null, dailyByDate: Record<dayKey, WaveObservation>, source: string }

export function isUsableWave(height, period) {
  if (height == null || Number.isNaN(Number(height))) return false;
  const h = Number(height);
  const p = period == null ? null : Number(period);
  if (h === 0 && (p === 0 || p == null)) return false;
  return true;
}
// Copy of holland/app.js:85–91. Height 0 with a real period is usable.
// Tests must include (0, 4) === true and (null, 4) === false / (null, 1) === false.

export function runProviderChain(providers, opts) {}
// opts.log optional
// for each provider p:
//   try {
//     const r = await p.fetch();
//     if (r && (Object.keys(r.dailyByDate).length > 0 || r.current != null)) return r;
//   } catch (e) { if (opts.log) opts.log(e); else console.error(e); }
// after the list: throw new Error("No wave forecast was available for this location.")
```

`isUsableWave` is applied **inside marine parsers** so GFS zeros become `null` at parse time (a provider that parsed nothing returns `null` and the chain continues). The chain’s “usable result” check is `Object.keys(dailyByDate).length > 0 || current != null`. A thrown `fetch()` (HTTP 500, timeout, JSON) must not abort the chain.

```js
export function OpenMeteoWeatherProvider(config) {}
OpenMeteoWeatherProvider.prototype.fetch = async function () {};

export function OpenMeteoMarineProvider(opts) {}
// opts: { model, point, config }
// model: "ecmwf_wam025" | "ncep_gfswave025"
// source string: `Open-Meteo ${model}`

export function NwsWaveProvider(opts) {}
// opts: { point, config }
// points → grid → waveHeight.values
// bucket by detroitDayKey via ISO duration expansion (durationToMs; keep original || 3600000)
// current for NWS remains “today’s daily max”, not a separate observation
```

Weather and waves load in parallel (`Promise.allSettled`) inside `SiteController.load`. Ready if **either** succeeds; error only if both fail or `buildDays` returns empty (original `loadConditions`). One `console.error` per rejected branch.

### 5.9 Image pipeline (`media/image-pipeline.js`)

```js
export async function fileToInlineJpeg(file, opts) {}
// opts: { limits, ladder, timeoutMs, chunkSize }
```

Steps (match original `compressToInlineJpeg` / `blobToJpegDataUrl`):

1. Type check (image MIME or filename `jpe?g|png|webp|gif|heic|heif`) and size check (`sourceFileBytes`).
2. Bitmap: `createImageBitmap(blob, { imageOrientation: "from-image" })`, fallback `Image` + object URL.
3. For each ladder step: scale so long side ≤ `maxSide`; create canvas; **`ctx.fillStyle = "#ffffff"` then `fillRect` then `drawImage`** (HEIC/PNG alpha must not stay transparent in JPEG).
4. `canvas.toBlob(..., "image/jpeg", quality)` until `blob.size <= inlineJpegBytes`.
5. Encode: `arrayBuffer` → `Uint8Array` → chunked `String.fromCharCode(...bytes.subarray(i, i + chunk))` + `btoa`. Chunk size `0x8000`. A single `String.fromCharCode(...bytes)` throws on large photos — do not do that.
6. If data URL length > `photoUrlChars` or last blob still too large → throw `too-large`.

Throws `Error` whose `message` is one of: `unreadable`, `too-large`, `timeout`, `compress-failed`, `not-image`, `file-too-large`.

`PhotoStrip` maps those codes to user strings (section 11). Pipeline does not know Firebase.

**Timeouts are not only in the pipeline.** PhotoStrip wraps `fileToInlineJpeg` **and** `store.addPhoto` each with a separate `withTimeout(..., CONFIG.timeouts.uploadMs, "timeout")`. A hung Firestore write must not spin forever.

### 5.10 Firebase

```js
// firebase/client.js
export async function connectFirebase() {}
// Returns one of:
//   { ok: false, reason: "unconfigured" }
//   { ok: true, app, auth, db, canWrite, firestore }
// firestore: { collection, addDoc, query, orderBy, onSnapshot, serverTimestamp, limit }
//   (store.js may instead import the same gstatic 11.0.2 firebase-firestore.js URL;
//    ESM singleton. Pick one; do not initializeApp twice.)
```

Behavior:

- If `!isFirebaseConfigured()` → `{ ok: false, reason: "unconfigured" }`. No SDK load.
- Else `initializeApp`, optional App Check (`ReCaptchaV3Provider` when `recaptchaSiteKey` is non-empty), `getAuth` / `getFirestore`, then `signInAnonymously`.
- If anonymous sign-in **fails**: still `{ ok: true, canWrite: false }`. Log the error. Public reads do not need auth. Do **not** return `reason: "auth-failed"` as a terminal connect failure.
- `canWrite === !!auth.currentUser` after the sign-in attempt.

**Cache rules:** cache the **in-flight** promise so concurrent callers share one connection. Cache a resolved `unconfigured` result (deterministic). Do **not** cache a rejected promise from a transient network / SDK-load failure without a retry path — the next `connectFirebase()` must try again. An `ok: true` result (including `canWrite: false`) may be cached for the page lifetime.

**Only `SiteController` calls `connectFirebase`.** Guestbook and PhotoStrip do not import `firebase/client.js`.

```js
// firebase/store.js
export function createStore(db, opts) {}
// opts: { auth, config, firestore }  // firestore fns from connectFirebase or same-URL import
// returns:
{
  subscribeComments: function (onNext, onError) {},  // Unsubscribe
  subscribePhotos: function (onNext, onError) {},
  addComment: function (input) {},                   // { nickname, text, dayKey }
  addPhoto: function (input) {},                     // { dayKey, url }  — store builds path
}
```

Both subscribe helpers: `orderBy("createdAt", "desc")` + `limit(config.limits.*)`, map docs through `commentFromDoc` / `photoFromDoc`.

`addComment` / `addPhoto` use `serverTimestamp()` for `createdAt` (`createdAt == request.time` in rules).

`addPhoto` generates `path` as ``days/${dayKey}/${uid}_${Date.now()}.jpg`` from `auth.currentUser.uid`. UI passes `{ dayKey, url }` only. If there is no uid, PhotoStrip must not call `addPhoto`; it shows `ERRORS.photoAuth`.

`isSafeImageSrc` is **not** a write-time filter (pipeline emits JPEG data URLs that the allowlist accepts; rules `validPhoto()` gate writes). Do not reject our own data URLs on write.

Repository pattern: same object shape, different collection name + mapper:

```js
function makeCollectionRepo(db, name, opts) {
  return {
    subscribe: function (onNext, onError) {},
    add: function (fields) {},
  };
}
```

Callers never import `collection()` / `addDoc` themselves.

### 5.11 UI components

Each component: `constructor(props)`, `element` getter, `destroy()`. No framework.

```js
new ClosedNotice({ root: HTMLElement })
.show()
.hide()

new ConditionsCard({ root: HTMLElement })
.setPhase("loading" | "error" | "ready", { message, asOf })
.mountCarousel(carouselElement)

new DayTile({ day: Day, pipeline, rateLimiters })
// constructs Guestbook + PhotoStrip with store: null
.element
.attachStore(store)
.setComments(Comment[])
.setPhotos(Photo[])
.destroy()

new Guestbook({ dayKey, store, rateLimiter })
// store may be null; no `closed` flag (closed site never mounts tiles)
.element
.attachStore(store)
.setItems(Comment[])
.setFeedState("loading" | "empty" | "ready" | "setup" | "error", message)
.destroy()

new PhotoStrip({ dayKey, store, pipeline, rateLimiter })
// no `auth` (path is store.addPhoto’s job); no `closed` flag
.element
.attachStore(store)
.setItems(Photo[])
.setListState("loading" | "empty" | "ready" | "setup" | "error", message)
.destroy()

new DayCarousel({ scroller, prevBtn, nextBtn })
// does NOT take a coordinator; it creates one in constructor/bind
.setTiles(DayTile[])
.scrollByTiles(deltaIndex)
.destroy()

// ScrollCoordinator — see §6. Created only by DayCarousel.
export function createScrollCoordinator(opts) {}
// opts: { scroller, getPageScroller, thresholdPx, isExemptTarget }
.bind()
.destroy()

SiteController.create(document)
.start()
.destroy()
```

**Shared rate limiter** (`lib/rate-limit.js`), owned by SiteController (or created once in `start` and passed down):

```js
export function createCooldown(ms) {
  let lastSuccess = 0;
  return {
    isBlocked: function () {
      return Date.now() - lastSuccess < ms;
    },
    stamp: function () {
      lastSuccess = Date.now();
    },
  };
}

export function createRateLimiters(config) {
  return {
    comment: createCooldown(config.rateLimit.commentMs),
    photo: createCooldown(config.rateLimit.photoMs),
  };
}
```

One `comment` cooldown and one `photo` cooldown for the **whole page**. Pass `rateLimiters.comment` into every Guestbook and `rateLimiters.photo` into every PhotoStrip. Stamp **after** a successful write (original `lastSubmit` / `lastUpload`). Failed writes do not start the cooldown. Do not keep `Date.now()` inside each instance.

**`attachStore(store)`:** tiles exist and have already painted weather (feeds still say “Loading notes…” / “Loading pictures…”). After `connectFirebase` + `createStore`, SiteController calls `tile.attachStore(store)` on each tile, which forwards to Guestbook and PhotoStrip. Forms are already bound; writes no-op with the original unconfigured/auth copy until a store with `canWrite` exists.

Guestbook and PhotoStrip **do not subscribe**. Components do not import `firebase/client.js`. Only SiteController and `createStore`’s module talk to Firebase.

`setListState` / `setFeedState` both import `ERRORS.firebaseUnconfigured` for `setup` copy.

**DayCarousel keyboard:** on `keydown`, ignore `ArrowLeft` / `ArrowRight` when `event.target` matches `input, textarea, select, [contenteditable]` (original listener is on the scroller, so arrows from a focused textarea bubble and would otherwise hijack). Then `preventDefault` and `scrollByTiles`. Snap `behavior` honors `prefers-reduced-motion` → `"auto"`, else `CONFIG.scroll.snapBehavior`.

**DayCarousel does not listen to `wheel` or `touchmove` and does not call `window.scrollBy`.**

### 5.12 DayTile render contract

`DayTile` paints the sky from `day` using these rules. `is-today` CSS and the kicker are driven by `day.isCurrent`. Weather / wave / wind / temp copy is driven by `observations` / `waves.now` presence.

```
skin code     = day.observations?.weatherCode ?? day.forecast.weatherCode
headline temp = day.observations?.tempF ?? day.forecast.highF
                element text = tempHeadline(day)   // "—" if both null
range         = if forecast.highF and forecast.lowF both non-null:
                  `H ${formatTemp(high)} / L ${formatTemp(low)}`
                else omit the range element
wx label      = skinForCode(skin code).label
waves line    = waveHeadline(day)                  // §5.5; daily compass first; max bit only if waves.max
wind line     = windHeadline(day); omit element if null
is-today class iff day.isCurrent
sky classes   = ["tile-sky", skin.className] plus "wx-dark" if skin.dark
article       = class "forecast-tile", data-day = dayKey,
                aria-label = `Weather and notes for ${dayKey}`
kicker/date   = formatDayLabel(day.dayKey, { isCurrent: day.isCurrent, timeZone })
```

Do not use only `forecast.weatherCode` for today’s art after a front has moved through. Do not use `new Date(dayKey)` for labels (UTC midnight is the previous Detroit calendar day).

---

## 6. Scroll / gesture architecture

This is the hard part. Design it as a product of **layout + CSS + one coordinator**, not three preventDefault patches.

This will not make iOS nested overflow correct in CSS alone. It puts the original two working interceptors (non-passive `touchmove` + non-passive `wheel`) in one object with one classifier. That is the debt in `initCarousel`. That is enough.

### 6.1 Problem statement (single policy)

There is a **vertical page scroller** (the document) and a **horizontal day scroller** (the forecast strip). They share the same pointer. Policy:

> A gesture has one axis. Vertical always moves the page. Horizontal always moves the day strip. Pinch is disabled. Form controls are exempt from **touch** axis locking so native caret / scroll / click work.

Wheel is a **discrete delta source** to the same `classify()` function. Wheel does **not** axis-lock across ticks (each `wheel` event is classified on its own `deltaX` / `deltaY`). Mouse-drag on `.tile-sky` is carousel paging (DayCarousel), not nested-scroll, and is not a coordinator concern.

### 6.2 Why CSS alone is not enough (but is required)

- `overflow-x: auto` on a tall box creates a scrollport. On iOS Safari, that scrollport often wins vertical pans.
- `overflow-x: auto; overflow-y: visible` is invalid: `visible` computes to `auto`.
- Therefore the scroller **must** be `overflow-x: auto; overflow-y: hidden` so it is **not** a vertical overflow scrollport (content height defines the box; the page scrolls).
- `touch-action` is the browser’s un-waited permission. JS exists because iOS still assigns vertical pans to that scrollport.
- **Keep original `touch-action: pan-x pan-y` on `.forecast-scroller`.** Do not switch the scroller to `pan-x` only while also `preventDefault`ing vertical `touchmove`. On engines where `pan-x` already delivers Y to the page, `preventDefault` cancels that page scroll and Y dies unless `scrollBy` is perfect. On iOS where the scrollport still eats Y, JS is required anyway. Original `pan-x pan-y` + steal Y is the known-good pair. Revisit `pan-x` only as a later experiment behind the same classifier, not as the v1 spec.

Viewport stays `maximum-scale=1` as in original (product constraint). Do not add `user-scalable=yes`. `html, body` use `touch-action: manipulation` (pan + tap, **no pinch**). Original used `pan-x pan-y` on `html, body`, which also disables pinch; `manipulation` is the clearer “no zoom” signal and still allows pan.

### 6.3 ScrollCoordinator — one contract

File: `ui/ScrollCoordinator.js`.

```js
export function createScrollCoordinator(opts) {
  // opts.scroller          // .forecast-scroller
  // opts.getPageScroller   // () => window  (inject for tests)
  // opts.thresholdPx       // CONFIG.scroll.axisThresholdPx
  // opts.isExemptTarget    // (el) => el.closest(CONFIG.scroll.touchExemptSelector)
}
```

**Invariants**

1. One gesture, one axis. Axis locks until `touchend` / `touchcancel` (touch) or is computed per `wheel` event (wheel has no lock across ticks).
2. Vertical always moves the **page**. Horizontal always moves the **scroller**. Pinch is not a coordinator concern (viewport + `touch-action` on `html, body`).
3. Coordinator **never** listens to `pointerdown` / `pointermove` / `pointerup`. Pointer on `.tile-sky` with `pointerType !== "touch"` is DayCarousel drag only. Coordinator never `setPointerCapture`.
4. Coordinator **never** branches on iOS / coarse pointer / `PointerEvent` in `window` / `matchMedia`. The listener set is the same on every device.
5. Coordinator does **not** `scrollBy` horizontally. Native `overflow-x` + snap owns X. There is no “unless native pan is known broken” fallback.

**Classifier** (same function for touch and wheel):

```js
export function classify(dx, dy, thresholdPx) {
  if (Math.abs(dx) < thresholdPx && Math.abs(dy) < thresholdPx) return "undecided";
  return Math.abs(dy) >= Math.abs(dx) ? "y" : "x";
}
```

- **Touch:** `dx` / `dy` are client deltas from **start**. Threshold from `CONFIG.scroll.axisThresholdPx`.
- **Wheel:** `dx` / `dy` are `event.deltaX` / `event.deltaY`. Threshold is `0` (no dead zone beyond original `deltaY === 0`). If axis is `y` **and** `deltaY !== 0`, steal; if axis is `x` **or** `deltaY === 0`, return (native horizontal / no-op).

Export `classify` for unit tests.

**Listeners (exactly these, on `scroller` only — not `document`)**

| Event | Passive | Role |
|---|---|---|
| `touchstart` | true | If `touches.length !== 1` or exempt target, ignore. Else record id, x, y; `axis = undecided`. |
| `touchmove` | **false** | If `touches.length !== 1` or exempt target, return. Classify from start. If `y`, `preventDefault` and `page.scrollBy(0, lastY - y)`; update `lastY`. If `x`, return (native `overflow-x` + snap). If `undecided`, return. |
| `touchend` / `touchcancel` | true | Clear identity / axis |
| `wheel` | **false** | Classify this event’s `deltaX` / `deltaY` with threshold `0`. If `y` (`abs(deltaY) >= abs(deltaX)` **and** `deltaY !== 0`), `preventDefault` and `page.scrollBy(0, deltaY)` with **raw** `deltaY` (do not multiply `deltaMode === 1` by 16). If `x` or `deltaY === 0`, return. |

**Exempt targets (touch only):** `closest("input, textarea, select, button, a, label")` on start **and** move. Do not start a lock; do not `preventDefault`. Original `touchstart` skipped `input, textarea, button, a`; `touchmove` skipped only `input, textarea`. holland2 uses one list for both.

**Wheel: no exempt list.** Match original: the page steals vertical wheel even over the comment box. That is a deliberate product choice for parity, not an accident. Do not convert wheel-over-textarea into inner-scroll unless a later spec change says so.

**`bind()` attaches only the table above.** Mouse drag is DayCarousel’s job. There is not a second wheel handler in DayCarousel.

**CSS (one map, no “or”)**

```css
html, body {
  touch-action: manipulation; /* no pinch; pan allowed */
}
.forecast-scroller {
  overflow-x: auto;
  overflow-y: hidden;
  touch-action: pan-x pan-y;  /* KEEP original; JS steals Y */
  overscroll-behavior-x: contain;
  overscroll-behavior-y: auto;
}
.tile-sky {
  touch-action: pan-x pan-y;  /* mouse-drag handle; same as original */
}
.tile-guestbook,
.photo-block {
  touch-action: pan-y;
}
textarea,
input {
  touch-action: manipulation;
}
```

### 6.4 Split of duties: Coordinator vs DayCarousel

| Concern | Owner |
|---|---|
| Axis lock, vertical page forwarding, wheel-to-page | `ScrollCoordinator` |
| Tile width + gap step, snap, prev/next, ArrowLeft/Right (with form-control guard), mouse-drag on `.tile-sky`, disabled nav at ends | `DayCarousel` |
| `touch-action` / overflow / snap / column count | CSS |
| Pinch zoom | viewport + `touch-action: manipulation` on `html, body` |

**DayCarousel constructs `ScrollCoordinator` in `constructor` / `bind`, destroys it in `destroy`. SiteController does not call `ScrollCoordinator.bind` and does not hold a coordinator reference.** `setTiles` may rebind if the scroller was empty.

DayCarousel only: click nav, keyboard (with input guard), mouse-drag on `.tile-sky`, snap on pointerup, `tileStep` = first tile width + computed column-gap, resize updates nav disabled. **No wheel. No touchmove. No `window.scrollBy`.**

Mouse-drag algorithm (carousel, not coordinator):

1. `pointerdown` if `pointerType !== "touch"` and `event.target.closest(".tile-sky")`.
2. Capture pointer, sample `startX`, `startScroll`.
3. `pointermove`: `scroller.scrollLeft = startScroll - (x - startX)`.
4. `pointerup` / `pointercancel`: snap `round(scrollLeft / tileStep) * tileStep` with reduced-motion-aware behavior.
5. `tileStep()` = first tile `getBoundingClientRect().width` + computed `column-gap`.

Do **not** start mouse-drag from guestbook/photos (original restriction). Touch horizontal paging uses native `overflow-x` + CSS scroll-snap, not the drag code path.

### 6.5 What we will not do

- `window.scrollBy` from three different listeners with three different thresholds.
- `if (deltaY)` vs `if (touchAxis === "y")` as unrelated patches in different files.
- Pointermove **and** touchmove both calling `scrollBy` (iOS Safari fires both; double-apply is the original vertical-pan bug inverted).
- `matchMedia("(pointer: coarse)")` or `if (iOS)` listener switching.
- Coordinator `setPointerCapture`.
- Horizontal JS `scrollBy` “if native pan is broken.”
- Forwarding vertical swipes by putting a capturing listener on `document`.
- Making guestbook `overflow-y: auto` (that recreates an inner scroller).
- `touch-action: none` on the scroller (breaks both axes, forces all JS).
- `touch-action: pan-x` only on the scroller in v1 (see 6.2).
- Special-casing “today’s tile” or “when there is one photo.”
- Converting wheel `deltaMode === 1` by `* 16` (makes wheel-over-tile differ from wheel-over-masthead). If a later change converts modes, convert mode 2 (pages) too and document it as deliberate.

### 6.6 Containment checklist (implementer must satisfy all)

1. `.forecast-scroller { overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; overscroll-behavior-y: auto; scroll-snap-type: x mandatory; touch-action: pan-x pan-y; }` plus the rest of the §6.3 CSS map.
2. Tiles `scroll-snap-align: start; scroll-snap-stop: always`.
3. Tiles grow with content; **no** `max-height` + inner scroll on photos or comments.
4. `.photo-list { display: flex; flex-direction: column; }` images `width: 100%; height: auto`.
5. Coordinator attached by DayCarousel after tiles mount; rebound on `setTiles` if needed.
6. `resize` only updates nav disabled state (and maybe snap), not a second scroll hack.

---

## 7. Data flow: load → model → render → subscribe

```
index.html parsed
    → app.js: SiteController.create(document).start()
        → phase = resolveClosed(...) ? "closed" : "loading"
        → if closed: ClosedNotice.show(); hide #live; return
             (no tiles, no Firebase, no Guestbook)
        → ConditionsCard.setPhase("loading")
        → parallel:
            OpenMeteoWeatherProvider.fetch()
            runProviderChain([ECMWF, GFS, NWS])
        → buildDays(weather, waves, { now })
        → if no days: phase "error"; stop
        → createRateLimiters(CONFIG) once
        → DayTile[] from Day[]
             each tile constructs Guestbook + PhotoStrip with store: null
             feeds show “Loading notes…” / “Loading pictures…”
        → DayCarousel.setTiles(tiles)
             DayCarousel binds ScrollCoordinator internally
             SiteController does NOT call ScrollCoordinator.bind
        → ConditionsCard.setPhase("ready", { asOf })
        → connectFirebase()          // SiteController only
            → unconfigured:
                  each tile Guestbook/PhotoStrip.setFeedState/setListState("setup", ERRORS.firebaseUnconfigured)
                  forms already bound; submit/upload show original “not configured” strings
                  no createStore, no snapshots
            → ok (canWrite true or false):
                  store = createStore(db, { auth, config, firestore })
                  tiles.forEach(t => t.attachStore(store))
                  ONE store.subscribeComments → groupBy dayKey → tile.setComments
                  ONE store.subscribePhotos  → groupBy dayKey → tile.setPhotos
                  if !canWrite: writes show original auth copy; snapshots still run
```

Load-time UX matches original: weather tiles paint first, then Firebase. Forms work after `attachStore`; they are bound at construction so unconfigured submit still shows the original error.

**Subscribe is push-to-tiles, not querySelectorAll.** `SiteController` holds `tiles: DayTile[]` and fans out. Tiles that unmount on destroy: store unsub (once, on the controller) + `tile.destroy()`.

**Honeypot / validate** happen in `Guestbook` before `store.addComment`. Store does not know about honeypots. Non-empty `company` → status `"Thanks."`, reset, no write.

**Photo path field:** store builds `days/${dayKey}/${uid}_${Date.now()}.jpg` so rules (`path` string < 400) and any existing docs stay consistent. Path is metadata only (inline URL is the image).

**No polling** of weather. Firestore snapshots are the only live updates.

Auth-failed is **not** `setFeedState("error")` as a terminal override. Original writes the auth sentence into feeds, then still starts `onSnapshot`; the snapshot replaces that copy when data arrives. holland2 may show the auth sentence briefly (or skip it and leave “Loading notes…” until the first snapshot). Either way, subscribe. Writes use `canWrite`.

---

## 8. Config surface

### Configurable (in `config.js` or `firebase-config.js`)

- Time zone, last open day, preview query name
- Forecast length (request `forecast_days=7`; do not slice wave-only dates)
- City lat/lon, wave point, NWS point
- API base URLs
- Collection names (`comments`, `photos`) — **do not change** without a migration
- Limits, timeouts, rate limits, image ladder, query limits
- Scroll threshold and touch exempt selector
- Firebase public keys + reCAPTCHA site key

### Derived (never duplicated as constants)

- Closed boolean ← now + lastOpenDay + query
- `isCurrent` ← dayKey === detroitDayKey(now)
- Skin ← weather code table
- Visible tile count ← CSS `--visible-tiles` (not JS)
- `tileStep` ← measured DOM
- As-of string ← payload `current.time` + `source` fields
- Wave “usable” ← `isUsableWave`
- NWS day buckets ← grid validTime + duration
- `canWrite` ← anonymous session succeeded

### Dual source of truth (document, do not pretend they share a runtime)

| Policy | Client | Server |
|---|---|---|
| Close instant | `CONFIG.lastOpenDay` + Detroit day key | `firestore.rules` `stillOpen()` 2026-09-04 04:00 UTC |
| Comment fields/lengths | `CONFIG.limits` + Guestbook sanitize | `validComment()` |
| Photo URL size/prefix | pipeline on **write**; `isSafeImageSrc` on **display** | `validPhoto()` |

`isSafeImageSrc` is the XSS boundary at `img.src`. The store persists what rules already accepted (including legacy `https://` Storage URLs). Do not run the allowlist as a write-time filter that would reject our own JPEG data URLs (it should accept them; writes are gated by rules).

README section “Keep these in sync” lists both close expressions **and** that holland / holland2 share collections.

---

## 9. CSS strategy

### Tokens

Keep original `:root` names and values (`--sky-top`, `--water`, `--paper`, `--ink`, `--dune`, `--error`, `--radius`, `--shadow`, …). Add:

```css
:root {
  --tile-gap: 0.85rem;
  --visible-tiles: 3;
}
```

### Carousel columns (no magic exceptions)

```css
.forecast-scroller {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: calc(
    (100% - (var(--visible-tiles) - 1) * var(--tile-gap)) / var(--visible-tiles)
  );
  gap: var(--tile-gap);
  /* overflow / snap / touch-action as §6.3 */
}

@media (min-width: 1400px) {
  :root { --visible-tiles: 4; }
}
@media (max-width: 900px) {
  :root { --visible-tiles: 2; }
}
@media (max-width: 600px) {
  :root { --visible-tiles: 1; }
  .forecast-wrap { grid-template-columns: 1fr; }
  .forecast-nav { display: none; }
}
```

When `--visible-tiles: 1`, `(n-1)*gap = 0`, so columns are `100%`. That replaces the special `grid-auto-columns: 100%` rule.

### `touch-action` (same map as §6.3)

| Selector | Value |
|---|---|
| `html, body` | `manipulation` |
| `.forecast-scroller` | `pan-x pan-y` plus `overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; overscroll-behavior-y: auto` |
| `.tile-sky` | `pan-x pan-y` |
| `.tile-guestbook`, `.photo-block` | `pan-y` |
| `textarea, input` | `manipulation` |

No “or.” Do not put `pan-x` alone on the scroller in v1.

### Weather skins

Keep class names `wx-clear` … `wx-thunder` and `wx-dark`. JS only adds `skin.className` and `wx-dark` if `skin.dark`. Art stays in CSS `::before`/`::after` (data-driven **class**, not data-driven gradients in JS).

### Phase visibility

Do **not** add `body[data-site-phase]`. No CSS rule needs it. Toggle existing `hidden` on `#closed` / `#live` / loading / error / data nodes via `ClosedNotice` and `ConditionsCard.setPhase`. `[hidden] { display: none !important; }` stays. `aria-busy` on `#conditions` matches original.

### Photos

No `overflow-y` on `.photo-list` or `.tile-guestbook`. Page is the only vertical scroller.

### Fonts / horizon / cards

Port from original with the same selectors where they still match. Do not introduce a CSS-in-JS layer.

### Reduced motion

`prefers-reduced-motion: reduce` → `scroll-behavior: auto` on the scroller; DayCarousel snap/nav uses `"auto"`. Cheap addition; does not change the product for everyone else.

---

## 10. Firebase / security

### Reuse, do not fork data

- Copy `firebase-config.js` **values** (apiKey, projectId `holland-vacation`, appId, recaptcha site key).
- Collections remain `comments` and `photos`. **holland/ and holland2/ share these collections.** Dual writers, same App Check domain (`pmcculfor.github.io`). A holland2 bug can write into the live guestbook. Do not invent `photos_v2`. Do not “clean up” `path`.
- Field shapes remain:
  - comments: `{ nickname, text, createdAt, dayKey }`
  - photos: `{ dayKey, url, path, createdAt }`
- `dayKey` is exactly 10 chars `YYYY-MM-DD`.
- Photo `url` is `data:image/jpeg;base64,...` (or legacy `https://` Firebase Storage URLs — keep `isSafeImageSrc` allowlist as original, for **reads**).

### Rules files

Copy `holland/firestore.rules` and `holland/storage.rules` into `holland2/` so the folder is self-contained for the README. **Publishing rules is a console action.** Identical files → no need to republish if holland/ rules are already live. If they ever diverge, that is a product bug.

Client close date: `2026-09-03` Detroit calendar day. Rules: `request.time < timestamp.date(2026, 9, 4) + duration.value(4, 'h')` (EDT UTC−4). Both must remain that pair.

### Client security behavior

- Anonymous sign-in once in `connectFirebase`. Failure → `canWrite: false`, snapshots still start.
- App Check + ReCaptchaV3Provider when `recaptchaSiteKey` is non-empty.
- Honeypot field `company` (visually hidden). Non-empty → fake success `"Thanks."`, no write.
- Sanitize nickname/text to limits before write.
- `isSafeImageSrc` in PhotoStrip **before** setting `img.src` (never in the store).
- No `innerHTML` for comments.

`isSafeImageSrc` (`lib/safe-url.js`), original allowlist:

- string length 12..900000
- `data:image/jpeg;base64,…` regex (`/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/`)
- or `https:` URL whose host is `firebasestorage.googleapis.com` / `*.firebasestorage.app` / `*.googleapis.com`

Unit-test `javascript:` URLs and oversized strings → false. JPEG data URLs from the pipeline → true.

### Authorized domains (README)

`localhost`, `pmcculfor.github.io`. Path for this site: `/minisites/holland2/`.

---

## 11. Error / loading / closed states (one state machine)

### Site phase (`SiteController`)

```
          start()
             │
             ▼
     resolveClosed()?
        │ yes          no
        ▼              ▼
     CLOSED         LOADING
                       │
              weather/waves settle
                 │            │
              has days      none
                 ▼            ▼
               READY        ERROR
```

- **CLOSED:** `#closed` visible, `#live` hidden. Firebase not required. No carousel, no tiles, no feeds. Query `?previewClosed=1` forces this regardless of date.
- **LOADING:** `#live` visible, spinner, `aria-busy="true"`.
- **READY:** forecast scroller populated, `aria-busy="false"`, as-of line. Partial: weather missing → tiles from wave dates (unsliced); waves missing → wave lines show “Waves —”; one console.error per rejected branch (original).
- **ERROR:** error paragraph, hide data + spinner. Message: `ERRORS.weatherBothFailed`. No tiles, so no feeds.

Transitions only through `setPhase`. No other file toggles `#closed` / `#live`.

Site `ERROR` and site `CLOSED` cannot fight feed phases: SiteController never mounts tiles in those phases.

### Feed / photo list phase (per tile)

Precedence:

1. **setup** — Firebase unconfigured. Override until keys exist. Forms still bound.
2. **loading** — store attached (or about to be); waiting for the first snapshot callback.
3. On snapshot **success:** `empty` if `items.length === 0`, else `ready`. Success **clears** a previous snapshot error (original `paintFeeds` overwrites).
4. On snapshot **error:** `error` with snapshot copy. Recoverable — the next successful snapshot returns to empty/ready.

Auth-failed is **not** a feed phase. Do not map it to `error` as a terminal override of snapshots.

| State | Notes UI | Photos UI |
|---|---|---|
| loading | “Loading notes…” | “Loading pictures…” |
| empty | “No notes for this day yet.” | “No pictures yet.” |
| ready | comment cards | stacked images (`isSafeImageSrc` first; if every URL is rejected, show empty copy) |
| setup | `ERRORS.firebaseUnconfigured` | same |
| error | `ERRORS.commentsSnapshot` | `ERRORS.photosSnapshot` |

Form/upload status is **ephemeral UI** on the form (Posting…, Uploaded., mapped errors), not a site phase.

### Error mapping (one table)

`ui/errors.js` holds **every** user-visible string that is not Appendix A chrome copy:

```js
export const ERRORS = {
  weatherBothFailed:
    "Could not load Holland conditions. Refresh the page to try again.",
  firebaseUnconfigured:
    "Notes and pictures are not connected yet. Add your Firebase keys in firebase-config.js (see README).",
  firebaseUnconfiguredComment:
    "Firebase is not configured yet, so comments cannot be saved.",
  firebaseUnconfiguredPhoto:
    "Firebase is not configured yet, so pictures cannot be saved.",
  authFailed:
    "Could not start an anonymous session. Check Auth is enabled and pmcculfor.github.io is an authorized domain.",
  commentsSnapshot:
    "Could not load notes. Check Firestore rules and App Check.",
  photosSnapshot:
    "Could not load pictures. Check Firestore rules and App Check.",
  commentPost:
    "Could not post. If App Check is enforced, the reCAPTCHA site key must be set and the domain allowed.",
  commentEmpty: "Write a comment first.",
  commentCooldown: "Wait a few seconds before posting again.",
  commentPosting: "Posting…",
  commentPosted: "Posted.",
  honeypotThanks: "Thanks.",
  photoPermission:
    "Could not save the picture. Publish the latest firestore.rules from this repo in the Firebase console.",
  photoAuth: "Could not start an anonymous session for uploads.",
  photoAppCheck:
    "Could not save the picture. Check App Check and the reCAPTCHA site key for this domain.",
  photoTimeout:
    "The picture took too long to save. Try a smaller photo or another network.",
  photoUnreadable: "Could not read that picture. Try a JPEG or PNG.",
  photoTooLarge: "That picture is still too large after shrinking. Try another photo.",
  photoNotImage: "Use a photo file (JPEG, PNG, WebP, HEIC, or GIF).",
  photoFileTooLarge: "That picture is over 20 MB.",
  photoCooldown: "Wait a few seconds before uploading again.",
  photoGeneric: "Could not save the picture. Try again in a moment.",
  photoReading: "Reading picture…",
  photoShrinking: "Shrinking picture…",
  photoSaving: "Saving picture…",
  photoUploaded: "Uploaded.",
  feedLoadingNotes: "Loading notes…",
  feedLoadingPictures: "Loading pictures…",
  feedEmptyNotes: "No notes for this day yet.",
  feedEmptyPictures: "No pictures yet.",
};

export function mapPhotoError(error) {}
// inspect code/message substrings as original:
// permission / PERMISSION → photoPermission
// unauthenticated / anonymous → photoAuth
// app-check / recaptcha / AppCheck → photoAppCheck
// timeout / timed out → photoTimeout
// unreadable / compress-failed → photoUnreadable
// too-large → photoTooLarge
// else photoGeneric
```

Do not inline these strings in PhotoStrip / Guestbook beyond calling `ERRORS.*` / the mapper.

Unconfigured submit uses `firebaseUnconfiguredComment` / `firebaseUnconfiguredPhoto` (not the long feed sentence). Feeds use `firebaseUnconfigured`. Auth-failed writes use `photoAuth` / `authFailed`. Honeypot success is `"Thanks."` not “Posted.”

---

## 12. Accessibility

- `lang="en"`, existing title/description.
- Conditions card: `aria-busy` tied to LOADING/READY/ERROR; `aria-live="polite"` on the card (original). No `a11y/live.js`.
- Scroller: `tabindex="0"`, `role="region"`, `aria-label` matching original purpose (daily weather, waves, notes, pictures; swipe or arrow keys).
- Nav buttons: `aria-label` “Earlier days” / “Later days”; `disabled` at ends.
- Each tile: `article` with `aria-label={`Weather and notes for ${dayKey}`}`.
- Today is visual (`is-today` ring) + “Today” kicker; not the only cue (date is also shown).
- Honeypot: `tabIndex=-1`, off-screen, not in tab order; associated label.
- Comments: textContent only; `white-space: pre-wrap; overflow-wrap: anywhere`.
- Images: `alt="Photo from this day"`, `loading="lazy"`.
- Focus: scroller `:focus-visible` outline; inputs keep 2px water outline.
- Keyboard: Left/Right on focused scroller page by one tile. **Do not hijack arrows when `event.target` is `input, textarea, select, [contenteditable]`.**
- Closed message is a heading + paragraph, not `display:none` on the whole main.
- `prefers-reduced-motion`: set `scroll-behavior: auto` and skip smooth snap animation (new, cheap, does not change product). Honor it in DayCarousel `behavior` option rather than always using `CONFIG.scroll.snapBehavior`.
- Pinch-zoom lock **hurts** zoom a11y; it is an explicit product constraint from holland/. Do not add `user-scalable=yes`. Document in README that max-scale is intentional for the carousel.

---

## 13. Testing / verification

No required test runner (static site). Verification is manual + a small optional node smoke if the implementer wants to unit-test pure functions.

### 13.1 Pure functions (strongly recommended, zero DOM)

If adding tests, use a single `holland2/domain/*.js` (and `lib/`, `ui/ScrollCoordinator.js` `classify`) import from Node. Cover:

- `detroitDayKey` around EDT/EST (fixed ISO instants).
- `resolveClosed` for lastOpenDay, day after, `previewClosed=1`.
- `skinForCode` for 0, 63, 95, unknown; labels for 48, 77, 80, 96, 99 (verbatim WMO).
- `buildDays` today vs other: observations null on non-current; `waves.now` only on current.
- `isUsableWave(0, 0) === false`, `isUsableWave(1.2, 4) === true`, `isUsableWave(0, 4) === true`, `isUsableWave(null, 1) === false`, `isUsableWave(null, 4) === false`.
- `formatDayLabel("2026-09-03", …)` via the UTC-16 instant — **not** `new Date("2026-09-03")` / UTC midnight, which is the previous calendar day in Detroit.
- `waveHeadline`: compass from daily max even when `waves.now` has a different `directionDeg`; “max {ft}” omitted when `waves.max` is null; `"Waves —"` when both null.
- `formatWaveFt(null) === "—"`, `formatWaveFt(0) === "Calm"` (0 ft < 0.15), a value ≥ 0.15 ft → one decimal + `" ft"`.
- `windHeadline` returns null when both speeds are null (no `"Wind —"`).
- `groupBy` fan-out.
- `isSafeImageSrc`: `javascript:alert(1)` false; oversized string false; jpeg data URL true; `https://firebasestorage.googleapis.com/...` true.
- **`classify` for the coordinator** (this is the code that caused the original patches):
  - touch: both abs < threshold → `"undecided"`; `|dy| >= |dx|` past threshold → `"y"`; else `"x"`.
  - wheel: `deltaY === 0` must not steal (treat as return / x path); `abs(deltaY) >= abs(deltaX)` and `deltaY !== 0` → `"y"`; horizontal trackpad → `"x"`.

Do not block shipping on a test framework install. Do not ship tests that only cover domain helpers and skip `classify`.

### 13.2 Desktop (browser)

Serve `holland2/` as static files (any local server). Check:

1. Load: spinner then 7 tiles (or fewer if API short; **more** than 7 if weather failed and NWS returned extra keys). As-of mentions Open-Meteo and the wave source that won (`Open-Meteo ecmwf_wam025` or GFS model string or National Weather Service).
2. Wheel over sky, notes, and photos: **page** scrolls; scroller `scrollLeft` unchanged.
3. Wheel over a focused textarea: **page** still scrolls (original; documented choice). Inner textarea scroll is not required.
4. Shift+wheel or trackpad horizontal: days move; snap.
5. Drag sky: days move; snap on release. Drag on textarea does not start carousel drag.
6. Prev/next and ArrowLeft/Right (scroller focused). Arrows in the comment box do **not** page the carousel. Nav buttons `disabled` at the ends.
7. Resize across 1400 / 900 / 600: 4 / 3 / 2 / 1 visible tiles; nav hidden at 600.
8. Post a note; appears in that day’s feed only. Rapid posts across **different** tiles share one cooldown.
9. Upload a JPEG; appears stacked full width; second photo below first; page grows; **no** inner scrollbar on the list. After two photos, vertical pan/wheel from the photo stack still moves the **page**.
10. `?previewClosed=1`: closed card, no live tile.
11. Footer + weather art for clear vs rain (wx-dark text).

### 13.3 Phone (required product constraints)

Use device or DevTools device mode **plus** a real touch path if possible.

**Do not claim iOS Safari nested-scroll certified from DevTools.** Record that DevTools cannot certify it.

| Test | Pass |
|---|---|
| Pinch on page | No zoom |
| Vertical pan on sky | Page scrolls |
| Vertical pan on notes / photos / form | Page scrolls |
| Horizontal swipe on strip | Next/prev day, snap |
| Type in comment box | No carousel move; keyboard usable |
| Photos 2+ | Stack vertically, full width; **no** inner scrollbar; page still pans from the photo |
| Upload | Status sequence “Reading picture…” → “Shrinking picture…” → “Saving picture…” → “Uploaded.”; no infinite spinner (kill network to see timeout if needed) |

### 13.4 Firebase / closed

- Unconfigured keys: setup message in feeds, form still “submits” with `ERRORS.firebaseUnconfiguredComment` (original `bindForms({})`).
- Auth-failed (if you can simulate): feeds still populate from public reads; post/upload show auth copy.
- After 2026-09-03 Detroit: closed UI without query param (can fake by temporarily pointing `lastOpenDay` in a local-only experiment; revert before commit). Prefer preview query for the demo.

### 13.5 What cannot be verified without credentials

App Check enforce + live write. Implementer uses existing holland Firebase; if the environment has no network to Firebase, still verify UI states with mock `store` in a local fixture **only if** it does not ship. Do not leave debug mocks in production files.

### 13.6 Visual regression

Side-by-side `holland/` vs `holland2/` at the same viewport. Match typography, horizon, tile art, guestbook. Differences allowed: cleaner column math (should look the same), no inner photo scroll.

### 13.7 Browser tools

If the implementing agent has browser tools, exercise the real click/swipe/wheel paths, not a single screenshot. If not, document that phone nested-scroll was verified in DevTools only, and that iOS Safari is **not** certified from that.

---

## 14. Implementation order

Each phase is independently checkable. Commit after each phase.

### Phase 0 — Scaffold

- Create `holland2/` (not before this plan is accepted / this is the implementer’s first code step).
- `index.html` chrome (copy structure from holland: `#closed`, `#live`, `#conditions`, `#forecast-scroller`; **no `#app`**; script `app.js`).
- `styles.css` tokens + page/horizon/card/footer (no carousel yet).
- `config.js`, `firebase-config.js` (copied values), `firestore.rules`, `storage.rules`, `README.md` (holland2 URL; **holland/ and holland2/ share `comments` / `photos`**; pinch `maximum-scale=1` is intentional; rules/console sync).
- `app.js` logs “holland2 scaffold”. **This log is temporary.** Appendix C is the final bootstrap, wired in Phase 6/7.
- **Check:** page loads, fonts, horizon, masthead, footer. `holland/` unchanged.

### Phase 1 — Domain + skins + time

- `lib/time.js`, `lib/dom.js`, `lib/safe-url.js`, `lib/rate-limit.js`, `domain/weather-skins.js`, `domain/models.js`.
- **Check:** node REPL or a temporary `debug.html` calling `skinForCode(95)`, `detroitDayKey`, `formatDayLabel`, `classify` once it exists. Remove debug page before ship.

### Phase 2 — Data providers

- `lib/http.js`, `data/weather.js`, `data/waves.js`, `domain/day-builder.js`.
- Temporary: `app.js` fetches and `console.table`s `Day[]`.
- **Check:** 7 dayKeys when weather works; today flagged; wave source string ``Open-Meteo ecmwf_wam025`` if ECMWF wins; GFS not used if ECMWF works. Fail ECMWF in DevTools to see GFS/NWS fallback (optional). Confirm a throwing first provider still reaches the next.

### Phase 3 — ConditionsCard + DayTile sky (no guestbook)

- CSS carousel variables + weather art + §6.3 `touch-action` map.
- `DayTile` renders sky only (§5.12). `ConditionsCard` loading/error/ready via `hidden` + `aria-busy`.
- **Check:** tiles look like holland; today ring; wx classes from observations on today; as-of; Calm / compass / high-low line.

### Phase 4 — DayCarousel + ScrollCoordinator (empty guestbook padding)

- Nav, keyboard (form-control guard), mouse-drag, coordinator wheel/touch as §6.3.
- **Check:** desktop wheel→page (including over a dummy textarea); `scrollLeft` unchanged for vertical wheel; horizontal snap; nav disabled at ends; phone pan-y page / pan-x days; no pinch. This phase is the go/no-go for architecture. Do not proceed to Firebase until nested scroll is right. Do not claim iOS certified from DevTools.

### Phase 5 — Guestbook + PhotoStrip + pipeline + store

- `firebase/client.js`, `firebase/store.js`, `media/image-pipeline.js`, `ui/Guestbook.js`, `ui/PhotoStrip.js`, `ui/errors.js`.
- SiteController: `connectFirebase` → `attachStore` → one comments sub + one photos sub → fan-out. Shared rate limiters.
- **Check:** existing production comments/photos appear on the correct days (same collections). New note. New photo stacks; after two photos, no inner scrollbar, page still pans. Dual timeouts (throttle network). Honeypot `"Thanks."`. Unconfigured strings. Auth-failed still shows existing notes if you can simulate. HEIC error path if available. Rapid posts on two tiles share cooldown.
- Re-verify Phase 4 scroll: forms change hit targets.

### Phase 6 — Site state machine + closed

- `ClosedNotice`, `resolveClosed`, preview query, skip Firebase when closed. Replace Phase 0 scaffold `app.js` with Appendix C bootstrap if not already.
- **Check:** `?previewClosed=1`; live path hidden.

### Phase 7 — A11y + README + polish

- `prefers-reduced-motion`, focus, labels.
- README: Pages path `/minisites/holland2/`, Firebase steps, **sync close date with rules**, **holland and holland2 share collections**, App Check order, local testing, pinch `maximum-scale=1` is intentional.
- Remove any debug hooks. Confirm no `import` from `../holland/`.
- **Check:** full §13 list. Side-by-side with holland/.

Do not mix Phase 4 scroll work into Phase 5. Scroll must be correct with inert tile bodies first, then add forms (exempt targets) and re-verify.

---

## 15. Explicit “we will NOT” list

1. **We will NOT** copy-paste `initCarousel`, `paintFeeds`/`paintPhotos`, or `weatherClass` if/includes chains.
2. **We will NOT** import from `holland/` or share a runtime with it.
3. **We will NOT** add `matchMedia("(pointer: coarse)")`, `if (iOS)`, a second wheel handler in DayCarousel, or pointermove+touchmove both calling `scrollBy`. Wheel is a delta source into the coordinator’s `classify()`, not a second policy. We **will** use `day.isCurrent` for the kicker / `is-today` class and for assigning `observations` / `waves.now` in the builder.
4. **We will NOT** `preventDefault` + `window.scrollBy` from multiple files. Only ScrollCoordinator calls `page.scrollBy` for nested vertical intent.
5. **We will NOT** querySelectorAll the document to bind comments after paint.
6. **We will NOT** put compression, Firestore, and guestbook markup in one file.
7. **We will NOT** hardcode `grid-auto-columns` four ways; `--visible-tiles` only.
8. **We will NOT** introduce an inner `overflow-y: auto` on photos or notes.
9. **We will NOT** change collection names, field names, or close-date semantics.
10. **We will NOT** add a bundler, React, or CSS framework.
11. **We will NOT** poll weather, or fetch on interval.
12. **We will NOT** enable pinch-zoom to “fix” a11y against the product spec.
13. **We will NOT** use `innerHTML` for user text.
14. **We will NOT** scatter timeouts/limits; they live in `config.js`.
15. **We will NOT** rebuild `detroitDayKey` / `el()` in a second module.
16. **We will NOT** treat GFS zeros with a one-off `if (model === gfs)` — the usable-wave predicate applies to every marine parser.
17. **We will NOT** create a per-day widget type; every day is a `Day` + `DayTile`.
18. **We will NOT** leave `holland/` modified.
19. **We will NOT** implement this plan in the planner turn (this file is spec only).
20. **We will NOT** add `?previewClosed` handling in more than `resolveClosed`.
21. **We will NOT** let Guestbook or PhotoStrip call `connectFirebase` or `onSnapshot`.
22. **We will NOT** give each tile its own rate-limit clock.
23. **We will NOT** map auth-failed to a terminal feed `error` that hides public reads.
24. **We will NOT** add `lib/format.js`, `a11y/live.js`, `ui/status.js`, or an `#app` mount.

---

## Appendix A — Original copy to preserve (do not rewrite)

**Title:** McCulfor vacation — Holland, Michigan

**Description meta:** McCulfor vacation in Holland, Michigan: weather, Lake Michigan waves, and notes and pictures for each day. Open through September 3, 2026.

**Kicker:** Holland, Michigan · Lake Michigan · through September 3, 2026

**H1:** McCulfor vacation

**Lede:** Weather in town, wave forecast just offshore, and notes and pictures for each day of the trip.

**Card title:** Forecast

**Loading:** Loading Holland conditions…

**Hint:** Swipe between days. Wider screens show three or more tiles at once.

**Wave note:** Wave height is a model forecast near the Holland buoy, not a live buoy reading. Not for navigation or swim safety.

**Closed h2:** The McCulfor vacation site has closed

**Closed body:** This Holland trip page ran through the end of September 3, 2026 (Eastern Time). Notes and pictures are no longer being accepted.

**Guestbook h3:** Leaving note about this day

**Form:** Name (optional), Comment, placeholder “Wind, water, beach, dinner…”, button “Post to this day”, “Upload a picture”

**Footer:** Weather from Open-Meteo (CC BY 4.0). Waves from Open-Meteo ECMWF WAM, with National Weather Service grid data if needed. / Not a marine forecast product. Do not use this page for navigation or safety decisions.

**As-of pattern:** `Now as of {weekday hour:minute} · weather {source} · waves {source}`

Form/feed/upload **strings** live in `ui/errors.js` (§11) so they cannot drift from the original sentences.

---

## Appendix B — Provider chain (concrete)

```js
const WAVE_PROVIDERS = [
  OpenMeteoMarineProvider({ model: "ecmwf_wam025", point: CONFIG.wavePoint }),
  OpenMeteoMarineProvider({ model: "ncep_gfswave025", point: CONFIG.wavePoint }),
  NwsWaveProvider({ point: CONFIG.nwsPoint }),
];
```

Each `fetch` is wrapped in try/catch by `runProviderChain`. A throw or a null/empty parse continues to the next provider. After the list, throw `No wave forecast was available for this location.`

NWS parsing: keep `durationToMs` + hourly walk + max height per Detroit day key from original `nwsDailyByDate`. Keep `(start.getTime() + durationToMs(duration) || 3600000)`. `current` for NWS remains “today’s daily max” (original `fetchNwsWaves`), not a separate observation — that is still `waves.now` on the current `Day`, not a special widget.

Open-Meteo marine `source`: ``Open-Meteo ${model}``.

---

## Appendix C — Entry HTML sketch

`index.html` stays close to holland’s structure (`#closed`, `#live`, `#conditions`, loading/error/data, `#forecast-scroller`, prev/next, `#as-of`). There is **no `#app`**. Script: `<script type="module" src="app.js"></script>`. Viewport meta unchanged. Fonts unchanged. `#conditions` keeps `aria-live="polite"` and `aria-busy`.

Phase 0 `app.js` only logs `"holland2 scaffold"` (temporary). Final `app.js` is ~15 lines:

```js
import { SiteController } from "./ui/SiteController.js";

const controller = SiteController.create(document);
controller.start();
```

---

## Appendix D — Success criteria (implementer sign-off)

- [ ] `holland/` git-identical to before the work
- [ ] No import path contains `holland/`
- [ ] Existing Firestore comments/photos show on the same `dayKey` tiles
- [ ] Nested scroll policy holds on desktop wheel and phone pan (iOS not claimed from DevTools)
- [ ] No pinch zoom
- [ ] Photos full-width stack, no inner scroller; page pans after two photos
- [ ] Closed preview works
- [ ] Config holds dates, limits, coordinates
- [ ] Weather skins are a table with original WMO strings
- [ ] Waves are a provider chain with per-provider try/catch
- [ ] One site phase machine; `hidden` + `aria-busy`; no `data-site-phase`
- [ ] One comments snapshot, one photos snapshot; auth-failed still reads
- [ ] One shared comment cooldown and one shared photo cooldown
- [ ] README documents holland2 Pages URL, rules/console sync, shared collections with holland/, and intentional `maximum-scale=1`

---

## Appendix E — Agent 1 notes

None. All six blocking issues and the non-blocking checklist items are accepted in this spec.
