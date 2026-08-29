# holland2 implementation review (Agent 2)

## Verdict
Approve with nits

The rebuild matches the agreed contract in `holland2-plan.md` and the addendum notes in `holland2-plan-review.md`. Scroll ownership, store lifetime, auth-failed reads, DayTile copy, the wave chain, shared rate limiters, the skins table, CSS columns, and the closed machine are implemented as specified. `holland/` is unmodified. This is not a rubber stamp: the files below were read, not inferred from the tree.

## Blocking issues
None.

## Non-blocking nits

1. **`ui/PhotoStrip.js:160–163` — “Reading picture…” never paints.** `_handleFile` sets `ERRORS.photoReading` and then, still synchronously, overwrites it with `ERRORS.photoShrinking` before the first `await`. Original `bindUploads` awaited `file.arrayBuffer()` between those two strings, so “Reading picture…” was visible. The later Shrinking / Saving / Uploaded / timeout path is correct. Optional fix: keep a real read step (or `await` a frame) before flipping to shrinking.

2. **`ui/PhotoStrip.js:6–20` and `media/image-pipeline.js:3–17` — `withTimeout` is copied.** Same helper rebuilt in two files. Spec forbade rebuilding logic that should be one object; a single `lib/timeout.js` (or similar) would match that bar. Same class of nit: `looksLikeImage` is duplicated in PhotoStrip and the pipeline (`PhotoStrip.js:131–132`, `image-pipeline.js:19–22`).

3. **`ui/ConditionsCard.js:36–42` — `mountCarousel` is a no-op.** `SiteController` passes `#forecast-scroller`, which is already the card’s scroller, so the append branch never runs. Dead API. Either delete it or have DayCarousel actually mount into the card.

4. **`ui/SiteController.js:134–135` — `ready` before `setTiles`.** Phase flips to ready (unhides the empty scroller) and then tiles are inserted. Original painted tiles first, then revealed `#conditions-data`. Possible empty-strip flash. Swap the two lines.

5. **`ui/SiteController.js:149–157` — SDK/network throw after weather paint.** `connectFirebase` correctly does not cache a rejected load, but `_connectFeeds` has no `try/catch`. A gstatic failure leaves the site in `ready` with feeds stuck on “Loading notes…”. Spec allows retry on the next `connectFirebase()`; nothing calls it again. Catch, map to `setFeedState`/`setListState("error")` or “setup”, and leave a retry path.

6. **`ui/DayCarousel.js:49–56` — dead `if (!this._coordinator)` branch.** The constructor always creates the coordinator. `setTiles` only needs `bind()`.

7. **`ui/Guestbook.js:38–39` — honeypot label is not associated.** Spec §12 asks for an associated label. The “Company” label is a sibling with class `hp` and no `for`/`htmlFor` (same as original). Wire `htmlFor` to the input id.

8. **`ui/errors.js:55` — `file-too-large` matches `too-large`.** `code.includes("too-large")` would map a pipeline `file-too-large` to “still too large after shrinking.” PhotoStrip pre-checks size, so this is latent. Check `file-too-large` first, or use exact message matches.

9. **`smoke.mjs:185` — `classify(0, 0, 0) === "y"` is documented, not executed as a steal test.** The comment is right (`onWheel` also requires `deltaY !== 0`), and the midnight-trap assertion (`formatDayLabel("2026-09-03")` → `Sep 3` / `Thu`) would fail on `new Date("2026-09-03")`. Coverage is real. A one-line contrast against UTC midnight, and a small `onWheel` harness, would make the trap and the steal guard obvious.

10. **Wave provider list is inlined in `SiteController._load` rather than a named `WAVE_PROVIDERS`.** Appendix B’s ordered list is present and correct (ECMWF → GFS → NWS); it is just not a reusable export. Cosmetic.

`DayCarousel.js:87–88` uses `matchMedia("(prefers-reduced-motion: reduce)")`. That is required by §5.1 / §6.4 / §12. It is not the forbidden `"(pointer: coarse)"` / iOS branch.

## Spec compliance checklist

| Item | Result |
|---|---|
| Scroll contract | **Pass.** Coordinator listeners are exactly `touchstart` / `touchmove` / `touchend` / `touchcancel` / `wheel` on the scroller. DayCarousel owns click nav, keyboard (form-control guard), mouse-drag on `.tile-sky` (`pointerType !== "touch"`), snap, resize→nav. No coordinator `pointer*` / `setPointerCapture` / `matchMedia` / iOS. No DayCarousel `wheel` / `touchmove` / `window.scrollBy`. Axis locks until `touchend`/`touchcancel`; wheel is per-event with threshold `0` and raw `deltaY`. Touch exempt list is the one CONFIG selector on start and move; wheel has no exempt list. CSS map matches §6.3 (`html, body` = `manipulation`; scroller `pan-x pan-y` + `overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; overscroll-behavior-y: auto`; `.tile-sky` `pan-x pan-y`; guestbook/photos `pan-y`; `textarea, input` `manipulation`). No inner `overflow-y` on `.photo-list` / `.tile-guestbook` / `.comment-feed`. SiteController does not bind the coordinator. Pointermove sets `scrollLeft` only while mouse-dragging; it never `scrollBy`s, so iOS pointer+touch cannot double-apply vertical `scrollBy`. |
| Store lifetime | **Pass.** Only `SiteController` imports/calls `connectFirebase`. Tiles construct Guestbook/PhotoStrip with `store: null`, weather paints first, then `attachStore`. One `subscribeComments` and one `subscribePhotos`; `groupBy` fan-out to `tiles[]`. Guestbook/PhotoStrip do not import `firebase/client.js` and do not subscribe. `connectFirebase` returns Firestore fns; `store.js` does not import the CDN. Cache: inflight shared, `unconfigured` cached, `ok` (including `canWrite: false`) cached, rejected load not cached. |
| Auth-failed reads | **Pass.** Sign-in failure logs and returns `{ ok: true, canWrite: false }`. Controller still `createStore`s, `attachStore`s, and starts both snapshots. Auth-failed is not a feed `error`. Writes use `ERRORS.authFailed` / `ERRORS.photoAuth`. Unconfigured is the only path that skips store + snapshots (`setup` copy, forms already bound). |
| DayTile copy | **Pass.** §5.12: skin from `observations?.weatherCode ?? forecast.weatherCode`; `tempHeadline`; range only if both high/low; `skin.label`; `waveHeadline` (daily compass first, max bit only if `waves.max`); `windHeadline` omitted when null; `is-today` / kicker from `isCurrent`; UTC-16 `formatDayLabel`; Calm at `< 0.15` ft. Formatters do not take `isToday`. |
| Wave chain | **Pass.** Per-provider `try/catch` in `runProviderChain`; original throw message after the list; `isUsableWave` is the `app.js:85–91` predicate and is applied in marine parsers; NWS keeps `(start + durationToMs) \|\| 3600000` and uses today’s daily max as `current`; source strings `Open-Meteo ${model}` / `National Weather Service`; `wavePayload?.` optional-chain; wave-only dates are not sliced (`smoke` asserts 8 keys). |
| Shared rate limiter | **Pass.** `createRateLimiters(CONFIG)` once in `SiteController`; same `comment` / `photo` objects passed into every Guestbook/PhotoStrip; `stamp()` only after successful write; no per-tile `Date.now()` clock. |
| Skins table | **Pass.** Full `WEATHER_SKINS` with verbatim WMO labels (including duplicate Freezing drizzle / Rain showers / hail); `skinForCode` lookup + `FALLBACK_SKIN`; dark flags match `wx-rain` / `wx-showers` / `wx-heavy` / `wx-thunder`. No if/includes class mapper. |
| CSS columns | **Pass.** One `grid-auto-columns` formula from `--visible-tiles` and `--tile-gap`. Breakpoints 1400 / 900 / 600 only change `--visible-tiles` (and hide nav at 600). `--visible-tiles: 1` yields `100%`. |
| Closed machine | **Pass.** `resolveClosed({ now, searchParams, lastOpenDay, previewParam })` is the only preview/date decision; `time.js` does not read `location.search`. CLOSED shows `#closed`, hides `#live`, mounts no tiles, does not call Firebase. Guestbook has no `closed` flag. |
| No holland/ imports | **Pass.** Every import path has a `.js` extension. No `holland/` import. `git diff holland/` is empty. `firestore.rules` / `storage.rules` / `index.html` match original; `firebase-config.js` values match (comment only differs). |

## If Request changes
Not applicable. No blocking list. Agent 1 does not need to update for approval.

### What was checked (so this is not a tree-only review)

- Every file under `holland2/` (32 files), including `smoke.mjs` (ran: `holland2 smoke: all assertions passed`).
- Scroll: `ui/ScrollCoordinator.js`, `ui/DayCarousel.js`, `styles.css` touch/overflow/column rules.
- Store: `ui/SiteController.js`, `firebase/client.js`, `firebase/store.js`, `ui/Guestbook.js`, `ui/PhotoStrip.js`.
- Domain/data: `domain/models.js`, `domain/weather-skins.js`, `domain/day-builder.js`, `data/waves.js`, `data/weather.js`, `lib/time.js`, `lib/safe-url.js`, `lib/rate-limit.js`, `media/image-pipeline.js`, `ui/errors.js`, `ui/DayTile.js`.
- Product chrome: `index.html`, `config.js`, `README.md`, rules, `app.js`.
- Parity spot-checks against `holland/{app.js,comments.js,index.html,styles.css,firebase-config.js,firestore.rules}`.
- Addendum notes: `wavePayload?.` optional-chain, axis stays locked, root `touch-action: manipulation`, empty nickname → `"Anonymous"`, `forecastDays` unused (no slice).

`holland/` was not modified. No code was changed for this review except this file.
