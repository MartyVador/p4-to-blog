'use strict';

require('./env'); // populate process.env before reading it below (cached, safe to repeat)

const fs = require('fs');
const path = require('path');

const ai = require('./ai');

const MAX_FILES_IN_PROMPT = 25;

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Title for the whole blog post.' },
    intro: { type: 'string', description: 'Two or three sentences introducing the post.' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          cl: { type: 'integer', description: 'The changelist number this section covers.' },
          title: { type: 'string' },
          angle: { type: 'string', description: 'Two or three sentences on the story worth telling.' },
          keyPoints: { type: 'array', items: { type: 'string' } },
        },
        required: ['cl', 'title', 'angle', 'keyPoints'],
        additionalProperties: false,
      },
    },
    conclusion: { type: 'string' },
  },
  required: ['title', 'intro', 'sections', 'conclusion'],
  additionalProperties: false,
};

const DEFAULT_SYSTEM_PROMPT = `You help a solo developer turn real Perforce changelists into a candidate blog post.

Write one section per changelist, in the order given. Ground every claim in the changelist's
actual description and file list — never invent benchmarks, incident details, or team decisions
that are not in the data. If a changelist description is thin, keep its section short and frame
the key points as questions the author should answer when they write it up.

The post is a draft for the developer to expand, not a finished article. Use plain, concrete
language and avoid marketing tone.`;

// Overridable from .env: inline for a quick tweak, or a file for serious editing.
// Read once at startup — restart the server to pick up a change.
function loadSystemPrompt() {
  const inlineVar = process.env.AI_SYSTEM_PROMPT ? 'AI_SYSTEM_PROMPT' : 'ANTHROPIC_SYSTEM_PROMPT';
  const inline = (process.env[inlineVar] || '').trim();
  if (inline) return { text: inline, source: `.env (${inlineVar})` };

  const fileVar = process.env.AI_SYSTEM_PROMPT_FILE ? 'AI_SYSTEM_PROMPT_FILE' : 'ANTHROPIC_SYSTEM_PROMPT_FILE';
  const file = (process.env[fileVar] || '').trim();
  if (file) {
    const resolved = path.resolve(file);
    let contents;
    try {
      contents = fs.readFileSync(resolved, 'utf8');
    } catch (err) {
      // A typo here should be loud, not silently fall back to the default.
      throw new Error(`${fileVar}: cannot read ${resolved} — ${err.message}`);
    }
    if (!contents.trim()) throw new Error(`${fileVar}: ${resolved} is empty.`);
    return { text: contents.trim(), source: resolved };
  }

  return { text: DEFAULT_SYSTEM_PROMPT, source: 'built-in default' };
}

const { text: SYSTEM_PROMPT, source: SYSTEM_PROMPT_SOURCE } = loadSystemPrompt();

function describeChangelist(cl) {
  const shown = cl.files.slice(0, MAX_FILES_IN_PROMPT);
  const overflow = cl.files.length - shown.length;
  const fileLines = shown.map((f) => `  ${f.action} ${f.path}`).join('\n');
  return [
    `Changelist ${cl.cl} (${cl.tag})`,
    `Author: ${cl.author}    Landed: ${cl.date}    Depot: ${cl.depot}`,
    `Lines: +${cl.linesAdded} / -${cl.linesRemoved} across ${cl.files.length} file(s)`,
    'Description:',
    cl.description || '(no description)',
    'Files:',
    fileLines + (overflow > 0 ? `\n  ...and ${overflow} more file(s)` : ''),
  ].join('\n');
}

function buildMarkdown(post, byId) {
  let md = `# ${post.title}\n\n${post.intro}\n\n`;
  for (const section of post.sections) {
    const cl = byId.get(section.cl);
    md += `## ${section.title}\n\n`;
    if (cl) md += `*${cl.tag} — CL ${cl.cl}, ${cl.depot}*\n\n`;
    md += `${section.angle}\n\n`;
    for (const point of section.keyPoints) md += `- ${point}\n`;
    md += '\n';
  }
  return `${md}${post.conclusion}\n`;
}

async function generatePost(changelists, settings) {
  const prompt = [
    `Draft a blog post covering these ${changelists.length} changelist(s).`,
    '',
    changelists.map(describeChangelist).join('\n\n---\n\n'),
  ].join('\n');

  let raw;
  try {
    raw = await ai.complete(settings, {
      system: settings.systemPrompt || SYSTEM_PROMPT,
      prompt,
      schema: SCHEMA,
    });
  } catch (err) {
    // Name the provider and model — the first thing you want to know when a
    // request is rejected for a parameter the model doesn't take.
    if (err.status === 400 || /API error|\b4\d\d\b/.test(err.message)) {
      const wrapped = new Error(`${settings.provider} / ${settings.model}: ${err.message}`);
      wrapped.status = err.status || 400;
      throw wrapped;
    }
    throw err;
  }

  let post;
  try {
    post = JSON.parse(raw);
  } catch {
    throw new Error(`The model did not return valid JSON. It replied: ${raw.slice(0, 300)}`);
  }

  const byId = new Map(changelists.map((cl) => [cl.cl, cl]));
  const sections = (post.sections || []).map((section) => {
    const cl = byId.get(section.cl);
    return {
      cl: section.cl,
      title: section.title,
      angle: section.angle,
      keyPoints: section.keyPoints || [],
      tag: cl ? cl.tag : '',
      depot: cl ? cl.depot : '',
    };
  });

  return {
    postTitle: post.title,
    postIntro: post.intro,
    postConclusion: post.conclusion,
    recs: sections,
    postMarkdown: buildMarkdown({ ...post, sections }, byId),
  };
}

module.exports = { generatePost, SYSTEM_PROMPT, SYSTEM_PROMPT_SOURCE };
