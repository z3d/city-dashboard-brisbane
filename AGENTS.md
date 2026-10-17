# City Dashboard

Single-file city dashboard focused on Brisbane, deployed optionally as a Cloudflare Worker.

## Commands

- `npm run dev` - local Cloudflare Worker at `http://localhost:8787`
- `npm run deploy` - deploy with Wrangler
- `node scripts/check-ios12-compat.js` - scan `index.html` for iOS 12-incompatible JavaScript
- `node --check src/worker.js` - syntax-check the Worker
- `npm run validate` - run the complete local validation suite
- Or open `index.html` directly in a browser for features that do not require the Worker

## Architecture

```text
index.html              # Single-file dashboard, source of truth for frontend
src/worker.js           # Cloudflare Worker API proxy routes
public/index.html       # Symlink to ../index.html; do not replace with a copy
public/exercise.html    # Standalone phone page for the Exercise card (same token, same synced log)
scripts/sync-exercise-app.js  # Copies the Exercise card's shared JS block into exercise.html
```

## iOS 12 Safari Compatibility

`index.html` must stay compatible with iOS 12 Safari:

- No arrow functions; use `function() {}`
- No `let` or `const`; use `var`
- No template literals
- No `for...of`
- No destructuring, spread, rest, optional chaining, or nullish coalescing
- No `Promise.allSettled`, `Object.entries`, or `Array.flat`
- Use `XMLHttpRequest`, not frontend `fetch()`
- Run `node scripts/check-ios12-compat.js` after frontend JavaScript changes

Worker code in `src/worker.js` runs on Cloudflare's V8 runtime and may use modern JavaScript.

## Data And Privacy

This public fork is intended to be generic. Do not add personal integrations, hardcoded device names, home proxy URLs, credentials, tokens, or private account identifiers.

The birthday feature must ship with `birthdays: []`. Names and dates are user-entered local settings and must never be added to source defaults or examples. Per-birthday timezones use the allowlisted IANA names in `COMMON_TIMEZONES`.

Before publishing or pushing, scan for secrets and identifying data:

```bash
rg -n "token|secret|password|api[_-]?key|email|github.com/.+/.+|workers.dev|AIza|sk-" .
git status --short
```

Keep `.dev.vars`, `.env`, `.Codex/settings.local.json`, `.codex/settings.local.json`, and `.claude/` ignored.

## Patterns

- Config is stored in `config` and persisted to localStorage with the `brisbane_` prefix.
- DOM elements are cached in `elements` from `initElements()`.
- New cards must be added to `DEFAULT_CARD_ORDER`.
- Card display modes use `xxxDisplayMode` with `card`, `ticker`, `banner`, or `both`.
- Cards in `STRIP_PLACEMENT_CARDS` (weather, UV, air quality, pollen) emit `kind: 'status'` slides and also store `xxxPlacement` (`bar`, `ticker`, `both`): top bar, scrolling row, or both. Their settings select combines the two as `mode:placement` (e.g. `both:bar`); `openSettings()` fills it via `stripModeValue()` and `saveSettings()` splits it with `applyStripModeValue()`. A new status card must join the list and use the wide combined select.
- Theme colours are CSS variables, never raw dark greys: rendered HTML strings and `style.*` assignments use `var(--t1)`..`var(--t6)` for text, `var(--s1)`/`var(--s2)` for inset surfaces, `var(--ok)`/`var(--warn)`/`var(--bad)`/`var(--info)` etc. for accents and `var(--wNN)` for translucent lines. A literal `#e0e0e0`/`#aaa`/`rgba(255,255,255,…)` vanishes in light mode. Dark values are on `html`, light values on `body.light-theme`.
- Escape all third-party API text at the HTML sink with `escapeHtml()`; use `safeDomId()` for API-derived element IDs.
- Exercise card: `getExerciseRows()` is the one source for the card, visibility, ticker and Needs Attention; definitions sync as `exerciseDef` (last-write-wins by `updatedAt`), completions and skips as the `exerciseDone` log (`<name>_<period>_<YYYY-MM-DD>` and `..._skipped`, union-merged by newest timestamp). The client `sanitiseExerciseDoneLog` and Worker `sanitizeExerciseDoneLog` must stay byte-for-byte equivalent (30-day cutoff, newest 500) or every poll PUTs to KV; `validate-project` pins the pair and the idempotent-PUT fingerprint. Poll-path reconcile PUTs are throttled to one per 5 min; user actions save immediately.
- `public/exercise.html` embeds the block between `// >>> shared-exercise-block` and `// <<< shared-exercise-block` verbatim from `index.html`; after changing the card's logic run `node scripts/sync-exercise-app.js` (validation fails on drift). The page PUTs only its own pending taps, never on a poll.
- Porting from the private dashboard: its medicine-named helpers map to `sanitiseExerciseDoneLog`, `mergeExerciseDoneLogs`, `exerciseDoneLogsEqual`, `getLocalDateStr`, `parseClockTimeToMin`, `formatNameList` (worker: `sanitizeExerciseDoneLog`); the scale/weight line is not ported (no scale feed here).
- Frontend XHRs inherit a 30-second timeout and same-URL GET deduplication. Worker upstream requests inherit a 20-second deadline. Preserve both wrappers.
- Needs Attention is a global smart strip controlled by `showNeedsAttention` and `needsAttentionMaxItems`. It renders in `#needsAttention`, uses enabled feature toggles as eligibility, and builds alerts from cached `last*Data`/config without extra API fetches. It currently excludes bin and sports alerts, and only treats electricity as attention-worthy when prices are high.
- Weather alert banners must never fire on the first feed snapshot. Re-baseline silently after a processing gap longer than 15 minutes so sleeping wall displays do not replay stale transitions when they wake.
- `/api/feed-health` is per-isolate, read-only observability populated by the central response wrapper. It must not write KV or add upstream requests.
- Bin card conditional dismissal can sync through `GET/PUT /api/dashboard-status` when the worker has a `STATUS_KV` or `SETTINGS_KV` binding. It falls back to the existing localStorage keys: `binTakenOutDate` hides the pre-collection card until the bring-in window, while `binDismissedDate` hides the bring-in "Done" state.
- Radar/Satellite conditional display depends on weather data: `bomRadarShowWhenRainy` and `radarShowWhenRainy` use weather codes or 50%+ rain chance. `fetchWeather()` must still run for these conditions even when the Weather card is off.
- Module-level Worker caches are load reducers, not cross-isolate rate limiters. Quota-limited upstreams must use a shared KV cache.
- `DASHBOARD_TOKEN` is mandatory for every API route except `/api/health`, and authentication must keep using `timingSafeEqual()`.
- Open-Meteo timestamps should use `timeformat=unixtime` and parse with `new Date(timestamp * 1000)`.
- Electricity prices use the Worker `/api/electricity` route. NEMWEB removed the old `GRAPH_5QLD1.csv` feed; parse the latest `DispatchIS_Reports/PUBLIC_DISPATCHIS_*.zip` and QLD1 `DISPATCH,PRICE` RRP instead. The card graph reads `/api/electricity/history` (AEMO 5MIN report, module cache only — a 5-min KV key would cost 288 puts/day), fetched at most every 5 minutes by `fetchElectricityHistory()`.
- Every ticker slide in `buildTickerSlides()` must carry a `cardId` (or `newsIdx` for headlines): tapping a ticker/status-strip reading clones that card's `.card-inner` into `#cardPopupOverlay` (`showCardPopup`), finance opens its spotlight. `validate-project.js` fails on an untagged slide.
- Ticker sparklines: a slide's optional `spark` (plain numbers) and `sparkClass` render through `tickerSparkHtml()`. Finance uses `/api/finance` `history` (a month of daily closes, which also supplies the day-change reference); fuel uses the Worker's `fuel_hist_*` KV record (one point per 6h per station set, ~4 puts/day, skipped without a KV binding).

## Adapting Another City

Fork the repo, then give it to an LLM coding agent with the target city's requirements. Ask it to update coordinates, transit APIs, waste collection data, radar/satellite defaults, electricity market, airport/flight bounding box, copy, docs, and deployment notes.
