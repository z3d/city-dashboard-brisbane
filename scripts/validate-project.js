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


// Client and Worker exercise done-log sanitisers must produce identical output,
// or every poll would see a client/server diff and PUT to KV (write-storm).
function checkExerciseSanitizerEquivalence(frontend, worker) {
  var now = Date.UTC(2026, 9, 14, 0, 0, 0);
  var day = 24 * 60 * 60 * 1000;
  var overLimit = {};
  for (var i = 0; i < 1005; i++) overLimit['s_' + i] = i < 1000 ? now - i : now + i;
  var fixtures = [null, [], { a: now, numeric_string: String(now - 1000), garbage: '123oops', inf: Infinity, old: now - 31 * day, fresh: now - 29 * day, long: now }, overLimit];
  fixtures[2][new Array(202).join('x')] = now;
  var frontSrc = extractBetween(frontend, 'function sanitiseExerciseDoneLog(', '\n      function mergeExerciseDoneLogs(', 'frontend exercise sanitiser');
  var workerSrc = extractBetween(worker, 'function sanitizeExerciseDoneLog(', '\nfunction isIsoTimestamp(', 'worker exercise sanitiser');
  for (var k = 0; k < fixtures.length; k++) {
    var fc = { input: fixtures[k], output: null, Date: { now: function() { return now; } } };
    vm.runInNewContext(frontSrc + '\noutput = sanitiseExerciseDoneLog(input);', fc);
    var wc = { input: fixtures[k], output: null, Date: { now: function() { return now; } } };
    vm.runInNewContext(workerSrc + '\noutput = sanitizeExerciseDoneLog(input);', wc);
    if (JSON.stringify(fc.output) !== JSON.stringify(wc.output)) throwFail('exercise sanitisers differ on fixture ' + k);
    if (k === 2 && Object.keys(fc.output).sort().join() !== 'a,fresh,long,numeric_string') throwFail('exercise sanitiser kept the wrong keys: ' + Object.keys(fc.output).join());
    if (k === 3 && Object.keys(fc.output).length !== 500) throwFail('exercise sanitiser must keep the newest 500');
  }
  console.log('Exercise sanitiser equivalence passed');
}

// Idempotent PUT: the fingerprint must cover the exercise log and definition.
function checkDashboardStatusFingerprint(worker) {
  var source = extractBetween(worker, 'const DASHBOARD_STATUS_KV_KEY', '\nconst ELECTRICITY_DISPATCH_DIR_URL', 'dashboard-status sanitiser + fingerprint');
  var context = { output: null };
  vm.runInNewContext(
    source + '\n' +
    'var a = sanitizeDashboardStatus({ updatedAt: "2026-09-01T00:00:00.000Z", bin: { dismissedDate: "2026-09-01" }, exerciseDone: { "B_evening_2026-09-01": Date.now() - 2000, "A_morning_2026-09-01": Date.now() - 1000 } });\n' +
    'var b = sanitizeDashboardStatus({ updatedAt: "2026-09-02T00:00:00.000Z", exerciseDone: { "A_morning_2026-09-01": a.exerciseDone["A_morning_2026-09-01"], "B_evening_2026-09-01": a.exerciseDone["B_evening_2026-09-01"] }, bin: { dismissedDate: "2026-09-01" } });\n' +
    'var c = sanitizeDashboardStatus({ bin: { dismissedDate: "2026-09-01" }, exerciseDone: a.exerciseDone, exerciseDef: { updatedAt: "2026-09-01T00:00:00.000Z", exercises: [{ name: "Walk", period: "anytime" }] } });\n' +
    'output = { same: dashboardStatusFingerprint(a) === dashboardStatusFingerprint(b), defDiffers: dashboardStatusFingerprint(a) !== dashboardStatusFingerprint(c), kept: Object.keys(a.exerciseDone).length === 2,' +
    ' newer: pickNewerDef({ updatedAt: "2026-09-01T00:00:00.000Z", x: 1 }, { updatedAt: "2026-09-02T00:00:00.000Z", x: 2 }).x };',
    context
  );
  var out = context.output;
  if (!out || out.same !== true || out.defDiffers !== true || out.kept !== true || out.newer !== 2) {
    throwFail('dashboard-status fingerprint behaviour changed: ' + JSON.stringify(out));
  }
  console.log('Dashboard-status fingerprint tests passed');
}

// Exercise card: one row list (getExerciseRows) feeds the card, visibility,
// ticker and Needs Attention, so pin the window/state rules and the streak here.
function checkExerciseHelpers(frontend, worker) {
  var helpers = extractBetween(frontend, 'var EXERCISE_PERIODS =', '\n      function renderExerciseRow(', 'exercise helpers');
  var daysNorm = extractBetween(frontend, 'function normaliseExerciseDaysForCompare(', '\n      function normaliseExercisesForCompare(', 'exercise days normaliser');
  var context = { config: { exerciseMorningStart: '05:00', exerciseEveningStart: '16:30', exercises: [], exerciseShowHistory: true }, output: null };
  vm.runInNewContext(
    'function parseClockTimeToMin(t, fb) { var p = t.split(":"); return parseInt(p[0], 10) * 60 + parseInt(p[1], 10); }\n' +
      'function getLocalDateStr(d) { return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }\n' +
      daysNorm + '\n' + helpers + '\n' +
      'var wed10 = new Date(2026, 9, 14, 10, 0, 0, 0);\n' + // Wednesday
      'var wed17 = new Date(2026, 9, 14, 17, 0, 0, 0);\n' +
      'var wed4 = new Date(2026, 9, 14, 4, 0, 0, 0);\n' +
      'config.exercises = [' +
      '{name: "Walk", period: "anytime", type: "walk"},' +
      '{name: "Stretch", period: "both", type: "stretch"},' +
      '{name: "Run", period: "morning", days: [1, 3, 5]},' +
      '{name: "Swim", period: "morning", days: [1, 5]},' +
      '{name: "Paused", period: "anytime", suspended: true},' +
      '{name: "New", period: "morning", trackingStart: new Date(2026, 9, 14, 11, 0, 0, 0).toISOString()}' +
      '];\n' +
      'function states(rows) { return rows.map(function(r) { return r.ex.name + ":" + r.period + ":" + r.state + (r.state === "open" ? ":" + r.closesInMin : "") + (r.state === "rest" ? ":" + r.nextDay : ""); }); }\n' +
      'var doneLog = {"Walk_anytime_2026-10-14": 1, "Walk_anytime_2026-10-13": 1, "Walk_anytime_2026-10-12": 1, "Walk_anytime_2026-10-11": 1,' +
      ' "Run_morning_2026-10-12": 1, "Run_morning_2026-10-09": 1, "Stretch_morning_2026-10-13": 1, "Stretch_evening_2026-10-13": 1, "Stretch_morning_2026-10-12": 1,' +
      ' "Stretch_evening_2026-10-14_skipped": 1, "Walk_anytime_2026-10-14_skipped": 2};\n' +
      'output = {' +
      'at10: states(getExerciseRows(wed10, {})),' +
      'at17: states(getExerciseRows(wed17, {})),' +
      'at4: states(getExerciseRows(wed4, {})),' +
      'doneRow: getExerciseRows(wed17, doneLog)[0].state,' +
      'skippedOpen: states([getExerciseRows(wed17, doneLog)[2]]).concat([getExerciseRows(wed17, doneLog)[2].closesInMin]),' + // skipped inside its window keeps closesInMin for the take-back Done
      'skippedClosed: getExerciseRows(wed4, {"Stretch_morning_2026-10-14_skipped": 1})[1].state + ":" + getExerciseRows(wed4, {"Stretch_morning_2026-10-14_skipped": 1})[1].closesInMin,' +
      'doneBeatsSkipped: getExerciseRows(wed17, doneLog)[0].state,' + // Walk is both done and skipped today: done wins
      'skipBreaksStreak: getExerciseStreak(config.exercises[0], {"Walk_anytime_2026-10-14": 1, "Walk_anytime_2026-10-13_skipped": 1, "Walk_anytime_2026-10-12": 1}, wed10),' +
      'skipTodayKeepsStreak: getExerciseStreak(config.exercises[0], {"Walk_anytime_2026-10-14_skipped": 1, "Walk_anytime_2026-10-13": 1, "Walk_anytime_2026-10-12": 1}, wed10),' +
      'skipKey: getExerciseSkipKey("Walk", "anytime", "2026-10-14"),' +
      'skipDot: /skipped/.test(buildExerciseHistoryStrip(config.exercises[1], "evening", doneLog, wed17)),' +
      'walkStreak: getExerciseStreak(config.exercises[0], doneLog, wed10),' +
      'walkStreakPendingToday: getExerciseStreak(config.exercises[0], {"Walk_anytime_2026-10-13": 1, "Walk_anytime_2026-10-12": 1}, wed10),' +
      'runStreak: getExerciseStreak(config.exercises[2], doneLog, wed10),' +
      'stretchStreak: getExerciseStreak(config.exercises[1], doneLog, wed10),' +
      'pausedStreak: getExerciseStreak(config.exercises[4], doneLog, wed10),' +
      'labels: [getExerciseDaysLabel({}), getExerciseDaysLabel({days: [1, 2, 3, 4, 5]}), getExerciseDaysLabel({days: [0, 6]}), getExerciseDaysLabel({days: [3, 1, 5]}), getExerciseDaysLabel({days: [0, 1, 2, 3, 4, 5, 6]})],' +
      'strip: (buildExerciseHistoryStrip(config.exercises[2], "morning", doneLog, wed10).match(/<span/g) || []).length,' +
      'withIds: (function() { config.exercises = [{id: "aaaa1111", name: "Walk", period: "morning", type: "walk"}, {id: "bbbb2222", name: "Walk", period: "morning", type: "walk"}, {id: "cccc3333", name: "Renamed", period: "anytime"}];' +
      ' var idLog = {"aaaa1111_morning_2026-10-14": 1, "Renamed_anytime_2026-10-14_skipped": 1, "Walk_morning_2026-10-14_skipped": 1, "Renamed_anytime_2026-10-13": 1};' +
      ' var rows = getExerciseRows(wed10, idLog); return states(rows).concat([rows[0].key, getExerciseStreak(config.exercises[2], idLog, wed10)]); })()' +
      '};',
    context
  );
  var expected = {
    at10: ['Walk:anytime:open:840', 'Stretch:morning:open:390', 'Stretch:evening:later', 'Run:morning:open:390', 'Swim:morning:rest:5', 'Paused:anytime:suspended', 'New:morning:untracked'],
    at17: ['Walk:anytime:open:420', 'Stretch:morning:missed', 'Stretch:evening:open:420', 'Run:morning:missed', 'Swim:morning:rest:5', 'Paused:anytime:suspended', 'New:morning:untracked'],
    at4: ['Walk:anytime:later', 'Stretch:morning:later', 'Stretch:evening:later', 'Run:morning:later', 'Swim:morning:rest:5', 'Paused:anytime:suspended', 'New:morning:untracked'],
    doneRow: 'done',
    skippedOpen: ['Stretch:evening:skipped', 420],
    skippedClosed: 'skipped:0',
    doneBeatsSkipped: 'done',
    skipBreaksStreak: 1, // today done; yesterday skipped ends it
    skipTodayKeepsStreak: 2, // today skipped is still "in progress" until tomorrow
    skipKey: 'Walk_anytime_2026-10-14_skipped',
    skipDot: true,
    walkStreak: 4, // today + 3 days
    walkStreakPendingToday: 2, // today still open does not break it
    runStreak: 2, // Mon 12 + Fri 9; Wed 7 missed; non-scheduled days skipped
    stretchStreak: 1, // Tue both done; Mon evening missing
    pausedStreak: 0,
    labels: ['Every day', 'Weekdays', 'Weekends', 'Mon Wed Fri', 'Every day'],
    strip: 7,
    // Two "Walk"s: the first is done under its own id, the second is only
    // skipped via the legacy name key (written before ids existed) and stays
    // independent; the renamed item still sees its name-keyed skip and streak day.
    withIds: ['Walk:morning:done', 'Walk:morning:skipped', 'Renamed:anytime:skipped', 'aaaa1111_morning_2026-10-14', 1]
  };
  if (JSON.stringify(context.output) !== JSON.stringify(expected)) {
    fail('exercise window/state or streak rules changed: ' + JSON.stringify(context.output));
  }
  if (frontend.indexOf("addExerciseSettingsRow({period: 'morning', trackingStart: new Date().toISOString()})") === -1) {
    fail('new exercises do not start tracking from their creation time');
  }
  if (frontend.indexOf('window.skipExerciseAt = skipExerciseAt;') === -1) fail('skipExerciseAt is not exposed for the card button');

  var workerSource = 'const APPLE_HEALTH_MAX_STEPS = 200000;\n' + extractBetween(worker, 'function isIsoTimestamp(', '\nfunction pickNewerDef', 'Worker exercise definition sanitizer');
  var workerContext = { output: null };
  vm.runInNewContext(
    workerSource + '\n' +
      'output = sanitizeExerciseDef({updatedAt: "2026-10-14T00:00:00.000Z", morningStart: "06:00", eveningStart: "bad", exercises: [' +
      '{name: "  Walk ", id: "ab12cd34", period: "anytime", type: "other", target: "  ", days: [0, 1, 2, 3, 4, 5, 6]},' +
      '{name: "Run", id: "BAD-ID", period: "nope", type: "cardio", target: "20 min", days: [5, 1, 1, 9, "3", 3], suspended: true, trackingStart: "2026-10-14T01:00:00.000Z", stepGoal: "-5"},' +
      '{name: "Steps", period: "both", type: "walk", stepGoal: 8000.4}, {name: "Big", period: "morning", type: "walk", stepGoal: 999999}, {name: "Lift", period: "morning", type: "strength", stepGoal: 5000},' +
      '{name: "", period: "morning"}, null]});',
    workerContext
  );
  var workerExpected = {
    exercises: [
      { name: 'Walk', period: 'anytime', id: 'ab12cd34' },
      { name: 'Run', period: 'anytime', type: 'cardio', target: '20 min', days: [1, 3, 5], suspended: true, trackingStart: '2026-10-14T01:00:00.000Z' },
      { name: 'Steps', period: 'both', type: 'walk', stepGoal: 8000 },
      { name: 'Big', period: 'morning', type: 'walk' },
      { name: 'Lift', period: 'morning', type: 'strength' }
    ],
    morningStart: '06:00',
    eveningStart: '16:30',
    updatedAt: '2026-10-14T00:00:00.000Z'
  };
  if (JSON.stringify(workerContext.output) !== JSON.stringify(workerExpected)) {
    fail('Worker exercise definition sanitizer changed: ' + JSON.stringify(workerContext.output));
  }
  console.log('Exercise helper tests passed');
}

// The phone app (public/exercise.html) embeds the card's shared block verbatim;
// scripts/sync-exercise-app.js --check (run below) catches drift. Here: syntax,
// a semver version and the "PUT only pending taps" rule.
function checkExercisePhoneApp() {
  var app = fs.readFileSync(path.join(root, 'public', 'exercise.html'), 'utf8');
  var scripts = app.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (var s = 0; s < scripts.length; s++) {
    var code = scripts[s].replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
    try { new Function(code); } catch (e) { throwFail('public/exercise.html script ' + (s + 1) + ': ' + e.message); }
  }
  if (!/<meta name="app-version" content="\d+\.\d+\.\d+">/.test(app)) throwFail('public/exercise.html needs a semver app-version meta');
  if (!/'\/api\/dashboard-status', \{ exerciseDone: pending \}/.test(app)) throwFail('the phone app must PUT only its pending exerciseDone entries');
  console.log('Exercise phone app checks passed');
}

// The Apple Health push endpoint trusts nothing from the phone: bad dates,
// negative/oversized counts and unknown shapes are dropped, both payload
// dialects (Shortcut and Health Auto Export) parse, and retention prunes.
function checkAppleHealthPush(worker, frontend) {
  var consts = extractBetween(worker, 'const APPLE_HEALTH_KV_KEY', '\nfunction brisbaneDateStr', 'APPLE_HEALTH constants');
  var fns = extractBetween(worker, 'function brisbaneDateStr(', '\nfunction isDashboardStatusDate', 'Apple Health helpers');
  var context = {};
  vm.createContext(context);
  vm.runInContext(consts + '\n' + fns +
    '\nthis.parse = parseAppleHealthPush; this.sanitize = sanitizeAppleHealthRecord; this.bris = brisbaneDateStr; this.goalKeys = exerciseStepGoalKeys; this.goalOf = exerciseStepGoalOf; this.bp = parseAppleHealthBp;', context);
  // 2026-10-18 09:00 Brisbane
  var now = Date.parse('2026-10-17T23:00:00Z');
  var today = context.bris(now);
  if (today !== '2026-10-18') throwFail('brisbaneDateStr should give the Brisbane calendar date, got ' + today);

  var simple = context.parse({ steps: '7,842 count' }, now);
  if (simple.length !== 1 || simple[0].steps !== 7842 || simple[0].date !== '2026-10-18') throwFail('Shortcut payload with a formatted count should parse to today, got ' + JSON.stringify(simple));
  if (context.parse({ steps: 500, date: '2026-10-25' }, now).length !== 0) throwFail('a date a week in the future must be rejected');
  if (context.parse({ steps: 500, date: '2026-09-01' }, now).length !== 0) throwFail('a date outside the retention window must be rejected');
  if (context.parse({ steps: -5 }, now).length !== 0) throwFail('negative steps must be rejected');
  if (context.parse({ steps: 999999 }, now).length !== 0) throwFail('absurd step counts must be rejected');
  if (context.parse({ hello: 'world' }, now).length !== 0 || context.parse('x', now).length !== 0 || context.parse(null, now).length !== 0) throwFail('unknown payload shapes must parse to nothing');
  // Whatever Shortcuts ends up sending: capitalised key, a one-item list, a
  // list of samples, a nested value, a bare number/string body, a form field.
  var looseCases = [
    [{ Steps: '7,842' }, 7842],
    [{ steps: ['7842 count'] }, 7842],
    [{ steps: [{ value: 3000 }, { value: 2000.4 }] }, 5000],
    [{ step_count: { qty: 1234 } }, 1234],
    [{ 'Step Count': 999 }, 999],
    [7842, 7842],
    ['7842', 7842],
    [{ steps: '7842', Date: '2026-10-17' }, 7842]
  ];
  for (var lc = 0; lc < looseCases.length; lc++) {
    var lr = context.parse(looseCases[lc][0], now);
    if (lr.length !== 1 || lr[0].steps !== looseCases[lc][1]) throwFail('loose payload ' + JSON.stringify(looseCases[lc][0]) + ' should give ' + looseCases[lc][1] + ', got ' + JSON.stringify(lr));
  }
  if (context.parse({ steps: '7842', Date: '2026-10-17' }, now)[0].date !== '2026-10-17') throwFail('a capitalised Date field must still set the day');
  var blankDate = context.parse({ systolic: '', steps: '30', diastolic: '', date: '' }, now);
  if (blankDate.length !== 1 || blankDate[0].steps !== 30 || blankDate[0].date !== '2026-10-18') throwFail('a blank date field must not drop the steps (seen live), got ' + JSON.stringify(blankDate));
  if (context.parse({ steps: 30, date: '18 Oct 2026 at 1:27 pm' }, now)[0].date !== '2026-10-18') throwFail('a Shortcut-formatted date on steps must reduce to the Brisbane day');
  if (context.parse({ steps: 'no number here' }, now).length !== 0 || context.parse({ steps: [] }, now).length !== 0) throwFail('non-numeric step values must still be rejected');

  // Blood pressure: Shortcut text, two-line text, explicit fields, Health Auto
  // Export, nested under bp, implausible pairs rejected, stamped now when undated.
  var bpCases = [
    [{ bp: '120/80 mmHg' }, [[120, 80]]],
    [{ bp: '128/84 mmHg\n122/79 mmHg' }, [[128, 84], [122, 79]]],
    [{ 'Blood Pressure': 'Systolic: 118 Diastolic: 76' }, [[118, 76]]],
    [{ systolic: 135, diastolic: 88, pulse: 64 }, [[135, 88]]],
    [{ systolic: '128 mmHg', diastolic: '84 mmHg' }, [[128, 84]]],
    [{ steps: '30', dias: '84 mmHg', sys: '128 mmHg' }, [[128, 84]]],
    [{ steps: '30', dias: '', sys: '' }, []],
    [{ Systolic: ['126 mmHg'], Diastolic: ['82 mmHg'], date: '2026-10-18T02:30:00Z' }, [[126, 82]]],
    [{ bp: { sys: '117', dia: '75' } }, [[117, 75]]],
    [{ data: { metrics: [{ name: 'blood_pressure', data: [{ date: '2026-10-17 08:00:00 +1000', systolic: 121, diastolic: 81 }] }] } }, [[121, 81]]],
    [{ bp: '80/120' }, [[120, 80]]],
    [{ diastolic: '120', systolic: '80' }, [[120, 80]]],
    [{ bp: '400/80' }, []],
    [{ steps: 7842 }, []],
    [{ hello: 'world' }, []]
  ];
  for (var bc = 0; bc < bpCases.length; bc++) {
    var br = context.bp(bpCases[bc][0], now).map(function(r) { return [r.sys, r.dia]; });
    if (JSON.stringify(br) !== JSON.stringify(bpCases[bc][1])) throwFail('bp payload ' + JSON.stringify(bpCases[bc][0]) + ' should give ' + JSON.stringify(bpCases[bc][1]) + ', got ' + JSON.stringify(br));
  }
  var bpPulse = context.bp({ systolic: 135, diastolic: 88, pulse: 64 }, now)[0];
  if (bpPulse.pulse !== 64 || bpPulse.t !== now) throwFail('pulse must be kept and an undated reading stamped with the push time');
  var bpDated = context.bp({ data: { metrics: [{ name: 'blood_pressure', data: [{ date: '2026-10-17 08:00:00 +1000', systolic: 121, diastolic: 81 }] }] } }, now)[0];
  if (bpDated.t !== Date.parse('2026-10-16T22:00:00Z')) throwFail('a Health Auto Export date with a +1000 offset must parse to the right instant, got ' + bpDated.t);
  // The reading's own date, as Shortcuts renders Start Date on an Australian phone.
  var bpDates = [
    [{ systolic: '128 mmHg', diastolic: '84 mmHg', date: '19 Jul 2026 at 8:15 am' }, Date.parse('2026-07-18T22:15:00Z')],
    [{ systolic: 128, diastolic: 84, date: '19/07/2026, 8:15 pm' }, Date.parse('2026-07-19T10:15:00Z')],
    [{ systolic: 128, diastolic: 84, date: 'Jul 19 2026 12:05 am' }, Date.parse('2026-07-18T14:05:00Z')],
    [{ systolic: 128, diastolic: 84, date: '2026-07-19T08:15:00+10:00' }, Date.parse('2026-07-18T22:15:00Z')],
    [{ systolic: 128, diastolic: 84, date: ['19 Jul 2026 at 8:15 am'] }, Date.parse('2026-07-18T22:15:00Z')],
    [{ systolic: 128, diastolic: 84, date: 'yesterday-ish' }, now]
  ];
  for (var bd = 0; bd < bpDates.length; bd++) {
    var got = context.bp(bpDates[bd][0], now)[0].t;
    if (got !== bpDates[bd][1]) throwFail('bp date ' + JSON.stringify(bpDates[bd][0].date) + ' should be ' + bpDates[bd][1] + ', got ' + got);
  }
  var bpRec = context.sanitize({ bp: [{ t: now - 5000, sys: 120, dia: 80 }, { t: now, sys: 125, dia: 82, pulse: 70 }, { t: now, sys: 50, dia: 80 }, 'junk'] }, now);
  if (bpRec.bp.length !== 2 || bpRec.bp[0].sys !== 125 || bpRec.bp[0].pulse !== 70) throwFail('sanitised bp must drop junk and sort newest first, got ' + JSON.stringify(bpRec.bp));
  // Steps and blood pressure may arrive in one body.
  if (context.parse({ steps: 5000, bp: '120/80' }, now).length !== 1 || context.bp({ steps: 5000, bp: '120/80' }, now).length !== 1) throwFail('a combined steps + bp body must yield both');
  var hae = context.parse({ data: { metrics: [
    { name: 'heart_rate', data: [{ date: '2026-10-18 08:00:00 +1000', qty: 60 }] },
    { name: 'step_count', units: 'count', data: [{ date: '2026-10-17 00:00:00 +1000', qty: 9120.4 }, { date: '2026-10-18 00:00:00 +1000', qty: 1200 }] }
  ] } }, now);
  if (hae.length !== 2 || hae[0].date !== '2026-10-17' || hae[0].steps !== 9120 || hae[1].steps !== 1200) throwFail('Health Auto Export payload should yield one entry per day of step_count only, got ' + JSON.stringify(hae));

  var rec = context.sanitize({ updatedAt: now - 1000, days: {
    '2026-10-18': { steps: 1200, at: now - 1000 },
    '2026-10-01': { steps: 5000, at: now - 17 * 86400000 },
    'garbage': { steps: 1, at: now },
    '2026-10-17': { steps: 'NaN', at: now },
    '2026-10-16': { steps: 8000.6, at: now - 2 * 86400000 }
  } }, now);
  var keys = Object.keys(rec.days).sort();
  if (keys.join(',') !== '2026-10-16,2026-10-18') throwFail('sanitizeAppleHealthRecord should prune old/invalid days, kept ' + keys.join(','));
  if (rec.days['2026-10-16'].steps !== 8001) throwFail('stored steps should be rounded integers');
  if (context.sanitize(null, now).updatedAt !== null || Object.keys(context.sanitize(undefined, now).days).length !== 0) throwFail('an empty KV record must sanitise to an empty day map');

  // Step goals -> done keys. 2026-10-18 is a Sunday (weekday 0).
  var def = { morningStart: '05:00', eveningStart: '16:30', exercises: [
    { name: 'Walk', period: 'anytime', type: 'walk', stepGoal: 8000 },
    { name: 'Both', period: 'both', type: 'walk', stepGoal: 5000 },
    { name: 'Weekday', period: 'morning', type: 'walk', stepGoal: 1000, days: [1, 2, 3, 4, 5] },
    { name: 'Paused', period: 'anytime', type: 'walk', stepGoal: 1000, suspended: true },
    { name: 'New', period: 'evening', type: 'walk', stepGoal: 1000, trackingStart: '2026-10-18T05:00:00.000Z' },
    { name: 'NewMorning', period: 'both', type: 'walk', stepGoal: 1000, trackingStart: '2026-10-18T05:00:00.000Z' },
    { name: 'Old', period: 'evening', type: 'walk', stepGoal: 1000, trackingStart: '2026-10-17T05:00:00.000Z' },
    { name: 'Run', period: 'anytime', type: 'cardio', stepGoal: 1000 },
    { name: 'NoGoal', period: 'anytime', type: 'walk' }
  ] };
  var got = context.goalKeys(def, '2026-10-18', 6000).sort().join('|');
  // 'New' was added 15:00 Brisbane: its evening window (16:30) is tracked that day, 'NewMorning''s morning window (05:00) is not.
  var want = ['Both_evening_2026-10-18', 'Both_morning_2026-10-18', 'NewMorning_evening_2026-10-18', 'New_evening_2026-10-18', 'Old_evening_2026-10-18'].join('|');
  if (got !== want) throwFail('step-goal keys at 6000 steps on a Sunday should be ' + want + ', got ' + got);
  if (context.goalKeys(def, '2026-10-18', 8000).indexOf('Walk_anytime_2026-10-18') === -1) throwFail('reaching the goal exactly must count');
  if (context.goalKeys(def, '2026-10-19', 1500).indexOf('Weekday_morning_2026-10-19') === -1) throwFail('a weekday-only exercise must complete on Monday');
  if (context.goalKeys(def, '2026-10-18', 6000).join('|').indexOf('Run_') !== -1) throwFail('a step goal on a non-walk exercise must be ignored');

  // A numeric Target on a walk is the goal when no explicit stepGoal is set —
  // and the frontend's getExerciseStepGoal must agree with the worker on every case.
  var feCtx = {};
  vm.createContext(feCtx);
  vm.runInContext(extractFunction(frontend, 'getExerciseStepGoal') + '\nthis.goalOf = getExerciseStepGoal;', feCtx);
  var goalCases = [
    [{ type: 'walk', target: '10000' }, 10000],
    [{ type: 'walk', target: ' 10,000 ' }, 10000],
    [{ type: 'walk', target: '10 000 steps' }, 10000],
    [{ type: 'walk', target: '5k' }, 5000],
    [{ type: 'walk', target: '7.5K steps' }, 7500],
    [{ type: 'walk', target: '2000', stepGoal: 3000 }, 3000],
    [{ type: 'walk', target: '20 min' }, 0],
    [{ type: 'walk', target: '2 sets of 10' }, 0],
    [{ type: 'walk', target: '999999' }, 0],
    [{ type: 'strength', target: '10000' }, 0],
    [{ type: 'strength', stepGoal: 5000 }, 0],
    [{ target: '10000' }, 0],
    [null, 0]
  ];
  for (var gc = 0; gc < goalCases.length; gc++) {
    var w = context.goalOf(goalCases[gc][0]);
    var f = feCtx.goalOf(goalCases[gc][0]);
    if (w !== goalCases[gc][1] || f !== goalCases[gc][1]) throwFail('step goal for ' + JSON.stringify(goalCases[gc][0]) + ' should be ' + goalCases[gc][1] + ' (worker ' + w + ', frontend ' + f + ')');
  }
  var targetDef = { exercises: [{ name: 'Walk 10k', period: 'morning', type: 'walk', target: '10000' }, { name: 'Squats', period: 'anytime', type: 'strength', target: '10000' }] };
  if (context.goalKeys(targetDef, '2026-10-18', 10000).join('|') !== 'Walk 10k_morning_2026-10-18') throwFail('a walk whose Target is a number must auto-complete from it (and a strength item must not)');
  var idDef = { exercises: [
    { id: 'aaaa1111', name: 'Walk', period: 'morning', type: 'walk', stepGoal: 1000 },
    { id: 'bbbb2222', name: 'Walk', period: 'morning', type: 'walk', stepGoal: 3000 }
  ] };
  if (context.goalKeys(idDef, '2026-10-18', 2000).join('|') !== 'aaaa1111_morning_2026-10-18') throwFail('two walks sharing a name must complete independently by id');
  if (context.goalKeys(idDef, '2026-10-18', 2000, { 'Walk_morning_2026-10-18': 1 }).length !== 0) throwFail('a legacy name-keyed done entry must suppress the id-keyed auto-done for that row');
  if (context.goalKeys(idDef, '2026-10-18', 5000, { 'aaaa1111_morning_2026-10-18': 1 }).join('|') !== 'bbbb2222_morning_2026-10-18') throwFail('an already-done id row must not be written again');
  if (context.goalKeys(def, '2026-10-18', 0).length !== 0 || context.goalKeys(null, '2026-10-18', 9999).length !== 0 || context.goalKeys(def, 'nope', 9999).length !== 0) throwFail('no steps, no def or a bad date must yield no keys');
  // The frontend's row key shape must stay identical or auto-done lands on nothing.
  if (!/function getExerciseDoneKey\(name, period, date\) \{\s*return name \+ '_' \+ period \+ '_' \+ date;/.test(frontend)) throwFail('getExerciseDoneKey changed shape; update exerciseStepGoalKeys in the worker to match');
  console.log('Apple Health push parsing and step-goal keys passed');
}


try { checkBinHelpers(html); } catch (e) { fail('bin helpers: ' + e.message); }
try { checkExerciseSanitizerEquivalence(html, worker); } catch (e) { fail('exercise sanitisers: ' + e.message); }
try { checkDashboardStatusFingerprint(worker); } catch (e) { fail('dashboard-status fingerprint: ' + e.message); }
try { checkExerciseHelpers(html, worker); } catch (e) { fail('exercise helpers: ' + e.message); }
try { checkExercisePhoneApp(); } catch (e) { fail('exercise phone app: ' + e.message); }
try { checkAppleHealthPush(worker, html); } catch (e) { fail('apple health push: ' + e.message); }
try { checkPollenHelpers(html); } catch (e) { fail('pollen helpers: ' + e.message); }
try { checkClimateHelpers(html); } catch (e) { fail('climate helpers: ' + e.message); }
try { checkStripPlacement(html); } catch (e) { fail('strip placement: ' + e.message); }
try { checkDisplayModeTickerParity(html); } catch (e) { fail('display-mode parity: ' + e.message); }
try { checkCardOrderCompleteness(html); } catch (e) { fail('card order: ' + e.message); }
try { checkNeedsAttentionDismissal(html); } catch (e) { fail('needs attention dismissal: ' + e.message); }

run('iOS 12 compatibility', process.execPath, ['scripts/check-ios12-compat.js']);
run('iOS 12 compatibility (phone app)', process.execPath, ['scripts/check-ios12-compat.js', 'public/exercise.html']);
// Runtime: boot both pages in jsdom and fail on any uncaught exception.
run('Boot smoke test', process.execPath, ['scripts/check-boot.js']);
run('Exercise phone app shared block', process.execPath, ['scripts/sync-exercise-app.js', '--check']);
run('Worker syntax', process.execPath, ['--check', 'src/worker.js']);

checkWorkerFetchDeadline(worker).catch(function(e) { fail('worker fetch deadline: ' + e.message); }).then(function() {
if (failures.length) {
  console.error('Project validation failed:');
  failures.forEach(function(message) { console.error('- ' + message); });
  process.exit(1);
}

console.log('Project validation passed (v' + versionMatch[1] + ').');
});
