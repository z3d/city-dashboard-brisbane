#!/usr/bin/env node
// Copies the Exercise card's shared logic block from index.html into the phone
// app (public/exercise.html) so both render the same rows from the same
// rules. validate-project.js fails when the two drift; run this to resync.
//
//   node scripts/sync-exercise-app.js          # rewrite the phone app's block
//   node scripts/sync-exercise-app.js --check  # exit 1 if it differs

var fs = require('fs');
var path = require('path');

var rootDir = path.resolve(__dirname, '..');
var INDEX = path.join(rootDir, 'index.html');
var APP = path.join(rootDir, 'public/exercise.html');
var START_MARKER = '// >>> shared-exercise-block';
var END_MARKER = '// <<< shared-exercise-block';
var INDENT = '      ';

function extractBetween(source, startMarker, endMarker, label) {
  var start = source.indexOf(startMarker);
  if (start === -1) throw new Error(label + ': start marker not found: ' + startMarker);
  var end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(label + ': end marker not found: ' + endMarker);
  return source.slice(start, end);
}

// The block the dashboard's own regression test (checkExerciseHelpers) pins,
// plus the row/button/weight-line renderers that follow it.
function sharedBlockFromIndex(indexSource) {
  return extractBetween(indexSource, 'var EXERCISE_PERIODS =', '\n      function renderExercise() {', 'index.html exercise block');
}

function sharedBlockFromApp(appSource) {
  var start = appSource.indexOf(START_MARKER);
  if (start === -1) throw new Error('exercise.html: ' + START_MARKER + ' not found');
  var lineEnd = appSource.indexOf('\n', start);
  var end = appSource.indexOf('\n' + INDENT + END_MARKER, lineEnd);
  if (end === -1) throw new Error('exercise.html: ' + END_MARKER + ' not found');
  return appSource.slice(lineEnd + 1 + INDENT.length, end);
}

function spliceBlock(appSource, block) {
  var start = appSource.indexOf(START_MARKER);
  var lineEnd = appSource.indexOf('\n', start);
  var end = appSource.indexOf('\n' + INDENT + END_MARKER, lineEnd);
  return appSource.slice(0, lineEnd + 1) + INDENT + block + appSource.slice(end);
}

function main() {
  var indexSource = fs.readFileSync(INDEX, 'utf8');
  var appSource = fs.readFileSync(APP, 'utf8');
  var wanted = sharedBlockFromIndex(indexSource);
  var current = sharedBlockFromApp(appSource);
  if (wanted === current) {
    console.log('exercise.html shared block already matches index.html');
    return;
  }
  if (process.argv.indexOf('--check') !== -1) {
    console.error('exercise.html shared block differs from index.html; run node scripts/sync-exercise-app.js');
    process.exit(1);
  }
  fs.writeFileSync(APP, spliceBlock(appSource, wanted));
  console.log('exercise.html shared block updated from index.html');
}

if (require.main === module) main();
module.exports = { sharedBlockFromIndex: sharedBlockFromIndex, sharedBlockFromApp: sharedBlockFromApp };
