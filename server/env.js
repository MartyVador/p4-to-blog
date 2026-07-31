'use strict';

// Minimal .env loader — no dependency, and no surprises: a variable already set
// in the real environment always wins, so `PORT=5000 npm start` still overrides
// the file. Must be required before anything that reads process.env at load time.

const fs = require('fs');
const path = require('path');

const ENV_PATH = process.env.ENV_FILE || path.join(__dirname, '..', '.env');

// Index of the closing quote, or -1. Inside double quotes a backslash escapes
// the next character; inside single quotes it doesn't (same as the shell).
function findClosingQuote(text, quote) {
  for (let i = 0; i < text.length; i++) {
    if (quote === '"' && text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}

function unescapeDoubleQuoted(text) {
  return text.replace(/\\(n|r|t|"|\\)/g, (_, char) => {
    if (char === 'n') return '\n';
    if (char === 'r') return '\r';
    if (char === 't') return '\t';
    return char;
  });
}

// Double-quoted values may span lines, so a multi-paragraph value (the Claude
// system prompt) can live in the file as-is instead of one escaped line.
function parseEnv(contents) {
  const lines = contents.split(/\r?\n/);
  const pairs = [];
  const skipped = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      // Usually the tail of a quoted value cut short by an unescaped quote.
      skipped.push({ line: i + 1, text: trimmed });
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    if (!key) continue;

    const rest = trimmed.slice(separator + 1);
    const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : null;

    if (!quote) {
      pairs.push([key, rest.trim()]);
      continue;
    }

    let body = rest.slice(1);
    let end = findClosingQuote(body, quote);

    if (end !== -1) {
      body = body.slice(0, end);
    } else {
      while (end === -1 && i + 1 < lines.length) {
        i += 1;
        const next = lines[i];
        const closing = findClosingQuote(next, quote);
        body += `\n${closing === -1 ? next : next.slice(0, closing)}`;
        end = closing;
      }
    }

    pairs.push([key, quote === '"' ? unescapeDoubleQuoted(body) : body]);
  }
  return { pairs, skipped };
}

function loadEnvFile() {
  let contents;
  try {
    contents = fs.readFileSync(ENV_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }

  const { pairs, skipped } = parseEnv(contents);
  for (const [key, value] of pairs) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  for (const { line, text } of skipped) {
    const preview = text.length > 60 ? `${text.slice(0, 57)}...` : text;
    console.warn(
      `[env] ${ENV_PATH}:${line} ignored (no "="): ${preview}\n` +
        '      If this is part of a multi-line value, an unescaped " ended it early — write \\" instead.'
    );
  }
  return true;
}

module.exports = { loadEnvFile: loadEnvFile(), envPath: ENV_PATH };
