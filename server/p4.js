'use strict';

require('./env'); // populate process.env before reading it below (cached, safe to repeat)

const { execFile } = require('child_process');

const P4_BIN = process.env.P4_BIN || 'p4';
const MAX_BUFFER = 32 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const DIFF_FILE_LIMIT = 60;
const CONCURRENCY = 4;

const describeCache = new Map();

const UNICODE_RE = /unicode server permits only unicode enabled clients/i;
const TRUST_RE = /authenticity of|fingerprint|p4 trust/i;

// Turn p4's terser failures into something that says what to do next.
function explain(message) {
  if (TRUST_RE.test(message)) {
    return `${message}\n\nThis SSL server's fingerprint is not trusted yet. Run "p4 -p <P4PORT> trust -y" once in a terminal, then reconnect.`;
  }
  return message;
}

const DEBUG = process.env.P4_DEBUG === '1';

// Never log the ticket or password.
function redact(argv) {
  return argv.map((a, i) => (argv[i - 1] === '-P' ? '<ticket>' : a)).join(' ');
}

function debugLog(message) {
  if (DEBUG) console.log(`[p4] ${message}`);
}

function execP4(argv, stdin) {
  debugLog(`$ ${P4_BIN} ${redact(argv)}`);
  return new Promise((resolve, reject) => {
    const child = execFile(
      P4_BIN,
      argv,
      { maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') {
            reject(new Error(`The "${P4_BIN}" command was not found. Install the Perforce CLI or set P4_BIN.`));
            return;
          }
          // p4 writes some failures to stdout rather than stderr.
          const message = explain((stderr || '').trim() || (stdout || '').trim() || err.message);
          debugLog(`failed: ${message}`);
          reject(new Error(message));
          return;
        }
        debugLog(`ok: ${stdout.length} bytes`);
        resolve(stdout);
      }
    );
    child.stdin.end(stdin == null ? '' : stdin);
  });
}

function globalArgs(conn) {
  const base = [];
  if (conn.port) base.push('-p', conn.port);
  if (conn.user) base.push('-u', conn.user);
  if (conn.ticket) base.push('-P', conn.ticket);
  if (conn.client) base.push('-c', conn.client);
  if (conn.charset) base.push('-C', conn.charset);
  return base;
}

async function runP4(conn, args, stdin) {
  try {
    return await execP4([...globalArgs(conn), ...args], stdin);
  } catch (err) {
    // Unicode-enabled servers reject non-unicode clients; retry once as utf8
    // and remember it for the rest of the session.
    if (!conn.charset && UNICODE_RE.test(err.message)) {
      conn.charset = 'utf8';
      return execP4([...globalArgs(conn), ...args], stdin);
    }
    throw err;
  }
}

// `p4 -Mj -ztag` emits one JSON object per line.
function parseMarshalledJson(stdout) {
  const stat = [];
  const other = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      throw new Error(
        `Could not parse p4 output as JSON — this needs a p4 client that supports "-Mj" (2018.1 or newer).\n\nIt printed: ${trimmed.slice(0, 300)}`
      );
    }
    if (record.code === 'error') throw new Error(record.data || 'Perforce returned an error.');
    // Not every client tags data rows: some emit "stat", some "info", and some
    // omit "code" altogether. Anything that isn't an error and carries fields
    // is a data row — filtering on "stat" alone reads as an empty server.
    if (record.code === 'stat' || record.code === undefined) stat.push(record);
    else if (record.code === 'info' && Object.keys(record).length > 2) other.push(record);
  }
  return stat.length ? stat : other;
}

async function p4Json(conn, args) {
  const argv = ['-Mj', '-ztag', ...args];
  const records = parseMarshalledJson(await runP4(conn, argv));
  debugLog(`p4 ${args.join(' ')} -> ${records.length} record(s)`);
  return records;
}

// Tickets are 32 hex chars; the looser form is what we accept back from
// `p4 login -p`, since not every server hands back exactly that.
const TICKET_RE = /^[0-9A-F]{32}$/i;
const TICKET_OUTPUT_RE = /^[0-9A-F]{16,}$/i;
const NO_PASSWORD_RE = /not necessary|no password set/i;

// `p4 info` answers even for an unauthenticated user, so auth has to be
// checked with `p4 login -s` — otherwise a bad ticket reads as "connected".
async function checkAuthenticated(conn) {
  try {
    await runP4(conn, ['login', '-s']);
  } catch (err) {
    // Servers running security=0 with no password set report this instead.
    if (NO_PASSWORD_RE.test(err.message)) return;
    throw err;
  }
}

// `p4 login -p` prints a ticket instead of storing it, so the server never
// holds the user's password beyond this call.
async function login(conn, password) {
  const secret = (password || '').trim();

  if (!secret) {
    await checkAuthenticated(conn);
    return null;
  }

  // The field accepts a password *or* a ticket; a ticket handed to
  // `p4 login` would just be rejected as a bad password.
  if (TICKET_RE.test(secret)) {
    conn.ticket = secret;
    await checkAuthenticated(conn);
    return secret;
  }

  let out;
  try {
    out = await runP4(conn, ['login', '-p'], `${secret}\n`);
  } catch (err) {
    // A server with no password set for this account rejects `p4 login`
    // outright. That is not a failure to connect — there is nothing to log in
    // to, and every other command will work fine.
    if (NO_PASSWORD_RE.test(err.message)) return null;
    throw err;
  }

  const ticket = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .reverse()
    .find((l) => TICKET_OUTPUT_RE.test(l));
  // Some servers (SSO/auth triggers) log in without printing a ticket. The
  // local p4 client still holds one, so carry on rather than failing.
  if (ticket) conn.ticket = ticket;
  return ticket || null;
}

async function info(conn) {
  const [record] = await p4Json(conn, ['info']);
  return record || {};
}

function relativeDate(epochSeconds) {
  const days = Math.floor((Date.now() / 1000 - Number(epochSeconds)) / 86400);
  if (!Number.isFinite(days) || days < 0) return 'just now';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return '1 week ago';
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 60) return '1 month ago';
  return `${Math.floor(days / 30)} months ago`;
}

const TAG_RULES = [
  ['Security', /\b(security|vulnerab|exploit|cve|sanitiz|injection|xss|csrf|auth|rate.?limit|hardening)\b/i],
  ['Bugfix', /\b(fix|fixes|fixed|bug|crash|regression|hotfix|broken|corrupt|desync|leak|deadlock)\b/i],
  ['Performance', /\b(perf|performance|optimi[sz]|speed.?up|faster|latency|throughput|memory|cache|hitch|batching)\b/i],
  ['Refactor', /\b(refactor|cleanup|clean.?up|simplif|rewrite|restructur|consolidat|dedup|tech.?debt|migrat)\b/i],
  ['Tooling', /\b(tool|tooling|build|ci|pipeline|script|automat|lint|test harness|cook|packaging)\b/i],
  ['UI/UX', /\b(ui|ux|hud|menu|layout|design|widget|screen|button|accessib|theme|icon)\b/i],
];

function classify(description, files) {
  const haystack = `${description} ${files.map((f) => f.path).join(' ')}`;
  for (const [tag, pattern] of TAG_RULES) {
    if (pattern.test(haystack)) return tag;
  }
  return 'Feature';
}

// The depot label in the UI is the deepest path prefix (max two segments)
// shared by every file in the changelist.
function deriveDepot(files) {
  if (!files.length) return '//';
  const split = files.map((f) => f.path.replace(/^\/\//, '').split('/'));
  const common = [];
  for (let i = 0; i < 2; i++) {
    const segment = split[0][i];
    if (segment === undefined || !split.every((s) => s[i] === segment)) break;
    common.push(segment);
  }
  return common.length ? `//${common.join('/')}` : '//';
}

// The actual depot (first path segment) the changelist lives in — what the
// depot filter matches against. Empty when a changelist spans several depots.
function deriveDepotRoot(files) {
  const roots = new Set(files.map((f) => f.path.replace(/^\/\//, '').split('/')[0]));
  return roots.size === 1 ? `//${[...roots][0]}` : '';
}

function summarize(description) {
  const firstLine = description.split('\n').map((l) => l.trim()).find(Boolean) || '(no description)';
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

function collectFiles(record) {
  const files = [];
  for (let i = 0; record[`depotFile${i}`] !== undefined; i++) {
    files.push({ path: record[`depotFile${i}`], action: record[`action${i}`] || 'edit' });
  }
  return files;
}

function countDiffLines(diffOutput) {
  let added = 0;
  let removed = 0;
  for (const line of diffOutput.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

async function diffStats(conn, changeId, fileCount) {
  if (fileCount === 0 || fileCount > DIFF_FILE_LIMIT) return { added: 0, removed: 0 };
  try {
    return countDiffLines(await runP4(conn, ['describe', '-du', String(changeId)]));
  } catch {
    // Binary files, unshelved content, or an oversized diff — the rest of the
    // changelist is still usable without line counts.
    return { added: 0, removed: 0 };
  }
}

async function describeChange(conn, changeId) {
  const cacheKey = `${conn.port}|${changeId}`;
  if (describeCache.has(cacheKey)) return describeCache.get(cacheKey);

  const [record] = await p4Json(conn, ['describe', '-s', String(changeId)]);
  if (!record) throw new Error(`Changelist ${changeId} not found.`);

  const files = collectFiles(record);
  const description = (record.desc || '').trim();
  const { added, removed } = await diffStats(conn, changeId, files.length);

  const changelist = {
    cl: Number(record.change),
    author: record.user || 'unknown',
    date: relativeDate(record.time),
    time: Number(record.time) || 0,
    depot: deriveDepot(files),
    depotRoot: deriveDepotRoot(files),
    tag: classify(description, files),
    summary: summarize(description),
    description,
    linesAdded: added,
    linesRemoved: removed,
    files,
  };
  describeCache.set(cacheKey, changelist);
  return changelist;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// `p4 depots` reports the depots that actually exist on the server, so the
// filter isn't limited to whatever the last page of changelists happened to
// touch. Depot types that never hold submitted changelists are dropped.
const CHANGELIST_BEARING_DEPOTS = new Set(['local', 'stream', 'spec', 'tangent', '']);

async function listDepots(conn) {
  const records = await p4Json(conn, ['depots']);
  return records
    .filter((r) => CHANGELIST_BEARING_DEPOTS.has(r.type || ''))
    .map((r) => ({
      name: `//${r.name}`,
      type: r.type || 'local',
      description: (r.desc || '').trim(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Walks the connection end to end and reports where it stops, so an empty
// screen can be told apart from a permissions problem or a bad P4PORT.
async function diagnose(conn) {
  const steps = [];
  const step = async (label, hint, fn) => {
    try {
      steps.push({ label, ok: true, detail: await fn() });
      return true;
    } catch (err) {
      steps.push({ label, ok: false, detail: err.message, hint });
      return false;
    }
  };

  const hasBinary = await step(
    'p4 client installed',
    'Install the Perforce CLI, or set P4_BIN to its full path.',
    async () => {
      const out = await execP4(['-V']);
      return out.split('\n').map((l) => l.trim()).find((l) => /^Rev\./.test(l)) || 'found';
    }
  );
  if (!hasBinary) return steps;

  const reachable = await step(
    'Server reachable',
    'Check the server address (P4PORT), including the ssl: prefix and port number.',
    async () => {
      const details = await info(conn);
      return `${details.serverVersion || 'connected'}${details.serverAddress ? ` at ${details.serverAddress}` : ''}`;
    }
  );
  if (!reachable) return steps;

  const authed = await step(
    'Account authenticated',
    'Reconnect with your password, or paste a ticket from "p4 login -p".',
    async () => {
      await checkAuthenticated(conn);
      return `as ${conn.user}`;
    }
  );
  if (!authed) return steps;

  await step(
    'Depots visible',
    'Your protections table may hide all depots. Type a depot path you can read into the path box instead.',
    async () => {
      // Parsed from raw here (rather than via listDepots) so an empty result
      // can report exactly what p4 printed.
      const raw = await runP4(conn, ['-Mj', '-ztag', 'depots']);
      const records = parseMarshalledJson(raw);
      const usable = records.filter((r) => CHANGELIST_BEARING_DEPOTS.has(r.type || ''));
      if (!usable.length) {
        throw new Error(
          `"p4 -Mj -ztag depots" returned ${records.length} usable record(s).\n\nRaw output:\n${raw.trim().slice(0, 600) || '(nothing)'}`
        );
      }
      return usable.map((r) => `//${r.name}`).join(', ');
    }
  );

  await step(
    'Submitted changelists visible',
    'Your protections may not grant read on //... — try a narrower path such as //your-depot/....',
    async () => {
      const raw = await runP4(conn, ['-Mj', '-ztag', 'changes', '-s', 'submitted', '-m', '1', '//...']);
      const records = parseMarshalledJson(raw);
      if (!records.length) {
        throw new Error(
          `"p4 changes -s submitted -m 1 //..." returned nothing.\n\nRaw output:\n${raw.trim().slice(0, 600) || '(nothing)'}`
        );
      }
      return `newest is CL ${records[0].change}`;
    }
  );

  return steps;
}

async function listChangelists(conn, { limit = 25, path = '//...' } = {}) {
  const records = await p4Json(conn, ['changes', '-s', 'submitted', '-m', String(limit), path]);
  const ids = records.map((r) => Number(r.change)).filter(Number.isFinite);
  const changelists = await mapWithConcurrency(ids, CONCURRENCY, (id) => describeChange(conn, id));
  return changelists.sort((a, b) => b.time - a.time);
}

module.exports = { login, info, diagnose, listDepots, listChangelists, describeChange };
