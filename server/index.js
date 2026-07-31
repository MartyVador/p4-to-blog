'use strict';

// Must come first — p4.js and blog.js read process.env at load time.
const { loadEnvFile, envPath } = require('./env');

const path = require('path');
const express = require('express');

const p4 = require('./p4');
const ai = require('./ai');
const history = require('./history');
const { generatePost, SYSTEM_PROMPT, SYSTEM_PROMPT_SOURCE } = require('./blog');

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';

// Each changelist costs a `p4 describe` plus a `p4 describe -du` for line counts,
// so this is the main lever on how long a refresh takes.
const DEFAULT_CHANGELIST_LIMIT = 25;
const MAX_CHANGELIST_LIMIT = 500;

function clampLimit(value, fallback) {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested < 1) return fallback;
  return Math.min(Math.floor(requested), MAX_CHANGELIST_LIMIT);
}

const CHANGELIST_LIMIT = clampLimit(process.env.P4_CHANGELIST_LIMIT, DEFAULT_CHANGELIST_LIMIT);

// Single-user local tool: one connection, held in memory, never sent to the browser.
const connection = {
  port: process.env.P4PORT || '',
  user: process.env.P4USER || '',
  client: process.env.P4CLIENT || '',
  ticket: null,
  charset: null,
  connected: false,
};

// AI settings start from the .env defaults and are editable at runtime from the
// UI. Like the P4 ticket, the key stays in this process and is never sent back.
const aiSettings = { ...ai.envDefaults(), systemPrompt: SYSTEM_PROMPT };

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function publicAiSettings() {
  const { apiKey, ...rest } = aiSettings;
  return {
    ...rest,
    hasApiKey: Boolean(apiKey),
    providers: ai.providerCatalog(),
    systemPromptSource: SYSTEM_PROMPT_SOURCE,
  };
}

function publicStatus() {
  return {
    serverAddress: connection.port || 'not configured',
    username: connection.user,
    connected: connection.connected,
  };
}

function handle(fn) {
  return (req, res) => {
    fn(req, res).catch((err) => {
      res.status(err.status || 500).json({ error: err.message });
    });
  };
}

function requireConnection() {
  if (!connection.connected) {
    const err = new Error('Not connected to a Perforce server. Open Server settings and connect.');
    err.status = 409;
    throw err;
  }
}

app.get('/api/status', (req, res) => res.json(publicStatus()));

app.post(
  '/api/connect',
  handle(async (req, res) => {
    const serverAddress = String(req.body.serverAddress || '').trim();
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    if (!serverAddress || !username) {
      res.status(400).json({ error: 'Server address and account are both required.' });
      return;
    }

    const probe = { port: serverAddress, user: username, client: connection.client };
    await p4.login(probe, password);
    const details = await p4.info(probe);

    connection.port = serverAddress;
    connection.user = username;
    connection.ticket = probe.ticket || null;
    connection.charset = probe.charset || null;
    connection.connected = true;

    res.json({ ...publicStatus(), serverVersion: details.serverVersion || '' });
  })
);

// Deliberately usable before a successful connect — that is when it matters.
app.post(
  '/api/diagnose',
  handle(async (req, res) => {
    const serverAddress = String(req.body.serverAddress || '').trim() || connection.port;
    const username = String(req.body.username || '').trim() || connection.user;
    const password = String(req.body.password || '');

    if (!serverAddress || !username) {
      res.status(400).json({ error: 'Server address and account are both required.' });
      return;
    }

    const probe = { port: serverAddress, user: username, client: connection.client };
    if (!password && connection.connected && connection.port === serverAddress) {
      probe.ticket = connection.ticket;
      probe.charset = connection.charset;
    } else if (password) {
      // Best effort: a failed login is reported as a step, not a hard error.
      await p4.login(probe, password).catch(() => {});
    }

    res.json({ steps: await p4.diagnose(probe) });
  })
);

app.get('/api/history', (req, res) => res.json({ entries: history.summaries(), limit: history.LIMIT }));

app.get(
  '/api/history/:id',
  handle(async (req, res) => {
    const entry = history.get(req.params.id);
    if (!entry) {
      res.status(404).json({ error: 'That history entry is gone.' });
      return;
    }
    res.json(entry);
  })
);

app.delete('/api/history', (req, res) => {
  history.clear();
  res.json({ entries: [], limit: history.LIMIT });
});

app.get('/api/ai/settings', (req, res) => res.json(publicAiSettings()));

app.post(
  '/api/ai/settings',
  handle(async (req, res) => {
    const provider = String(req.body.provider || aiSettings.provider);
    if (!ai.PROVIDERS[provider]) {
      res.status(400).json({ error: `Unknown provider "${provider}".` });
      return;
    }

    // A URL or model belongs to the provider it was set for, so when the
    // provider changes and the caller didn't supply one, fall back to the new
    // provider's default rather than carrying the old one over.
    const switched = provider !== aiSettings.provider;
    const carryUrl = switched ? ai.PROVIDERS[provider].defaultBaseUrl : aiSettings.baseUrl;
    const carryModel = switched ? ai.PROVIDERS[provider].defaultModel : aiSettings.model;

    aiSettings.provider = provider;
    aiSettings.baseUrl = String(req.body.baseUrl ?? carryUrl).trim() || ai.PROVIDERS[provider].defaultBaseUrl;
    aiSettings.model = String(req.body.model ?? carryModel).trim();
    aiSettings.effort = String(req.body.effort ?? aiSettings.effort).trim();
    if (typeof req.body.systemPrompt === 'string' && req.body.systemPrompt.trim()) {
      aiSettings.systemPrompt = req.body.systemPrompt;
    }
    // Blank means "keep the current key" so the form never has to echo it back.
    if (typeof req.body.apiKey === 'string' && req.body.apiKey.trim()) {
      aiSettings.apiKey = req.body.apiKey.trim();
    }

    res.json(publicAiSettings());
  })
);

app.get(
  '/api/ai/models',
  handle(async (req, res) => {
    // Accept unsaved form values so you can list models before committing them.
    const probe = {
      ...aiSettings,
      provider: req.query.provider ? String(req.query.provider) : aiSettings.provider,
      baseUrl: req.query.baseUrl ? String(req.query.baseUrl) : aiSettings.baseUrl,
      apiKey: req.query.apiKey ? String(req.query.apiKey) : aiSettings.apiKey,
    };
    if (!ai.PROVIDERS[probe.provider]) {
      res.status(400).json({ error: `Unknown provider "${probe.provider}".` });
      return;
    }
    res.json({ models: await ai.listModels(probe) });
  })
);

app.get(
  '/api/depots',
  handle(async (req, res) => {
    requireConnection();
    res.json({ depots: await p4.listDepots(connection) });
  })
);

app.get(
  '/api/changelists',
  handle(async (req, res) => {
    requireConnection();
    // The query param is for API callers; the UI omits it and gets the configured default.
    const limit = clampLimit(req.query.limit, CHANGELIST_LIMIT);
    const depotPath = String(req.query.path || '//...');
    // execFile takes no shell, but a path starting with "-" would still be
    // read by p4 as a flag.
    if (!depotPath.startsWith('//')) {
      res.status(400).json({ error: 'Depot path must start with "//".' });
      return;
    }
    res.json({ changelists: await p4.listChangelists(connection, { limit, path: depotPath }) });
  })
);

app.post(
  '/api/generate',
  handle(async (req, res) => {
    requireConnection();
    const ids = Array.isArray(req.body.changelists) ? req.body.changelists.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) {
      res.status(400).json({ error: 'Select at least one changelist.' });
      return;
    }
    const changelists = await Promise.all(ids.map((id) => p4.describeChange(connection, id)));
    changelists.sort((a, b) => b.time - a.time);

    const post = await generatePost(changelists, aiSettings);
    history.add(post, {
      changelists: changelists.map((cl) => cl.cl),
      provider: aiSettings.provider,
      model: aiSettings.model,
    });
    res.json(post);
  })
);

app.listen(PORT, HOST, () => {
  console.log(`Perforce blog recommender running at http://${HOST}:${PORT}`);
  console.log(loadEnvFile ? `Loaded ${envPath}` : `No .env file at ${envPath} (using the shell environment)`);
  console.log(`Fetching up to ${CHANGELIST_LIMIT} changelists per refresh (P4_CHANGELIST_LIMIT)`);
  if (process.env.P4_CHANGELIST_LIMIT && clampLimit(process.env.P4_CHANGELIST_LIMIT, null) === null) {
    console.warn(`  ignoring P4_CHANGELIST_LIMIT="${process.env.P4_CHANGELIST_LIMIT}" — not a number >= 1`);
  }
  console.log(
    aiSettings.apiKey
      ? `AI: ${aiSettings.provider} / ${aiSettings.model || '(no model set)'} at ${aiSettings.baseUrl}`
      : `AI: ${aiSettings.provider} — no API key set; add one in AI settings or .env`
  );
  console.log(`System prompt: ${SYSTEM_PROMPT_SOURCE}`);
  console.log(`History: last ${history.LIMIT} posts in ${history.FILE}`);
  if (connection.port && connection.user) {
    console.log(`Pre-filled from environment: ${connection.user}@${connection.port}`);
  }
});
