/**
 * TransLink GTFS-RT Proxy Worker
 * Fetches real-time bus departures from TransLink and returns JSON
 */

// Bus-only feed is much smaller than the full SEQ feed, staying within CPU limits
const TRANSLINK_API = 'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates/Bus';

// Apply one deadline to every upstream request. Static assets use env.ASSETS.fetch
// and are intentionally unaffected. Callers that provide their own AbortSignal
// keep full control of their request lifetime.
const UPSTREAM_FETCH_TIMEOUT_MS = 20000;
function fetch(input, init) {
  if (init && init.signal) return globalThis.fetch(input, init);
  const controller = new AbortController();
  const options = init ? Object.assign({}, init) : {};
  options.signal = controller.signal;
  const timer = setTimeout(function() { controller.abort(); }, UPSTREAM_FETCH_TIMEOUT_MS);
  const clear = function() { clearTimeout(timer); };
  // The promise settles when headers arrive, so clearing the timer there left
  // body reads (multi-MB GTFS-RT, zip downloads) with no deadline at all. Keep
  // the abort armed until a body reader settles; an unread body is aborted
  // harmlessly when the timer fires.
  return globalThis.fetch(input, options).then(function(resp) {
    const readers = ['text', 'json', 'arrayBuffer', 'blob', 'formData'];
    for (let i = 0; i < readers.length; i++) {
      const name = readers[i];
      const orig = resp[name];
      if (typeof orig !== 'function') continue;
      try {
        Object.defineProperty(resp, name, {
          configurable: true,
          writable: true,
          value: function() { return orig.apply(resp, arguments).finally(clear); }
        });
      } catch (e) { /* non-extensible response: fall back to header-only deadline */ clear(); }
    }
    return resp;
  }, function(err) {
    clear();
    throw err;
  });
}

// Module-level cache: persists across requests within the same isolate
// Avoids re-fetching and re-reading the protobuf on every request
let rawFeedBuf = null;
let rawFeedTime = 0;

// Module-level caches — caches.default with synthetic URLs doesn't work reliably,
// so all endpoints use module-level variables that persist within the same isolate.
let _flightsCache = {};        // { cacheKey -> json string }
let _flightsTime = {};
let _depsCache = {};           // { cacheKey -> json string }
let _depsTime = {};
let _sportsCache = {};         // { cacheKey -> json string }
let _sportsTime = {};
let _cricketCache = null;      // CricketData.org currentMatches L1 cache
let _cricketTime = 0;
const CRICKET_KV_KEY = 'cricket_current_matches';
let _standingsCache = {};      // { cacheKey -> json string }
let _standingsTime = {};
let _fuelSiteDetails = null;
let _fuelSiteTime = 0;
let _fuelBrands = null;
let _fuelBrandsTime = 0;
let _fuelResultCache = {};
let _fuelResultTime = {};
// Keyed by sorted symbol set: screens with different custom tickers must not
// evict each other (a single slot made every request a Yahoo miss).
const _financeCache = {};
let _electricityCache = null;
let _electricityTime = 0;
const _polymarketCache = {}; // keyed by limit
let _routesCache = {};         // { callsign -> json string }
let _routesTime = {};
let _warningsCache = {};       // { geohash -> json string }
let _warningsTime = {};
let _pollenCache = {};         // { rounded lat/lon -> json string }
let _pollenTime = {};
let _pollenRetryAfter = {};
let _bushfiresCache = null;    // { incidents: [...], ts } — parsed statewide feed
let _newsCache = null;         // JSON string
let _newsTime = 0;
let _lastFeatureRequestTime = 0;

// Per-isolate diagnostics only: no KV writes and no polling side effects.
const _workerBootTime = Date.now();
const _feedHealth = {};
const FEED_HEALTH_SKIP = new Set(['health', 'feed-health', 'dashboard-status', 'feature-request']);

function recordFeedEvent(feed, kind, detail) {
  const health = _feedHealth[feed] = _feedHealth[feed] || {};
  health[kind] = Date.now();
  if (kind === 'err') health.errDetail = String(detail || '').slice(0, 140);
}

function recordFeedHealth(request, response) {
  try {
    if (!response || request.method !== 'GET') return;
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/')) return;
    const feed = path.slice(5).split('/')[0];
    if (!feed || FEED_HEALTH_SKIP.has(feed)) return;
    const cacheStatus = response.headers.get('X-Cache');
    if (response.status >= 500) recordFeedEvent(feed, 'err', 'HTTP ' + response.status);
    else if (cacheStatus && cacheStatus.indexOf('STALE') === 0) recordFeedEvent(feed, 'stale'); // includes STALE-PARTIAL
    else if (response.ok && cacheStatus !== 'HIT') recordFeedEvent(feed, 'ok');
  } catch (e) {}
}

const DASHBOARD_STATUS_KV_KEY = 'dashboard_status';
const WARNINGS_DATA_TTL = 5 * 60 * 1000;
const POLLEN_DATA_TTL = 12 * 60 * 60 * 1000;
const POLLEN_RETRY_TTL = 30 * 60 * 1000;
const POLLEN_STALE_MAX_MS = 3 * 24 * 60 * 60 * 1000;
const POLLEN_KV_EXPIRATION_TTL_S = 7 * 24 * 60 * 60;
const POLLEN_KV_KEY_PREFIX = 'pollen_forecast:';

// Minimal XML entity/CDATA decoder for the QFD Atom and news RSS parsers.
function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, function(match, number) { return String.fromCodePoint(parseInt(number, 10)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function(match, number) { return String.fromCodePoint(parseInt(number, 16)); })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const BUSHFIRE_LEVELS = { 'emergency warning': 3, 'watch and act': 2, 'advice': 1 };

function isDashboardStatusDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function sanitizeDashboardStatus(data) {
  const input = data && typeof data === 'object' ? data : {};
  const bin = input.bin && typeof input.bin === 'object' && !Array.isArray(input.bin) ? input.bin : {};
  const status = {
    bin: {},
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : null
  };
  if (isDashboardStatusDate(bin.dismissedDate)) status.bin.dismissedDate = bin.dismissedDate;
  if (isDashboardStatusDate(bin.takenOutDate)) status.bin.takenOutDate = bin.takenOutDate;
  return status;
}

// Stable content fingerprint excluding the server-owned updatedAt timestamp.
// Redundant status reconciliation must not consume the daily KV write budget.
function dashboardStatusFingerprint(status) {
  return JSON.stringify({
    bin: {
      dismissedDate: (status.bin && status.bin.dismissedDate) || '',
      takenOutDate: (status.bin && status.bin.takenOutDate) || ''
    }
  });
}

const ELECTRICITY_DISPATCH_DIR_URL = 'https://www.nemweb.com.au/REPORTS/CURRENT/DispatchIS_Reports/';
const ELECTRICITY_DATA_TTL = 60 * 1000;

function splitCsvLine(line) {
  var parts = [];
  var current = '';
  var inQuotes = false;

  for (var i = 0; i < line.length; i++) {
    var ch = line.charAt(i);
    if (ch === '"') {
      if (inQuotes && line.charAt(i + 1) === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  parts.push(current);
  return parts;
}

function findLatestElectricityDispatchUrl(indexHtml) {
  var pattern = /href="([^"]*PUBLIC_DISPATCHIS_\d{12}_[^"]+\.zip)"/gi;
  var latest = '';
  var match;

  while ((match = pattern.exec(indexHtml || '')) !== null) {
    if (match[1] > latest) latest = match[1];
  }

  if (!latest) {
    throw new Error('No NEMWEB DispatchIS files found');
  }

  return new URL(latest, ELECTRICITY_DISPATCH_DIR_URL).toString();
}

function findZipEocdOffset(view) {
  var minOffset = Math.max(0, view.byteLength - 66000);
  for (var i = view.byteLength - 22; i >= minOffset; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

function findFirstZipFileEntry(bytes, view) {
  var eocdOffset = findZipEocdOffset(view);
  if (eocdOffset !== -1) {
    var totalEntries = view.getUint16(eocdOffset + 10, true);
    var centralOffset = view.getUint32(eocdOffset + 16, true);
    var offset = centralOffset;

    for (var i = 0; i < totalEntries; i++) {
      if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) break;

      var method = view.getUint16(offset + 10, true);
      var compressedSize = view.getUint32(offset + 20, true);
      var fileNameLength = view.getUint16(offset + 28, true);
      var extraLength = view.getUint16(offset + 30, true);
      var commentLength = view.getUint16(offset + 32, true);
      var localHeaderOffset = view.getUint32(offset + 42, true);
      var nameStart = offset + 46;
      var nameEnd = nameStart + fileNameLength;
      var name = new TextDecoder().decode(bytes.slice(nameStart, nameEnd));

      if (name.charAt(name.length - 1) !== '/') {
        return {
          method: method,
          compressedSize: compressedSize,
          localHeaderOffset: localHeaderOffset
        };
      }

      offset = nameEnd + extraLength + commentLength;
    }
  }

  if (bytes.length >= 30 && view.getUint32(0, true) === 0x04034b50) {
    return {
      method: view.getUint16(8, true),
      compressedSize: view.getUint32(18, true),
      localHeaderOffset: 0
    };
  }

  throw new Error('No ZIP file entry found');
}

async function unzipFirstFileText(arrayBuffer) {
  var bytes = new Uint8Array(arrayBuffer);
  var view = new DataView(arrayBuffer);
  var entry = findFirstZipFileEntry(bytes, view);
  var localOffset = entry.localHeaderOffset;

  if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
    throw new Error('Invalid ZIP local header');
  }

  var fileNameLength = view.getUint16(localOffset + 26, true);
  var extraLength = view.getUint16(localOffset + 28, true);
  var dataStart = localOffset + 30 + fileNameLength + extraLength;
  var dataEnd = dataStart + entry.compressedSize;

  if (dataEnd > bytes.length) {
    throw new Error('Truncated ZIP file entry');
  }

  var compressed = bytes.slice(dataStart, dataEnd);
  if (entry.method === 0) {
    return new TextDecoder().decode(compressed);
  }
  if (entry.method !== 8) {
    throw new Error('Unsupported ZIP compression method: ' + entry.method);
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('ZIP decompression is not available');
  }

  var stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(stream).text();
}

function parseElectricityDispatchCsv(csvText) {
  var lines = (csvText || '').replace(/\r/g, '').split('\n');
  var latest = null;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;

    var parts = splitCsvLine(line);

    if (parts.length >= 10 && parts[0] === 'D' && parts[1] === 'DISPATCH' && parts[2] === 'PRICE' && parts[6] === 'QLD1') {
      var dispatchPrice = parseFloat(parts[9]);
      if (!isNaN(dispatchPrice)) {
        latest = {
          region: parts[6],
          settlementDate: parts[4],
          totalDemand: null,
          price: dispatchPrice
        };
      }
    } else if (parts.length >= 10 && parts[0] === 'D' && parts[1] === 'DISPATCH' && parts[2] === 'REGIONSUM' && parts[6] === 'QLD1') {
      if (latest && latest.settlementDate === parts[4]) {
        var dispatchDemand = parseFloat(parts[9]);
        latest.totalDemand = isNaN(dispatchDemand) ? null : dispatchDemand;
      }
    } else if (parts.length >= 14 && parts[0] === 'D' && parts[1] === 'DREGION' && parts[6] === 'QLD1') {
      var legacyPrice = parseFloat(parts[8]);
      var legacyDemand = parseFloat(parts[13]);
      if (!isNaN(legacyPrice)) {
        latest = {
          region: parts[6],
          settlementDate: parts[4],
          totalDemand: isNaN(legacyDemand) ? null : legacyDemand,
          price: legacyPrice
        };
      }
    }
  }

  if (!latest) {
    throw new Error('QLD dispatch price not found in NEMWEB CSV');
  }

  return latest;
}

const FPD_API_BASE = 'https://fppdirectapi-prod.fuelpricesqld.com.au';
const FPD_FUEL_MAP = {
  'e10': 12, 'Unleaded': 2, 'U91': 2, '95': 5, 'U95': 5,
  '98': 8, 'U98': 8, 'Diesel': 3, 'LPG': 4, 'Premium': 5, 'Premium Diesel': 14
};
const FPD_FUEL_NAMES = {};
// Build reverse map: FuelId -> grade name used by frontend
(function() {
  // Use frontend-friendly names (shortest alias)
  var preferred = { 12: 'e10', 2: 'Unleaded', 5: '95', 8: '98', 3: 'Diesel', 4: 'LPG', 14: 'Premium Diesel' };
  for (var k in preferred) FPD_FUEL_NAMES[k] = preferred[k];
})();

// Minimal Protobuf decoder for GTFS-RT
// Field types: 0=varint, 1=64bit, 2=length-delimited, 5=32bit
function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    byte = buf[pos.i++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte >= 0x80);
  return result;
}

function readString(buf, pos, len) {
  const bytes = buf.slice(pos.i, pos.i + len);
  pos.i += len;
  return new TextDecoder().decode(bytes);
}

function skipField(buf, pos, wireType) {
  if (wireType === 0) {
    while (buf[pos.i++] >= 0x80);
  } else if (wireType === 1) {
    pos.i += 8;
  } else if (wireType === 2) {
    const len = readVarint(buf, pos);
    pos.i += len;
  } else if (wireType === 5) {
    pos.i += 4;
  } else {
    throw new Error('Unsupported protobuf wire type: ' + wireType);
  }
}

function parseStopTimeEvent(buf, end, pos) {
  const result = {};
  while (pos.i < end) {
    const tag = readVarint(buf, pos);
    const fieldNum = tag >> 3;
    const wireType = tag & 0x7;
    if (fieldNum === 2 && wireType === 0) {
      result.time = readVarint(buf, pos);
    } else {
      skipField(buf, pos, wireType);
    }
  }
  return result;
}

function parseStopTimeUpdate(buf, end, pos) {
  const result = {};
  while (pos.i < end) {
    const tag = readVarint(buf, pos);
    const fieldNum = tag >> 3;
    const wireType = tag & 0x7;
    if (fieldNum === 4 && wireType === 2) {
      result.stopId = readString(buf, pos, readVarint(buf, pos));
    } else if (fieldNum === 2 && wireType === 2) {
      const len = readVarint(buf, pos);
      result.arrival = parseStopTimeEvent(buf, pos.i + len, pos);
    } else if (fieldNum === 3 && wireType === 2) {
      const len = readVarint(buf, pos);
      result.departure = parseStopTimeEvent(buf, pos.i + len, pos);
    } else {
      skipField(buf, pos, wireType);
    }
  }
  return result;
}

function parseTripDescriptor(buf, end, pos) {
  const result = {};
  while (pos.i < end) {
    const tag = readVarint(buf, pos);
    const fieldNum = tag >> 3;
    const wireType = tag & 0x7;
    if (fieldNum === 5 && wireType === 2) {
      result.routeId = readString(buf, pos, readVarint(buf, pos));
    } else if (fieldNum === 4 && wireType === 2) {
      result.tripHeadsign = readString(buf, pos, readVarint(buf, pos));
    } else {
      skipField(buf, pos, wireType);
    }
  }
  return result;
}

function parseTripUpdate(buf, end, pos) {
  const result = { stopTimeUpdates: [] };
  while (pos.i < end) {
    const tag = readVarint(buf, pos);
    const fieldNum = tag >> 3;
    const wireType = tag & 0x7;
    if (fieldNum === 1 && wireType === 2) {
      const len = readVarint(buf, pos);
      result.trip = parseTripDescriptor(buf, pos.i + len, pos);
    } else if (fieldNum === 2 && wireType === 2) {
      const len = readVarint(buf, pos);
      result.stopTimeUpdates.push(parseStopTimeUpdate(buf, pos.i + len, pos));
    } else {
      skipField(buf, pos, wireType);
    }
  }
  return result;
}

function parseFeedEntity(buf, end, pos) {
  const result = {};
  while (pos.i < end) {
    const tag = readVarint(buf, pos);
    const fieldNum = tag >> 3;
    const wireType = tag & 0x7;
    if (fieldNum === 1 && wireType === 2) {
      result.id = readString(buf, pos, readVarint(buf, pos));
    } else if (fieldNum === 3 && wireType === 2) {
      const len = readVarint(buf, pos);
      result.tripUpdate = parseTripUpdate(buf, pos.i + len, pos);
    } else {
      skipField(buf, pos, wireType);
    }
  }
  return result;
}

// Quick byte-scan: check if a byte pattern appears anywhere in a buffer range
function bufContains(buf, start, end, pattern) {
  for (var i = start; i <= end - pattern.length; i++) {
    var match = true;
    for (var j = 0; j < pattern.length; j++) {
      if (buf[i + j] !== pattern[j]) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

// Build ASCII byte patterns for stop IDs (for pre-filter scanning)
function buildStopPatterns(rawStops, padStop) {
  var encoder = new TextEncoder();
  var patterns = [];
  var seen = {};
  for (var i = 0; i < rawStops.length; i++) {
    var raw = rawStops[i];
    if (!seen[raw]) { patterns.push(encoder.encode(raw)); seen[raw] = true; }
    var padded = padStop(raw);
    if (!seen[padded]) { patterns.push(encoder.encode(padded)); seen[padded] = true; }
  }
  return patterns;
}

function parseFeedMessage(buf, stopPatterns) {
  const result = { entities: [] };
  const pos = { i: 0 };
  while (pos.i < buf.length) {
    const tag = readVarint(buf, pos);
    const fieldNum = tag >> 3;
    const wireType = tag & 0x7;
    if (fieldNum === 2 && wireType === 2) {
      const len = readVarint(buf, pos);
      const entityEnd = pos.i + len;
      // Pre-filter: skip entities that don't contain any target stop ID bytes
      if (stopPatterns) {
        var found = false;
        for (var p = 0; p < stopPatterns.length; p++) {
          if (bufContains(buf, pos.i, entityEnd, stopPatterns[p])) { found = true; break; }
        }
        if (!found) { pos.i = entityEnd; continue; }
      }
      result.entities.push(parseFeedEntity(buf, entityEnd, pos));
    } else {
      skipField(buf, pos, wireType);
    }
  }
  return result;
}

function getRouteShortName(routeId) {
  if (!routeId) return '';
  const match = routeId.match(/^(\d+)/);
  return match ? match[1] : routeId;
}

// Fetch brand ID -> name mapping from FPD API (cached 24 hours)
async function getFuelBrands(token) {
  var now = Date.now();
  if (_fuelBrands && (now - _fuelBrandsTime) < 86400 * 1000) return _fuelBrands;
  var resp = await fetch(FPD_API_BASE + '/Subscriber/GetCountryBrands?countryId=21', {
    headers: { 'Authorization': 'FPDAPI SubscriberToken=' + token, 'Content-Type': 'application/json' }
  });
  if (!resp.ok) throw new Error('FPD brands API error: ' + resp.status);
  var data = await resp.json();
  var map = {};
  var brands = data.Brands || [];
  for (var i = 0; i < brands.length; i++) {
    map[brands[i].BrandId] = brands[i].Name;
  }
  _fuelBrands = map;
  _fuelBrandsTime = now;
  return map;
}

// Fetch site details from FPD API (cached 24 hours)
async function getFuelSiteDetails(token) {
  var now = Date.now();
  if (_fuelSiteDetails && (now - _fuelSiteTime) < 86400 * 1000) return _fuelSiteDetails;
  var resp = await fetch(FPD_API_BASE + '/Subscriber/GetFullSiteDetails?countryId=21&geoRegionLevel=3&geoRegionId=1', {
    headers: { 'Authorization': 'FPDAPI SubscriberToken=' + token, 'Content-Type': 'application/json' }
  });
  if (!resp.ok) throw new Error('FPD site details API error: ' + resp.status);
  var data = await resp.json();
  var map = {};
  var sites = data.S || [];
  for (var i = 0; i < sites.length; i++) {
    var s = sites[i];
    map[s.S] = { name: s.N || '', brandId: s.B, address: s.A || '', postcode: s.P || '' };
  }
  _fuelSiteDetails = map;
  _fuelSiteTime = now;
  return map;
}

function encodeGeohash(lat, lon, precision) {
  const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  let idx = 0, bit = 0, evenBit = true, geohash = '';
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  while (geohash.length < precision) {
    if (evenBit) {
      const lonMid = (lonMin + lonMax) / 2;
      if (lon >= lonMid) { idx = idx * 2 + 1; lonMin = lonMid; }
      else { idx = idx * 2; lonMax = lonMid; }
    } else {
      const latMid = (latMin + latMax) / 2;
      if (lat >= latMid) { idx = idx * 2 + 1; latMin = latMid; }
      else { idx = idx * 2; latMax = latMid; }
    }
    evenBit = !evenBit;
    if (++bit === 5) { geohash += BASE32.charAt(idx); bit = 0; idx = 0; }
  }
  return geohash;
}

// Constant-time string comparison avoids leaking a matching token prefix through
// timing differences in the authentication check.
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length === bb.length ? 0 : 1;
  const len = Math.max(ab.length, bb.length, 1);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i % ab.length] || 0) ^ (bb[i % bb.length] || 0);
  }
  return diff === 0;
}

export default {
  async fetch(request, env, ctx) {
    let response = await handleRequest(request, env, ctx);
    if (new URL(request.url).pathname.startsWith('/api/') && !response.headers.has('Cache-Control')) {
      // Dynamic token-gated data: never let a browser or intermediary apply heuristic freshness.
      response = new Response(response.body, response);
      response.headers.set('Cache-Control', 'no-store');
    }
    recordFeedHealth(request, response);
    return response;
  }
};

async function handleRequest(request, env, ctx) {
    var url = new URL(request.url);
    var path = url.pathname;

    if (!path.startsWith('/api/')) {
      // Wrangler serves matching static assets before invoking the Worker. A
      // missing asset can still reach this handler without an ASSETS binding.
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }

    var corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Dashboard-Token',
      'Access-Control-Expose-Headers': 'X-Cache',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (path === '/api/health') {
      return new Response(JSON.stringify({ status: 'ok', timestamp: Date.now() }), {
        headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
      });
    }

    // Token auth — mandatory on all API routes except health
    if (!env.DASHBOARD_TOKEN) {
      return new Response(JSON.stringify({ error: 'DASHBOARD_TOKEN secret is not set. All API routes require authentication.' }), {
        status: 500,
        headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
      });
    }
    var incoming = request.headers.get('X-Dashboard-Token') || '';
    if (!timingSafeEqual(incoming, env.DASHBOARD_TOKEN)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
      });
    }

    if (path === '/api/feed-health') {
      return new Response(JSON.stringify({ bootedAt: _workerBootTime, now: Date.now(), feeds: _feedHealth }), {
        headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, corsHeaders)
      });
    }

    // Queensland electricity spot price - AEMO NEMWEB DispatchIS report
    if (path === '/api/electricity') {
      var elecNow = Date.now();
      if (_electricityCache && (elecNow - _electricityTime) < ELECTRICITY_DATA_TTL) {
        return new Response(_electricityCache, {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'HIT' }, corsHeaders)
        });
      }

      try {
        var elecIndexResp = await fetch(ELECTRICITY_DISPATCH_DIR_URL, {
          headers: {
            'User-Agent': 'city-dashboard/1.0',
            'Accept': 'text/html, */*'
          }
        });
        if (!elecIndexResp.ok) {
          throw new Error('NEMWEB directory error: ' + elecIndexResp.status);
        }

        var elecDispatchUrl = findLatestElectricityDispatchUrl(await elecIndexResp.text());
        var elecResp = await fetch(elecDispatchUrl, {
          headers: {
            'User-Agent': 'city-dashboard/1.0',
            'Accept': 'application/zip, application/x-zip-compressed, */*'
          }
        });
        if (!elecResp.ok) {
          throw new Error('NEMWEB dispatch error: ' + elecResp.status);
        }

        var elecText = await unzipFirstFileText(await elecResp.arrayBuffer());
        var elecData = parseElectricityDispatchCsv(elecText);
        elecData.fetchedAt = elecNow;
        elecData.source = 'NEMWEB DispatchIS';
        elecData.sourceUrl = elecDispatchUrl;

        var elecJson = JSON.stringify(elecData);
        _electricityCache = elecJson;
        _electricityTime = elecNow;
        return new Response(elecJson, {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'MISS' }, corsHeaders)
        });
      } catch (err) {
        if (_electricityCache) {
          return new Response(_electricityCache, {
            headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'STALE' }, corsHeaders)
          });
        }
        return new Response(JSON.stringify({ error: 'Electricity API error: ' + err.message }), {
          status: 502,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }
    }

    // Proxy ADSB.lol flights with edge caching
    if (path === '/api/flights') {
      var lamin = url.searchParams.get('lamin');
      var lomin = url.searchParams.get('lomin');
      var lamax = url.searchParams.get('lamax');
      var lomax = url.searchParams.get('lomax');
      if (!lamin || !lomin || !lamax || !lomax) {
        return new Response(JSON.stringify({ error: 'Missing flight area parameters: lamin, lomin, lamax, and lomax are required.' }), {
          status: 400,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }

      var minLat = parseFloat(lamin);
      var minLon = parseFloat(lomin);
      var maxLat = parseFloat(lamax);
      var maxLon = parseFloat(lomax);
      if (isNaN(minLat) || isNaN(minLon) || isNaN(maxLat) || isNaN(maxLon) ||
          minLat < -90 || maxLat > 90 || minLon < -180 || maxLon > 180 ||
          minLat >= maxLat || minLon >= maxLon) {
        return new Response(JSON.stringify({ error: 'Invalid flight area settings. Check the minimum and maximum latitude/longitude values.' }), {
          status: 400,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }

      var flightCacheKey = 'flights:' + lamin + ',' + lomin + ',' + lamax + ',' + lomax;
      var flightNow = Date.now();
      if (_flightsCache[flightCacheKey] && (flightNow - _flightsTime[flightCacheKey]) < 30 * 1000) {
        return new Response(_flightsCache[flightCacheKey], {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'HIT' }, corsHeaders)
        });
      }

      try {
        // Both providers use readsb v2 JSON; fall back when Cloudflare's shared
        // egress address is throttled by the primary provider.
        var centerLat = (minLat + maxLat) / 2;
        var centerLon = (minLon + maxLon) / 2;
        var distNm = Math.ceil(Math.max(
          Math.abs(maxLat - minLat) * 60 / 2,
          Math.abs(maxLon - minLon) * 60 / 2
        ));
        var providers = [
          { source: 'adsb.lol', url: 'https://api.adsb.lol/v2/lat/' + centerLat + '/lon/' + centerLon + '/dist/' + distNm },
          { source: 'airplanes.live', url: 'https://api.airplanes.live/v2/point/' + centerLat + '/' + centerLon + '/' + distNm }
        ];
        var adsbData = null;
        var lastProviderError = null;
        for (var pi = 0; pi < providers.length; pi++) {
          var provider = providers[pi];
          try {
            var flightResp = await fetch(provider.url);
            if (flightResp.ok) {
              var candidate = null;
              try { candidate = await flightResp.json(); } catch (parseErr) { candidate = null; }
              if (candidate && Array.isArray(candidate.ac)) {
                adsbData = candidate;
                break;
              }
              // e.g. {"message":"rate limited"} with HTTP 200 — try the next provider
              lastProviderError = {
                error: provider.source + ' returned an unexpected payload',
                source: provider.source
              };
              continue;
            }
            lastProviderError = {
              error: provider.source + ' returned HTTP ' + flightResp.status,
              source: provider.source,
              providerStatus: flightResp.status
            };
          } catch (providerErr) {
            lastProviderError = {
              error: provider.source + ' request failed',
              source: provider.source
            };
          }
        }
        if (adsbData === null) {
          if (_flightsCache[flightCacheKey]) {
            return new Response(_flightsCache[flightCacheKey], {
              headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'STALE' }, corsHeaders)
            });
          }
          return new Response(JSON.stringify(lastProviderError || { error: 'No flight provider available' }), {
            status: lastProviderError && lastProviderError.providerStatus === 429 ? 429 : 502,
            headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
          });
        }
        // Filter out ground aircraft, ground vehicles, and useless entries
        var airborne = (adsbData.ac || []).filter(function(ac) {
          // Exclude aircraft on the ground
          if (ac.alt_baro === 'ground') return false;
          // Exclude surface vehicles (category C1, C2, C3)
          if (ac.category && ac.category.charAt(0) === 'C') return false;
          // Exclude ground infrastructure (towers etc)
          if (ac.t === 'TWR' || ac.t === 'GND') return false;
          // Exclude entries with no position
          if (ac.lat == null || ac.lon == null) return false;
          // Exclude entries with no altitude data
          if (ac.alt_geom == null && ac.alt_baro == null) return false;
          return true;
        });
        // Convert to OpenSky states format for frontend compatibility
        var states = airborne.map(function(ac) {
          var altMeters = ac.alt_geom != null ? ac.alt_geom * 0.3048 : null;
          var speedMs = ac.gs != null ? ac.gs * 0.514444 : null;
          var onGround = ac.alt_baro === 'ground';
          return [
            ac.hex || '',                    // 0: icao24
            (ac.flight || '').trim() || '',  // 1: callsign
            '',                              // 2: origin_country
            null,                            // 3: time_position
            null,                            // 4: last_contact
            ac.lon != null ? ac.lon : null,  // 5: longitude
            ac.lat != null ? ac.lat : null,  // 6: latitude
            altMeters,                       // 7: baro_altitude (meters)
            onGround,                        // 8: on_ground
            speedMs,                         // 9: velocity (m/s)
            ac.track != null ? ac.track : null, // 10: true_track
            null,                            // 11: vertical_rate
            null,                            // 12: sensors
            altMeters,                       // 13: geo_altitude
            ac.squawk || null,               // 14: squawk
            false,                           // 15: spi
            0,                               // 16: position_source
            ac.t || '',                      // 17: aircraft type (ADSB.lol)
            ac.r || ''                       // 18: registration (ADSB.lol)
          ];
        });
        var flightData = JSON.stringify({ time: Math.floor(Date.now() / 1000), states: states });
        _flightsCache[flightCacheKey] = flightData;
        _flightsTime[flightCacheKey] = flightNow;
        return new Response(flightData, {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'MISS' }, corsHeaders)
        });
      } catch (err) {
        var flightErrMsg = err && err.message ? err.message : String(err);
        return new Response(JSON.stringify({ error: 'Flight provider request failed: ' + flightErrMsg, source: 'adsb.lol' }), {
          status: 502,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }
    }

    // Flight route lookup — cascade: adsbdb → hexdb → OpenSky
    if (path === '/api/routes') {
      var callsigns = (url.searchParams.get('callsigns') || '').split(',').filter(Boolean);
      if (callsigns.length === 0) {
        return new Response(JSON.stringify({ error: 'Missing callsigns parameter' }), {
          status: 400,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }
      // Cap at 10 callsigns per request
      callsigns = callsigns.slice(0, 10);
      var routeNow = Date.now();
      var ROUTE_TTL = 24 * 60 * 60 * 1000;    // 24h for successful lookups
      var ROUTE_FAIL_TTL = 60 * 60 * 1000;    // 1h for failed/empty lookups
      var results = {};
      var toFetch = [];

      // Check module cache
      for (var ri = 0; ri < callsigns.length; ri++) {
        var cs = callsigns[ri].trim().toUpperCase();
        if (_routesCache[cs] && (routeNow - _routesTime[cs]) < (_routesCache[cs] === '[]' ? ROUTE_FAIL_TTL : ROUTE_TTL)) {
          results[cs] = JSON.parse(_routesCache[cs]);
        } else {
          toFetch.push(cs);
        }
      }

      // Fetch missing routes sequentially using cascade: adsbdb → hexdb → OpenSky
      for (var fi = 0; fi < toFetch.length; fi++) {
        var fetchCs = toFetch[fi];
        var route = [];

        // 1. Try adsbdb.com (free, no API key, rich response)
        try {
          var adsbdbResp = await fetch('https://api.adsbdb.com/v0/callsign/' + encodeURIComponent(fetchCs), {
            headers: { 'User-Agent': 'brisbane-dashboard/1.0' }
          });
          if (adsbdbResp.ok) {
            var adsbdbData = await adsbdbResp.json();
            var fr = adsbdbData.response && adsbdbData.response.flightroute;
            if (fr && fr.origin && fr.destination && fr.origin.icao_code && fr.destination.icao_code) {
              route = [fr.origin.icao_code, fr.destination.icao_code];
            }
          }
        } catch (e) { /* try next source */ }

        // 2. Try hexdb.io (free, no API key, simple format)
        if (route.length === 0) {
          try {
            var hexdbResp = await fetch('https://hexdb.io/api/v1/route/icao/' + encodeURIComponent(fetchCs));
            if (hexdbResp.ok) {
              var hexdbData = await hexdbResp.json();
              if (hexdbData.route && hexdbData.route.indexOf('-') !== -1) {
                var hexParts = hexdbData.route.split('-');
                if (hexParts.length >= 2 && hexParts[0].length === 4 && hexParts[1].length === 4) {
                  route = [hexParts[0], hexParts[1]];
                }
              }
            }
          } catch (e) { /* try next source */ }
        }

        // 3. Fallback to OpenSky
        if (route.length === 0) {
          try {
            var routeResp = await fetch('https://opensky-network.org/api/routes?callsign=' + encodeURIComponent(fetchCs));
            if (routeResp.ok) {
              var routeData = await routeResp.json();
              route = routeData.route || [];
            }
          } catch (e) { /* keep empty route */ }
        }

        _routesCache[fetchCs] = JSON.stringify(route);
        _routesTime[fetchCs] = routeNow;
        results[fetchCs] = route;
      }

      return new Response(JSON.stringify({ routes: results }), {
        headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
      });
    }

    if (path === '/api/departures') {
      var stopsParam = url.searchParams.get('stops');
      if (!stopsParam) {
        return new Response(JSON.stringify({ error: 'Missing stops parameter' }), {
          status: 400,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }

      var rawStops = stopsParam.split(',').map(function(s) { return s.trim(); });

      // Build lookup: map GTFS stop IDs (both raw and zero-padded) to user-provided IDs
      var padStop = function(s) { return s.length < 6 ? ('000000' + s).slice(-6) : s; };
      var gtfsToRaw = {};
      for (var i = 0; i < rawStops.length; i++) {
        var raw = rawStops[i];
        gtfsToRaw[raw] = raw;
        gtfsToRaw[padStop(raw)] = raw;
      }

      // Cache key uses sorted raw stops (module-level, 120s TTL)
      var sortedStops = rawStops.slice().sort();
      var depsCacheKey = 'deps:' + sortedStops.join(',');
      var depsNow = Date.now();
      if (_depsCache[depsCacheKey] && (depsNow - _depsTime[depsCacheKey]) < 120 * 1000) {
        return new Response(_depsCache[depsCacheKey], {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'HIT' }, corsHeaders)
        });
      }

      try {
        // Use module-level cache to avoid re-fetching within the same isolate
        var now_ms = Date.now();
        if (!rawFeedBuf || now_ms - rawFeedTime > 120000) {
          var response = await fetch(TRANSLINK_API, { cf: { cacheTtl: 120 } });
          if (!response.ok) {
            throw new Error('Failed to fetch TransLink data: ' + response.status);
          }
          rawFeedBuf = new Uint8Array(await response.arrayBuffer());
          rawFeedTime = now_ms;
        }

        var buf = rawFeedBuf;
        var stopPatterns = buildStopPatterns(rawStops, padStop);
        var feed = parseFeedMessage(buf, stopPatterns);

        // Build departures by stop (keyed by user-provided IDs)
        var stopDepartures = {};
        for (var s = 0; s < rawStops.length; s++) {
          stopDepartures[rawStops[s]] = { departures: [] };
        }

        var now = Math.floor(Date.now() / 1000);

        for (var j = 0; j < feed.entities.length; j++) {
          var entity = feed.entities[j];
          if (!entity.tripUpdate) continue;

          var trip = entity.tripUpdate.trip || {};
          var routeId = trip.routeId || '';
          var routeShortName = getRouteShortName(routeId);

          for (var k = 0; k < entity.tripUpdate.stopTimeUpdates.length; k++) {
            var stu = entity.tripUpdate.stopTimeUpdates[k];
            // Match against both raw and padded stop IDs
            var matchedRaw = gtfsToRaw[stu.stopId];
            if (!matchedRaw) continue;

            var depTime = (stu.departure && stu.departure.time) || (stu.arrival && stu.arrival.time);
            if (!depTime || depTime < now) continue;

            stopDepartures[matchedRaw].departures.push({
              route: routeShortName,
              routeId: routeId,
              time: new Date(depTime * 1000).toISOString(),
              destination: trip.tripHeadsign || ''
            });
          }
        }

        // Sort departures by time
        for (var stopId in stopDepartures) {
          stopDepartures[stopId].departures.sort(function(a, b) {
            return new Date(a.time) - new Date(b.time);
          });
          stopDepartures[stopId].departures = stopDepartures[stopId].departures.slice(0, 10);
        }

        var depsResult = JSON.stringify({
          stops: stopDepartures,
          timestamp: Date.now()
        });
        _depsCache[depsCacheKey] = depsResult;
        _depsTime[depsCacheKey] = depsNow;

        return new Response(depsResult, {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'MISS' }, corsHeaders)
        });

      } catch (err) {
        // Do not keep reparsing corrupt bytes for the full feed cache TTL.
        rawFeedBuf = null;
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }
    }

    // Sports proxy — ESPN for soccer, TheSportsDB for rugby/tennis
    if (path === '/api/sports') {
      const leagueParam = url.searchParams.get('leagues') || '';
      const leagueIds = leagueParam.split(',').map(s => s.trim()).filter(Boolean);
      if (!leagueIds.length) {
        return new Response(JSON.stringify({}), {
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }
      if (leagueIds.length > 10 || leagueIds.some(id => !/^[a-z0-9._-]{1,40}$/i.test(id) || /^\.+$/.test(id))) {
        return new Response(JSON.stringify({ error: 'Invalid leagues parameter' }), {
          status: 400,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }

      // Edge cache keyed on sorted leagues — 5 min TTL protects upstream rate limits
      const sortedLeagues = leagueIds.slice().sort().join(',');
      var sportsCacheKey = 'sports:v3:' + sortedLeagues;
      var sportsNow = Date.now();
      if (_sportsCache[sportsCacheKey] && (sportsNow - _sportsTime[sportsCacheKey]) < 300 * 1000) {
        return new Response(_sportsCache[sportsCacheKey], {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'HIT' }, corsHeaders)
        });
      }

      // ESPN paths for soccer leagues
      const ESPN_MAP = {
        '4328': 'soccer/eng.1',
        '4480': 'soccer/UEFA.CHAMPIONS',
        '4443': 'soccer/FIFA.WORLD',
        '4335': 'soccer/esp.1',
        '4331': 'soccer/ger.1',
        '4332': 'soccer/ita.1',
        '4668': 'soccer/ksa.1'
      };

      // TheSportsDB IDs for rugby/tennis (free tier, eventsseason endpoint)
      const SPORTSDB_IDS = new Set(['4714', '4464', '4517']);

      function fmtDate(d) {
        return '' + d.getFullYear() +
          ('0' + (d.getMonth() + 1)).slice(-2) +
          ('0' + d.getDate()).slice(-2);
      }

      const now = new Date();
      const todayStr = now.toISOString().substring(0, 10);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const twoWeeksAhead = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
      const pastRange = fmtDate(sevenDaysAgo) + '-' + fmtDate(now);
      const futureRange = fmtDate(now) + '-' + fmtDate(twoWeeksAhead);

      // Browser-like headers so ESPN doesn't block server-side requests
      const espnHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.espn.com/',
        'Origin': 'https://www.espn.com'
      };

      async function fetchEspnRange(espnPath, dateRange) {
        try {
          const espnUrl = 'https://site.api.espn.com/apis/site/v2/sports/' +
            espnPath + '/scoreboard?limit=100&dates=' + dateRange;
          const resp = await fetch(espnUrl, { headers: espnHeaders });
          if (!resp.ok) return null;
          const text = await resp.text();
          let data = null;
          try { data = JSON.parse(text); } catch (e) { return null; } // HTML/challenge page = failure
          if (!data || typeof data !== 'object' || !Array.isArray(data.events)) return null;
          return data.events;
        } catch (e) {
          return null;
        }
      }

      function normalizeEspnEvent(ev) {
        const comp = ev.competitions && ev.competitions[0];
        if (!comp) return null;
        const statusType = (comp.status && comp.status.type) || {};
        const isCompleted = !!statusType.completed;
        const isLive = !isCompleted && statusType.state === 'in';
        const competitors = comp.competitors || [];
        let homeComp = null, awayComp = null;
        for (let j = 0; j < competitors.length; j++) {
          if (competitors[j].homeAway === 'home') homeComp = competitors[j];
          else if (competitors[j].homeAway === 'away') awayComp = competitors[j];
        }
        if (!homeComp || !awayComp) return null;
        return {
          strHomeTeam: homeComp.team ? (homeComp.team.shortDisplayName || homeComp.team.displayName) : '',
          strAwayTeam: awayComp.team ? (awayComp.team.shortDisplayName || awayComp.team.displayName) : '',
          intHomeScore: (isCompleted || isLive) ? homeComp.score : null,
          intAwayScore: (isCompleted || isLive) ? awayComp.score : null,
          dateEvent: ev.date ? ev.date.substring(0, 10) : '',
          strTime: ev.date ? ev.date.substring(11, 16) : '',
          strTimestamp: ev.date || '',
          strStatus: isCompleted ? 'Match Finished' : (isLive ? 'In Progress' : 'Scheduled'),
          strProgress: isLive ? ((comp.status && comp.status.displayClock) || statusType.shortDetail || 'LIVE') : '',
          _completed: isCompleted,
          _live: isLive
        };
      }

      // TheSportsDB: try current year first (works for most leagues incl. Six Nations)
      async function fetchSportsDbSeason(leagueId) {
        const year = now.getFullYear();
        const seasons = ['' + year, (year - 1) + '-' + year, '' + (year - 1)];
        let anyOk = false;
        for (const s of seasons) {
          try {
            const resp = await fetch(
              'https://www.thesportsdb.com/api/v1/json/3/eventsseason.php?id=' + leagueId + '&s=' + s
            );
            if (!resp.ok) continue;
            const data = await resp.json();
            anyOk = true;
            const evs = data.events || [];
            if (evs.length > 0) return evs;
          } catch (e) {}
        }
        return anyOk ? [] : null;
      }

      function normalizeCricketMatch(m) {
        const teams = m.teams || [];
        if (teams.length < 2) return null;
        const homeTeam = teams[0];
        const awayTeam = teams[1];
        const status = m.status || '';
        const isCompleted = status.includes('won') || status.includes('draw') ||
          status.includes('tied') || status.includes('No result');

        // Parse scores from score array (r=runs, w=wickets per innings)
        let homeScore = null, awayScore = null;
        const scores = m.score || [];
        if (scores.length > 0) {
          const homeInnings = [], awayInnings = [];
          for (let si = 0; si < scores.length; si++) {
            const s = scores[si];
            const inning = (s.inning || '').toLowerCase();
            if (inning.indexOf(homeTeam.toLowerCase()) === 0) homeInnings.push(s);
            else awayInnings.push(s);
          }
          // Fall back to positional split if name matching failed
          if (!homeInnings.length && !awayInnings.length) {
            for (let si = 0; si < scores.length; si++) {
              if (si % 2 === 0) homeInnings.push(scores[si]);
              else awayInnings.push(scores[si]);
            }
          }
          if (homeInnings.length) {
            const s = homeInnings[homeInnings.length - 1];
            homeScore = s.r + '/' + s.w;
          }
          if (awayInnings.length) {
            const s = awayInnings[awayInnings.length - 1];
            awayScore = s.r + '/' + s.w;
          }
        }

        const mtMap = { t20: 'T20', odi: 'ODI', test: 'Test' };
        let cricTs = m.dateTimeGMT || '';
        if (cricTs && cricTs.indexOf('Z') < 0 && cricTs.indexOf('+') < 0) cricTs += 'Z';
        return {
          strHomeTeam: homeTeam,
          strAwayTeam: awayTeam,
          intHomeScore: homeScore,
          intAwayScore: awayScore,
          dateEvent: (m.date || '').substring(0, 10),
          strTime: '',
          strTimestamp: cricTs,
          strStatus: isCompleted ? 'Match Finished' : 'Scheduled',
          strResult: isCompleted ? status : '',
          strMatchType: mtMap[m.matchType] || (m.matchType || '').toUpperCase(),
          _completed: isCompleted
        };
      }

      const DOMESTIC_KEYWORDS = ['Ranji', 'IPL', 'PSL', 'BBL', 'CPL', 'BPL',
        'Vitality', 'Blast', 'CSA Provincial', 'LPL', 'APL', 'Sheffield',
        'County', 'Plunket', 'Super Smash', 'Quaid-e-Azam', 'Duleep', 'Irani',
        'Syed Mushtaq', 'Vijay Hazare', 'National T20', 'Women', 'Unofficial',
        'Under-19', 'U19', 'U-19', 'Youth'];

      function isInternationalCricket(name) {
        return !DOMESTIC_KEYWORDS.some(function(kw) { return name.includes(kw); });
      }

      function normalizeSportsDbEvent(ev) {
        // TheSportsDB uses 'FT', 'Match Finished', or populated scores to indicate completion
        const hasScore = ev.intHomeScore !== null && ev.intHomeScore !== undefined && ev.intHomeScore !== '';
        const isCompleted = ev.strStatus === 'Match Finished' || ev.strStatus === 'FT' || hasScore;
        let timestamp = ev.strTimestamp || '';
        if (!timestamp && ev.dateEvent && ev.strTime) {
          const time = ev.strTime.length === 5 ? ev.strTime + ':00' : ev.strTime;
          timestamp = ev.dateEvent + 'T' + time + '+00:00';
        }
        return {
          strHomeTeam: ev.strHomeTeam || '',
          strAwayTeam: ev.strAwayTeam || '',
          intHomeScore: hasScore ? ev.intHomeScore : null,
          intAwayScore: hasScore ? ev.intAwayScore : null,
          dateEvent: ev.dateEvent || '',
          strTime: ev.strTime ? ev.strTime.substring(0, 5) : '',
          strTimestamp: timestamp,
          strStatus: isCompleted ? 'Match Finished' : 'Scheduled',
          _completed: isCompleted
        };
      }

      // Keep a rolling 24-hour fixture window, with sensible minimum and maximum
      // counts for quiet and tournament-heavy leagues.
      function eventMillis(event) {
        const value = event && event.strTimestamp ? Date.parse(event.strTimestamp) : NaN;
        return isNaN(value) ? 0 : value;
      }
      function sortEvents(events) {
        return events.slice().sort(function(a, b) { return eventMillis(a) - eventMillis(b); });
      }
      function pickUpcoming(events, min, max) {
        const sorted = sortEvents(events);
        const cutoff = now.getTime() + 24 * 60 * 60 * 1000;
        let count = 0;
        for (let i = 0; i < sorted.length; i++) if (eventMillis(sorted[i]) <= cutoff) count++;
        count = Math.max(min, Math.min(count, max));
        return sorted.slice(0, count);
      }
      function pickRecent(events, min, max) {
        const sorted = sortEvents(events);
        const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
        let count = 0;
        for (let i = 0; i < sorted.length; i++) if (eventMillis(sorted[i]) >= cutoff) count++;
        count = Math.max(min, Math.min(count, max));
        return sorted.slice(-count);
      }

      const sportsResult = {};
      let sportsFailed = 0;
      const sportsFetches = leagueIds.map(async function(lid) {
        try {
          // --- ESPN path ---
          if (ESPN_MAP[lid]) {
            const espnPath = ESPN_MAP[lid];
            const [pastRaw, futureRaw] = await Promise.all([
              fetchEspnRange(espnPath, pastRange),
              fetchEspnRange(espnPath, futureRange)
            ]);
            if (pastRaw === null && futureRaw === null) {
              sportsResult[lid] = { next: [], past: [] };
              sportsFailed++;
              return;
            }
            const past = [], next = [], live = [];
            const seen = {};
            function routeEspn(norm) {
              if (!norm) return;
              const key = norm.strHomeTeam + '|' + norm.strAwayTeam + '|' + norm.dateEvent;
              if (seen[key]) return;
              seen[key] = true;
              if (norm._live) live.push(norm);
              else if (norm._completed) past.push(norm);
              else next.push(norm);
            }
            for (const ev of (pastRaw || [])) {
              const norm = normalizeEspnEvent(ev);
              if (norm && (norm._completed || norm._live)) routeEspn(norm);
            }
            for (const ev of (futureRaw || [])) routeEspn(normalizeEspnEvent(ev));
            sportsResult[lid] = { past: pickRecent(past, 3, 8), next: pickUpcoming(next, 3, 12), live: live };

          // --- TheSportsDB path ---
          } else if (SPORTSDB_IDS.has(lid)) {
            const evs = await fetchSportsDbSeason(lid);
            if (evs === null) {
              sportsResult[lid] = { next: [], past: [] };
              sportsFailed++;
              return;
            }
            const past = [], next = [];
            for (const ev of evs) {
              const norm = normalizeSportsDbEvent(ev);
              if (!norm.dateEvent) continue;
              if (norm._completed && norm.dateEvent < todayStr) past.push(norm);
              else if (!norm._completed && norm.dateEvent >= todayStr) next.push(norm);
            }
            sportsResult[lid] = { past: pickRecent(past, 3, 8), next: pickUpcoming(next, 3, 12) };

          // --- CricketData.org path ---
          } else if (lid === '4752') {
            if (!env.CRICAPI_KEY) { sportsResult[lid] = { next: [], past: [] }; return; }
            const cricketKv = env.STATUS_KV || env.SETTINGS_KV;
            if (!cricketKv) {
              sportsResult[lid] = { next: [], past: [] };
              sportsFailed++;
              return;
            }
            const CRICKET_TTL = 30 * 60 * 1000;
            let cricData;
            if (_cricketCache && (sportsNow - _cricketTime) < CRICKET_TTL) {
              cricData = _cricketCache;
            } else {
              let kvCricket = null;
              try { kvCricket = await cricketKv.get(CRICKET_KV_KEY, 'json'); } catch (e) {}
              if (kvCricket && kvCricket.data && (sportsNow - (kvCricket.ts || 0)) < CRICKET_TTL) {
                cricData = kvCricket.data;
                _cricketCache = cricData;
                _cricketTime = kvCricket.ts;
              } else {
                const cricResp = await fetch(
                  'https://cricketdata.org/api/v1/currentMatches?apikey=' + env.CRICAPI_KEY + '&offset=0'
                );
                if (!cricResp.ok) {
                  if (_cricketCache) cricData = _cricketCache;
                  else if (kvCricket && kvCricket.data) cricData = kvCricket.data;
                  else { cricData = { data: [] }; sportsFailed++; }
                  _cricketCache = cricData;
                  _cricketTime = sportsNow;
                } else {
                  cricData = await cricResp.json();
                  _cricketCache = cricData;
                  _cricketTime = sportsNow;
                  try {
                    await cricketKv.put(CRICKET_KV_KEY, JSON.stringify({ data: cricData, ts: sportsNow }));
                  } catch (e) {}
                }
              }
            }
            const cricMatches = (cricData.data || []).filter(function(m) {
              return ['test', 'odi', 't20'].includes(m.matchType) && isInternationalCricket(m.name || '');
            });
            const cricPast = [], cricNext = [];
            for (const m of cricMatches) {
              const norm = normalizeCricketMatch(m);
              if (!norm || !norm.dateEvent) continue;
              if (norm._completed) cricPast.push(norm);
              else cricNext.push(norm);
            }
            sportsResult[lid] = { past: pickRecent(cricPast, 3, 8), next: pickUpcoming(cricNext, 3, 12) };

          } else {
            sportsResult[lid] = { next: [], past: [] };
          }
        } catch (e) {
          sportsResult[lid] = { next: [], past: [] };
          sportsFailed++;
        }
      });
      await Promise.all(sportsFetches);
      if (sportsFailed === leagueIds.length && _sportsCache[sportsCacheKey]) {
        return new Response(_sportsCache[sportsCacheKey], {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'STALE' }, corsHeaders)
        });
      }
      var sportsResultJson = JSON.stringify(sportsResult);
      _sportsCache[sportsCacheKey] = sportsResultJson;
      _sportsTime[sportsCacheKey] = sportsNow;
      return new Response(sportsResultJson, {
        headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'MISS' }, corsHeaders)
      });
    }

    // QLD fuel price proxy — FPD Direct API (fppdirectapi-prod.fuelpricesqld.com.au)
    if (path === '/api/fuel') {
      var gradesParam = url.searchParams.get('grades') || '';
      var stationsParam = url.searchParams.get('stations') || '';

      if (!gradesParam || !stationsParam) {
        return new Response(JSON.stringify({ error: 'Missing grades or stations parameters' }), {
          status: 400,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }

      var grades = gradesParam.split('|').map(function(g) { return g.trim(); }).filter(function(g) { return !!FPD_FUEL_MAP[g]; });
      var stations = stationsParam.split('|').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0 && s.length < 200; });

      if (!grades.length || !stations.length) {
        return new Response(JSON.stringify({ error: 'No valid grades or stations' }), {
          status: 400,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }

      // Build set of wanted FuelIds from grade names
      var wantedFuelIds = {};
      for (var gi = 0; gi < grades.length; gi++) {
        wantedFuelIds[FPD_FUEL_MAP[grades[gi]]] = true;
      }

      // Cache key: sorted grades + sorted stations (15 min TTL)
      var fuelCacheKey = grades.slice().sort().join('|') + '::' + stations.slice().sort().join('|');
      var fuel_now = Date.now();
      if (_fuelResultCache[fuelCacheKey] && (fuel_now - _fuelResultTime[fuelCacheKey]) < 900 * 1000) {
        return new Response(_fuelResultCache[fuelCacheKey], {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'HIT' }, corsHeaders)
        });
      }

      var fuelToken = env.FUEL_API_TOKEN;
      if (!fuelToken) {
        return new Response(JSON.stringify({ error: 'FUEL_API_TOKEN not configured' }), {
          status: 500,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }

      try {
        // Fetch site details, brands, and prices in parallel
        // Settle all three together so a prices failure can't leave the other
        // two as unhandled rejections after the handler has already returned.
        var fuelParts = await Promise.all([
          getFuelSiteDetails(fuelToken).then(function(v) { return { ok: true, value: v }; }, function(e) { return { ok: false, error: e }; }),
          getFuelBrands(fuelToken).then(function(v) { return { ok: true, value: v }; }, function(e) { return { ok: false, error: e }; }),
          fetch(FPD_API_BASE + '/Price/GetSitesPrices?countryId=21&geoRegionLevel=3&geoRegionId=1', {
            headers: { 'Authorization': 'FPDAPI SubscriberToken=' + fuelToken, 'Content-Type': 'application/json' }
          }).then(function(v) { return { ok: true, value: v }; }, function(e) { return { ok: false, error: e }; })
        ]);
        if (!fuelParts[2].ok) throw fuelParts[2].error;
        var pricesResp = fuelParts[2].value;
        if (!pricesResp.ok) throw new Error('FPD prices API error: ' + pricesResp.status);
        var pricesData = await pricesResp.json();
        if (!fuelParts[0].ok) throw fuelParts[0].error;
        if (!fuelParts[1].ok) throw fuelParts[1].error;
        var siteDetails = fuelParts[0].value;
        var brandNames = fuelParts[1].value;

        // Lowercase station search terms for case-insensitive matching
        var stationsLower = [];
        for (var si = 0; si < stations.length; si++) {
          stationsLower.push(stations[si].toLowerCase());
        }

        // Group prices by site, filtering by wanted fuel types and station names
        var stationMap = {};
        var allPrices = pricesData.SitePrices || [];
        for (var pi = 0; pi < allPrices.length; pi++) {
          var p = allPrices[pi];
          if (!wantedFuelIds[p.FuelId]) continue;

          var site = siteDetails[p.SiteId];
          if (!site) continue;

          // Check if station name matches any search term (case-insensitive substring)
          var nameLower = site.name.toLowerCase();
          var matched = false;
          for (var mi = 0; mi < stationsLower.length; mi++) {
            if (nameLower.indexOf(stationsLower[mi]) !== -1) {
              matched = true;
              break;
            }
          }
          if (!matched) continue;

          var gradeName = FPD_FUEL_NAMES[p.FuelId] || ('FuelId_' + p.FuelId);
          if (!stationMap[p.SiteId]) {
            stationMap[p.SiteId] = {
              name: site.name,
              brand: brandNames[site.brandId] || '',
              address: site.address,
              suburb: '',
              grades: {}
            };
          }
          stationMap[p.SiteId].grades[gradeName] = {
            price: p.Price,
            updated: p.TransactionDateUtc
          };
        }

        var stationsArray = [];
        for (var sk in stationMap) stationsArray.push(stationMap[sk]);

        var fuelResult = JSON.stringify({
          stations: stationsArray,
          fetchedAt: new Date().toISOString()
        });

        _fuelResultCache[fuelCacheKey] = fuelResult;
        _fuelResultTime[fuelCacheKey] = fuel_now;

        return new Response(fuelResult, {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'MISS' }, corsHeaders)
        });

      } catch (fuelErr) {
        return new Response(JSON.stringify({ error: fuelErr.message }), {
          status: 502,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }
    }

    // Soccer league standings (ESPN)
    if (path === '/api/standings') {
      const leagueParam = url.searchParams.get('leagues') || '';
      const leagueIds = leagueParam.split(',').map(s => s.trim()).filter(Boolean);
      if (!leagueIds.length) {
        return new Response(JSON.stringify({}), {
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }
      if (leagueIds.length > 10 || leagueIds.some(id => !/^[a-z0-9._-]{1,40}$/i.test(id) || /^\.+$/.test(id))) {
        return new Response(JSON.stringify({ error: 'Invalid leagues parameter' }), {
          status: 400,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }

      const sortedLeagues = leagueIds.slice().sort().join(',');
      const standingsCacheKey = 'standings:' + sortedLeagues;
      const standingsNow = Date.now();
      if (_standingsCache[standingsCacheKey] && (standingsNow - _standingsTime[standingsCacheKey]) < 300 * 1000) {
        return new Response(_standingsCache[standingsCacheKey], {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'HIT' }, corsHeaders)
        });
      }

      const standingsHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.espn.com/',
        'Origin': 'https://www.espn.com'
      };

      const result = {};
      let standingsFailed = 0;
      const fetches = leagueIds.map(async function(espnPath) {
        try {
          const resp = await fetch(
            'https://site.api.espn.com/apis/v2/sports/soccer/' + espnPath + '/standings',
            { headers: standingsHeaders }
          );
          if (!resp.ok) { result[espnPath] = []; standingsFailed++; return; }
          const data = await resp.json();

          const entries = (data.children && data.children[0] &&
            data.children[0].standings && data.children[0].standings.entries) || [];

          const table = [];
          for (const entry of entries) {
            const statsMap = {};
            const stats = entry.stats || [];
            for (const s of stats) {
              statsMap[s.name] = s.value;
            }
            table.push({
              pos: statsMap.rank || 0,
              team: entry.team ? (entry.team.shortDisplayName || entry.team.displayName || '') : '',
              played: statsMap.gamesPlayed || 0,
              won: statsMap.wins || 0,
              drawn: statsMap.ties || 0,
              lost: statsMap.losses || 0,
              gd: statsMap.pointDifferential || 0,
              points: statsMap.points || 0
            });
          }
          table.sort(function(a, b) { return a.pos - b.pos; });
          result[espnPath] = table;
        } catch (e) {
          result[espnPath] = [];
          standingsFailed++;
        }
      });
      await Promise.all(fetches);

      if (standingsFailed === leagueIds.length && _standingsCache[standingsCacheKey]) {
        return new Response(_standingsCache[standingsCacheKey], {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'STALE' }, corsHeaders)
        });
      }
      const standingsJson = JSON.stringify(result);
      _standingsCache[standingsCacheKey] = standingsJson;
      _standingsTime[standingsCacheKey] = standingsNow;
      return new Response(standingsJson, {
        headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'MISS' }, corsHeaders)
      });
    }

    if (path === '/api/finance') {
      const symbolsParam = url.searchParams.get('symbols') || '';
      const symbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean);
      if (!symbols.length) {
        return new Response(JSON.stringify({}), {
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }

      const sortedKey = symbols.slice().sort().join(',');
      const finNow = Date.now();
      const finCached = _financeCache[sortedKey];
      if (finCached && (finNow - finCached.time) < 300 * 1000) {
        return new Response(finCached.json, {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'HIT' }, corsHeaders)
        });
      }

      const yahooHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9'
      };

      const finResult = {};
      const finFetches = symbols.map(async function(sym) {
        try {
          const chartUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=2d&interval=1d&includePrePost=false';
          const resp = await fetch(chartUrl, { headers: yahooHeaders });
          if (!resp.ok) { finResult[sym] = null; return; }
          const data = await resp.json();
          const result = data && data.chart && data.chart.result && data.chart.result[0];
          const meta = result && result.meta;
          if (!meta) { finResult[sym] = null; return; }
          // Prefer actual chart close price over meta.regularMarketPrice (unreliable for futures)
          let chartPrice = meta.regularMarketPrice;
          const quotes = result.indicators && result.indicators.quote && result.indicators.quote[0];
          if (quotes && quotes.close && quotes.close.length > 0) {
            const lastClose = quotes.close[quotes.close.length - 1];
            if (lastClose != null) {
              chartPrice = lastClose;
            }
          }
          finResult[sym] = {
            price: chartPrice,
            previousClose: meta.chartPreviousClose,
            currency: meta.currency || '',
            marketState: meta.currentTradingPeriod && meta.currentTradingPeriod.regular ? 'regular' : '',
            dayHigh: meta.regularMarketDayHigh || null,
            dayLow: meta.regularMarketDayLow || null,
            open: meta.regularMarketOpen || null
          };
        } catch (e) {
          finResult[sym] = null;
        }
      });
      await Promise.all(finFetches);

      const finAllFailed = symbols.every(sym => finResult[sym] === null);
      if (finAllFailed && finCached) {
        return new Response(finCached.json, {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'STALE' }, corsHeaders)
        });
      }
      const finJson = JSON.stringify(finResult);
      _financeCache[sortedKey] = { json: finJson, time: finNow };
      return new Response(finJson, {
        headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'MISS' }, corsHeaders)
      });
    }

    if (path === '/api/polymarket') {
      const limit = parseInt(url.searchParams.get('limit')) || 5;
      const cacheKey = 'pm_' + limit;
      const pmNow = Date.now();

      const pmCached = _polymarketCache[cacheKey];
      if (pmCached && (pmNow - pmCached.time) < 300 * 1000) {
        return new Response(pmCached.json, {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'HIT' }, corsHeaders)
        });
      }

      try {
        const fetchLimit = limit * 10;
        const gammaUrl = 'https://gamma-api.polymarket.com/events?active=true&closed=false&order=volume24hr&ascending=false&limit=' + fetchLimit;
        const resp = await fetch(gammaUrl, {
          headers: { 'Accept': 'application/json' }
        });
        if (!resp.ok) {
          return new Response(JSON.stringify({ error: 'Polymarket API error' }), {
            status: 502,
            headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
          });
        }

        const events = await resp.json();
        const result = [];
        for (const ev of events) {
          const markets = ev.markets || [];
          const multiOutcome = markets.length > 1;

          // Find the leading market (highest Yes price)
          let bestMarket = null;
          let bestYes = -1;
          for (const m of markets) {
            if (!m.outcomePrices) continue;
            try {
              const prices = JSON.parse(m.outcomePrices);
              const yp = parseFloat(prices[0]) || 0;
              if (yp > bestYes) {
                bestYes = yp;
                bestMarket = m;
              }
            } catch (e) {}
          }

          const yesPrice = bestYes >= 0 ? bestYes : 0.5;
          const item = {
            title: ev.title || 'Untitled',
            yesPrice: yesPrice,
            volume: parseFloat(ev.volume) || 0
          };

          // For multi-outcome events, include the leading outcome name
          if (multiOutcome && bestMarket) {
            const q = bestMarket.question || bestMarket.groupItemTitle || '';
            if (q) item.outcome = q;
          }

          result.push(item);
        }

        // Filter out near-certain markets (>95% or <5%) and take top N by volume
        const filtered = result.filter(r => r.yesPrice > 0.05 && r.yesPrice < 0.95).slice(0, limit);
        const pmJson = JSON.stringify(filtered);
        _polymarketCache[cacheKey] = { json: pmJson, time: pmNow };
        return new Response(pmJson, {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'MISS' }, corsHeaders)
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Polymarket fetch failed' }), {
          status: 502,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }
    }

    // BoM severe-weather warnings, addressed by the location geohash used by
    // the official BoM application API.
    if (path === '/api/warnings') {
      var warningLat = parseFloat(url.searchParams.get('lat'));
      var warningLon = parseFloat(url.searchParams.get('lon'));
      if (isNaN(warningLat)) warningLat = -27.4705;
      if (isNaN(warningLon)) warningLon = 153.026;
      if (warningLat < -90 || warningLat > 90 || warningLon < -180 || warningLon > 180) {
        return new Response(JSON.stringify({ error: 'Invalid lat/lon' }), {
          status: 400,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }
      var warningGeohash = encodeGeohash(warningLat, warningLon, 6);
      var warningNow = Date.now();
      if (_warningsCache[warningGeohash] && (warningNow - _warningsTime[warningGeohash]) < WARNINGS_DATA_TTL) {
        return new Response(_warningsCache[warningGeohash], {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'HIT' }, corsHeaders)
        });
      }
      try {
        var warningResp = await fetch('https://api.weather.bom.gov.au/v1/locations/' + warningGeohash + '/warnings', {
          headers: { 'User-Agent': 'CityDashboard/1.0', 'Accept': 'application/json' }
        });
        if (!warningResp.ok) throw new Error('BoM warnings API returned ' + warningResp.status);
        var warningRaw = await warningResp.json();
        var warnings = (warningRaw.data || []).map(function(warning) {
          return {
            id: warning.id,
            type: warning.type,
            title: warning.title,
            shortTitle: warning.short_title,
            state: warning.state,
            group: warning.warning_group_type,
            phase: warning.phase,
            issuedAt: warning.issue_time,
            expiresAt: warning.expiry_time
          };
        });
        var warningJson = JSON.stringify({ warnings: warnings, geohash: warningGeohash, fetchedAt: warningNow });
        _warningsCache[warningGeohash] = warningJson;
        _warningsTime[warningGeohash] = warningNow;
        return new Response(warningJson, {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'MISS' }, corsHeaders)
        });
      } catch (warningErr) {
        if (_warningsCache[warningGeohash]) {
          return new Response(_warningsCache[warningGeohash], {
            headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'STALE' }, corsHeaders)
          });
        }
        return new Response(JSON.stringify({ error: 'BoM warnings error: ' + warningErr.message }), {
          status: 502,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }
    }

    // Queensland Fire Department statewide incident feed. The parsed feed is
    // cached independently of the caller's location; distance is calculated
    // per request so no home location is retained server-side.
    if (path === '/api/bushfires') {
      let bfLat = parseFloat(url.searchParams.get('lat'));
      let bfLon = parseFloat(url.searchParams.get('lon'));
      if (isNaN(bfLat)) bfLat = -27.4698;
      if (isNaN(bfLon)) bfLon = 153.0251;
      if (bfLat < -90 || bfLat > 90 || bfLon < -180 || bfLon > 180) {
        return new Response(JSON.stringify({ error: 'Invalid lat/lon' }), {
          status: 400,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }
      const BUSHFIRES_TTL = 5 * 60 * 1000;
      const bfNow = Date.now();
      let incidents = null;
      let cacheState = 'HIT';
      if (_bushfiresCache && (bfNow - _bushfiresCache.ts) < BUSHFIRES_TTL) {
        incidents = _bushfiresCache.incidents;
      } else {
        try {
          const response = await fetch('https://publiccontent-gis-psba-qld-gov-au.s3.amazonaws.com/content/Feeds/BushfireCurrentIncidents/bushfireAlert.xml');
          if (!response.ok) throw new Error('feed returned ' + response.status);
          const xml = await response.text();
          // A 200 error page would parse to zero incidents and cache as "all clear".
          if (!/<feed[\s>]/i.test(xml)) throw new Error('feed returned a non-Atom body');
          const parsed = [];
          const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
          let entryMatch;
          while ((entryMatch = entryPattern.exec(xml)) !== null && parsed.length < 200) {
            const chunk = entryMatch[1];
            const pick = function(pattern) {
              const match = chunk.match(pattern);
              return match ? decodeXmlEntities(match[1]).trim() : '';
            };
            const point = pick(/<georss:point>([\s\S]*?)<\/georss:point>/).split(/\s+/);
            const incidentLat = parseFloat(point[0]);
            const incidentLon = parseFloat(point[1]);
            if (isNaN(incidentLat) || isNaN(incidentLon)) continue;
            const level = pick(/<category term="([^"]*)"/);
            parsed.push({
              id: pick(/<id>([\s\S]*?)<\/id>/).slice(0, 60),
              level: level.slice(0, 40),
              severity: BUSHFIRE_LEVELS[level.toLowerCase()] || 0,
              title: pick(/<title>([\s\S]*?)<\/title>/).slice(0, 200),
              content: pick(/<content>([\s\S]*?)<\/content>/).slice(0, 400),
              lat: incidentLat,
              lon: incidentLon,
              updated: pick(/<updated>([\s\S]*?)<\/updated>/).slice(0, 40)
            });
          }
          _bushfiresCache = { incidents: parsed, ts: bfNow };
          incidents = parsed;
          cacheState = 'MISS';
        } catch (error) {
          if (_bushfiresCache) {
            incidents = _bushfiresCache.incidents;
            cacheState = 'STALE';
          } else {
            return new Response(JSON.stringify({ error: 'Bushfire feed unavailable' }), {
              status: 502,
              headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
            });
          }
        }
      }
      const output = incidents.map(function(incident) {
        return Object.assign({}, incident, {
          distanceKm: Math.round(haversineKm(bfLat, bfLon, incident.lat, incident.lon) * 10) / 10
        });
      });
      output.sort(function(a, b) { return (b.severity - a.severity) || (a.distanceKm - b.distanceKm); });
      return new Response(JSON.stringify({ incidents: output, fetchedAt: bfNow }), {
        headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': cacheState }, corsHeaders)
      });
    }

    // Local headlines from two public RSS feeds, merged newest-first. A total
    // upstream failure serves the most recent parsed result when available.
    if (path === '/api/news') {
      const NEWS_TTL = 15 * 60 * 1000;
      const newsNow = Date.now();
      if (_newsCache && (newsNow - _newsTime) < NEWS_TTL) {
        return new Response(_newsCache, {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'HIT' }, corsHeaders)
        });
      }
      const sources = [
        { name: 'ABC News', url: 'https://www.abc.net.au/news/feed/45910/rss.xml' },
        { name: 'Brisbane Times', url: 'https://www.brisbanetimes.com.au/rss/national/queensland.xml' }
      ];
      const fluffPattern = /^(why|how|meet|inside|watch:|what)\b|\?\s*$|future of|need to know|here'?s |you should|first look/i;
      const sourceResults = await Promise.all(sources.map(async function(source) {
        try {
          const response = await fetch(source.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BrisbaneDashboard/1.0)' } });
          if (!response.ok) return null;
          const xml = await response.text();
          if (!/<(rss|feed)[\s>]/i.test(xml)) return null; // HTML error page, not a feed
          const items = [];
          const itemPattern = /<item>([\s\S]*?)<\/item>/g;
          let itemMatch;
          while ((itemMatch = itemPattern.exec(xml)) !== null && items.length < 10) {
            const chunk = itemMatch[1];
            const titleMatch = chunk.match(/<title>([\s\S]*?)<\/title>/);
            if (!titleMatch) continue;
            const title = decodeXmlEntities(titleMatch[1]).trim().slice(0, 160);
            if (!title || fluffPattern.test(title)) continue;
            const publishedMatch = chunk.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
            const timestamp = publishedMatch ? Date.parse(publishedMatch[1]) : NaN;
            items.push({
              title: title,
              source: source.name,
              publishedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
              _timestamp: Number.isFinite(timestamp) ? timestamp : 0
            });
          }
          return items;
        } catch (error) {
          return null;
        }
      }));
      const successful = sourceResults.filter(function(items) { return items !== null; });
      if (!successful.length) {
        if (_newsCache) {
          return new Response(_newsCache, {
            headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'STALE' }, corsHeaders)
          });
        }
        return new Response(JSON.stringify({ error: 'All news feeds failed' }), {
          status: 502,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }
      const merged = [];
      for (const items of successful) merged.push(...items);
      merged.sort(function(a, b) { return b._timestamp - a._timestamp; });
      const top = merged.slice(0, 10).map(function(item) {
        return { title: item.title, source: item.source, publishedAt: item.publishedAt };
      });
      const newsJson = JSON.stringify({ items: top, fetchedAt: newsNow });
      _newsCache = newsJson;
      _newsTime = newsNow;
      return new Response(newsJson, {
        headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'MISS' }, corsHeaders)
      });
    }

    // Google Pollen forecast. Shared KV is mandatory because per-isolate caches
    // cannot safely protect a paid API quota across Worker cold starts.
    if (path === '/api/pollen') {
      if (!env.GOOGLE_POLLEN_API_KEY) {
        return new Response(JSON.stringify({ error: 'GOOGLE_POLLEN_API_KEY not configured' }), {
          status: 500,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }
      var pollenKv = env.STATUS_KV || env.SETTINGS_KV;
      if (!pollenKv) {
        return new Response(JSON.stringify({ error: 'STATUS_KV or SETTINGS_KV is required for pollen quota protection' }), {
          status: 500,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }
      var pollenLat = parseFloat(url.searchParams.get('lat'));
      var pollenLon = parseFloat(url.searchParams.get('lon'));
      if (isNaN(pollenLat)) pollenLat = -27.4705;
      if (isNaN(pollenLon)) pollenLon = 153.026;
      if (pollenLat < -90 || pollenLat > 90 || pollenLon < -180 || pollenLon > 180) {
        return new Response(JSON.stringify({ error: 'Invalid lat/lon' }), {
          status: 400,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }
      var pollenKey = pollenLat.toFixed(2) + ',' + pollenLon.toFixed(2);
      var pollenKvKey = POLLEN_KV_KEY_PREFIX + pollenKey;
      var pollenNow = Date.now();
      if (_pollenCache[pollenKey] && (pollenNow - _pollenTime[pollenKey]) < POLLEN_DATA_TTL) {
        return new Response(_pollenCache[pollenKey], {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'HIT' }, corsHeaders)
        });
      }
      if (_pollenCache[pollenKey] && _pollenRetryAfter[pollenKey] > pollenNow &&
          (pollenNow - _pollenTime[pollenKey]) < POLLEN_STALE_MAX_MS) {
        return new Response(_pollenCache[pollenKey], {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'STALE' }, corsHeaders)
        });
      }
      var pollenKvCache = null;
      try { pollenKvCache = await pollenKv.get(pollenKvKey, 'json'); } catch (e) {}
      if (pollenKvCache && typeof pollenKvCache.json === 'string') {
        var pollenKvAge = pollenNow - (pollenKvCache.ts || 0);
        _pollenCache[pollenKey] = pollenKvCache.json;
        _pollenTime[pollenKey] = pollenKvCache.ts || 0;
        _pollenRetryAfter[pollenKey] = pollenKvCache.retryAfter || 0;
        if (pollenKvAge < POLLEN_DATA_TTL) {
          return new Response(pollenKvCache.json, {
            headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'HIT' }, corsHeaders)
          });
        }
        if ((pollenKvCache.retryAfter || 0) > pollenNow && pollenKvAge < POLLEN_STALE_MAX_MS) {
          return new Response(pollenKvCache.json, {
            headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'STALE' }, corsHeaders)
          });
        }
      }
      if (pollenKvCache && (pollenKvCache.retryAfter || 0) > pollenNow) {
        return new Response(JSON.stringify({ error: 'Pollen API temporarily unavailable' }), {
          status: 503,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }
      try {
        var pollenUrl = 'https://pollen.googleapis.com/v1/forecast:lookup' +
          '?key=' + encodeURIComponent(env.GOOGLE_POLLEN_API_KEY) +
          '&location.latitude=' + pollenLat + '&location.longitude=' + pollenLon + '&days=3';
        var pollenResp = await fetch(pollenUrl);
        if (!pollenResp.ok) throw new Error('Google Pollen API returned ' + pollenResp.status);
        var pollenRaw = await pollenResp.json();
        var pollenDays = (pollenRaw.dailyInfo || []).map(function(dayInfo) {
          var pollenDate = dayInfo.date || {};
          var dateText = pollenDate.year + '-' + String(pollenDate.month).padStart(2, '0') + '-' + String(pollenDate.day).padStart(2, '0');
          var pollenTypes = {};
          (dayInfo.pollenTypeInfo || []).forEach(function(typeInfo) {
            pollenTypes[typeInfo.code] = {
              value: typeInfo.indexInfo ? typeInfo.indexInfo.value : null,
              category: typeInfo.indexInfo ? typeInfo.indexInfo.category : null,
              inSeason: typeInfo.inSeason === true
            };
          });
          var plants = (dayInfo.plantInfo || []).filter(function(plant) {
            return plant.indexInfo && plant.indexInfo.value > 0;
          }).map(function(plant) {
            return { name: plant.displayName || plant.code, value: plant.indexInfo.value, category: plant.indexInfo.category };
          });
          return { date: dateText, types: pollenTypes, plants: plants };
        });
        var pollenJson = JSON.stringify({ days: pollenDays, regionCode: pollenRaw.regionCode || '', fetchedAt: pollenNow });
        _pollenCache[pollenKey] = pollenJson;
        _pollenTime[pollenKey] = pollenNow;
        _pollenRetryAfter[pollenKey] = 0;
        try {
          await pollenKv.put(pollenKvKey, JSON.stringify({ json: pollenJson, ts: pollenNow, retryAfter: 0 }), {
            expirationTtl: POLLEN_KV_EXPIRATION_TTL_S
          });
        } catch (e) {}
        return new Response(pollenJson, {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'MISS' }, corsHeaders)
        });
      } catch (pollenErr) {
        var retryAfter = pollenNow + POLLEN_RETRY_TTL;
        var stalePollen = null;
        var staleTimestamp = 0;
        if (_pollenCache[pollenKey] && (pollenNow - _pollenTime[pollenKey]) < POLLEN_STALE_MAX_MS) {
          stalePollen = _pollenCache[pollenKey];
          staleTimestamp = _pollenTime[pollenKey];
        } else if (pollenKvCache && typeof pollenKvCache.json === 'string' &&
                   (pollenNow - (pollenKvCache.ts || 0)) < POLLEN_STALE_MAX_MS) {
          stalePollen = pollenKvCache.json;
          staleTimestamp = pollenKvCache.ts || 0;
        }
        _pollenRetryAfter[pollenKey] = retryAfter;
        try {
          await pollenKv.put(pollenKvKey, JSON.stringify({ json: stalePollen, ts: staleTimestamp, retryAfter: retryAfter }), {
            expirationTtl: POLLEN_KV_EXPIRATION_TTL_S
          });
        } catch (e) {}
        if (stalePollen) {
          return new Response(stalePollen, {
            headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'STALE' }, corsHeaders)
          });
        }
        return new Response(JSON.stringify({ error: 'Pollen API error: ' + pollenErr.message }), {
          status: 502,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }
    }

    // Dashboard status — optional KV-backed mutable state shared across devices
    if (path === '/api/dashboard-status') {
      const statusKv = env.STATUS_KV || env.SETTINGS_KV;
      if (!statusKv) {
        return new Response(JSON.stringify({ error: 'STATUS_KV not configured' }), {
          status: 500,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
        });
      }

      if (request.method === 'GET') {
        let stored = null;
        try {
          stored = await statusKv.get(DASHBOARD_STATUS_KV_KEY, 'json');
        } catch (e) {
          return new Response(JSON.stringify({ error: 'Storage read failed, retry later' }), {
            status: 503,
            headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
          });
        }
        return new Response(JSON.stringify(sanitizeDashboardStatus(stored)), {
          headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, corsHeaders)
        });
      }

      if (request.method === 'PUT' || request.method === 'POST') {
        let body;
        try {
          body = await request.json();
        } catch (e) {
          return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
            status: 400,
            headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
          });
        }

        let stored = null;
        try {
          stored = await statusKv.get(DASHBOARD_STATUS_KV_KEY, 'json');
        } catch (e) {
          return new Response(JSON.stringify({ error: 'Storage read failed, retry later' }), {
            status: 503,
            headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
          });
        }

        const existing = sanitizeDashboardStatus(stored);
        const incoming = sanitizeDashboardStatus(body);
        const next = sanitizeDashboardStatus({
          bin: Object.assign({}, existing.bin, incoming.bin),
          updatedAt: new Date().toISOString()
        });

        const changed = dashboardStatusFingerprint(next) !== dashboardStatusFingerprint(existing);
        if (changed) {
          try {
            await statusKv.put(DASHBOARD_STATUS_KV_KEY, JSON.stringify(next));
          } catch (e) {
            return new Response(JSON.stringify({ error: 'Storage write failed, retry later' }), {
              status: 503,
              headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
            });
          }
        }
        return new Response(JSON.stringify(changed ? next : existing), {
          headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, corsHeaders)
        });
      }

      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
      });
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
    });
}
