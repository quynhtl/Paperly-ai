# Paperly Agent

Status 2026-10-04, version 0.9.40. Built from `agent_mode.md` (in the
Paperly workspace, outside this repo, now at `specs/agent-mode.md`); this file records what was built,
what was decided, and where it differs from that guide.

## What it is

The Conversation view now chats with the user's own **Claude Code** or
**Codex** CLI, the way OpenMausBot drives them. The CLI is the one the user
installed and signed in to through Anthropic's or OpenAI's own page; Paperly
never sees a password or a token, and every turn runs on the user's own
plan. Paperly gives the CLI tools to read the open paper and the library, and
draws the conversation itself.

The older relay (Send types into the provider's web page) is still there:
the agent menu's **Use the web page instead** switches to it, and the old
view's **Paperly Agent** button switches back. The choice is the pref
`agent.conversationMode` (`agent` by default).

## Where the code is

| | |
| --- | --- |
| `src/modules/agent/streamParser.ts` | CLI output → events (`claude` stream-json, `codex exec --json`). Pure. |
| `src/modules/agent/mcpProtocol.ts` | The MCP server's JSON-RPC handling. Pure. |
| `src/modules/agent/markdown.ts` | Markdown → a tree (the view) and → Zotero note HTML. Pure. |
| `src/modules/agent/signInText.ts` | Reading the CLIs' sign-in prompts. Pure. |
| `src/modules/agent/prompt.ts` | The system prompt. Pure. |
| `src/modules/agent/endpoint.ts` | `/paperly/mcp` on Zotero's local server. |
| `src/modules/agent/paperTools.ts` | The tools, on Zotero's API. |
| `src/modules/agent/cli.ts` | Finding the CLIs, their environment, sign-in status. |
| `src/modules/agent/runner.ts` | One CLI process per turn. |
| `src/modules/agent/signIn.ts` | `claude auth login` / `codex login --device-auth` from the app. |
| `src/modules/agent/store.ts` | Conversations on disk. |
| `src/modules/agent/agentService.ts` | State, turns, approvals; what the view subscribes to. |
| `src/ui/agent/` | The view, its Markdown/KaTeX renderer, its strings. |

Touched outside those folders, all additive: `WebAIWorkspace.tsx` (the
Conversation view branches to the agent; Reload and Open External hide while
it shows), `Sidebar.tsx` (Explain/Ask carry the selection and page),
`hooks.ts` (endpoint, KaTeX stylesheet, shutdown), `addon/prefs.js`,
`addon/content/styles.css` (a `.paperly-agent` section), and
`scripts/scaffold-build.mjs` (copies KaTeX's CSS and woff2 fonts into
`addon/content/katex/`, which git ignores).

## How a turn runs

`claude -p --input-format stream-json --output-format stream-json --verbose
--include-partial-messages --tools "WebSearch" --strict-mcp-config
--mcp-config <0600 file> --allowedTools "mcp__paperly__*,WebSearch"
--permission-mode dontAsk --setting-sources project --system-prompt <…>
[--model] [--effort] (--session-id <new uuid> | --resume <id>)`, in the empty
folder `<profile>/paperly-agent/work`. The question goes in on stdin as one
stream-json line; the MCP config file holds the token and is deleted after
the turn.

Codex: `codex exec --json --skip-git-repo-check --ignore-user-config
--sandbox read-only -c features.shell_tool=false …` (shell, unified exec,
browser and computer use, apps, plugins, image generation, multi-agent,
hooks and memories all off), Paperly's MCP server by `-c mcp_servers.paperly.*`
with the token passed as an environment variable through `env_http_headers`,
`-c developer_instructions=<…>`, and `codex exec … resume <thread id> -` for
later turns. The prompt goes in on stdin, and stdin is closed: Codex waits
on an open stdin forever.

## Safety

- **No shell, no file tools.** `--tools` lists only WebSearch; the CLI's own
  `init` line is checked again, and any tool other than Paperly's and
  WebSearch stops the turn. For Codex a `command_execution` or
  `file_change` item stops it.
- **No user setup leaks in.** `--strict-mcp-config` (no other MCP servers),
  `--setting-sources project` in an empty folder (no hooks, settings or
  CLAUDE.md), `--ignore-user-config` for Codex.
- **Slash commands.** The CLI runs a message that starts with `/` as its own
  command, even `/config` -- with `--disable-slash-commands` too, and with
  array content too (measured). Paperly handles `/new` and `/save` itself and
  sends anything else with a leading space, which the CLI does not treat as
  a command.
- **Writes wait for a click.** `add_note` puts a card in the chat and blocks
  until Allow or Don't save; it refuses a call without a live turn. A turn
  that is stopped or ends answers its open cards as declined. The MCP config
  sets `"timeout": 600000`, because Claude Code otherwise cuts an HTTP tool
  call at 60 s with no answer and at 5 minutes of silence (measured: a 75 s
  call succeeds with the field); Paperly itself gives up after 9 minutes.
- **The endpoint.** Zotero's server already drops browser requests (Mozilla
  user agent or an Origin header) and checks Host against DNS rebinding.
  `/paperly/mcp` also wants `X-Paperly-Token` (a random 256-bit value in
  `agent.token`), compared in constant time, and refuses an Origin itself.
  Measured: no token 401, wrong token 401, Origin dropped, Mozilla UA
  dropped, wrong Host 400, GET 405, non-JSON 400.
- **Credentials.** Paperly never reads the Keychain or any token file. It
  asks `claude auth status --json` and `codex login status`. Sign-in runs
  the unmodified CLI with pipes: Paperly opens the link the CLI prints
  (accepted only on Anthropic's or OpenAI's https hosts) and passes the code
  the user pastes back to the CLI's stdin.

## Tools

`get_current_paper`, `read_pages` (≤ 10 pages a call; the open reader's own
PDF.js when the paper is open -- exact pages -- otherwise the full-text cache
split on `\f`), `get_selection` (the reader's live selection, then the last
selection popup), `get_annotations`, `search_library` (every user and group
library), `find_related` (Semantic Scholar and arXiv), `add_note`.

Every tool takes the item key explicitly; the system prompt names the open
paper's key. Nothing reads "whatever tab is open now".

## Differences from agent_mode.md

1. `--allowedTools` is not a boundary (it pre-approves); `--tools` is. Added
   `dontAsk`, `--strict-mcp-config`, `--setting-sources project` and the
   `init` check.
2. WebFetch is off (a PDF could tell the model to send library text to a
   URL). WebSearch is on, as the user asked; `agent.webSearch` turns it off.
3. `--include-partial-messages`, so replies stream as they are written.
4. The question goes on stdin, not argv (`ps`, length).
5. Prefs live under `extensions.zotero.zotero-webai.agent.*`, the plugin's
   real prefix.
6. Paperly keeps its own transcript per paper (`<profile>/paperly-agent/
   conversations/`); `--resume` only gives the model its memory.
7. `--system-prompt` replaces Claude Code's coding-assistant prompt (works
   with a subscription; ~1.1k tokens instead of ~3.6k).
8. The agent lives in the existing Conversation view, as the user asked,
   not as a new provider in the header menu. Explain and Ask from the
   selection popup go to it (in English, not the old Chinese template);
   Explain sends at once, Ask fills the box.
9. `add_highlight` is not built: Zotero has no chrome-side API from text to
   highlight rectangles, and rectangles computed from PDF.js text items
   would be approximate. `add_note` and **Save chat as note** are.
10. Sign-in from inside the app (agent_mode.md only reported "not logged in").
11. A lost CLI session ("No conversation found with session ID") starts a
    new one once, with a notice, instead of failing every turn.

## Verified

- Unit tests: `npm test` (32),
  on output recorded from claude 2.1.258 and codex-cli 0.144.6
  (`test/agent/fixtures`, machine paths and installed skills removed).
- In the app, on a scratch profile, with the real CLIs: Main idea (tools,
  page citations), KaTeX math, memory across turns, Explain from the popup,
  add_note allowed (one note) and declined (none), Save chat as note, Stop,
  per-paper conversations across tabs and items, Codex end to end, AI Web
  and Google Search unchanged, the old relay view and its Explain path
  unchanged, a real Return key from the keyboard, light and dark themes,
  and -- with a stand-in CLI -- the sign-in and install cards.

## Known limits

- macOS is the tested platform. On Windows, npm installs `claude.cmd`
  shims, which Gecko's Subprocess cannot start directly.
- A CLI on an unusual path: set `agent.claudePath` / `agent.codexPath`.
- Users who sign Claude Code in through `apiKeyHelper` or `env` in
  `~/.claude/settings.json` lose that under `--setting-sources project`.
- Codex reports no token-by-token text, so its replies arrive whole.
