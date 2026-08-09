# City Dashboard

A single-file, iOS 12-compatible city dashboard focused on Brisbane, Australia.

The dashboard is designed for always-on tablets and small displays. It can run by opening `index.html` directly, or it can be deployed as a Cloudflare Worker for API proxy routes that browsers cannot call directly.

## Features

- Weather, BoM warnings, rain-soon alerts, air quality, UV index, sunrise, and sunset
- Nearby Queensland bushfire incidents with local dismissal, plus ABC/Brisbane Times headlines
- Optional pollen forecasts through the Google Pollen API
- Optional locally configured birthday reminders with per-person timezones, acknowledgement, and birthday-only import/export (ships with an empty list)
- Queensland electricity spot prices via AEMO NEMWEB
- Brisbane City Council bin collection lookup and recycling/garden alternation
- TransLink bus arrivals through the Worker proxy
- Overhead flight tracking via ADSB.lol, with route lookup fallbacks
- Windy satellite map and BOM Brisbane weather radar
- Sports fixtures and standings
- Finance prices via Yahoo Finance, including user-defined symbols
- Queensland fuel prices, when a FPD Direct API token is configured
- Optional Polymarket event card
- Touch-friendly card ordering, collapsible cards, schedules, keyboard-accessible settings, import/export settings, and dark/light themes
- Static conditions strip, moving data ticker, optional dedicated headline row, and on-demand Worker feed diagnostics
- Needs Attention coverage for ticker-only weather warnings, serious nearby bushfires, and unacknowledged birthdays

Private/person-specific integrations have been removed from this public fork. Do not commit local `.dev.vars`, API tokens, proxy URLs, or device-specific settings.

## Quick Start

Open `index.html` in a browser, then use Settings to configure your location, cards, and refresh intervals.

For the Worker-backed routes:

```bash
npm install
npm run dev
```

The local Worker runs at `http://localhost:8787`.

## Deploy

```bash
npm install
npm run deploy
```

Set Worker secrets as needed:

```bash
npx wrangler secret put DASHBOARD_TOKEN
npx wrangler secret put FUEL_API_TOKEN
npx wrangler secret put CRICAPI_KEY
npx wrangler secret put GOOGLE_POLLEN_API_KEY
```

`DASHBOARD_TOKEN` protects API routes other than `/api/health`. Use the same value in Settings -> System -> Dashboard Token.

A Worker KV binding named `STATUS_KV` or `SETTINGS_KV` enables optional bin dismissal sync and is required for shared cricket and pollen caches. Without one, bin state stays in local browser storage and quota-limited feeds fail closed instead of hitting their upstream on every isolate cold start.

## Project Structure

```text
index.html              # Single-file dashboard: HTML, CSS, and ES5 JavaScript
src/worker.js           # Cloudflare Worker API proxy routes
public/                 # Worker static assets; public/index.html symlinks to ../index.html
scripts/                # Compatibility checks
wrangler.jsonc          # Cloudflare Worker config
```

## Checks

```bash
npm run validate
```

`index.html` intentionally targets iOS 12 Safari: no arrow functions, `let`, `const`, template literals, optional chaining, or frontend `fetch()`.

## API Routes

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | Health check |
| `GET /api/feed-health` | Per-Worker-instance feed success/stale/error diagnostics |
| `GET /api/electricity` | Queensland electricity spot price proxy |
| `GET /api/warnings?lat=..&lon=..` | BoM weather warnings for a geohash area |
| `GET /api/bushfires?lat=..&lon=..` | Queensland bushfire incidents with distance |
| `GET /api/news` | Local headlines from public RSS feeds |
| `GET /api/pollen?lat=..&lon=..` | Optional Google pollen forecast |
| `GET /api/departures?stops=123456,234567` | TransLink bus departures |
| `GET /api/flights?lamin=..&lomin=..&lamax=..&lomax=..` | ADSB.lol flight proxy |
| `GET /api/routes?callsign=QFA1` | Flight route lookup |
| `GET /api/finance?symbols=^GSPC,^AXJO` | Finance proxy |
| `GET /api/sports?leagues=4328,4480` | Sports fixtures |
| `GET /api/standings?leagues=eng.1` | Sports standings |
| `GET /api/fuel?grades=e10\|Diesel&stations=Shell` | Queensland fuel prices |
| `GET /api/polymarket?limit=5` | Polymarket events |
| `GET/PUT /api/dashboard-status` | Optional KV-backed bin dismissal/taken-out status sync |

Electricity prices are read from the latest NEMWEB DispatchIS ZIP report. The old `GRAPH_5QLD1.csv` feed is no longer available.

## Adapting For Another City

The easiest path is to fork this repo and give the fork to an LLM coding agent. Ask it to swap the defaults and city-specific data sources: coordinates, transit provider, waste collection source, weather radar, electricity market, airport/flight area, dashboard title, and README.

Keep the iOS 12 rules in `AGENTS.md` unless you deliberately drop old-device support.

## License

GPL-3.0-only. This is the GNU General Public License v3, not the Affero GPL.
