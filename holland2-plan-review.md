# holland2 plan review (Agent 2)

## Verdict

**Request changes.**

The direction is right: config as the constant table, `Day { forecast, observations }`, one weather-skin table, a named wave chain, CSS variable columns, Guestbook/PhotoStrip constructed with their listeners, fan-out instead of `querySelectorAll`. Those would actually retire original debts.

The plan is not implementable as written. §6 contradicts itself on the only problem that forced the original patches. §7 contradicts itself on when the store exists. Several original product behaviors are implied rather than specified, so an implementer following the APIs (not the source) will ship the wrong sky copy, the wrong close-adjacent labels, and a weaker abuse story. Do not start Phase 0 until the checklist in this review is applied to `holland2-plan.md`.

---

## What is strong

- **Same collections, same field shapes, same Firebase project.** Correct for live data. Do not “clean up” `path` or invent a `photos_v2` collection.
- **No bundler, ES modules, GitHub Pages, no import from `holland/`.** The right hosting constraint.
- **`CONFIG.lastOpenDay` + Detroit day key on the client, rules `stillOpen()` left as the server twin.** Honest about the dual source of truth.
- **`Day { forecast, observations }` with `observations === null` on non-current days.** This is the actual replacement for the `currentTemp` / `currentWx` / `waveNowM` pile — if DayTile is specified to key off presence of observations, not `if (day.isCurrent)`.
- **One `WEATHER_SKINS` table returning `{ className, label, dark }`.** Kills the three-structure WMO / `weatherClass` / `isDarkWeather` split.
- **`runProviderChain` + `isUsableWave` at parse time, no `if (model === gfs)`.** Matches the original sequential fallback without encoding GFS folklore as a branch.
- **CSS `--tile-gap` + `--visible-tiles` with one `grid-auto-columns` formula.** The original four copies were the same math.
- **Components own their listeners; SiteController fans snapshots to `tiles[]`.** That removes `paintFeeds` / `paintPhotos` / `initComments` querySelectorAll.
- **Magic numbers listed into `config.js`.** Fetch, upload, cooldown, query, image ladder, axis threshold.
- **Closed is a site phase, not `initComments({ closed: true })` early-return.**
- **Photo stacking is layout, not a JS special case.** No inner `overflow-y` on `.photo-list` / `.tile-guestbook`.
- **Appendix A copy is accurate** against `holland/index.html`.
- **Phase 4 (scroll) before Phase 5 (forms)** is the correct go/no-go. Forms change hit targets; re-verify is mandatory.
- **`prefers-reduced-motion` as a cheap addition** that does not change the product.

---

## Blocking issues

### 1. §6 is three designs, not one — the coordinator will recreate the patches

**Problem.** §6.3 states all of the following:

1. Pointer Events are the **primary** API (`pointerdown/move/up/cancel`), plus non-passive `touchmove` because iOS.
2. Deduplicate with `handledTouchIds` / “touchmove already ran this frame.”
3. **Simplest robust rule:** touch-primary devices use touch listeners; mouse uses pointer; `matchMedia("(pointer: coarse)")` or `pointerType`.
4. The `bind()` snippet attaches **only** `wheel` + `touch*` — no pointer — and says mouse drag is DayCarousel’s job.

§6.4 then has DayCarousel listen to `pointerdown` when `pointerType !== "touch"`. §15.3 forbids special-case JS for “iOS only” or “wheel only.” §6.3’s x-axis row also says the coordinator may `scrollBy` horizontally “unless native pan is known broken (see 6.5)” — and 6.5 never defines that condition.

**Why it will cause a bad rebuild.** This is exactly how `initCarousel` grew: a new listener for each failure mode. If the implementer attaches both pointermove and touchmove, iOS Safari fires both and `scrollBy` double-applies (the original vertical-pan bug, inverted). If they follow `matchMedia("(pointer: coarse)")`, iPads with trackpads and Windows touch laptops take the wrong path. If they follow the `bind()` snippet only, the Pointer-Events paragraphs are dead text that someone will “complete” later. `touch-action: pan-x` on `.forecast-scroller` (plan) vs original `pan-x pan-y`, plus JS `preventDefault` on the same node, is an unspecified interaction: either CSS already sends vertical pans to the page (JS `preventDefault` then **blocks** the page and must `scrollBy`, or you get a dead Y-axis), or iOS still captures Y inside the overflow-x scrollport (JS is required, same as today). The plan never picks which world we are in.

**Required plan change.** Replace §6.3’s pointer/touch/iOS/coarse paragraphs with one contract (proposed in **Scroll architecture assessment**). Delete “see 6.5” horizontal fallback. Delete `matchMedia`. Coordinator does not setPointerCapture. Wheel is the same classifier fed by a delta, not a second policy.

### 2. Store lifetime vs tile construction is self-contradictory

**Problem.** §7 constructs `DayTile` (and therefore Guestbook + PhotoStrip) **before** `connectFirebase()`. The same paragraph says “tiles receive the same store instance at construction so forms/uploads work.” §5.11 constructors take `store`. §5.10 says cache `connectFirebase()` “so Guestbook and PhotoStrip share one connection,” which implies the components call it themselves. Phase 5 says SiteController fans out subscriptions.

Three architectures, one data-flow diagram.

**Why it will cause a bad rebuild.** Implementer either:

- passes `store = null`, then forms no-op until an unspecified `attachStore` (not in the API), or
- has every Guestbook call `connectFirebase()` **and** SiteController call it, then nobody knows who owns `subscribeComments` (N snapshot listeners vs 1), or
- delays tile construction until after Firebase, which delays first paint of weather (original paints tiles first, then `initComments` — that order is load-time UX, not optional).

Original: tiles exist, feeds say “Loading notes…”, then one `initComments` binds the world. holland2 needs that sequence with a **single** connection owner.

**Required plan change.** Pick one and write it in §5.11 + §7:

- `SiteController` is the only caller of `connectFirebase()` / `createStore()`.
- `DayTile` / Guestbook / PhotoStrip are constructed with `store: null` (or a thenable) and have `attachStore(store)` **or** constructors run after weather paint but Guestbook defers writes until `attachStore`.
- `subscribeComments` / `subscribePhotos` live only in `SiteController`. Components do not subscribe.
- Components do not import `firebase/client.js`. Only SiteController and `createStore`’s module do.

Also fix: **`firebase/client.js` cannot be the only file that imports the Firestore SDK.** `createStore` needs `collection`, `addDoc`, `query`, `orderBy`, `onSnapshot`, `serverTimestamp`, `limit`. Either `connectFirebase` returns those functions next to `db`, or `store.js` is explicitly allowed to static/dynamic-import the same `gstatic` 11.0.2 URLs (browser ESM treats them as a singleton). The sentence “inside `firebase/client.js` only” is currently false.

### 3. Auth-failed is specified as a terminal feed state; original is not

**Problem.** Original `initComments`: `signInAnonymously` failure writes the auth message into feeds, **then still starts `onSnapshot` and `bindForms`**. Public reads do not need auth. The snapshot replaces the auth message when data arrives. Writes fail without `uid` (upload already checks `auth.currentUser.uid`).

Plan §7 / §11: `auth-failed` → feed state `"error"` with auth copy, and `createStore` only on `ok`. Existing notes/pictures disappear behind a session error.

**Why it will cause a bad rebuild.** Feature regression on the exact failure App Check / authorized-domains / Anonymous Auth misconfig produces. Visitors still need to **read** the guestbook.

**Required plan change.** `connectFirebase` reasons:

- `unconfigured` → no SDK, setup copy, bind local forms that show the original “not configured” submit errors.
- `ok` with `auth.currentUser` possibly null → still `createStore` and subscribe. If anonymous sign-in failed, keep a **write** flag `canWrite: false`; feeds still load; post/upload show the original auth copy.
- Do not map auth-failed to `setFeedState("error")` as a terminal override of snapshots.

### 4. DayTile / sky copy is not specified; `waveHeadline` does not match original

**Problem.** Product table says headline temp, current wx on today, Today kicker, wave/wind lines. The APIs specify `waveHeadline` / `windHeadline` only, and those helpers are wrong in detail.

Original (`app.js` `renderTile` / `buildDays`):

| Concern | Original | Plan gap |
|---|---|---|
| Sky WMO class + label | `currentWx ?? weatherCode` | Not stated. Easy to use only `forecast.weatherCode`. |
| Headline temp | `currentTemp ?? high` | No `tempHeadline(day)`. |
| High/low line | Only if **both** non-null: `H {n}° / L {n}°` | Missing. |
| Wind line | Omitted entirely if speed is null. Today: `currentWindMph ?? windMph`. | `windHeadline` unspecified when both null (must not print `Wind —`). |
| Wave compass | `waveDay.direction ?? (today ? current.direction : null)` — **daily dominant first** | `waveHeadline` if `waves.now` will take now’s direction. |
| Wave “max” bit | Pushed only if `waveMaxM != null` | Plan always interpolates `max {ft}` when `waves.now` is set. |
| Calm | `formatWaveFt`: `< 0.15` ft → `"Calm"` | Named but not specified. |
| Day labels | `Date.UTC(year, month-1, day, 16)` then format in `America/Detroit` | `formatDayLabel` has no algorithm. `new Date(dayKey)` is UTC midnight → **previous calendar day** in Detroit. |

`buildDays` still sets `isCurrent` and then branches observations/waves.now (necessary). That is fine. What is **not** fine is §3.12 / §15.3 implying DayTile has no today logic while `waveHeadline` is described as a today-shaped string, and `formatDayLabel({ isCurrent })` is how “Today” appears — that last one **is** a today branch and should be named as the one allowed calendar branch, not hidden.

**Why it will cause a bad rebuild.** Wrong art on today’s tile after a front moves through, wrong weekday on every tile, `Now 1.2 ft · max — · NNE` when max is missing, compass from the current sample instead of daily dominant.

**Required plan change.** Add a **§5.12 DayTile render contract** with functions and original rules (replacement text in the checklist). Put `formatDayLabel`’s UTC-16 algorithm in §5.2. Put `formatWaveFt` / `formatTemp` / `compassFromDegrees` + the 16-point `COMPASS` table in `domain/models.js` (do not spawn `lib/format.js` unless it appears in the tree). State that `is-today` CSS and the kicker are driven by `day.isCurrent`; weather/wave/wind/temp **copy** is driven by `observations` / `waves.now` presence, with the compass/max rules above.

### 5. Wave chain will not fall through if `fetch()` throws

**Problem.** Original: `fetchOpenMeteoWaves("ecmwf_wam025").catch(() => null)` then GFS then NWS. Plan §5.8: “await each provider.fetch(); return first non-null usable result.” No per-provider catch. HTTP 500 / timeout / JSON throw aborts the chain.

**Why it will cause a bad rebuild.** ECMWF down → no GFS, no NWS, waves branch rejected, possible site ERROR if weather also fails — original would have shown NWS.

**Required plan change.** `runProviderChain`: each provider is `try { const r = await p.fetch(); if (usable(r)) return r; } catch (e) { log(e); }`. After the list, throw the original message `No wave forecast was available for this location.` Usable stays `Object.keys(dailyByDate).length > 0 || current != null`. `isUsableWave` must be the original predicate (see spec bugs), applied inside marine parsers so GFS zeros become `null` at parse time.

### 6. Rate limits are global in the original; the component API makes them per-tile

**Problem.** `bindForms` / `bindUploads` keep one `lastSubmit` / `lastUpload` for the whole page. Plan: each `Guestbook({ rateLimitMs })` and each PhotoStrip instance.

**Why it will cause a bad rebuild.** Seven tiles × post every 0 ms is seven times the original client throttle. Weakens the only client-side burst control (rules do not rate-limit).

**Required plan change.** One `RateLimiter` (or two: comment/photo) owned by SiteController or the store, passed into every Guestbook/PhotoStrip. Not `Date.now()` inside each instance. Put the shared object in §5.11.

---

## Non-blocking improvements

1. **`isSafeImageSrc` is required and homeless.** Original lives in `comments.js` next to `renderPhotos`. Allowlist: `data:image/jpeg;base64,…` regex, length 12..900000, or `https:` host `firebasestorage.googleapis.com` / `*.firebasestorage.app` / `*.googleapis.com`. Put `lib/safe-url.js` (or under `media/`) in the **file tree**, call it in PhotoStrip before `img.src`, never in the store (store should persist what rules already accepted; the DOM sink is the XSS boundary). Test `javascript:` and oversized strings.

2. **Upload timeout must wrap compress *and* `addDoc` separately** (original: two `withTimeout(..., 45000)`). §5.9 only times `fileToInlineJpeg`. PhotoStrip will infinite-spin on a hung Firestore write. Specify both in §5.11.

3. **Image pipeline omitted original details that prevent real bugs:** fill canvas with `#ffffff` before `drawImage` (HEIC/PNG alpha); keep chunked `String.fromCharCode` + `btoa` (a single `String.fromCharCode(...bytes)` throws on large photos). Write them into §5.9.

4. **Keyboard: original already hijacks arrows that bubble from textarea** (listener is on the scroller, tiles are descendants). §12 says don’t; §6.4 doesn’t. Add to DayCarousel: ignore ArrowLeft/Right when `event.target` is `input, textarea, select, [contenteditable]`.

5. **`ERRORS` is missing original form strings.** Feeds use the long Firebase-keys sentence; **submit** uses “Firebase is not configured yet, so comments cannot be saved.”; **upload button** uses the pictures variant; honeypot success is `"Thanks."`; statuses are `Reading picture…` / `Shrinking picture…` / `Saving picture…` / `Uploaded.` / `Posting…` / `Posted.` — not the truncated “Reading / Shrinking / Saving / Uploaded” in §2. Put every user-visible string in `ui/errors.js` or Appendix A.

6. **Wave-only `forecastDays` slice.** Original `buildDays` does **not** slice; weather is requested with `forecast_days=7`, but NWS-only fallback uses **all** `dailyByDate` keys. Plan step 2 slices to 7. Prefer original: do not slice wave-only dates (or document the change). Request still passes `forecast_days=7`.

7. **NWS `parseIsoDuration` operator precedence** is `(start + duration) || 3600000`. Keep it when moving to `durationToMs`; do not “fix” it.

8. **Open-Meteo marine `source` string** is ``Open-Meteo ${model}`` (e.g. `Open-Meteo ecmwf_wam025`). Specify so as-of matches.

9. **`overscroll-behavior-y: auto`** on `.forecast-scroller` exists in original and is omitted from §6.6. Keep it unless you can show it fights the policy.

10. **Drop `a11y/live.js`.** It is “optional,” has no API, and is unused in Phase 7. Conditions card already has `aria-live="polite"`. Either specify two functions or delete the directory from the tree.

11. **Rename leftover `ui/status.js` (§3.10) to `ui/errors.js`** and add `ui/errors.js` to the §4 tree. Phase 5 already names it.

12. **Do not add `lib/format.js` “if helpers grow.”** Compass + temp + wave-ft belong in `domain/models.js` next to the headlines. Optional files are how the tree and later sections diverge.

13. **`lib/dom.js` “delegate helpers”** are in the tree one-liner and missing from §5.3. Either `on(el, type, selector, fn)` is specified or the phrase is removed.

14. **README must say holland and holland2 share `comments` / `photos`.** Dual writers, same App Check domain (`pmcculfor.github.io`). Accepted; operators need to know a holland2 bug can write into the live guestbook.

15. **`connectFirebase` cache:** cache the in-flight promise; do **not** cache a rejected `ok: false` from a transient network error without a retry path (unconfigured can be cached).

16. **Wheel `deltaMode`:** original passes `deltaY` through raw. Converting mode 1 with `* 16` makes wheel-over-tile feel different from wheel-over-masthead (browser uses its own line height). Prefer raw `deltaY` for parity; if you convert, convert mode 2 (pages) too and note it as a deliberate change.

17. **PhotoStrip should not take `auth`.** Path `days/${dayKey}/${uid}_${Date.now()}.jpg` belongs in `store.addPhoto` (store already has `auth` via client). UI passes `{ dayKey, url }`.

18. **`Guestbook({ closed })` is dead.** Closed site never mounts tiles. Remove the flag or explain a use.

19. **Unit-test the axis classifier** (`undecided` / `x` / `y` for touch deltas and for wheel `deltaX`/`deltaY`, including `deltaY === 0`). §13.1 tests domain functions and ignores the code that caused the patches.

20. **Exempt list: original touchstart** skips `input, textarea, button, a`; **touchmove** skips only `input, textarea`. Plan adds `label` and uses one list for all events. Prefer one list: `input, textarea, select, button, a, label`. Apply it to touch; decide wheel-over-textarea explicitly (original does **not** exempt wheel — page steals scroll even over the comment box).

---

## Spec bugs / inconsistencies

1. **File tree vs later sections.** §4 tree has no `ui/errors.js` (required in §11 and Phase 5). Has `a11y/live.js` optional (never specified). §3.10 names `ui/status.js`. §5.5 names `lib/format.js` as optional. `lib/dom.js` “delegate helpers” have no API.

2. **“No today branch” vs builder vs kicker vs waveHeadline.** §3.12 / §15.3 vs §5.7 steps 6–8 (`isCurrent ? observations`) vs `formatDayLabel({ isCurrent })` vs wave strings that exist to mimic today. Rephrase: one calendar flag `isCurrent`; no second `if (isToday)` in formatters — formatters read `observations` / `waves.now`. Kicker is allowed to use `isCurrent`.

3. **DayCarousel vs coordinator ownership.** §5.11: `new DayCarousel({ … coordinator })`. §6.4: “DayCarousel.init creates the coordinator.” §7: `ScrollCoordinator.bind(scroller)` as a sibling step after `setTiles`. One owner: DayCarousel constructs/binds/destroys the coordinator. SiteController does not call `ScrollCoordinator.bind`.

4. **Pointer primary vs `bind()` without pointer** — Blocking issue 1.

5. **`touch-action` values changed without a migration note.** Original: `html, body` and `.forecast-scroller` and `.tile-sky` are `pan-x pan-y`; guestbook/photos `pan-y`. Plan: `html, body` `manipulation`; scroller `pan-x`; sky `pan-x`; guestbook `manipulation` or `pan-y`. That is a behavior change, not a restyle. Specify the final map in one table; do not leave “or.”

6. **TypeScript in “JSDoc contracts.”** §5 uses `function foo(): string`. Implementer paste will break native ESM. Rewrite examples as `@param` / `@returns` or untyped JS.

7. **`isUsableWave` wording vs code.** §2: “reject height/period both zero or missing.” Original: null/NaN **height** is unusable; `height === 0 && (period === 0 || period == null)` is unusable; **height 0 with a real period is usable.** §13.1 only tests `(0,0)` and `(1.2, 4)`. Add `(0, 4) === true`, `(null, 4) === false`.

8. **`WaveObservation.directionDeg` vs original `direction`.** Internal rename is fine; parsers must map Open-Meteo `wave_direction_dominant` / `wave_direction` and NWS (null). Do not persist `directionDeg` to Firestore (waves are not stored).

9. **Site phases vs per-tile feed phases.** §11 does not define precedence. Required: connection states `setup` | `error`(snapshot) are overrides until the next successful snapshot; `loading` until first snapshot callback; then `empty` | `ready` from `items.length`. Snapshot success **clears** a previous snapshot error (original `paintFeeds` overwrites). Site `ERROR` means no tiles — feeds do not exist. Site `CLOSED` means no Firebase. These cannot fight if SiteController never mounts tiles in CLOSED/ERROR.

10. **`body[data-site-phase]` vs `hidden` on `#closed` / `#live`.** §9 says both, prefers `hidden`. Pick `hidden` + `aria-busy` to match original; drop the data attribute unless CSS needs it (it doesn’t).

11. **Appendix C `app.js` vs Phase 0.** Phase 0: `app.js` logs “holland2 scaffold.” Appendix C: 15-line SiteController bootstrap. Fine as a sequence; say Phase 0 is temporary.

12. **`el()` in §5.3 vs original `el(tag, className, text)`.** New attrs object is fine; require `textContent` only, never `innerHTML`, including `aria-*` via `setAttribute`.

13. **Weather skins table is a sketch.** Drizzle/rain/showers/heavy/snow rows are comments (`/* labels per code */`). The implementer must copy `WMO` from `app.js:11–40` **verbatim**. Paste the full table into §5.6; “must match original” without the strings is how labels drift (`Rain showers` twice, `Freezing drizzle` twice, hail on 96 and 99).

14. **`CONFIG.scroll.snapBehavior: "smooth"`** vs `prefers-reduced-motion` → `auto`. DayCarousel must read the media query (or a helper) rather than always using CONFIG.

15. **`PhotoStrip.setListState` vs `Guestbook.setFeedState`.** Harmless, but `setup` copy is shared — both should import `ERRORS.firebaseUnconfigured`.

16. **Relative imports.** `ui/SiteController.js` → `../firebase/client.js` **works** on GitHub Pages (same-origin static files, `type="module"`, `.js` extensions required). `app.js` → `./ui/SiteController.js` works. No cycle if `firebase/client.js` does not import `ui/*`, `config.js` imports nothing in `ui/` or `data/`, `domain/models.js` does not import `ui/`. Document that **every import includes `.js`**. There is no circular import in the intended graph; the risk is SiteController ↔ DayCarousel ↔ ScrollCoordinator if coordinator imports carousel. Coordinator must not import DayCarousel.

17. **`index.html` mounts.** §4 says `#app mount`; Appendix C says stay close to holland (`#closed`, `#live`, `#conditions`, `#forecast-scroller`). There is no `#app`. Drop `#app`; reuse original ids so ClosedNotice/ConditionsCard are not a second shell.

18. **`forecast-scroller` `touch-action` vs JS `preventDefault`.** Spec bug as a CSS/JS contract gap — see scroll section.

19. **§8 “photo URL size/prefix | pipeline + `isSafeImageSrc`”** while pipeline emits only JPEG data URLs. `isSafeImageSrc` is for **reads** of legacy `https://` Storage URLs. Do not run the allowlist as a write-time filter that would reject our own data URLs (it should accept them). Writes: rules `validPhoto()`.

20. **Closed copy / rules pair** is correct: client `detroitDayKey() > "2026-09-03"`; rules `< 2026-09-04 04:00 UTC`. Do not “unify” them into one JS expression used by rules (impossible). README sync paragraph is required and already planned.

---

## Scroll architecture assessment

**Will §6 replace the patches or relocate them?** As written, **relocate, then multiply.** The policy sentence in §6.1 is good. The implementation section immediately special-cases devices, then contradicts itself with a simpler `bind()` that is basically original `initCarousel` minus mouse-drag. That is an organizational split (DayCarousel vs ScrollCoordinator), not a new architecture. Organizational splits are worth doing **if** the coordinator is one classifier + one router + one listener set.

CSS containment in §6.2 is correct and necessary: `overflow-x: auto; overflow-y: hidden` (because `visible` computes to `auto`). That is the root cause. `touch-action` is the browser’s un-waited permission. JS exists because iOS still assigns vertical pans to that scrollport.

### Tighter contract (replace §6.3)

**Invariants**

1. One gesture, one axis. Axis locks until `touchend`/`touchcancel` (touch) or is computed per `wheel` event (wheel has no lock across ticks).
2. Vertical always moves the **page**. Horizontal always moves the **scroller**. Pinch is not a coordinator concern (viewport + `touch-action` on `html, body`).
3. Coordinator **never** listens to pointermove. Pointer on `.tile-sky` with `pointerType !== "touch"` is DayCarousel drag only.
4. Coordinator **never** branches on iOS / coarse pointer / `PointerEvent` in `window`. The listener set is the same on every device.

**Listeners (exactly these, on `scroller` only — not `document`)**

| Event | Passive | Role |
|---|---|---|
| `touchstart` | true | Record id, x, y; axis = undecided; ignore if `touches.length !== 1` or exempt target |
| `touchmove` | **false** | Classify; if `y`, `preventDefault` and `page.scrollBy(0, lastY - y)`; update lastY. If `x`, return (native `overflow-x` + snap). If undecided, return |
| `touchend` / `touchcancel` | true | Clear identity |
| `wheel` | **false** | Classify this event’s `deltaX`/`deltaY`. If `y` (`abs(deltaY) >= abs(deltaX)` **and** `deltaY !== 0`), `preventDefault` and `page.scrollBy(0, deltaY)`. If `x` or `deltaY === 0`, return |

Classifier: `abs(dx) < t && abs(dy) < t` → undecided; else `abs(dy) >= abs(dx) ? y : x`. Same function for touch (client deltas from start) and wheel (event deltas). Threshold from `CONFIG.scroll.axisThresholdPx` (touch only; wheel has no threshold beyond original `deltaY === 0`).

**Exempt targets (touch only):** `closest("input, textarea, select, button, a, label")` on start **and** move. Do not start a lock; do not `preventDefault`. Wheel: **match original** (no exempt) unless you explicitly accept textarea inner-scroll as a product change — then say so.

**CSS (one map, no “or”)**

```
html, body          touch-action: manipulation;   /* no pinch; pan allowed */
.forecast-scroller  overflow-x: auto; overflow-y: hidden;
                    touch-action: pan-x pan-y;    /* KEEP original; JS steals Y */
                    overscroll-behavior-x: contain;
                    overscroll-behavior-y: auto;
.tile-sky           touch-action: pan-x pan-y;    /* mouse-drag handle; same as original */
.tile-guestbook,
.photo-block        touch-action: pan-y;
textarea, input     touch-action: manipulation;
```

**Why not `pan-x` only on the scroller?** Because the plan then **also** `preventDefault`s vertical `touchmove`. On engines where `pan-x` already delivers Y to the page, `preventDefault` on the scroller cancels that page scroll and you must `scrollBy` perfectly or Y dies. On iOS where the scrollport still eats Y, you need the JS anyway. Original `pan-x pan-y` + steal Y is the known-good pair. Switching CSS **and** keeping JS is two untested changes. Revisit `pan-x` only as a later experiment behind the same classifier, not as the v1 spec.

**DayCarousel only:** click nav, keyboard (with input guard), mouse-drag on `.tile-sky`, snap on pointerup, `tileStep` = first tile width + computed column-gap, resize updates nav disabled. **No wheel. No touchmove. No `window.scrollBy`.**

**What this does not pretend:** it will not make iOS nested overflow correct in CSS alone. It **does** put the original two working interceptors in one object with one classifier, which is the actual debt in `initCarousel`. That is enough. Claiming “no exception for wheel vs touch” while wheel cannot axis-lock across events is sloganeering; call wheel a discrete delta source to the same `classify()`.

**Test the contract, not the browser brand:** classifier unit tests; desktop wheel over sky/notes/photos does not change `scrollLeft`; shift/trackpad X still does; after Phase 5, vertical pan on a **tall** photo stack still moves the page (this is the inner-scroller regression). Record that iOS Safari cannot be certified in DevTools.

---

## Required plan edits (checklist)

Agent 1 must change `holland2-plan.md` as follows before coding.

- [ ] **§4 tree:** Add `ui/errors.js`. Remove `a11y/live.js` (or give it a real API). Remove any mention of `ui/status.js` and `lib/format.js`. Remove `#app`. Add `lib/safe-url.js` (`isSafeImageSrc`). Add `lib/rate-limit.js` or specify a store-owned limiter.

- [ ] **§5.2 `formatDayLabel`:** Replace the stub with: parse `YYYY-MM-DD`, `new Date(Date.UTC(year, month - 1, day, 16))`, format weekday + `month day` with `timeZone`. Kicker `"Today"` iff `isCurrent`.

- [ ] **§5.5 / new §5.12 DayTile render contract** (insert after 5.11):

```
skin code     = day.observations?.weatherCode ?? day.forecast.weatherCode
headline temp = day.observations?.tempF ?? day.forecast.highF   // "—" if both null
range         = if highF and lowF both non-null: `H ${formatTemp(high)} / L ${formatTemp(low)}`; else omit
wx label      = skinForCode(skin code).label
waves         = waveHeadline(day)  // see corrected helper
wind          = if speed == null omit; else `Wind ${round} mph` [+ space + compass if present]
                speed = observations.windMph ?? forecast.windMph
                dir   = observations.windDirDeg ?? forecast.windDirDeg  // today prefers current
is-today class iff day.isCurrent
```

Corrected `waveHeadline`:

```
compass from (waves.max?.directionDeg ?? waves.now?.directionDeg)  // daily first
if waves.now:
  bits = [`Now ${formatWaveFt(now.heightM)}`]
  if waves.max: bits.push(`max ${formatWaveFt(max.heightM)}`)
else if waves.max:
  bits = [`Waves ${formatWaveFt(max.heightM)}`]
else:
  bits = [`Waves —`]
if compass: bits.push(compass)
return bits.join(" · ")
```

`formatWaveFt`: null/NaN → `"—"`; else feet = m * 3.28084; if feet < 0.15 → `"Calm"`; else one decimal + `" ft"`.

- [ ] **§5.6:** Paste the full original `WMO` labels into `WEATHER_SKINS` (every code 0–99 used in `app.js`).

- [ ] **§5.7:** Keep observations/waves.now assignment on `isCurrent`. Do **not** slice wave-only date lists to `forecastDays` (or explicitly accept showing fewer NWS days than original).

- [ ] **§5.8:** Per-provider try/catch; original throw message; `isUsableWave` copied from `app.js:85–91`.

- [ ] **§5.9:** White fill, orientation, ladder, chunked base64, typed errors. PhotoStrip additionally timeouts `addPhoto` with `CONFIG.timeouts.uploadMs`.

- [ ] **§5.10:** `connectFirebase` returns `{ ok, app, auth, db, canWrite }` plus Firestore **functions** (or store.js may import gstatic 11.0.2). Cache promise. `addPhoto` generates `path` from `auth.uid`. `addComment` / `addPhoto` use `serverTimestamp()` (`createdAt == request.time` in rules).

- [ ] **§5.11:** Remove `coordinator` from DayCarousel constructor public API (it creates one). Remove `auth` from PhotoStrip. Remove `closed` from Guestbook/PhotoStrip or justify it. Add `attachStore(store)` (or equivalent). Add shared rate limiter. DayCarousel keydown guard for form controls. `ScrollCoordinator` API matches the tighter contract (no pointer, no matchMedia).

- [ ] **§6.3:** Delete and replace with the tighter contract in this review (listeners table + CSS map + `pan-x pan-y` on scroller). State wheel is a delta **source**, not a second policy. Delete horizontal `scrollBy` “if native pan broken.”

- [ ] **§6.4:** “DayCarousel constructs ScrollCoordinator in `constructor`/`bind`, destroys it in `destroy`. SiteController does not bind the coordinator.” Mouse-drag algorithm stays.

- [ ] **§7 data flow:** After `setTiles`, `DayCarousel` binds coordinator internally. Then `connectFirebase` → `attachStore` + **one** comments subscription + **one** photos subscription → `groupBy` → `tile.setComments` / `setPhotos`. Auth failure does not skip subscribe. Unconfigured: `setFeedState("setup")` + forms still bind.

- [ ] **§9:** One `touch-action` table matching §6. Drop `data-site-phase` unless a CSS rule needs it. Keep `[hidden]`.

- [ ] **§11:** Feed state precedence (loading → snapshot → empty/ready; setup if unconfigured; snapshot error recoverable). Auth-failed is not a feed phase. Include all original strings in `ERRORS` (configured vs unconfigured submit, honeypot `"Thanks."`, picture status sentences).

- [ ] **§13.1:** Add `isUsableWave(0, 4)`, `isUsableWave(null, 1)`, `formatDayLabel` at a Detroit-ambiguous UTC midnight, `waveHeadline` daily-vs-now compass, `classify` for the coordinator.

- [ ] **§13.2 / 13.3:** Wheel over textarea (document chosen behavior). After two photos, no inner scrollbar, page still pans from the photo. Nav disabled at ends. `?previewClosed=1`. Do not claim iOS certified from DevTools.

- [ ] **§15.3:** Rewrite so it does not forbid wheel-as-delta-source. It **does** forbid `matchMedia`, `if (iOS)`, second wheel handler in DayCarousel, and pointer+touch both calling `scrollBy`.

- [ ] **README (planned):** holland2 URL; rules/console sync; **holland/ and holland2/ share collections**; pinch `maximum-scale=1` is intentional.

---

## What we should not change

- No bundler, no React, no shared runtime with `holland/`.
- Same Firestore collections and field shapes; `dayKey` 10-char `YYYY-MM-DD`; photo `url` inline JPEG (plus legacy https allowlist on **display**).
- Same Firebase project, App Check, anonymous auth, honeypot `company`, create-only rules.
- Client close: `detroitDayKey() > "2026-09-03"`; preview `?previewClosed=1`; rules `stillOpen()` at 2026-09-04 04:00 UTC.
- Copy in Appendix A; WMO strings; as-of pattern; footer.
- Weather: Open-Meteo city `42.7875, -86.1089`, °F, mph, `America/Detroit`, `forecast_days=7`, fetch once.
- Wave points and order: ECMWF WAM `ecmwf_wam025` → GFS `ncep_gfswave025` → NWS points `42.9,-86.27` grid `waveHeight`. Forecast, not buoy.
- `Day` model with `forecast` + nullable `observations` (do not go back to a bag of `currentTemp` fields).
- `WEATHER_SKINS` table; CSS weather art via classes; `wx-dark` from `skin.dark`.
- `--tile-gap` / `--visible-tiles` as the only column math; breakpoints 1400 / 900 / 600.
- Photos: vertical stack, `height: auto`, no inner scroller; compress ladder; 20 MB / 180 KiB / 45 s timeout.
- Site phases `closed | loading | ready | error` with `hidden` on `#closed` / `#live`.
- `Promise.allSettled` weather vs waves; ready if either works; ERROR only if both fail or `buildDays` is empty.
- Viewport `maximum-scale=1`; do not add `user-scalable=yes`.
- Phase 4 scroll go/no-go before Firebase widgets.
- `type="module"` + relative `./…/*.js` imports, Firebase 11.0.2 from gstatic.
- Leave `holland/` untouched.
