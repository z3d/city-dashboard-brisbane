#!/usr/bin/env node

var fs = require('fs');
var path = require('path');

var rootDir = path.resolve(__dirname, '..');
var indexPath = path.join(rootDir, 'index.html');
var source = fs.readFileSync(indexPath, 'utf8');

function countLines(text) {
  var count = 1;
  for (var i = 0; i < text.length; i++) {
    if (text.charAt(i) === '\n') count++;
  }
  return count;
}

function lineColumn(text, index) {
  var line = 1;
  var column = 1;
  for (var i = 0; i < index; i++) {
    if (text.charAt(i) === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return {line: line, column: column};
}

function maskChar(ch) {
  return ch === '\n' ? '\n' : ' ';
}

function scrubJavaScript(code, reportTemplateLiteral) {
  var output = '';
  var state = 'code';
  var i = 0;

  while (i < code.length) {
    var ch = code.charAt(i);
    var next = code.charAt(i + 1);

    if (state === 'code') {
      if (ch === "'") {
        state = 'single';
        output += ' ';
      } else if (ch === '"') {
        state = 'double';
        output += ' ';
      } else if (ch === '`') {
        reportTemplateLiteral(i);
        state = 'template';
        output += ' ';
      } else if (ch === '/' && next === '/') {
        state = 'lineComment';
        output += '  ';
        i++;
      } else if (ch === '/' && next === '*') {
        state = 'blockComment';
        output += '  ';
        i++;
      } else {
        output += ch;
      }
    } else if (state === 'single') {
      if (ch === '\\') {
        output += ' ';
        if (i + 1 < code.length) {
          output += maskChar(code.charAt(i + 1));
          i++;
        }
      } else if (ch === "'") {
        state = 'code';
        output += ' ';
      } else {
        output += maskChar(ch);
      }
    } else if (state === 'double') {
      if (ch === '\\') {
        output += ' ';
        if (i + 1 < code.length) {
          output += maskChar(code.charAt(i + 1));
          i++;
        }
      } else if (ch === '"') {
        state = 'code';
        output += ' ';
      } else {
        output += maskChar(ch);
      }
    } else if (state === 'template') {
      if (ch === '\\') {
        output += ' ';
        if (i + 1 < code.length) {
          output += maskChar(code.charAt(i + 1));
          i++;
        }
      } else if (ch === '`') {
        state = 'code';
        output += ' ';
      } else {
        output += maskChar(ch);
      }
    } else if (state === 'lineComment') {
      if (ch === '\n') {
        state = 'code';
        output += '\n';
      } else {
        output += ' ';
      }
    } else if (state === 'blockComment') {
      if (ch === '*' && next === '/') {
        state = 'code';
        output += '  ';
        i++;
      } else {
        output += maskChar(ch);
      }
    }

    i++;
  }

  return output;
}

function eachMatch(text, pattern, callback) {
  var match;
  pattern.lastIndex = 0;
  while ((match = pattern.exec(text)) !== null) {
    callback(match.index, match[0]);
    if (match[0].length === 0) pattern.lastIndex++;
  }
}

var scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
var scripts = [];
var scriptMatch;

while ((scriptMatch = scriptPattern.exec(source)) !== null) {
  var attrs = scriptMatch[1] || '';
  if (/\bsrc\s*=/.test(attrs)) continue;
  var fullMatch = scriptMatch[0];
  var contentStart = scriptMatch.index + fullMatch.indexOf('>') + 1;
  scripts.push({
    code: scriptMatch[2],
    startLine: countLines(source.substring(0, contentStart))
  });
}

var failures = [];

function addFailure(baseLine, code, index, message, snippet) {
  var position = lineColumn(code, index);
  failures.push({
    line: baseLine + position.line - 1,
    column: position.column,
    message: message,
    snippet: snippet
  });
}

var checks = [
  {message: 'Use var instead of let.', pattern: /\blet\b/g},
  {message: 'Use var instead of const.', pattern: /\bconst\b/g},
  {message: 'Use function() {} instead of arrow functions.', pattern: /=>/g},
  {message: 'Use string concatenation instead of template literals.', pattern: /`/g, handledByScanner: true},
  {message: 'Use indexed for loops instead of for...of.', pattern: /\bfor\s*\([^)]*\bof\b[^)]*\)/g},
  {message: 'Avoid destructuring assignments/declarations.', pattern: /\b(var|function|catch)\s+[A-Za-z0-9_$]*\s*[\{\[]/g},
  {message: 'Avoid spread/rest syntax.', pattern: /(^|[^.])\.\.\.(?!\.)/g},
  {message: 'Avoid optional chaining.', pattern: /\?\./g},
  {message: 'Avoid nullish coalescing.', pattern: /\?\?/g},
  {message: 'Promise.allSettled is not available on iOS 12 Safari.', pattern: /\bPromise\s*\.\s*allSettled\s*\(/g},
  {message: 'Object.entries is not available on iOS 12 Safari.', pattern: /\bObject\s*\.\s*entries\s*\(/g},
  {message: 'Array.flat is not available on iOS 12 Safari.', pattern: /\.flat\s*\(/g},
  {message: 'Use XMLHttpRequest instead of fetch().', pattern: /\bfetch\s*\(/g}
];

for (var si = 0; si < scripts.length; si++) {
  var script = scripts[si];
  var scrubbed = scrubJavaScript(script.code, function(index) {
    addFailure(script.startLine, script.code, index, 'Use string concatenation instead of template literals.', '`');
  });

  for (var ci = 0; ci < checks.length; ci++) {
    var check = checks[ci];
    if (check.handledByScanner) continue;
    eachMatch(scrubbed, check.pattern, function(index, snippet) {
      addFailure(script.startLine, script.code, index, check.message, snippet.replace(/\s+/g, ' '));
    });
  }
}

if (failures.length > 0) {
  console.error('iOS 12 compatibility check failed for index.html:');
  for (var fi = 0; fi < failures.length; fi++) {
    var failure = failures[fi];
    console.error('  index.html:' + failure.line + ':' + failure.column + ' - ' + failure.message + ' [' + failure.snippet + ']');
  }
  process.exit(1);
}

console.log('iOS 12 compatibility check passed for index.html.');
