'use strict';

require('./env'); // populate process.env before reading it below (cached, safe to repeat)

const Anthropic = require('@anthropic-ai/sdk');

// Each provider differs in three ways only: base URL, how models are listed,
// and how a JSON-schema-constrained completion is requested. Mistral and every
// local runtime (Ollama, LM Studio, vLLM) speak the OpenAI wire format, so they
// share one implementation and differ only in defaults.
const PROVIDERS = {
  claude: {
    label: 'Claude (Anthropic)',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-opus-5',
    // Anthropic calls it output_config.effort.
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  openai: {
    label: 'OpenAI-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: '',
    // OpenAI calls it reasoning_effort, and only reasoning models accept it.
    effortLevels: ['low', 'medium', 'high'],
  },
  mistral: {
    label: 'Mistral',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    effortLevels: [],
  },
};

const DEFAULT_PROVIDER = PROVIDERS[process.env.AI_PROVIDER] ? process.env.AI_PROVIDER : 'claude';

// ANTHROPIC_* stays supported so existing .env files keep working; AI_* wins.
function envDefaults() {
  const provider = DEFAULT_PROVIDER;
  const key =
    process.env.AI_API_KEY ||
    (provider === 'claude' ? process.env.ANTHROPIC_API_KEY : '') ||
    '';
  return {
    provider,
    baseUrl: (process.env.AI_BASE_URL || '').trim() || PROVIDERS[provider].defaultBaseUrl,
    apiKey: key,
    model:
      (process.env.AI_MODEL || '').trim() ||
      (provider === 'claude' ? (process.env.ANTHROPIC_MODEL || '').trim() : '') ||
      PROVIDERS[provider].defaultModel,
    effort:
      (process.env.AI_EFFORT || '').trim() ||
      (provider === 'claude' ? (process.env.ANTHROPIC_EFFORT || '').trim() : '') ||
      'medium',
  };
}

function providerCatalog() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    defaultBaseUrl: p.defaultBaseUrl,
    defaultModel: p.defaultModel,
    effortLevels: p.effortLevels,
  }));
}

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function requireKey(settings) {
  if (!settings.apiKey) {
    const err = new Error('No API key set. Open AI settings and add one.');
    err.status = 400;
    throw err;
  }
}

/* ------------------------------------------------------------------ models */

async function fetchJson(url, options, label) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (err) {
    throw new Error(`${label}: could not reach ${url} — ${err.message}`);
  }
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${label}: ${response.status} ${body.slice(0, 400)}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label}: response was not JSON — ${body.slice(0, 200)}`);
  }
}

async function listModels(settings) {
  requireKey(settings);
  const base = trimSlash(settings.baseUrl || PROVIDERS[settings.provider].defaultBaseUrl);

  if (settings.provider === 'claude') {
    const data = await fetchJson(
      `${base}/v1/models?limit=100`,
      { headers: { 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' } },
      'Listing Claude models'
    );
    return (data.data || []).map((m) => ({ id: m.id, label: m.display_name || m.id }));
  }

  // OpenAI-compatible (also Mistral, Ollama, LM Studio, vLLM, OpenRouter…)
  const data = await fetchJson(
    `${base}/models`,
    { headers: { authorization: `Bearer ${settings.apiKey}` } },
    'Listing models'
  );
  return (data.data || []).map((m) => ({ id: m.id, label: m.id })).sort((a, b) => a.id.localeCompare(b.id));
}

/* -------------------------------------------------------------- completion */

// Effort is rejected outright by some models (Claude Haiku 4.5, non-reasoning
// OpenAI models). Rather than track a model list, send it and remember a "no".
const effortRejected = new Set();

function effortKey(settings) {
  return `${settings.provider}|${settings.model}`;
}

function supportsEffort(settings) {
  const levels = PROVIDERS[settings.provider].effortLevels;
  if (!levels.length) return false;
  if (!settings.effort || settings.effort.toLowerCase() === 'off') return false;
  return !effortRejected.has(effortKey(settings));
}

function isEffortRejection(message) {
  return /effort/i.test(message || '');
}

async function completeClaude(settings, { system, prompt, schema }) {
  const client = new Anthropic({
    apiKey: settings.apiKey,
    baseURL: trimSlash(settings.baseUrl) || undefined,
  });
  const params = {
    model: settings.model,
    max_tokens: 16000,
    system,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: prompt }],
  };

  const send = async (withEffort) =>
    client.messages.create(
      withEffort
        ? { ...params, output_config: { ...params.output_config, effort: settings.effort } }
        : params
    );

  let response;
  if (supportsEffort(settings)) {
    try {
      response = await send(true);
    } catch (err) {
      if (!(err instanceof Anthropic.BadRequestError) || !isEffortRejection(err.message)) throw err;
      console.warn(`[ai] ${settings.model} rejected effort="${settings.effort}"; retrying without it.`);
      effortRejected.add(effortKey(settings));
      response = await send(false);
    }
  } else {
    response = await send(false);
  }

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined to write about these changelists.');
  }
  const text = response.content.find((block) => block.type === 'text');
  if (!text) throw new Error('Claude returned no content.');
  return text.text;
}

async function completeOpenAiCompatible(settings, { system, prompt, schema }) {
  const base = trimSlash(settings.baseUrl || PROVIDERS[settings.provider].defaultBaseUrl);
  const body = {
    model: settings.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'blog_post', strict: true, schema },
    },
  };

  const send = async (payload) =>
    fetchJson(
      `${base}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify(payload),
      },
      'Generating'
    );

  let data;
  const withEffort = supportsEffort(settings)
    ? { ...body, reasoning_effort: settings.effort }
    : body;

  try {
    data = await send(withEffort);
  } catch (err) {
    if (withEffort !== body && isEffortRejection(err.message)) {
      console.warn(`[ai] ${settings.model} rejected effort="${settings.effort}"; retrying without it.`);
      effortRejected.add(effortKey(settings));
      data = await send(body);
    } else if (/json_schema|response_format|schema/i.test(err.message)) {
      // Older OpenAI-compatible servers only do the looser json_object mode.
      console.warn(`[ai] ${settings.model} rejected json_schema; falling back to json_object.`);
      data = await send({
        ...body,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `${system}\n\nReply with JSON matching this schema:\n${JSON.stringify(schema)}` },
          { role: 'user', content: prompt },
        ],
      });
    } else {
      throw err;
    }
  }

  const choice = (data.choices || [])[0];
  const content = choice && choice.message && choice.message.content;
  if (!content) throw new Error('The model returned no content.');
  return content;
}

async function complete(settings, request) {
  requireKey(settings);
  if (!settings.model) {
    const err = new Error('No model selected. Open AI settings and pick one.');
    err.status = 400;
    throw err;
  }
  return settings.provider === 'claude'
    ? completeClaude(settings, request)
    : completeOpenAiCompatible(settings, request);
}

module.exports = { PROVIDERS, providerCatalog, envDefaults, listModels, complete };
