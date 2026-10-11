#!/usr/bin/env node

'use strict';

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

var root = path.resolve(__dirname, '..');
var htmlPath = path.join(root, 'index.html');
var publicHtmlPath = path.join(root, 'public', 'index.html');
var workerPath = path.join(root, 'src', 'worker.js');
var failures = [];

function fail(message) {
  failures.push(message);
}

function run(label, command, args) {
  var result = childProcess.spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    fail(label + ': ' + String(result.stderr || result.stdout || 'failed').trim());
  }
}

var html = fs.readFileSync(htmlPath, 'utf8');
var versionMatch = html.match(/<meta name="app-version" content="([^"]+)">/);
if (!versionMatch || !/^\d+\.\d+\.\d+$/.test(versionMatch[1])) fail('app-version must be semver');
if (!/\bbirthdays:\s*\[\s*\]/.test(html)) fail('birthday defaults must remain an empty array');

var idPattern = /\sid="([^"]+)"/g;
var ids = {};
var idMatch;
while ((idMatch = idPattern.exec(html)) !== null) {
  ids[idMatch[1]] = (ids[idMatch[1]] || 0) + 1;
}
Object.keys(ids).forEach(function(id) {
  if (ids[id] > 1) fail('duplicate HTML id: ' + id);
});

try {
  if (!fs.lstatSync(publicHtmlPath).isSymbolicLink() || fs.readlinkSync(publicHtmlPath) !== '../index.html') {
    fail('public/index.html must remain a symlink to ../index.html');
  }
} catch (error) {
  fail('public/index.html symlink is missing');
}

var worker = fs.readFileSync(workerPath, 'utf8');
if (worker.indexOf('timingSafeEqual(incoming, env.DASHBOARD_TOKEN)') === -1) {
  fail('Worker authentication must use timingSafeEqual');
}
if (worker.indexOf('UPSTREAM_FETCH_TIMEOUT_MS') === -1) fail('Worker upstream deadline wrapper is missing');


// --- Behavioural regression checks (ported from the private dashboard) ---
var vm = require('vm');
function throwFail(message) { throw new Error(message); }
function extractBetween(source, startToken, endToken, label) {
  var start = source.indexOf(startToken);
  var end = source.indexOf(endToken, start + startToken.length);
  if (start === -1 || end === -1) throwFail('could not extract ' + label);
  return source.slice(start, end);
}

function extractFunction(source, name) {
  return extractBetween(source, 'function ' + name + '(', '\n      function ', name);
}

// Wrap a fixed "now" so code that calls new Date() / Date.now() is testable.
// The context must already hold NativeDate (see captureNativeDate) because a
// function declaration named Date shadows the built-in for the whole script.
function captureNativeDate(context) {
  vm.runInNewContext('NativeDate = Date;', context);
}
function fixedDatePrelude() {
  return 'function Date(a, b, c, d, e, f, g) {\n' +
    '  if (!(this instanceof Date)) return NativeDate.apply(null, arguments);\n' +
    '  if (arguments.length === 0) return new NativeDate(fixedNow);\n' +
    '  if (arguments.length === 1) return new NativeDate(a);\n' +
    '  if (arguments.length === 2) return new NativeDate(a, b);\n' +
    '  return new NativeDate(a, b, c, d || 0, e || 0, f || 0, g || 0);\n' +
    '}\n' +
    'Date.prototype = NativeDate.prototype;\n' +
    'Date.now = function() { return fixedNow; };\n' +
    'Date.parse = NativeDate.parse; Date.UTC = NativeDate.UTC;\n';
}

// Weekly doses: due day and the day after are "current" on every surface;
// from day+2 there is no period at all (so nothing can show as overdue when
// the card offers no Take button). Missing/null weekDay means Monday.
function checkBinHelpers(frontend) {
  var source = extractFunction(frontend, 'getLocalDateString') + '\n' +
    extractFunction(frontend, 'isBinRecyclingForDate') + '\n' +
    extractFunction(frontend, 'getBinCollectionDayIndex');
  var context = { config: { binRecyclingAnchor: '2026-08-31', binDay: 'Wednesday' }, output: null };
  vm.runInNewContext(
    source + '\n' +
      'output = [' +
      'isBinRecyclingForDate(new Date(2026, 8, 1)),' +   // Tue of the anchor week
      'isBinRecyclingForDate(new Date(2026, 8, 8)),' +   // Tue of the following week
      'isBinRecyclingForDate(new Date(2026, 8, 15)),' +
      'isBinRecyclingForDate(new Date(2026, 7, 25)),' +  // Tue of the week before the anchor
      'getBinCollectionDayIndex()' +
      '];\n' +
      'config.binDay = "wed"; output.push(getBinCollectionDayIndex());\n' +
      'config.binDay = ""; output.push(getBinCollectionDayIndex());',
    context
  );
  if (JSON.stringify(context.output) !== JSON.stringify([true, false, true, false, 3, 3, -1])) {
    throwFail('bin helpers changed behaviour: ' + JSON.stringify(context.output));
  }
  if (frontend.indexOf("dayNames[d].toLowerCase() === config.binDay") !== -1) {
    throwFail('bin visibility must use getBinCollectionDayIndex(), not an exact-match loop');
  }
  var parityUses = frontend.split('isBinRecyclingForDate(').length - 1;
  if (parityUses < 3) throwFail('card and ticker must both derive bin type via isBinRecyclingForDate; found ' + parityUses);
  console.log('Bin helper tests passed');
}

// Every card that offers a Ticker display mode must produce a ticker slide,
// otherwise choosing "Ticker" hides the card and shows nothing (Life360 and
// Birthdays shipped that way for months).
function checkDisplayModeTickerParity(frontend) {
  var start = frontend.indexOf('function buildTickerSlides(');
  var end = frontend.indexOf('\n      function ', start + 10);
  if (start === -1 || end === -1) throwFail('could not locate buildTickerSlides');
  var body = frontend.slice(start, end);
  var re = /<(?:select|span) id="([A-Za-z0-9]+)DisplayMode"/g;
  var match;
  var missing = [];
  var seen = {};
  while ((match = re.exec(frontend))) {
    var name = match[1];
    if (seen[name]) continue;
    seen[name] = true;
    if (body.indexOf('config.' + name + 'DisplayMode') === -1 && body.indexOf("'" + name + "DisplayMode'") === -1) {
      missing.push(name);
    }
  }
  if (missing.length) throwFail('display-mode selects with no ticker slide in buildTickerSlides: ' + missing.join(', '));

  // Every slide must name its card so a ticker tap can lift it as a popup.
  // News is the one exception: a headline tap opens the story instead.
  var pushRe = /slides\.push\(\{/g;
  var untagged = 0;
  var total = 0;
  while ((match = pushRe.exec(body))) {
    total++;
    var close = body.indexOf('});', match.index);
    var chunk = body.slice(match.index, close === -1 ? match.index + 400 : close);
    if (chunk.indexOf('cardId:') === -1 && chunk.indexOf('newsIdx:') === -1) untagged++;
  }
  if (total < 15) throwFail('expected buildTickerSlides to push many slides, found ' + total);
  if (untagged) throwFail(untagged + ' ticker slide(s) in buildTickerSlides have no cardId (needed for the tap-to-popup)');
  console.log('Display-mode / ticker-slide parity passed');
}

// DEFAULT_CARD_ORDER is the single source of truth for card order.
function checkCardOrderCompleteness(frontend) {
  var literal = frontend.match(/var DEFAULT_CARD_ORDER = \[([^\]]*)\]/);
  if (!literal) throwFail('DEFAULT_CARD_ORDER not found');
  var order = literal[1].split(',').map(function(s) { return s.trim().replace(/['"]/g, ''); }).filter(Boolean);
  var re = /data-card-id="([A-Za-z0-9]+)"/g;
  var match;
  var missing = [];
  while ((match = re.exec(frontend))) {
    if (order.indexOf(match[1]) === -1 && missing.indexOf(match[1]) === -1) missing.push(match[1]);
  }
  if (missing.length) throwFail('cards missing from DEFAULT_CARD_ORDER: ' + missing.join(', '));
  if (frontend.indexOf('cardOrder: DEFAULT_CARD_ORDER.slice()') === -1) throwFail('config.cardOrder default must derive from DEFAULT_CARD_ORDER');
  if (frontend.indexOf('var DEFAULT_CARD_ORDER') > frontend.indexOf('\n      var config = {')) throwFail('DEFAULT_CARD_ORDER must be declared before the config defaults');
  console.log('Card order completeness passed');
}

// Worker upstream deadline: the abort timer must stay armed until the body is
// read, not just until headers arrive.
function checkNeedsAttentionDismissal(frontend) {
  var source = extractBetween(frontend, 'function addNeedsAttentionItem(', '\n      function feedHealthWatchList', 'Needs Attention dismissal helpers');
  var context = { config: { needsAttentionDismissable: true }, output: null, rendered: 0 };
  vm.runInNewContext(
    'var store = {}; var localStorage = { getItem: function(k) { return store[k] || null; }, setItem: function(k, v) { store[k] = String(v); }, removeItem: function(k) { delete store[k]; } };\n' +
    'function storageKey(n) { return "t_" + n; }\n' +
    'function renderNeedsAttention() { rendered++; }\n' +
    'var window = {};\n' +
    'var current = [];\n' +
    'function buildNeedsAttentionItems() { return current.slice(); }\n' +
    source + '\n' +
    'var items = []; addNeedsAttentionItem(items, 50, "warn", "Weather", "35°C now", "Heat"); addNeedsAttentionItem(items, 90, "urgent", "Bushfire", "Emergency", "x", "dismissBushfireWarning(1)");\n' +
    'current = items;\n' +
    'var before = filterDismissedNeedsAttention(items).length;\n' +
    'dismissNeedsAttentionItem(items[0].key);\n' +
    'var after = filterDismissedNeedsAttention(items).length;\n' +
    'dismissNeedsAttentionItem(items[1].key); /* has action → not dismissable */\n' +
    'var afterAction = filterDismissedNeedsAttention(items).length;\n' +
    'var changed = []; addNeedsAttentionItem(changed, 50, "warn", "Weather", "38°C now", "Heat");\n' +
    'var afterChange = filterDismissedNeedsAttention(changed).length;\n' +
    'resetNeedsAttentionDismissed();\n' +
    'var afterReset = filterDismissedNeedsAttention(items).length;\n' +
    'output = { before: before, after: after, afterAction: afterAction, afterChange: afterChange, afterReset: afterReset, actionDismissable: isNeedsAttentionItemDismissable(items[1]), plainDismissable: isNeedsAttentionItemDismissable(items[0]) };',
    context
  );
  var expected = { before: 2, after: 1, afterAction: 1, afterChange: 1, afterReset: 2, actionDismissable: false, plainDismissable: true };
  if (JSON.stringify(context.output) !== JSON.stringify(expected)) {
    throwFail('Needs Attention dismissal behaviour changed: ' + JSON.stringify(context.output));
  }
  console.log('Needs Attention dismissal tests passed');
}

function checkWorkerFetchDeadline(worker) {
  var source = extractBetween(worker, 'const UPSTREAM_FETCH_TIMEOUT_MS', '\n// Module-level cache', 'worker fetch wrapper');
  var context = { output: null };
  vm.runInNewContext(
    'var timers = 0, cleared = 0, aborted = false;\n' +
    'function setTimeout(fn) { timers++; return timers; }\n' +
    'function clearTimeout(id) { cleared++; }\n' +
    'function AbortController() { var self = this; this.signal = {}; this.abort = function() { aborted = true; }; }\n' +
    'var bodyResolve; var bodyPromise = new Promise(function(r) { bodyResolve = r; });\n' +
    'var fakeResp = { ok: true, text: function() { return bodyPromise; }, json: function() { return bodyPromise.then(function(t) { return JSON.parse(t); }); } };\n' +
    'var globalThis = { fetch: function() { return Promise.resolve(fakeResp); } };\n' +
    source + '\n' +
    'var clearedAfterHeaders = null, clearedAfterBody = null;\n' +
    'fetch("https://example.test/x").then(function(resp) {\n' +
    '  clearedAfterHeaders = cleared;\n' +
    '  var p = resp.text().then(function(t) { clearedAfterBody = cleared; return t; });\n' +
    '  bodyResolve("hello");\n' +
    '  return p;\n' +
    '}).then(function(text) { output = { timers: timers, clearedAfterHeaders: clearedAfterHeaders, clearedAfterBody: clearedAfterBody, text: text }; });',
    context
  );
  return new Promise(function(resolve) { setImmediate(resolve); }).then(function() {
    var expected = { timers: 1, clearedAfterHeaders: 0, clearedAfterBody: 1, text: 'hello' };
    if (JSON.stringify(context.output) !== JSON.stringify(expected)) {
      throwFail('worker fetch deadline no longer covers the body read: ' + JSON.stringify(context.output));
    }
    console.log('Worker fetch deadline tests passed');
  });
}

// Idempotent PUT: the fingerprint must ignore the server's own updatedAt and be
// stable under key order, so an identical re-PUT never costs a KV write. Bin
// merge must keep the newer date per field.

// Pollen: the worker cache can be up to 12h (or 3 days stale) old, so card
// and ticker must pick the forecast day matching the local date, not days[0].
// Google's AU TREE index is cypress only and is labelled as such.
function checkPollenHelpers(frontend) {
  var source = extractFunction(frontend, 'getLocalDateString') + '\n' +
    extractBetween(frontend, 'var POLLEN_TYPE_LABELS', '\n      function pollenTypeLabel', 'pollen constants') + '\n' +
    extractFunction(frontend, 'pollenTypeLabel') + '\n' +
    extractFunction(frontend, 'pollenCoverageNote') + '\n' +
    extractFunction(frontend, 'pollenDayForToday') + '\n' +
    extractFunction(frontend, 'pollenReportedTypes');
  var data = { days: [
    { date: '2026-09-28', types: { TREE: { value: 1 }, GRASS: { value: 1 } } },
    { date: '2026-09-29', types: { TREE: { value: 2 }, GRASS: { value: 2 } } },
    { date: '2026-09-30', types: { GRASS: { value: 3 } } }
  ] };
  var context = { data: data, output: null };
  vm.runInNewContext(
    source + '\n' +
      'function d(x) { var r = pollenDayForToday(data, x); return r ? r.date : null; }\n' +
      'output = [' +
      'd(new Date(2026, 8, 28, 20)),' +
      'd(new Date(2026, 8, 29, 7)),' +     // cached overnight: must not show the 28th
      'd(new Date(2026, 8, 27, 12)),' +    // clock behind the forecast: next future day
      'd(new Date(2026, 9, 1, 9)),' +      // every day is past: no current forecast
      'pollenReportedTypes(data.days[0]).join(","),' +
      'pollenReportedTypes(null).length,' +
      'pollenTypeLabel("TREE", { regionCode: "AU" }),' +
      'pollenTypeLabel("TREE", { regionCode: "US" }),' +
      'pollenTypeLabel("GRASS", { regionCode: "AU" }),' +
      '!!pollenCoverageNote({ regionCode: "AU" }),' +
      'pollenCoverageNote({})' +
      '];',
    context
  );
  var expected = ['2026-09-28', '2026-09-29', '2026-09-28', null, 'GRASS,TREE', 0, 'Cypress', 'Tree', 'Grass', true, ''];
  if (JSON.stringify(context.output) !== JSON.stringify(expected)) {
    throwFail('pollen helpers changed behaviour: ' + JSON.stringify(context.output));
  }
  if (frontend.indexOf('lastPollenData.days[0]') !== -1) {
    throwFail('pollen card/ticker must use pollenDayForToday(), not days[0]');
  }
  console.log('Pollen helper tests passed');
}

// Weather feels-like (BOM apparent temperature with wind) for the top bar,
// dew point for the scrolling/fullscreen ticker.
function checkClimateHelpers(frontend) {
  var source = [extractFunction(frontend, 'getDewpointComfort'),
    extractFunction(frontend, 'apparentTempC'),
    extractFunction(frontend, 'weatherConditions'),
    extractFunction(frontend, 'climateStripDetail'),
    extractFunction(frontend, 'climateDew')].join('\n');
  var context = { out: null };
  vm.runInNewContext(source + '\n' +
    'out = {\n' +
    '  windMs: weatherConditions({current:{temperature_2m:20,relative_humidity_2m:50,dew_point_2m:9,wind_speed_10m:36}}).windMs,\n' +
    '  noWind: weatherConditions({current:{temperature_2m:20}}).windMs,\n' +
    '  empty: weatherConditions(null).temp,\n' +
    '  windChill: climateStripDetail({temp:20, humidity:50, windMs:10}),\n' +
    '  calmMuggy: climateStripDetail({temp:30, humidity:70, windMs:0}),\n' +
    '  neutral: climateStripDetail({temp:24, humidity:50, windMs:1}),\n' +
    '  missingWind: climateStripDetail({temp:30, humidity:70, windMs:null}),\n' +
    '  noTemp: climateStripDetail({temp:null, humidity:50, windMs:2}),\n' +
    '  dew: climateDew(17.6),\n' +
    '  dewNone: climateDew(null)\n' +
    '};', context);
  var expected = { windMs: 10, noWind: null, empty: null, windChill: 'feels 13°', calmMuggy: 'feels 36°',
    neutral: '', missingWind: '', noTemp: '', dew: { text: 'dew 18°', cls: 'dewpoint-uncomfortable' }, dewNone: null };
  if (JSON.stringify(context.out) !== JSON.stringify(expected)) {
    throwFail('climate helpers changed behaviour: ' + JSON.stringify(context.out));
  }
  console.log('Climate helper tests passed');
}

// Top-bar cards: one picker value "mode:placement" round-trips through config.
function checkStripPlacement(frontend) {
  var source = [extractFunction(frontend, 'stripPlacement'),
    extractFunction(frontend, 'isTickerDisplayMode'),
    extractFunction(frontend, 'stripChipInputs'),
    extractFunction(frontend, 'paintStripChips'),
    extractFunction(frontend, 'loadStripChips'),
    extractFunction(frontend, 'saveStripChips')].join('\n');
  var context = { out: null };
  // Fake chip groups: each "input" has value/checked and a parent label.
  vm.runInNewContext('function group() { var ins = ["card", "bar", "ticker", "banner"].map(function (v) { return { value: v, checked: false, parentNode: { className: "" } }; }); return { getElementsByTagName: function () { return ins; }, ins: ins }; }\n' +
    'var elements = { weatherDisplayMode: group(), pollenDisplayMode: group() };\n' +
    'var config = { weatherDisplayMode: "both", weatherPlacement: "bar", pollenDisplayMode: "card", pollenPlacement: "junk" };\n' +
    source + '\n' +
    'function state(id) { return elements[id + "DisplayMode"].ins.map(function (i) { return i.checked ? 1 : 0; }).join(""); }\n' +
    'loadStripChips("weather"); loadStripChips("pollen");\n' +
    'var r = [state("weather"), state("pollen"), stripPlacement("pollen"), elements.weatherDisplayMode.ins[0].parentNode.className];\n' +
    'var w = elements.weatherDisplayMode.ins; w[0].checked = false; w[1].checked = true; w[2].checked = true; w[3].checked = false;\n' +
    'saveStripChips("weather"); r.push(config.weatherDisplayMode, config.weatherPlacement);\n' +
    'w[0].checked = true; w[1].checked = false; w[2].checked = false; saveStripChips("weather"); r.push(config.weatherDisplayMode, config.weatherPlacement);\n' +
    'w[3].checked = true; saveStripChips("weather"); r.push(config.weatherDisplayMode, config.weatherPlacement);\n' +
    'out = r;', context);
  var expected = ['1100', '1000', 'bar', 'mode-chip on', 'ticker', 'both', 'card', 'both', 'banner', 'both'];
  if (JSON.stringify(context.out) !== JSON.stringify(expected)) {
    throwFail('strip placement helpers changed behaviour: ' + JSON.stringify(context.out));
  }
  var m = frontend.match(/var STRIP_PLACEMENT_CARDS = \[([^\]]*)\]/);
  if (!m) throwFail('STRIP_PLACEMENT_CARDS missing');
  var cards = m[1].replace(/['\s]/g, '').split(',');
  for (var i = 0; i < cards.length; i++) {
    if (frontend.indexOf('<span class="display-mode-chips" id="' + cards[i] + 'DisplayMode" data-card="' + cards[i] + '" role="group">') === -1) {
      throwFail(cards[i] + ' needs the Card/Bar/Ticker/Banner chip group');
    }
  }
  console.log('Strip placement tests passed');
}

try { checkBinHelpers(html); } catch (e) { fail('bin helpers: ' + e.message); }
try { checkPollenHelpers(html); } catch (e) { fail('pollen helpers: ' + e.message); }
try { checkClimateHelpers(html); } catch (e) { fail('climate helpers: ' + e.message); }
try { checkStripPlacement(html); } catch (e) { fail('strip placement: ' + e.message); }
try { checkDisplayModeTickerParity(html); } catch (e) { fail('display-mode parity: ' + e.message); }
try { checkCardOrderCompleteness(html); } catch (e) { fail('card order: ' + e.message); }
try { checkNeedsAttentionDismissal(html); } catch (e) { fail('needs attention dismissal: ' + e.message); }

run('iOS 12 compatibility', process.execPath, ['scripts/check-ios12-compat.js']);
run('Worker syntax', process.execPath, ['--check', 'src/worker.js']);

checkWorkerFetchDeadline(worker).catch(function(e) { fail('worker fetch deadline: ' + e.message); }).then(function() {
if (failures.length) {
  console.error('Project validation failed:');
  failures.forEach(function(message) { console.error('- ' + message); });
  process.exit(1);
}

console.log('Project validation passed (v' + versionMatch[1] + ').');
});
