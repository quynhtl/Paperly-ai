# Paperly AI

A plugin for [Paperly](https://github.com/quynhtl/Paperly-client) that puts an AI
assistant, a reading status and a starred collection into your library.

It uses AI providers through their **web interfaces**, not their APIs. There is no
API key to buy or configure: you sign in to the provider inside the panel, the same
account you already use in a browser.

> **Status: work in progress.** Built and run from source; there is no release yet.

## What it does

**An AI panel beside the paper.** A column that opens next to the reader or the
library, carrying the provider's own web page. Claude, Gemini, NotebookLM, ChatGPT,
DeepSeek and Z.ai. One surface that follows the paper you are on rather than one per
tab.

**A floating bot** you can drag anywhere. It moves on a spring, with inertia and a
trailing wake, and can be dismissed with its close button — the Paperly icon in the
top-right brings it back.

**Reading status.** A column before the title where each paper is unread, reading or
read, ticked straight from the list. Child rows stay unmarked.

**Starred papers.** A star column and a saved search that collects what you starred.

**A note pad in the reader** that floats over both panes: blocks, tables, an emoji
picker, five colour families, and a format bar over the selection.

**Look-up on selected text** — translate, dictionary, and search — from the reader's
selection popup.

**Slash commands** in the chat box: `/pdf` attaches the current PDF or item full
text, `/websearch` runs a search and attaches readable results, `/zotero-mcp` loads a
local MCP tool catalogue and feeds real tool results back into the web chat. Custom
skills are configured in settings.

## Building

```bash
npm install
npm run build          # produces .scaffold/build/Paperly.AI-<version>.xpi
```

Install the `.xpi` through **Tools → Add-ons → Install Add-on From File**.

While developing, `scripts/dev-reload.sh` builds and installs into an isolated dev
profile rather than the one you use day to day, and `--launch` starts Paperly on it:

```bash
./scripts/dev-reload.sh --launch
```

## Documentation

Notes on how each piece works and why it was built that way are in [`docs/`](docs/):

| | |
| --- | --- |
| [`BOT.md`](docs/BOT.md) | the floating bot, its spring physics and its clip budget |
| [`READING-STATUS.md`](docs/READING-STATUS.md) | the status column, and three ways it silently failed to register |
| [`STARRED.md`](docs/STARRED.md) | the star column and its saved search |
| [`NOTE.md`](docs/NOTE.md) | the reader note pad |
| [`ADDING-A-PROVIDER.md`](docs/ADDING-A-PROVIDER.md) | how to add an AI provider |
| [`TESTING.md`](docs/TESTING.md) | how this is tested |
| [`PAPERLY-FORK.md`](docs/PAPERLY-FORK.md) | what this fork changed |

## Credits

Paperly AI began as a fork of [**Zotero
WebAI**](https://github.com/lineex/Zotero-WebAI) by **lineex**, which built the
embedded web-provider workspace, the slash commands and the MCP bridge this plugin
still rests on. The reading status, the starred collection, the floating bot, the
note pad and the Paperly integration were added here.

The upstream project does not carry a licence, so its terms are whatever its author
grants. If you intend to redistribute this plugin, ask lineex first.
