#!/usr/bin/env node
// Boot smoke test: load a page in jsdom, let init() run with the network
// stubbed to fail fast (an offline screen), and fail on any uncaught
// exception. This catches what the syntax and iOS 12 checks cannot: a call
// to a function that does not exist, a missing element id, a bad default —
// the class of bug that bricks every wall screen on the next auto-update.
//
// Usage: node scripts/check-boot.js [index.html] [public/exercise.html]
// Requires `npm ci` (jsdom). Runs inside validate-project.js.
'use strict';

var fs = require('fs');
var path = require('path');

var repoRoot = path.resolve(__dirname, '..');
var SETTLE_MS = 1500; // long enough for XHR callbacks and first timers to fire

var jsdom;
try {
  jsdom = require('jsdom');
} catch (e) {
  console.error('check-boot: jsdom is not installed — run `npm ci` in the repo root.');
  process.exit(1);
}

function installNetworkStubs(window) {
  // Every request completes asynchronously with status 0, which is what a
  // screen sees when the worker is unreachable. The frontend's XHR prototype
  // wrapper (timeout + same-URL dedup) patches this class like the real one.
  function MockXHR() {
    this.readyState = 0;
    this.status = 0;
    this.responseText = '';
    this._listeners = {};
    window.__bootRequests++;
  }
  MockXHR.prototype.open = function(method, url) { this.method = method; this.url = url; this.readyState = 1; };
  MockXHR.prototype.setRequestHeader = function() {};
  MockXHR.prototype.getResponseHeader = function() { return null; };
  MockXHR.prototype.abort = function() {};
  MockXHR.prototype.addEventListener = function(name, fn) {
    (this._listeners[name] || (this._listeners[name] = [])).push(fn);
  };
  MockXHR.prototype.removeEventListener = function() {};
  MockXHR.prototype.send = function() {
    var self = this;
    window.setTimeout(function() {
      self.readyState = 4;
      if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
      ['error', 'loadend'].forEach(function(name) {
        (self._listeners[name] || []).forEach(function(fn) { fn.call(self); });
        if (typeof self['on' + name] === 'function') self['on' + name]();
      });
    }, 0);
  };
  window.__bootRequests = 0;
  window.XMLHttpRequest = MockXHR;
  window.fetch = function() { return Promise.reject(new Error('network disabled in boot test')); };
}

// Seed localStorage so init() goes past the "no worker configured" state:
// the dashboard gets a worker URL, a token and every card switched on (keys
// read from its own config defaults, so a new card is covered automatically);
// the phone app gets a token. Nothing here reaches a real network.
var SEEDS = {
  'index.html': function(window, html) {
    var seed = { busProxyUrl: 'https://dashboard.test', dashboardToken: 'boot-test' };
    var flags = html.match(/^\s+(show[A-Za-z0-9]+): (?:true|false),?$/gm) || [];
    flags.forEach(function(line) { seed[line.trim().split(':')[0]] = true; });
    window.localStorage.setItem('brisbane_config', JSON.stringify(seed));
  },
  'public/exercise.html': function(window) {
    window.localStorage.setItem('exerciseApp_token', 'boot-test');
  }
};

function bootPage(relPath) {
  var file = path.resolve(repoRoot, relPath);
  var html = fs.readFileSync(file, 'utf8');
  var errors = [];
  var notImplemented = {};
  var seed = SEEDS[relPath] || SEEDS[path.relative(repoRoot, file)] || SEEDS['index.html'];

  var virtualConsole = new jsdom.VirtualConsole();
  virtualConsole.on('jsdomError', function(err) {
    var msg = String(err && err.message || err);
    // jsdom gaps (window.scrollTo, layout) are not app bugs; count, don't fail.
    if (msg.indexOf('Not implemented:') === 0) { notImplemented[msg] = (notImplemented[msg] || 0) + 1; return; }
    errors.push(err);
  });

  var dom = new jsdom.JSDOM(html, {
    url: 'https://dashboard.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: virtualConsole,
    beforeParse: function(window) {
      installNetworkStubs(window);
      seed(window, html);
    }
  });

  return new Promise(function(resolve) {
    setTimeout(function() {
      var requests = dom.window.__bootRequests;
      var scriptsRan = typeof dom.window.init === 'function' || requests > 0;
      dom.window.close();
      resolve({ path: relPath, errors: errors, requests: requests, scriptsRan: scriptsRan, notImplemented: notImplemented });
    }, SETTLE_MS);
  });
}

var targets = process.argv.slice(2);
if (!targets.length) targets = ['index.html', 'public/exercise.html'];

Promise.all(targets.map(bootPage)).then(function(results) {
  var failed = false;
  results.forEach(function(r) {
    var gaps = Object.keys(r.notImplemented);
    if (r.errors.length) {
      failed = true;
      console.error('Boot smoke test FAILED for ' + r.path + ': ' + r.errors.length + ' uncaught error(s)');
      r.errors.forEach(function(err, i) {
        var detail = err && err.detail && err.detail.stack ? err.detail.stack : (err && err.stack ? err.stack : String(err));
        console.error('  [' + (i + 1) + '] ' + detail.split('\n').slice(0, 6).join('\n      '));
      });
    } else if (r.requests === 0) {
      // A page that made no requests almost certainly never reached init().
      failed = true;
      console.error('Boot smoke test FAILED for ' + r.path + ': init made no network requests — did the scripts run?');
    } else {
      console.log('Boot smoke test passed for ' + r.path + ' (' + r.requests + ' requests stubbed' +
        (gaps.length ? ', jsdom gaps ignored: ' + gaps.map(function(g) { return g.replace('Not implemented: ', ''); }).join(', ') : '') + ')');
    }
  });
  process.exit(failed ? 1 : 0);
}).catch(function(e) {
  console.error('Boot smoke test crashed: ' + (e && e.stack || e));
  process.exit(1);
});
