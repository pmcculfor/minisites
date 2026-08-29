# holland2 implementation plan

Rebuild `/workspace/holland/` as `/workspace/holland2/` with feature parity and a clean architecture. Do not copy-paste patched modules. Do not import from `holland/`. Leave `holland/` untouched.

This document is the spec for the implementing engineer. Names, file paths, and APIs below are the intended contract unless a later note records a justified deviation.

---

## 1. Goals and non-goals

### Goals

- Recreate the McCulfor vacation minisite (Holland, MI, through 2026-09-03 America/Detroit) with the same product, copy, visual language, and UX constraints.
- Same GitHub Pages static hosting: ES modules, no bundler, no framework, no build step.
- Same Firebase project and the same Firestore collections (`comments`, `photos`) so existing live data keeps working.
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
| Window | Open through **end of 2026-09-03 America/Detroit**. Client: `detroitDayKey() > "2026-09-03"`. Preview: `?previewClosed=1`. Rules: `request.time < 2026-09-04 04:00 UTC`. |
| Weather | Open-Meteo forecast, city `42.7875, -86.1089`, °F, mph, timezone `America/Detroit`, `forecast_days=7`. Current: temp, weather_code, wind speed/dir. Daily: weather_code, max/min temp, max wind, dominant wind dir. Fetched **once** on load (no polling). |
| Waves | Primary Open-Meteo ECMWF WAM `ecmwf_wam025` at offshore `42.90, -86.50`. Backup GFS Wave `ncep_gfswave025`. Fallback NWS gridpoint via `api.weather.gov/points/42.9,-86.27` then `forecastGridData.waveHeight`. Usable-wave filter: reject height/period both zero or missing. Labeled as forecast, not live buoy. Disclaimer in footer + tile note. |
| Day tiles | One tile per forecast day. Header (sky art) + notes + pictures. “Today” kicker + inset ring on the Detroit calendar day. Headline temp is current temp on today, else daily high. Waves: today shows `Now X ft · max Y ft · DIR`; other days `Waves X ft · DIR`. Wind: today prefers current wind. |
| Guestbook | Per-day notes: optional nickname ≤40, text 1–500, honeypot `company`, char counter, “Post to this day”. Render nickname/time/body as text only. Empty: “No notes for this day yet.” |
| Pictures | “Upload a picture” → hidden file input. Accept JPEG/PNG/WebP/GIF/HEIC/HEIF. Compress in-browser to JPEG data URL (~1024px long side, fallback smaller). Store on `photos` doc (`dayKey`, `url`, `path`, `createdAt`). Full-width vertical stack, `height: auto`, **no inner photo scroller**. Timeout instead of infinite spinner. |
| Auth / abuse | Anonymous Auth, App Check reCAPTCHA v3, honeypot, client rate limits, Firestore create-only + size/length rules. Public reads. |
| Closed UI | `#closed` card visible, `#live` hidden. No new notes/pictures. Copy: site ran through end of Sept 3, 2026 Eastern. |
| Hosting | Static files under `holland2/`. Intended URL `https://pmcculfor.github.io/minisites/holland2/`. Repo `.nojekyll` already at root. |

### UX constraints (must hold on holland2)

1. **Phone: no pinch-zoom.** Viewport `width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover`. Root `touch-action` must not allow pinch (`manipulation` or `pan-x pan-y`, never `pinch-zoom`).
2. **Vertical page scroll works even while the pointer is over a day card** (sky, notes, pictures, form). The horizontal scroller must not trap vertical pans.
3. **Horizontal swipe between days** on the weather strip (and anywhere on the tile that is not a text field / button). Scroll-snap per tile. Nav chevrons on wide screens; hidden below 600px.
4. **Mouse wheel over a day card scrolls the PAGE**, not the horizontal scroller. Trackpad horizontal gestures / Shift+wheel may still move the carousel.
5. **Photos stack full-width vertically** inside the tile. Tile height grows with content. Page (not an inner list) is the vertical scroller.
6. **Desktop:** grab-drag on the sky header moves days; arrow keys on the focused scroller; prev/next buttons; snap after drag.
7. **Loading:** spinner “Loading Holland conditions…” until weather/wave requests settle. Error card if both fail. Degraded OK if one of weather or waves succeeds.
8. **Uploads:** status “Reading / Shrinking / Saving / Uploaded”; 45s timeout; 20 MB pre-compress cap; 4s client cooldown; HEIC fallback error if unreadable.

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

**holland2:** one `WEATHER_SKINS` table. Lookup returns `{ className, label, dark }`.

### 3.3 Wave fetch as three ad-hoc functions — `app.js:146–223`

`fetchOpenMeteoWaves`, `fetchNwsWaves`, `fetchWaves` with sequential `if (x) return x`. Parsing (`dailyMapFromOpenMeteo`, `nwsDailyByDate`, `isUsableWave`) is mixed into fetchers. GFS “often returns zeros” knowledge is a comment, not a named predicate used by the chain.

**holland2:** `WaveProvider` interface + ordered `WAVE_PROVIDERS` list + `runProviderChain(providers)`.

### 3.4 `paintFeeds` / `paintPhotos` near-duplicates — `comments.js:177–199`

Identical group-by-`dayKey` then querySelectorAll paint loops. Two collections, one idea.

**holland2:** generic `groupByDay(docs)` in the store, and each component receives **its** day’s records. Components do not query the whole document.

### 3.5 Carousel mixing four input systems — `app.js:364–461`

`initCarousel` owns:

- Click nav (`forecast-prev` / `forecast-next`)
- Keyboard arrows
- Pointer-drag (mouse only, and only if `event.target.closest(".tile-sky")`)
- Custom touch-axis interceptor (`touchAxis` x/y, `preventDefault` + `window.scrollBy` for vertical)
- Wheel special-case (`deltaY` vs `deltaX`, `preventDefault` + `window.scrollBy`)

These were bolted on after scroll fights (git: `c9c8c4b`, `8f7b339`, `5ae717b`). There is no named policy.

**holland2:** `DayCarousel` owns snap/nav/keyboard/drag. `ScrollCoordinator` owns nested-scroll intent. One classifier, all devices.

### 3.6 Wheel handler special-cases the scroller — `app.js:449–457`

```js
if (Math.abs(event.deltaY) < Math.abs(event.deltaX) || event.deltaY === 0) return;
event.preventDefault();
window.scrollBy(0, event.deltaY);
```

This exists because `overflow-x: auto` makes the scroller a scrollport that eats `deltaY`. Patching the symptom in the carousel file mixed concerns.

**holland2:** coordinator policy: “vertical delta never belongs to the horizontal scroller.” Implemented once.

### 3.7 Two-phase guestbook — `createDayGuestbook` then `initComments`

`createDayGuestbook` (`comments.js:58–137`) builds a large DOM tree with `data-*` hooks. `initComments` (`comments.js:489–578`) later `querySelectorAll`s the whole document and binds forms/uploads/snapshots. Closed path calls `initComments({ closed: true })` which returns before tiles exist (`app.js:526–527`). Live path binds only after `loadConditions` paints tiles (`app.js:529`). Fragile if render order changes.

**holland2:** `Guestbook` and `PhotoStrip` construct, bind, and subscribe in one constructor. `DayTile` composes them. No document-wide query after paint.

### 3.8 Scattered magic numbers

| Number | Where | Meaning |
|---|---|---|
| 12000 | `app.js:79` | fetch timeout |
| 45000 | `comments.js:203` | upload timeout |
| 8000 | `comments.js:452` | comment cooldown |
| 4000 | `comments.js:367` | photo cooldown |
| 200 | `comments.js:553` | comment query limit |
| 60 | `comments.js:565` | photo query limit |
| 500 / 40 | comments + rules | text / nick |
| 900000 / 180*1024 | comments + rules | data-URL / binary size |
| 20*1024*1024 | `comments.js:201` | pre-compress file cap |
| 1024/960/800/640 + qualities | `comments.js:273–278` | compress ladder |
| 8 (px) | `app.js:438` | touch axis threshold |

**holland2:** all in `config.js` (`LIMITS`, `TIMEOUTS`, `IMAGE`, `QUERY`). Fetch, store, and UI import them.

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

**holland2:** split into `firebase/client.js`, `firebase/store.js`, `media/image-pipeline.js`, `ui/Guestbook.js`, `ui/PhotoStrip.js`, `ui/status.js` (error mapping).

### 3.11 Closed vs live as scattered flags

`applyClosedState` toggles two `hidden` attributes (`app.js:519–522`). `initComments({ closed })` early-returns. Guestbook markup is never built when closed (good) but the closed decision is not a named phase; preview query is inlined in `isSiteClosed`.

**holland2:** `SiteController` with phases `closed | loading | ready | error`. Preview is one input to `resolveSitePhase(now, searchParams, config)`.

### 3.12 Today special-casing in `buildDays` / `renderTile`

`buildDays` (`app.js:250–274`) stamps `currentTemp` / `currentWx` / `waveNowM` only when `isToday`. `renderTile` (`app.js:325–338`) branches wave copy the same way. “Current observations” is not a field on the day; it is a pile of nullable properties.

**holland2:** `Day { forecast, observations }` where `observations` is `null` unless this day is the Detroit “today” **and** current data exists. `DayTile` renders forecast always; observations optionally. No `if (day.isToday)` in wave/wind formatting beyond “if observations, show Now”.

### 3.13 CSS overflow trap (root cause of scroll patches)

`styles.css:175–191`: `.forecast-scroller` has `overflow-x: auto; overflow-y: hidden`. CSS spec: if one axis is not `visible`, the other `visible` computes to `auto`. A tall overflow-x scroller on iOS still captures vertical pans. Guestbook/photo `touch-action: pan-y` was a partial fix; JS interceptors finished the job.

**holland2:** treat nested scroll as a first-class design (section 6). CSS containment + one intent classifier. No third handler for “just wheel” or “just iOS”.

---

## 4. Proposed module map

```
holland2/
  index.html                 # shell: masthead, #app mount, closed template, footer
  styles.css                 # tokens, layout, weather skins, carousel columns
  firebase-config.js         # same values as holland/; isFirebaseConfigured()
  firestore.rules            # copy of holland/ (must stay in sync with console)
  storage.rules              # copy of holland/ (unused; documentation)
  README.md                  # Pages + Firebase, holland2 URL
  app.js                     # bootstrap only: config → SiteController.start()
  config.js                  # ALL product constants
  lib/
    time.js                  # Detroit day keys, close check, formatters
    dom.js                   # el(), clear(), delegate helpers
    http.js                  # fetchJson(url, { timeoutMs, headers })
    group.js                 # groupBy(key)
  domain/
    models.js                # factory fns: Day, Conditions, WaveObservation, Comment, Photo
    weather-skins.js         # WMO code → { className, label, dark }
    day-builder.js           # weather + waves → Day[]
  data/
    weather.js               # OpenMeteoWeatherProvider
    waves.js                 # OpenMeteoMarineProvider, NwsWaveProvider, runProviderChain
  media/
    image-pipeline.js        # File → JPEG data URL (compress ladder)
  firebase/
    client.js                # app, App Check, anonymous auth (once)
    store.js                 # CommentsRepo + PhotosRepo (same repository pattern)
  ui/
    SiteController.js        # phase machine: closed | loading | ready | error
    ClosedNotice.js
    ConditionsCard.js        # loading/error/as-of/disclaimer chrome around carousel
    DayCarousel.js           # snap, nav buttons, keyboard, drag-on-sky
    DayTile.js               # sky + guestbook + photos for one Day
    Guestbook.js             # feed + form; owns listeners
    PhotoStrip.js            # upload + vertical list; owns listeners
    ScrollCoordinator.js     # nested scroll policy (see §6)
  a11y/
    live.js                  # polite status helpers (optional thin wrapper)
```

### One-sentence responsibility each

| Path | Responsibility |
|---|---|
| `index.html` | Static chrome and empty mounts (`#closed`, `#conditions`, `#forecast-scroller`, `#live`). No per-day markup. |
| `styles.css` | Visual design and carousel geometry via CSS variables. No JS-driven class soup beyond weather skins and phase classes. |
| `firebase-config.js` | Public Firebase + reCAPTCHA keys. Copied values from `holland/firebase-config.js`. |
| `config.js` | Location, dates, URLs, limits, timeouts, provider ids, image ladder, query limits. |
| `app.js` | Import css is via HTML. JS: `SiteController.create(document).start()`. |
| `lib/time.js` | Timezone-aware day keys and display timestamps. |
| `lib/dom.js` | Create/update DOM nodes; no product logic. |
| `lib/http.js` | Abortable JSON fetch with timeout from config. |
| `lib/group.js` | `groupBy(items, keyFn) → Map`. |
| `domain/models.js` | Normalized objects from API/Firestore rows. |
| `domain/weather-skins.js` | Data table + `skinForCode(code)`. |
| `domain/day-builder.js` | Merge weather + wave payloads into `Day[]`. |
| `data/weather.js` | One weather provider, one `fetch()` returning `{ current, daily, source, fetchedAt }`. |
| `data/waves.js` | Provider objects with identical `fetch()`; chain runner. |
| `media/image-pipeline.js` | Compress + data-URL encode; throws typed errors (`unreadable`, `too-large`, `timeout`). |
| `firebase/client.js` | Idempotent `connectFirebase()` → `{ app, auth, db }` or `{ unavailable, reason }`. |
| `firebase/store.js` | `subscribeComments(cb)`, `subscribePhotos(cb)`, `addComment(input)`, `addPhoto(input)`. |
| `ui/SiteController.js` | Owns phase, loads data, mounts children, tears down. |
| `ui/ClosedNotice.js` | Closed card visibility + copy. |
| `ui/ConditionsCard.js` | Loading / error / ready chrome; hosts carousel. |
| `ui/DayCarousel.js` | Horizontal paging of `DayTile`s. |
| `ui/DayTile.js` | One day’s presentation; composes sky + Guestbook + PhotoStrip. |
| `ui/Guestbook.js` | Notes for one `dayKey`. |
| `ui/PhotoStrip.js` | Pictures for one `dayKey`. |
| `ui/ScrollCoordinator.js` | Axis lock + routing for nested horizontal carousel in a vertical page. |

Firebase CDN modules stay as dynamic `import()` from `gstatic` version **11.0.2** (same as original) inside `firebase/client.js` only.

---

## 5. Core types and public APIs

JavaScript has no types at runtime. Treat these as JSDoc contracts in the implementing files.

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
  nwsPoints: (lat, lon) => `https://api.weather.gov/points/${lat},${lon}`,
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
  },
  scroll: {
    axisThresholdPx: 8,
    snapBehavior: "smooth",
  },
  firebaseCdnVersion: "11.0.2",
};
```

`lastOpenDay` is the **client** close key. Firestore `stillOpen()` stays in `firestore.rules` (console-published). README must state they are one policy expressed twice.

### 5.2 Time (`lib/time.js`)

```js
export function detroitDayKey(date = new Date(), timeZone = CONFIG.timeZone): string
// en-CA YYYY-MM-DD in timeZone

export function isAfterLastOpenDay(date, lastOpenDay, timeZone): boolean
// detroitDayKey(date) > lastOpenDay

export function resolveClosed({ now, searchParams, lastOpenDay, previewParam }): boolean
// true if previewParam === "1" OR isAfterLastOpenDay

export function formatDayLabel(dayKey, { isCurrent, timeZone }): { kicker: string, date: string }
// kicker = "Today" if isCurrent else short weekday; date = "Sep 3"

export function formatClock(date, timeZone): string  // "Sat 3:04 PM" style used in as-of
export function formatCommentTime(date, timeZone): string  // hour:minute
```

Do not put `location.search` inside `time.js`. `SiteController` passes `searchParams`.

### 5.3 DOM (`lib/dom.js`)

```js
export function el(tag, attrs = {}, children = []): HTMLElement
// attrs: class, text, dataset, aria-*, type, name, …  text via textContent (never innerHTML)

export function clear(node): void
```

### 5.4 HTTP (`lib/http.js`)

```js
export function fetchJson(url, { timeoutMs, headers, signal } = {}): Promise<any>
// AbortController + timeout; throws HttpError { status, message }
```

### 5.5 Domain models (`domain/models.js`)

Plain objects from factories (not classes), so they serialize easily in tests.

```js
export function conditions({ weatherCode, tempF, highF, lowF, windMph, windDirDeg } = {})
// missing numbers stay null

export function waveObservation({ heightM, periodS, directionDeg, source } = {})

export function day({
  dayKey,                 // "YYYY-MM-DD"
  isCurrent,              // Detroit today
  forecast,               // Conditions (daily)
  observations,           // Conditions | null  (current wx/wind/temp)
  waves,                  // { now: WaveObservation|null, max: WaveObservation|null }
  weatherSource,
  waveSource,
})

export function commentFromDoc(data): { nickname, text, createdAt, dayKey }
export function photoFromDoc(data): { dayKey, url, path, createdAt }
```

Wave display helper (used by DayTile, not a special Today branch in the builder):

```js
export function waveHeadline(day): string
// if day.waves.now → "Now {ft} · max {ft} · {compass}"
// else if day.waves.max → "Waves {ft} · {compass}"
// else "Waves —"

export function windHeadline(day): string
// prefer observations.windMph else forecast.windMph
```

`formatWaveFt(meters)`, `formatTemp(f)`, `compassFromDegrees(deg)` live in `domain/models.js` or `lib/format.js` if format helpers grow. One place.

### 5.6 Weather skins (`domain/weather-skins.js`)

```js
export const WEATHER_SKINS = [
  { codes: [0], className: "wx-clear", label: "Clear", dark: false },
  { codes: [1], className: "wx-mostly", label: "Mostly clear", dark: false },
  { codes: [2], className: "wx-partly", label: "Partly cloudy", dark: false },
  { codes: [3], className: "wx-overcast", label: "Overcast", dark: false },
  { codes: [45, 48], className: "wx-fog", labelByCode: { 45: "Fog", 48: "Icy fog" }, dark: false },
  { codes: [51, 53, 55, 56, 57], className: "wx-drizzle", /* labels per code */, dark: false },
  { codes: [61, 63, 66, 67], className: "wx-rain", dark: true },
  { codes: [80, 81], className: "wx-showers", dark: true },
  { codes: [65, 82], className: "wx-heavy", dark: true },
  { codes: [71, 73, 75, 77, 85, 86], className: "wx-snow", dark: false },
  { codes: [95, 96, 99], className: "wx-thunder", dark: true },
];

export const FALLBACK_SKIN = { className: "wx-overcast", label: "—", dark: false };

export function skinForCode(code): { className, label, dark }
```

Labels must match original `WMO` map exactly (including “Icy fog”, “Snow grains”, “Thunderstorm with hail”).

### 5.7 Day builder (`domain/day-builder.js`)

```js
export function buildDays(weatherPayload, wavePayload, { now, timeZone, forecastDays }): Day[]
```

Algorithm:

1. `dates = weatherPayload?.daily.time ?? sorted keys of wavePayload.dailyByDate`.
2. Slice to `forecastDays`.
3. For each index `i`, `dayKey = dates[i]`.
4. `isCurrent = dayKey === detroitDayKey(now)`.
5. `forecast` from daily arrays at `i` (null-safe).
6. `observations = isCurrent ? conditions(from weatherPayload.current) : null` (null if no current).
7. `waves.max` from `wavePayload.dailyByDate[dayKey]`.
8. `waves.now = isCurrent ? (wavePayload.current ?? waves.max) : null`.
9. Attach `weatherSource` / `waveSource` strings for the as-of line (card-level, not per tile).

No other today branches.

### 5.8 Providers

```js
// Shared result shape
// WaveForecast = { current: WaveObservation|null, dailyByDate: Record<dayKey, WaveObservation>, source: string }

export function runProviderChain(providers, { log }): Promise<WaveForecast>
// await each provider.fetch(); return first non-null usable result
// usable = Object.keys(dailyByDate).length > 0 || current != null
// if all fail, throw Error("No wave forecast was available for this location.")

// data/weather.js
export function OpenMeteoWeatherProvider(config)
OpenMeteoWeatherProvider.prototype.fetch = async function(): Promise<WeatherPayload>

// data/waves.js
export function OpenMeteoMarineProvider({ model, point, config })
// model: "ecmwf_wam025" | "ncep_gfswave025"
export function NwsWaveProvider({ point, config })
// points → grid → waveHeight.values; bucket by detroitDayKey via ISO duration expansion (keep original parseIsoDuration logic, moved to lib/time.js as durationToMs)
```

`isUsableWave(height, period)` is a named export used by marine parsers **and** the chain (GFS zeros dropped at parse time, so a provider that parsed nothing returns `null` and the chain continues).

Weather and waves load in parallel (`Promise.allSettled`) inside `SiteController.load`. Ready if **either** succeeds; error only if both fail (original `loadConditions`).

### 5.9 Image pipeline (`media/image-pipeline.js`)

```js
export async function fileToInlineJpeg(file, { limits, ladder, timeoutMs }): Promise<string>
// steps: type check → size check → bitmap (createImageBitmap with imageOrientation, fallback Image) 
// → ladder until blob.size <= inlineJpegBytes → data URL
// throws Error with message in { unreadable, too-large, timeout, compress-failed, not-image, file-too-large }
```

`PhotoStrip` maps those codes to user strings (section 11). Pipeline does not know Firebase.

### 5.10 Firebase

```js
// firebase/client.js
export async function connectFirebase(): Promise<
  | { ok: true, app, auth, db }
  | { ok: false, reason: "unconfigured" | "auth-failed" }
>
// initializeApp, optional App Check if recaptchaSiteKey, signInAnonymously
// cache the promise so Guestbook and PhotoStrip share one connection

// firebase/store.js
export function createStore(db, config)
// returns:
{
  subscribeComments(onNext, onError): Unsubscribe
  subscribePhotos(onNext, onError): Unsubscribe
  addComment({ nickname, text, dayKey }): Promise<void>
  addPhoto({ dayKey, url, path }): Promise<void>
}
```

Both subscribe helpers: `orderBy("createdAt", "desc")` + `limit(config.limits.*)`, map docs through `commentFromDoc` / `photoFromDoc`.

Repository pattern: same object shape, different collection name + validator. Implement as:

```js
function makeCollectionRepo(db, name, { limitN, fromDoc }) {
  return {
    subscribe(onNext, onError) { /* onSnapshot */ },
    add(fields) { /* addDoc + serverTimestamp */ },
  };
}
```

`createStore` exposes comments vs photos with their field maps. Callers never import `collection()` / `addDoc` themselves.

### 5.11 UI components

Each component: `constructor(props)`, `element` getter, `destroy()`. No framework.

```js
// ClosedNotice
new ClosedNotice({ root: HTMLElement })
.show()
.hide()

// ConditionsCard
new ConditionsCard({ root })
.setPhase("loading" | "error" | "ready", { message?, asOf? })
.mountCarousel(carouselElement)

// DayTile
new DayTile({ day: Day })
.element: HTMLElement
.setComments(Comment[])
.setPhotos(Photo[])
.destroy()

// Guestbook
new Guestbook({ dayKey, store, closed, rateLimitMs })
.element
.setItems(Comment[])
.setFeedState("loading" | "empty" | "ready" | "setup" | "error", message?)
.destroy()

// PhotoStrip
new PhotoStrip({ dayKey, store, auth, pipeline, closed })
.element
.setItems(Photo[])
.setListState(...)
.destroy()

// DayCarousel
new DayCarousel({ scroller, prevBtn, nextBtn, coordinator })
.setTiles(DayTile[])
.scrollByTiles(deltaIndex)
.destroy()

// ScrollCoordinator — see §6

// SiteController
SiteController.create(document): SiteController
.start(): Promise<void>
.destroy()
```

`DayTile` constructs Guestbook + PhotoStrip immediately (single phase). Store may still be connecting; components show “Loading notes…” until first snapshot or setup/error.

---

## 6. Scroll / gesture architecture

This is the hard part. Design it as a product of **layout + CSS + one coordinator**, not three preventDefault patches.

### 6.1 Problem statement (single policy)

There is a **vertical page scroller** (the document) and a **horizontal day scroller** (the forecast strip). They share the same pointer. Policy:

> A gesture has one axis. Vertical always moves the page. Horizontal always moves the day strip. Pinch is disabled. Form controls (input, textarea, button, file) are exempt from axis locking so native caret/scroll/click work.

No exception for “wheel vs touch vs mouse drag.” Those are **input devices** feeding the same classifier.

### 6.2 Why CSS alone is not enough (but is required)

- `overflow-x: auto` on a tall box creates a scrollport. On iOS Safari, that scrollport often wins vertical pans.
- `overflow-x: auto; overflow-y: visible` is invalid: `visible` computes to `auto`.
- Therefore the scroller **must** be `overflow-x: auto; overflow-y: hidden` so it is **not** a vertical scrollport (content height defines the box; the page scrolls).
- `touch-action` then tells the browser which pans it may perform **without waiting for JS**:
  - `html, body`: `manipulation` (pan + tap, **no pinch**, no double-tap zoom). Original used `pan-x pan-y` which also disables pinch; `manipulation` is the clearer “no zoom” signal and still allows pan. Use `manipulation` on `html, body`.
  - `.forecast-scroller`: `pan-x` — horizontal native swipe between days. Vertical pans are **not** claimed by the scroller, so they should go to the page. iOS is inconsistent here, which is why JS still exists.
  - `.tile-guestbook, .photo-block, textarea, input`: `manipulation` (or `pan-y`) so text fields and lists do not start a horizontal pan accidentally.
  - `.tile-sky`: `pan-x` — the weather header is the explicit horizontal handle (also the mouse-drag handle).

Viewport stays `maximum-scale=1` as in original (product constraint). Do not add `user-scalable=no` unless testing shows pinch still occurs; `maximum-scale=1` + `touch-action: manipulation` is the original’s effective policy.

### 6.3 ScrollCoordinator — one object

File: `ui/ScrollCoordinator.js`.

```js
export function createScrollCoordinator({
  scroller,          // .forecast-scroller
  getPageScroller,   // () => window  (inject for tests)
  thresholdPx,       // CONFIG.scroll.axisThresholdPx
  isExemptTarget,    // (el) => closest input/textarea/button/a/label
})
```

**Internal state per pointer/touch identity:**

```
{ id, startX, startY, lastX, lastY, axis: "undecided" | "x" | "y" }
```

**Classifier** (`classify(dx, dy)`): if both abs < threshold, stay `undecided`; else `abs(dy) >= abs(dx) ? "y" : "x"`. Axis **locks** until `pointerup` / `touchend` / `pointercancel`.

**Routing (same for pointer and touch):**

| axis | action |
|---|---|
| `undecided` | do nothing (let the event continue) |
| `x` | do not call `preventDefault` for native `pan-x` on the scroller; DayCarousel may additionally drag-scroll on pointer for mouse. Coordinator does not `scrollBy` horizontally itself unless native pan is known broken (see 6.5). |
| `y` | vertical delta is **page** scroll. If the browser would otherwise apply it to the scroller (the failure mode), `preventDefault` and `pageScroller.scrollBy(0, -dy)` (touch) or `pageScroller.scrollBy(0, deltaY)` (wheel). |

**Wheel (same policy, no special case beyond “wheel is a delta not a pan”):**

- Compute `axis` from `deltaX`/`deltaY` of **this event** (wheels are discrete; no lock across ticks except: if `abs(deltaY) >= abs(deltaX)` treat as `y`).
- `y` → `preventDefault` on the scroller + `pageScroller.scrollBy({ top: event.deltaY })`.
- `x` → leave to native horizontal scroll (trackpad swipe / shift+wheel).
- `deltaMode` lines/pages: convert using `deltaY * 16` if `deltaMode === 1` so page scroll distance matches.

There is **not** a second wheel handler in `DayCarousel`.

**Touch vs Pointer:**

- Use **Pointer Events** as the primary API (`pointerdown/move/up/cancel`) with `setPointerCapture` only when axis is `x` **and** the target is the sky (DayCarousel drag).
- Also listen to `touchmove` with `{ passive: false }` **only on the scroller**, because iOS still requires non-passive `touchmove` to `preventDefault` when stealing a pan. The touch listener must call the **same** `onMove(id, x, y)` as the pointer listener. Deduplicate: if `pointerType === "touch"` and pointer events fire, ignore the duplicate pointer move for vertical forwarding (use a `handledTouchIds` set from `touchstart`, or prefer touch on iOS via `window.PointerEvent` + checking that `touchmove` already ran this frame). Simplest robust rule:

  **Implementation rule:** On `touch-primary` devices, drive the classifier from `touchstart/move/end`. On mouse, drive from `pointerdown/move/up`. Do not attach both move handlers in a way that double-applies `scrollBy`. Detect: `matchMedia("(pointer: coarse)")` or `pointerType`.

  ```
  bind() {
    scroller.addEventListener("wheel", onWheel, { passive: false });
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: false });
    scroller.addEventListener("touchend", onTouchEnd, { passive: true });
    scroller.addEventListener("touchcancel", onTouchEnd, { passive: true });
    // mouse drag is DayCarousel's job, not the coordinator
  }
  ```

  Wheel + touch cover the original bugs. Mouse wheel is `wheel`. Mouse **drag** is not nested-scroll; it is carousel paging (DayCarousel).

### 6.4 Split of duties: Coordinator vs DayCarousel

| Concern | Owner |
|---|---|
| Axis lock, vertical page forwarding, wheel-to-page | `ScrollCoordinator` |
| Tile width + gap step, snap, prev/next, ArrowLeft/Right, mouse-drag on `.tile-sky`, disabled nav at ends | `DayCarousel` |
| `touch-action` / overflow / snap / column count | CSS |
| Pinch zoom | viewport + `touch-action: manipulation` on `html, body` |

`DayCarousel.init` creates the coordinator and passes `scroller`. `destroy` unbinds both.

Mouse-drag algorithm (carousel, not coordinator):

1. `pointerdown` if `pointerType !== "touch"` and `event.target.closest(".tile-sky")`.
2. Capture pointer, sample `startX`, `startScroll`.
3. `pointermove`: `scroller.scrollLeft = startScroll - (x - startX)`.
4. `pointerup`: snap `round(scrollLeft / tileStep) * tileStep`.
5. `tileStep()` = first tile `getBoundingClientRect().width` + computed `column-gap`.

Do **not** start mouse-drag from guestbook/photos (original restriction). Touch horizontal paging uses native `pan-x` + CSS scroll-snap, not the drag code path.

### 6.5 What we will not do

- `window.scrollBy` from three different listeners with three different thresholds.
- `if (deltaY)` vs `if (touchAxis === "y")` as unrelated patches.
- Forwarding vertical swipes by putting a capturing listener on `document`.
- Making guestbook `overflow-y: auto` (that recreates an inner scroller).
- `touch-action: none` on the scroller (breaks both axes, forces all JS).
- Special-casing “today’s tile” or “when there is one photo.”

### 6.6 Containment checklist (implementer must satisfy all)

1. `.forecast-scroller { overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scroll-snap-type: x mandatory; }`.
2. Tiles `scroll-snap-align: start; scroll-snap-stop: always`.
3. Tiles grow with content; **no** `max-height` + inner scroll on photos or comments.
4. `.photo-list { display: flex; flex-direction: column; }` images `width: 100%; height: auto`.
5. Coordinator attached once after tiles mount; rebound on `setTiles`.
6. `resize` only updates nav disabled state (and maybe snap), not a second scroll hack.

---

## 7. Data flow: load → model → render → subscribe

```
index.html parsed
    → app.js: SiteController.create(document).start()
        → phase = resolveClosed(...) ? "closed" : "loading"
        → if closed: ClosedNotice.show(); hide #live; return
        → ConditionsCard.setPhase("loading")
        → parallel:
            OpenMeteoWeatherProvider.fetch()
            runProviderChain([ECMWF, GFS, NWS])
        → buildDays(weather, waves, { now })
        → if no days: phase "error"; stop
        → DayTile[] from Day[] (each tile constructs Guestbook + PhotoStrip)
        → DayCarousel.setTiles(tiles)
        → ScrollCoordinator.bind(scroller)
        → ConditionsCard.setPhase("ready", { asOf })
        → connectFirebase()
            → unconfigured: each Guestbook/PhotoStrip.setFeedState("setup", README message)
            → auth-failed: feed state "error" with auth copy
            → ok: createStore(db)
                → store.subscribeComments(docs => {
                      const map = groupBy(docs, d => d.dayKey)
                      tiles.forEach(t => t.setComments(map.get(t.dayKey) ?? []))
                  })
                → store.subscribePhotos(...) same
                → tiles receive the same store instance at construction so forms/uploads work
```

**Subscribe is push-to-tiles, not querySelectorAll.** `SiteController` holds `tiles: DayTile[]` and fans out. Tiles that unmount on destroy unsubscribe via store unsub + `tile.destroy()`.

**Honeypot / validate** happen in `Guestbook` before `store.addComment`. Store does not know about honeypots.

**Photo path field:** keep original shape `days/${dayKey}/${uid}_${Date.now()}.jpg` so rules (`path` string < 400) and any existing docs stay consistent. Path is metadata only (inline URL is the image).

**No polling** of weather. Firestore snapshots are the only live updates.

---

## 8. Config surface

### Configurable (in `config.js` or `firebase-config.js`)

- Time zone, last open day, preview query name
- Forecast length
- City lat/lon, wave point, NWS point
- API base URLs
- Collection names (`comments`, `photos`) — **do not change** without a migration
- Limits, timeouts, rate limits, image ladder, query limits
- Scroll threshold
- Firebase public keys + reCAPTCHA site key

### Derived (never duplicated as constants)

- Closed boolean ← now + lastOpenDay + query
- `isCurrent` ← dayKey === detroitDayKey(now)
- Skin ← weather code table
- Visible tile count ← CSS `--visible-tiles` (not JS)
- `tileStep` ← measured DOM
- As-of string ← payload `current.time` + `source` fields
- Wave “usable” ← height/period predicate
- NWS day buckets ← grid validTime + duration

### Dual source of truth (document, do not pretend they share a runtime)

| Policy | Client | Server |
|---|---|---|
| Close instant | `CONFIG.lastOpenDay` + Detroit day key | `firestore.rules` `stillOpen()` 2026-09-04 04:00 UTC |
| Comment fields/lengths | `CONFIG.limits` + Guestbook sanitize | `validComment()` |
| Photo URL size/prefix | pipeline + `isSafeImageSrc` | `validPhoto()` |

README section “Keep these in sync” lists both close expressions.

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
  /* overflow / snap / touch-action as §6 */
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

### Weather skins

Keep class names `wx-clear` … `wx-thunder` and `wx-dark`. JS only adds `skin.className` and `wx-dark` if `skin.dark`. Art stays in CSS `::before`/`::after` (data-driven **class**, not data-driven gradients in JS).

### Phase classes

`body[data-site-phase="closed"|"loading"|"ready"|"error"]` if useful. Prefer existing `hidden` on `#closed` / `#live` / loading / error / data nodes via `ConditionsCard.setPhase` so we do not restyle from scratch. `[hidden] { display: none !important; }` stays.

### Photos

No `overflow-y` on `.photo-list` or `.tile-guestbook`. Page is the only vertical scroller.

### Fonts / horizon / cards

Port from original with the same selectors where they still match. Do not introduce a CSS-in-JS layer.

---

## 10. Firebase / security

### Reuse, do not fork data

- Copy `firebase-config.js` **values** (apiKey, projectId `holland-vacation`, appId, recaptcha site key).
- Collections remain `comments` and `photos`.
- Field shapes remain:
  - comments: `{ nickname, text, createdAt, dayKey }`
  - photos: `{ dayKey, url, path, createdAt }`
- `dayKey` is exactly 10 chars `YYYY-MM-DD`.
- Photo `url` is `data:image/jpeg;base64,...` (or legacy `https://` Firebase Storage URLs — keep `isSafeImageSrc` allowlist as original).

### Rules files

Copy `holland/firestore.rules` and `holland/storage.rules` into `holland2/` so the folder is self-contained for the README. **Publishing rules is a console action.** Identical files → no need to republish if holland/ rules are already live. If they ever diverge, that is a product bug.

Client close date: `2026-09-03` Detroit calendar day. Rules: `request.time < timestamp.date(2026, 9, 4) + duration.value(4, 'h')` (EDT UTC−4). Both must remain that pair.

### Client security behavior

- Anonymous sign-in once in `connectFirebase`.
- App Check + ReCaptchaV3Provider when `recaptchaSiteKey` is non-empty.
- Honeypot field `company` (visually hidden). Non-empty → fake success, no write.
- Sanitize nickname/text to limits before write.
- `isSafeImageSrc` before setting `img.src`.
- No `innerHTML` for comments.

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

- **CLOSED:** `#closed` visible, `#live` hidden. Firebase not required. No carousel. Query `?previewClosed=1` forces this regardless of date.
- **LOADING:** `#live` visible, spinner, `aria-busy="true"`.
- **READY:** forecast scroller populated, `aria-busy="false"`, as-of line. Partial: weather missing → tiles from wave dates; waves missing → wave lines show “Waves —”; one console.error per rejected branch (original).
- **ERROR:** error paragraph, hide data + spinner. Message: “Could not load Holland conditions. Refresh the page to try again.”

Transitions only through `setPhase`. No other file toggles `#closed` / `#live`.

### Feed / photo list phase (per tile)

`loading` → `empty` | `ready` | `setup` | `error`.

| State | Notes UI | Photos UI |
|---|---|---|
| loading | “Loading notes…” | “Loading pictures…” |
| empty | “No notes for this day yet.” | “No pictures yet.” |
| ready | comment cards | stacked images |
| setup | Firebase keys missing copy (same sentence as original) | same |
| error | snapshot/auth failure copy | same |

Form/upload status is **ephemeral UI** on the form (Posting…, Uploaded, mapped errors), not a site phase.

### Error mapping (one table)

`ui/errors.js`:

```js
export const ERRORS = {
  weatherBothFailed: "Could not load Holland conditions. Refresh the page to try again.",
  firebaseUnconfigured: "Notes and pictures are not connected yet. Add your Firebase keys in firebase-config.js (see README).",
  authFailed: "Could not start an anonymous session. Check Auth is enabled and pmcculfor.github.io is an authorized domain.",
  commentsSnapshot: "Could not load notes. Check Firestore rules and App Check.",
  photosSnapshot: "Could not load pictures. Check Firestore rules and App Check.",
  commentPost: "Could not post. If App Check is enforced, the reCAPTCHA site key must be set and the domain allowed.",
  photoPermission: "Could not save the picture. Publish the latest firestore.rules from this repo in the Firebase console.",
  photoAuth: "Could not start an anonymous session for uploads.",
  photoAppCheck: "Could not save the picture. Check App Check and the reCAPTCHA site key for this domain.",
  photoTimeout: "The picture took too long to save. Try a smaller photo or another network.",
  photoUnreadable: "Could not read that picture. Try a JPEG or PNG.",
  photoTooLarge: "That picture is still too large after shrinking. Try another photo.",
  photoNotImage: "Use a photo file (JPEG, PNG, WebP, HEIC, or GIF).",
  photoFileTooLarge: "That picture is over 20 MB.",
  photoCooldown: "Wait a few seconds before uploading again.",
  commentCooldown: "Wait a few seconds before posting again.",
  commentEmpty: "Write a comment first.",
  photoGeneric: "Could not save the picture. Try again in a moment.",
};
```

`mapPhotoError(error)` inspects `code`/`message` substrings as original (`permission`, `unauthenticated`, `app-check`, `timeout`, `unreadable`, `too-large`) and returns `ERRORS.*`. Do not inline strings in PhotoStrip beyond calling the mapper.

---

## 12. Accessibility

- `lang="en"`, existing title/description.
- Conditions card: `aria-busy` tied to LOADING/READY/ERROR; `aria-live="polite"` on the card (original).
- Scroller: `tabindex="0"`, `role="region"`, `aria-label` matching original purpose (daily weather, waves, notes, pictures; swipe or arrow keys).
- Nav buttons: `aria-label` “Earlier days” / “Later days”; `disabled` at ends.
- Each tile: `article` with `aria-label={`Weather and notes for ${dayKey}`}`.
- Today is visual (`is-today` ring) + “Today” kicker; not the only cue (date is also shown).
- Honeypot: `tabIndex=-1`, off-screen, not in tab order; associated label.
- Comments: textContent only; `white-space: pre-wrap; overflow-wrap: anywhere`.
- Images: `alt="Photo from this day"`, `loading="lazy"`.
- Focus: scroller `:focus-visible` outline; inputs keep 2px water outline.
- Keyboard: Left/Right on focused scroller page by one tile. Do not hijack arrows when focus is in a textarea.
- Closed message is a heading + paragraph, not `display:none` on the whole main.
- `prefers-reduced-motion`: set `scroll-behavior: auto` and skip smooth snap animation (new, cheap, does not change product). Honor it in DayCarousel `behavior` option.
- Pinch-zoom lock **hurts** zoom a11y; it is an explicit product constraint from holland/. Do not add `user-scalable=yes`. Document in README that max-scale is intentional for the carousel.

---

## 13. Testing / verification

No required test runner (static site). Verification is manual + a small optional node smoke if the implementer wants to unit-test pure functions.

### 13.1 Pure functions (strongly recommended, zero DOM)

If adding tests, use a single `holland2/domain/*.js` import from Node with `--check` or a tiny node script. Cover:

- `detroitDayKey` around EDT/EST (fixed ISO instants).
- `resolveClosed` for lastOpenDay, day after, `previewClosed=1`.
- `skinForCode` for 0, 63, 95, unknown.
- `buildDays` today vs other: observations null on non-current; wave headline strings.
- `isUsableWave(0, 0) === false`, `isUsableWave(1.2, 4) === true`.
- `groupBy` fan-out.

Do not block shipping on a test framework install.

### 13.2 Desktop (browser)

Serve `holland2/` as static files (any local server). Check:

1. Load: spinner then 7 tiles (or fewer if API short). As-of mentions Open-Meteo and the wave source that won.
2. Wheel over sky, notes, and photos: **page** scrolls; scroller `scrollLeft` unchanged.
3. Shift+wheel or trackpad horizontal: days move; snap.
4. Drag sky: days move; snap on release. Drag on textarea does not start carousel drag.
5. Prev/next and ArrowLeft/Right (scroller focused).
6. Resize across 1400 / 900 / 600: 4 / 3 / 2 / 1 visible tiles; nav hidden at 600.
7. Post a note; appears in that day’s feed only.
8. Upload a JPEG; appears stacked full width; second photo below first; page grows; **no** inner scrollbar on the list.
9. `?previewClosed=1`: closed card, no live tile.
10. Footer + weather art for clear vs rain (wx-dark text).

### 13.3 Phone (required product constraints)

Use device or DevTools device mode **plus** a real touch path if possible (DevTools touch is imperfect for iOS overflow bugs).

| Test | Pass |
|---|---|
| Pinch on page | No zoom |
| Vertical pan on sky | Page scrolls |
| Vertical pan on notes / photos / form | Page scrolls |
| Horizontal swipe on strip | Next/prev day, snap |
| Type in comment box | No carousel move; keyboard usable |
| Photos 2+ | Stack vertically, full width |
| Upload | Status sequence; no infinite spinner (kill network to see timeout if needed) |

### 13.4 Firebase / closed

- Unconfigured keys: setup message, form still “submits” with error (original bindForms({})).
- After 2026-09-03 Detroit: closed UI without query param (can fake by temporarily pointing `lastOpenDay` in a local-only experiment; revert before commit). Prefer preview query for the demo.

### 13.5 What cannot be verified without credentials

App Check enforce + live write. Implementer uses existing holland Firebase; if the environment has no network to Firebase, still verify UI states with mock `store` in a local fixture **only if** it does not ship. Do not leave debug mocks in production files.

### 13.6 Visual regression

Side-by-side `holland/` vs `holland2/` at the same viewport. Match typography, horizon, tile art, guestbook. Differences allowed: cleaner column math (should look the same), no inner photo scroll.

### 13.7 Browser tools

If the implementing agent has browser tools, exercise the real click/swipe/wheel paths, not a single screenshot. If not, document that phone nested-scroll was verified in DevTools only.

---

## 14. Implementation order

Each phase is independently checkable. Commit after each phase.

### Phase 0 — Scaffold

- Create `holland2/` (not before this plan is accepted / this is the implementer’s first code step).
- `index.html` chrome (copy structure from holland, script `app.js`).
- `styles.css` tokens + page/horizon/card/footer (no carousel yet).
- `config.js`, `firebase-config.js` (copied values), `firestore.rules`, `storage.rules`, `README.md` (holland2 URL).
- `app.js` logs “holland2 scaffold”.
- **Check:** page loads, fonts, horizon, masthead, footer. `holland/` unchanged.

### Phase 1 — Domain + skins + time

- `lib/time.js`, `lib/dom.js`, `domain/weather-skins.js`, `domain/models.js`.
- **Check:** node REPL or a temporary `debug.html` calling `skinForCode(95)`, `detroitDayKey`. Remove debug page before ship.

### Phase 2 — Data providers

- `lib/http.js`, `data/weather.js`, `data/waves.js`, `domain/day-builder.js`.
- Temporary: `app.js` fetches and `console.table`s `Day[]`.
- **Check:** 7 dayKeys, today flagged, wave source string, GFS not used if ECMWF works. Fail ECMWF in DevTools to see GFS/NWS fallback (optional).

### Phase 3 — ConditionsCard + DayTile sky (no guestbook)

- CSS carousel variables + weather art.
- `DayTile` renders sky only. `ConditionsCard` loading/error/ready.
- **Check:** tiles look like holland; today ring; wx classes; as-of.

### Phase 4 — DayCarousel + ScrollCoordinator (empty guestbook padding)

- Nav, keyboard, mouse-drag, coordinator wheel/touch.
- **Check:** desktop wheel→page; horizontal snap; phone pan-y page / pan-x days; no pinch. This phase is the go/no-go for architecture. Do not proceed to Firebase until nested scroll is right.

### Phase 5 — Guestbook + PhotoStrip + pipeline + store

- `firebase/client.js`, `firebase/store.js`, `media/image-pipeline.js`, `ui/Guestbook.js`, `ui/PhotoStrip.js`, `ui/errors.js`.
- Wire store fan-out in `SiteController`.
- **Check:** existing production comments/photos appear on the correct days (same collections). New note. New photo stacks. Timeout error if you throttle. Honeypot. HEIC error path if available.

### Phase 6 — Site state machine + closed

- `ClosedNotice`, `resolveClosed`, preview query, skip Firebase when closed.
- **Check:** `?previewClosed=1`; live path hidden.

### Phase 7 — A11y + README + polish

- `prefers-reduced-motion`, focus, labels.
- README: Pages path `/minisites/holland2/`, Firebase steps, **sync close date with rules**, App Check order, local testing.
- Remove any debug hooks. Confirm no `import` from `../holland/`.
- **Check:** full §13 list. Side-by-side with holland/.

Do not mix Phase 4 scroll work into Phase 5. Scroll must be correct with inert tile bodies first, then add forms (exempt targets) and re-verify.

---

## 15. Explicit “we will NOT” list

1. **We will NOT** copy-paste `initCarousel`, `paintFeeds`/`paintPhotos`, or `weatherClass` if/includes chains.
2. **We will NOT** import from `holland/` or share a runtime with it.
3. **We will NOT** add special-case JS for “today,” “only one tile,” “first photo,” “iOS only,” or “wheel only” outside the coordinator’s single axis policy.
4. **We will NOT** `preventDefault` + `window.scrollBy` from multiple files.
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

## Appendix B — Provider chain (concrete)

```js
const WAVE_PROVIDERS = [
  OpenMeteoMarineProvider({ model: "ecmwf_wam025", point: CONFIG.wavePoint }),
  OpenMeteoMarineProvider({ model: "ncep_gfswave025", point: CONFIG.wavePoint }),
  NwsWaveProvider({ point: CONFIG.nwsPoint }),
];
```

NWS parsing: keep `parseIsoDuration` + hourly walk + max height per Detroit day key from original `nwsDailyByDate`. `current` for NWS remains “today’s daily max” (original `fetchNwsWaves`), not a separate observation — that is still `waves.now` on the current `Day`, not a special widget.

## Appendix C — Entry HTML sketch

`index.html` stays close to holland’s structure (`#closed`, `#live`, `#conditions`, loading/error/data, `#forecast-scroller`, prev/next, `#as-of`). Script: `<script type="module" src="app.js"></script>`. Viewport meta unchanged. Fonts unchanged.

`app.js` is ~15 lines:

```js
import { SiteController } from "./ui/SiteController.js";

const controller = SiteController.create(document);
controller.start();
```

## Appendix D — Success criteria (implementer sign-off)

- [ ] `holland/` git-identical to before the work
- [ ] No import path contains `holland/`
- [ ] Existing Firestore comments/photos show on the same `dayKey` tiles
- [ ] Nested scroll policy holds on desktop wheel and phone pan
- [ ] No pinch zoom
- [ ] Photos full-width stack, no inner scroller
- [ ] Closed preview works
- [ ] Config holds dates, limits, coordinates
- [ ] Weather skins are a table
- [ ] Waves are a provider chain
- [ ] One site phase machine
- [ ] README documents holland2 Pages URL and rules/console sync
