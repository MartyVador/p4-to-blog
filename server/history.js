'use strict';

// Generated posts are work product — keeping them only in memory would lose
// them on every restart, so the ring buffer is mirrored to a small JSON file.
// Failures here are never fatal: history is a convenience, not the product.

const fs = require('fs');
const path = require('path');

const LIMIT = 10;
const FILE = process.env.HISTORY_FILE
  ? path.resolve(process.env.HISTORY_FILE)
  : path.join(__dirname, '..', '.history.json');

let entries = load();

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed.slice(0, LIMIT) : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[history] ignoring unreadable ${FILE} — ${err.message}`);
    }
    return [];
  }
}

function persist() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(entries, null, 2));
  } catch (err) {
    console.warn(`[history] could not write ${FILE} — ${err.message}`);
  }
}

function add(post, meta) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    title: post.postTitle || '(untitled)',
    changelists: meta.changelists,
    provider: meta.provider,
    model: meta.model,
    post,
  };
  entries = [entry, ...entries].slice(0, LIMIT);
  persist();
  return entry;
}

// The list view doesn't need the full post body of every entry.
function summaries() {
  return entries.map(({ post, ...rest }) => ({
    ...rest,
    changelistCount: rest.changelists.length,
  }));
}

function get(id) {
  return entries.find((entry) => entry.id === id) || null;
}

function clear() {
  entries = [];
  persist();
}

module.exports = { LIMIT, FILE, add, summaries, get, clear };
