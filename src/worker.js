/**
 * TransLink GTFS-RT Proxy Worker
 * Fetches real-time bus departures from TransLink and returns JSON
 */

// Bus-only feed is much smaller than the full SEQ feed, staying within CPU limits
const TRANSLINK_API = 'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates/Bus';

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
let _standingsCache = {};      // { cacheKey -> json string }
let _standingsTime = {};
let _fuelSiteDetails = null;
let _fuelSiteTime = 0;
let _fuelBrands = null;
let _fuelBrandsTime = 0;
let _fuelResultCache = {};
let _fuelResultTime = {};
let _financeCache = null;
let _financeTime = 0;
let _electricityCache = null;
let _electricityTime = 0;
let _polymarketCache = null;
let _polymarketTime = 0;
let _routesCache = {};         // { callsign -> json string }
let _routesTime = {};
let _lastFeatureRequestTime = 0;

const ELECTRICITY_GRAPH_URL = 'https://www.nemweb.com.au/mms.GRAPHS/GRAPHS/GRAPH_5QLD1.csv';
const ELECTRICITY_DATA_TTL = 60 * 1000;

function parseElectricityGraphCsv(csvText) {
  var lines = (csvText || '').replace(/\r/g, '').split('\n');
  var latest = null;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line || line.indexOf('REGION,') === 0) continue;

    var parts = line.split(',');
    if (parts.length < 4) continue;
    if (parts[0] !== 'QLD1') continue;

    var price = parseFloat(parts[3]);
    if (isNaN(price)) continue;

    latest = {
      region: parts[0],
      settlementDate: (parts[1] || '').replace(/^"|"$/g, ''),
      totalDemand: parseFloat(parts[2]),
      price: price
    };
  }

  if (!latest) {
    throw new Error('QLD price not found in NEMWEB CSV');
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

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var path = url.pathname;

    if (!path.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    var corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Dashboard-Token',
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
    if (incoming !== env.DASHBOARD_TOKEN) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
      });
    }

    // Queensland electricity spot price - AEMO NEMWEB graph CSV
    if (path === '/api/electricity') {
      var elecNow = Date.now();
      if (_electricityCache && (elecNow - _electricityTime) < ELECTRICITY_DATA_TTL) {
        return new Response(_electricityCache, {
          headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'HIT' }, corsHeaders)
        });
      }

      try {
        var elecResp = await fetch(ELECTRICITY_GRAPH_URL, {
          headers: {
            'User-Agent': 'brisbane-dashboard/1.0',
            'Accept': 'text/csv, text/plain, */*'
          }
        });
        if (!elecResp.ok) {
          throw new Error('NEMWEB error: ' + elecResp.status);
        }

        var elecText = await elecResp.text();
        var elecData = parseElectricityGraphCsv(elecText);
        elecData.fetchedAt = elecNow;
        elecData.source = 'NEMWEB GRAPH_5QLD1.csv';

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
        // ADSB.lol uses center + radius (nm), compute from bounding box
        var centerLat = (minLat + maxLat) / 2;
        var centerLon = (minLon + maxLon) / 2;
        var distNm = Math.max(
          Math.abs(maxLat - minLat) * 60 / 2,
          Math.abs(maxLon - minLon) * 60 / 2
        );
        var adsbUrl = 'https://api.adsb.lol/v2/lat/' + centerLat + '/lon/' + centerLon + '/dist/' + Math.ceil(distNm);
        var flightResp = await fetch(adsbUrl);
        if (!flightResp.ok) {
          var providerBody = '';
          try {
            providerBody = await flightResp.text();
          } catch (bodyErr) {}
          providerBody = (providerBody || '').replace(/\s+/g, ' ');
          if (providerBody.length > 160) providerBody = providerBody.substring(0, 160) + '...';

          var providerError = {
            error: 'ADSB.lol returned HTTP ' + flightResp.status + (flightResp.statusText ? ' ' + flightResp.statusText : ''),
            source: 'adsb.lol',
            providerStatus: flightResp.status
          };
          if (providerBody) providerError.detail = providerBody;

          return new Response(JSON.stringify(providerError), {
            status: flightResp.status === 429 ? 429 : 502,
            headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
          });
        }
        var adsbData = await flightResp.json();
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
            espnPath + '/scoreboard?limit=10&dates=' + dateRange;
          const resp = await fetch(espnUrl, { headers: espnHeaders });
          if (!resp.ok) return [];
          const text = await resp.text();
          let data = {};
          try { data = JSON.parse(text); } catch (e) {}
          return data.events || [];
        } catch (e) {
          return [];
        }
      }

      function normalizeEspnEvent(ev) {
        const comp = ev.competitions && ev.competitions[0];
        if (!comp) return null;
        const isCompleted = !!(comp.status && comp.status.type && comp.status.type.completed);
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
          intHomeScore: isCompleted ? homeComp.score : null,
          intAwayScore: isCompleted ? awayComp.score : null,
          dateEvent: ev.date ? ev.date.substring(0, 10) : '',
          strTime: ev.date ? ev.date.substring(11, 16) : '',
          strStatus: isCompleted ? 'Match Finished' : 'Scheduled',
          _completed: isCompleted
        };
      }

      // TheSportsDB: try current year first (works for most leagues incl. Six Nations)
      async function fetchSportsDbSeason(leagueId) {
        const year = now.getFullYear();
        const seasons = ['' + year, (year - 1) + '-' + year, '' + (year - 1)];
        for (const s of seasons) {
          try {
            const resp = await fetch(
              'https://www.thesportsdb.com/api/v1/json/3/eventsseason.php?id=' + leagueId + '&s=' + s
            );
            if (!resp.ok) continue;
            const data = await resp.json();
            const evs = data.events || [];
            if (evs.length > 0) return evs;
          } catch (e) {}
        }
        return [];
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
        return {
          strHomeTeam: homeTeam,
          strAwayTeam: awayTeam,
          intHomeScore: homeScore,
          intAwayScore: awayScore,
          dateEvent: (m.date || '').substring(0, 10),
          strTime: '',
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
        return {
          strHomeTeam: ev.strHomeTeam || '',
          strAwayTeam: ev.strAwayTeam || '',
          intHomeScore: hasScore ? ev.intHomeScore : null,
          intAwayScore: hasScore ? ev.intAwayScore : null,
          dateEvent: ev.dateEvent || '',
          strTime: ev.strTime ? ev.strTime.substring(0, 5) : '',
          strStatus: isCompleted ? 'Match Finished' : 'Scheduled',
          _completed: isCompleted
        };
      }

      const sportsResult = {};
      const sportsFetches = leagueIds.map(async function(lid) {
        try {
          // --- ESPN path ---
          if (ESPN_MAP[lid]) {
            const espnPath = ESPN_MAP[lid];
            const [pastRaw, futureRaw] = await Promise.all([
              fetchEspnRange(espnPath, pastRange),
              fetchEspnRange(espnPath, futureRange)
            ]);
            const past = [], next = [];
            for (const ev of pastRaw) {
              const norm = normalizeEspnEvent(ev);
              if (norm && norm._completed) past.push(norm);
            }
            for (const ev of futureRaw) {
              const norm = normalizeEspnEvent(ev);
              if (!norm) continue;
              if (norm._completed) past.push(norm);
              else next.push(norm);
            }
            sportsResult[lid] = { past: past.slice(-3), next: next.slice(0, 3) };

          // --- TheSportsDB path ---
          } else if (SPORTSDB_IDS.has(lid)) {
            const evs = await fetchSportsDbSeason(lid);
            const past = [], next = [];
            for (const ev of evs) {
              const norm = normalizeSportsDbEvent(ev);
              if (!norm.dateEvent) continue;
              if (norm._completed && norm.dateEvent < todayStr) past.push(norm);
              else if (!norm._completed && norm.dateEvent >= todayStr) next.push(norm);
            }
            sportsResult[lid] = { past: past.slice(-3), next: next.slice(0, 3) };

          // --- CricketData.org path ---
          } else if (lid === '4752') {
            if (!env.CRICAPI_KEY) { sportsResult[lid] = { next: [], past: [] }; return; }
            const cricResp = await fetch(
              'https://cricketdata.org/api/v1/currentMatches?apikey=' + env.CRICAPI_KEY + '&offset=0'
            );
            if (!cricResp.ok) { sportsResult[lid] = { next: [], past: [] }; return; }
            const cricData = await cricResp.json();
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
            sportsResult[lid] = { past: cricPast.slice(-3), next: cricNext.slice(0, 3) };

          } else {
            sportsResult[lid] = { next: [], past: [] };
          }
        } catch (e) {
          sportsResult[lid] = { next: [], past: [] };
        }
      });
      await Promise.all(sportsFetches);
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
        var detailsPromise = getFuelSiteDetails(fuelToken);
        var brandsPromise = getFuelBrands(fuelToken);
        var pricesResp = await fetch(FPD_API_BASE + '/Price/GetSitesPrices?countryId=21&geoRegionLevel=3&geoRegionId=1', {
          headers: { 'Authorization': 'FPDAPI SubscriberToken=' + fuelToken, 'Content-Type': 'application/json' }
        });
        if (!pricesResp.ok) throw new Error('FPD prices API error: ' + pricesResp.status);
        var pricesData = await pricesResp.json();
        var siteDetails = await detailsPromise;
        var brandNames = await brandsPromise;

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
      const fetches = leagueIds.map(async function(espnPath) {
        try {
          const resp = await fetch(
            'https://site.api.espn.com/apis/v2/sports/soccer/' + espnPath + '/standings',
            { headers: standingsHeaders }
          );
          if (!resp.ok) { result[espnPath] = []; return; }
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
        }
      });
      await Promise.all(fetches);

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
      if (_financeCache && _financeCache.key === sortedKey && (finNow - _financeTime) < 300 * 1000) {
        return new Response(_financeCache.json, {
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

      const finJson = JSON.stringify(finResult);
      _financeCache = { key: sortedKey, json: finJson };
      _financeTime = finNow;
      return new Response(finJson, {
        headers: Object.assign({ 'Content-Type': 'application/json', 'X-Cache': 'MISS' }, corsHeaders)
      });
    }

    if (path === '/api/polymarket') {
      const limit = parseInt(url.searchParams.get('limit')) || 5;
      const cacheKey = 'pm_' + limit;
      const pmNow = Date.now();

      if (_polymarketCache && _polymarketCache.key === cacheKey && (pmNow - _polymarketTime) < 300 * 1000) {
        return new Response(_polymarketCache.json, {
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
        _polymarketCache = { key: cacheKey, json: pmJson };
        _polymarketTime = pmNow;
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

    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
    });
  }
};

