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

run('iOS 12 compatibility', process.execPath, ['scripts/check-ios12-compat.js']);
run('Worker syntax', process.execPath, ['--check', 'src/worker.js']);

if (failures.length) {
  console.error('Project validation failed:');
  failures.forEach(function(message) { console.error('- ' + message); });
  process.exit(1);
}

console.log('Project validation passed (v' + versionMatch[1] + ').');
