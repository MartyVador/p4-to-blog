# Perforce changelist blog recommender

Reads your real Perforce submitted-changelist history, lets you pick the changelists worth
writing about, and drafts a blog post from them using Claude, OpenAI-compatible endpoints, or
Mistral.

Perforce speaks a binary protocol that a browser cannot call, so this ships as a small local
server: it shells out to the `p4` CLI, returns JSON, and serves the UI.

## Requirements

- Node.js 18+
- The Perforce CLI (`p4`) on your `PATH`, version 2018.1 or newer (it needs `-Mj` JSON output)
- An API key for whichever provider you use (Claude by default) — set it in `.env` or in the
  **AI settings** modal

## Run it

```sh
npm install
cp .env.example .env    # then put your API key in it
npm start
```

Configuration is read from a `.env` file next to `package.json` — see `.env.example` for
every supported variable. Anything already set in your shell wins over the file, so
`PORT=5000 npm start` still overrides it. `.env` is gitignored; don't commit it. If you'd
rather not use a file, exporting the variables works exactly as before.

Then open http://127.0.0.1:4173, click **Server settings**, and enter your P4PORT, account, and
password. Leave the password blank to reuse the ticket your local `p4` client already holds.

The password is exchanged for a ticket via `p4 login -p` and never stored; the ticket lives in
the server process only and is never sent to the browser. The server binds to localhost by
default — it holds a live Perforce ticket, so only change `HOST` if you understand that.

## Configuration

Set these in `.env` (copy `.env.example`) or export them in your shell.

| Variable | Purpose |
| --- | --- |
| `AI_PROVIDER` | `claude`, `openai`, or `mistral` (default `claude`) |
| `AI_BASE_URL` | API endpoint; blank uses the provider's default |
| `AI_API_KEY`, `AI_MODEL`, `AI_EFFORT` | Credentials and model for the chosen provider |
| `ANTHROPIC_API_KEY` | Claude key — used when `AI_API_KEY` is unset |
| `ANTHROPIC_MODEL` | Claude model — used when `AI_MODEL` is unset (default `claude-opus-5`) |
| `ANTHROPIC_EFFORT` | Reasoning depth: `low`–`max`, or `off` to omit the parameter (default `medium`) |
| `AI_SYSTEM_PROMPT` / `ANTHROPIC_SYSTEM_PROMPT` | Replaces the built-in system prompt (may span lines — see below) |
| `AI_SYSTEM_PROMPT_FILE` / `ANTHROPIC_SYSTEM_PROMPT_FILE` | Read the system prompt from a file instead; ignored if the inline one is set |
| `P4PORT`, `P4USER`, `P4CLIENT` | Pre-fill the connection form |
| `P4_CHANGELIST_LIMIT` | Changelists pulled per refresh (default `25`, max `500`) |
| `P4_BIN` | Path to the `p4` binary if it isn't on `PATH` |
| `P4_DEBUG` | Set to `1` to log every `p4` command and result to the console (tickets redacted) |
| `HOST`, `PORT` | Listen address (default `127.0.0.1:4173`) |

## How it works

- `server/p4.js` — runs `p4` via `execFile` (no shell), parses `-Mj -ztag` JSON, and turns each
  changelist into the shape the UI wants: summary, depot, relative date, file list, and `+/-`
  line counts from `p4 describe -du`. Tags (Feature, Bugfix, Performance, …) are inferred from
  the description and file paths, since Perforce has no such field. Submitted changelists are
  immutable, so descriptions are cached in memory. Note that `-Mj` record tagging varies by
  client build — some emit `"code":"stat"`, some `"info"`, and some omit `code` entirely — so
  any non-error row carrying fields is treated as data.
- `server/blog.js` — builds the prompt from the selected changelists, asks for a JSON-schema
  response, and assembles the markdown. Provider-agnostic.
- `server/ai.js` — the provider layer. Claude goes through the Anthropic SDK; everything else
  speaks the OpenAI wire format, so `openai` covers OpenAI, Ollama, LM Studio, vLLM, OpenRouter
  and friends, and `mistral` is the same path with different defaults. Effort (`output_config.effort`
  on Claude, `reasoning_effort` on OpenAI) is rejected by some models rather than ignored, so the
  first request sends it and transparently retries without it if the model says no, remembering
  that per model. An endpoint that only supports the looser `json_object` response format is
  detected the same way and retried with the schema inlined into the prompt.
- `server/env.js` — dependency-free `.env` loader. Double-quoted values may span lines and
  understand `\n` / `\"`; single-quoted values are literal. A line without `=` is reported
  rather than ignored, since that usually means an unescaped `"` ended a value early.
- `prompts/blog-system.txt` — the default system prompt as a file, for editing via
  `ANTHROPIC_SYSTEM_PROMPT_FILE`.
- `server/index.js` — `POST /api/connect`, `GET /api/status`, `GET /api/depots`,
  `GET /api/changelists`, `POST /api/diagnose`, `GET|POST /api/ai/settings`, `GET /api/ai/models`,
  `POST /api/generate`, plus static hosting.
- The depot filter is populated from `p4 depots` — the depots that actually exist on your
  server — not from whatever the loaded changelists happen to touch. Picking one re-queries
  Perforce scoped to `//depot/...`. Unload and archive depots are omitted since they hold no
  submitted changelists. If your account can't run `p4 depots`, the error is shown under the
  filter and the list falls back to the depots seen in the loaded changelists.
- The depot path box under the filters is editable. A restrictive protections table can hide
  `//...` entirely while still granting read on a specific path — type it and press Enter.

## On a phone

Below 760px the two panes become tabs — **Changelists** and **Post** — since they don't fit
side by side. Generating switches you to the Post tab automatically. The header condenses,
the changelist detail slides in full-screen (close it with the ×), and both modals inset from
the screen edges and scroll internally. Controls are bumped to 16px on narrow screens because
iOS Safari zooms the whole page when you focus anything smaller. Rotating or resizing switches
layouts live.

## AI settings

**AI settings** in the header (next to **Server settings**) opens a modal with the provider,
API URL, API key, model, effort, and the system prompt. It opens pre-filled from your `.env`,
and **Fetch models** lists what the endpoint actually offers so you can pick from a dropdown
rather than typing an ID. Effort is hidden for providers that have no such concept.

Changes there apply until the server restarts — put them in `.env` to make them permanent. The
API key is held in the server process and is never sent back to the browser; leaving the field
blank keeps the key already in use.

## Tweaking the prompt

The system prompt that shapes the draft is overridable — live in the AI settings modal, or as
a default in `.env`. For a quick change, put it straight in
`.env` — double-quoted values may span lines, so paste prose in as-is and escape any literal
quote as `\"`:

```
ANTHROPIC_SYSTEM_PROMPT="Write one section per changelist.

Keep every section under 100 words and never say \"leverage\"."
```

For longer edits, point at a file instead — `prompts/blog-system.txt` already contains the
default, so uncomment `ANTHROPIC_SYSTEM_PROMPT_FILE=./prompts/blog-system.txt` and edit it
directly. The inline variable wins if both are set. Either way the prompt is read once at
startup, so restart the server after a change; the startup banner prints which source is in
use (`System prompt: …`).

## Nothing showing up?

Open **Server settings** and click **Diagnose**. It walks the connection one step at a time —
`p4` binary present, server reachable, account authenticated, depots visible, submitted
changelists visible — and reports what `p4` actually said at the step that failed, plus what to
do about it. It works before a successful connection, which is when you need it most.

Two things it commonly catches:

- **SSL fingerprint not trusted.** New `ssl:` servers need `p4 -p <P4PORT> trust -y` run once in
  a terminal before any command succeeds.
- **Protections hide `//...`.** Your account may be able to read `//your-depot/...` but not the
  root. Type the path you can read into the depot path box.
- **No password set for the account.** On a `security=0` server `p4 login` refuses outright
  ("'login' not necessary, no password set for this user"). That is not a connection failure —
  it is treated as success, with no ticket, and everything else works normally.

If the diagnostics all pass but the list is still empty, run the server with `P4_DEBUG=1
npm start`. Every `p4` invocation, its byte count and its record count are logged to the
console (the ticket is redacted), which shows exactly which command came back short.

Unicode-enabled servers are handled automatically — the first command to be rejected triggers a
retry with `-C utf8` for the rest of the session.
- `public/index.html` — the design, ported to a single self-contained file.

The original design prototypes are preserved under `project/`.

---

# Handoff bundle notes

This started as a **handoff bundle** from Claude Design (claude.ai/design).

A user mocked up designs in HTML/CSS/JS using an AI design tool, then exported this bundle so a coding agent can implement the designs for real.

## What you should do — IMPORTANT

**Read the chat transcripts first.** There are 2 chat transcript(s) in `chats/`. The transcripts show the full back-and-forth between the user and the design assistant — they tell you **what the user actually wants** and **where they landed** after iterating. Don't skip them. The final HTML files are the output, but the chat is where the intent lives.

**Read `project/Perforce Blog Recommender.dc.html` in full.** The user had this file open when they triggered the handoff, so it's almost certainly the primary design they want built. Read it top to bottom — don't skim. Then **follow its imports**: open every file it pulls in (shared components, CSS, scripts) so you understand how the pieces fit together before you start implementing.

**If anything is ambiguous, ask the user to confirm before you start implementing.** It's much cheaper to clarify scope up front than to build the wrong thing.

## About the design files

The design medium is **HTML/CSS/JS** — these are prototypes, not production code. Your job is to **recreate them pixel-perfectly** in whatever technology makes sense for the target codebase (React, Vue, native, whatever fits). Match the visual output; don't copy the prototype's internal structure unless it happens to fit.

**Don't render these files in a browser or take screenshots unless the user asks you to.** Everything you need — dimensions, colors, layout rules — is spelled out in the source. Read the HTML and CSS directly; a screenshot won't tell you anything they don't.

## Bundle contents

- `README.md` — this file
- `chats/` — conversation transcripts (read these!)
- `project/` — the `Perforce changelist blog recommender` project files (HTML prototypes, assets, components)
