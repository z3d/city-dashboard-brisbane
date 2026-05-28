# City Dashboard

Single-file city dashboard focused on Brisbane, deployed optionally as a Cloudflare Worker.

## Commands

- `npm run dev` - local Cloudflare Worker at `http://localhost:8787`
- `npm run deploy` - deploy with Wrangler
- `node scripts/check-ios12-compat.js` - scan `index.html` for iOS 12-incompatible JavaScript
- `node --check src/worker.js` - syntax-check the Worker
- Or open `index.html` directly in a browser for features that do not require the Worker

## Architecture

```text
index.html              # Single-file dashboard, source of truth for frontend
src/worker.js           # Cloudflare Worker API proxy routes
public/index.html       # Symlink to ../index.html; do not replace with a copy
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
- Needs Attention is a global smart strip controlled by `showNeedsAttention` and `needsAttentionMaxItems`. It renders in `#needsAttention`, uses enabled feature toggles as eligibility, and builds alerts from cached `last*Data`/config without extra API fetches. It currently excludes bin and sports alerts, and only treats electricity as attention-worthy when prices are high.
- Bin card conditional dismissal uses two separate localStorage keys: `binTakenOutDate` hides the pre-collection card until the bring-in window, while `binDismissedDate` hides the bring-in "Done" state.
- Worker caches use module-level `_xxxCache` and `_xxxTime` variables.
- Open-Meteo timestamps should use `timeformat=unixtime` and parse with `new Date(timestamp * 1000)`.

## Adapting Another City

Fork the repo, then give it to an LLM coding agent with the target city's requirements. Ask it to update coordinates, transit APIs, waste collection data, radar/satellite defaults, electricity market, airport/flight bounding box, copy, docs, and deployment notes.
