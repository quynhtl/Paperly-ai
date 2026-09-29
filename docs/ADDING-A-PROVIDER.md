# Adding an AI provider

Read the embedding and injection sections of `PAPERLY-FORK.md` first.

## Minimum change

The registry lives in `src/ui/webAIServices.ts` — a standalone module, not
inside `WebAIWorkspace.tsx`, so that the Sidebar header can import it without
pulling in a 10k-line component. Registering a provider takes two edits there.

1. Widen the union:

```ts
export type WebAIServiceId = "deepseek" | ... | "yourid";
```

2. Add the entry to `SERVICES`:

```ts
{ id: "yourid", kind: "chat", label: "Your AI Web", url: "https://example.com/chat" },
```

Session restore validates against `SERVICES` via `isKnownServiceID`, so it needs
no edit. (Before this fork it hardcoded the id list and silently reset unknown
providers to `deepseek`.)

Nothing else needs editing. The one selector in the Sidebar header renders
straight from `SERVICES`, so a new entry appears in the menu automatically.

## `kind`: chat or lookup

`kind: "chat"` means the page takes a prompt and streams an answer back, so the
composer, the transcript, automatic answer capture and the web-search toggle all
apply.

`kind: "lookup"` is for ordinary web pages with a search box — a dictionary, a
search engine. There is no prompt to inject and no answer to capture, so the
panel hides the entire chat surface and shows a single look-up box instead.
Selected text in the reader lands in that box rather than in the composer. A
lookup provider also needs a `searchUrlTemplate`, where `{q}` is replaced with
the URL-encoded query:

```ts
{
  id: "cambridge",
  kind: "lookup",
  label: "Cambridge Dictionary",
  url: "https://dictionary.cambridge.org/",
  searchUrlTemplate: "https://dictionary.cambridge.org/dictionary/english/{q}",
}
```

Do not register a non-chat page as `kind: "chat"`. Send and Regenerate would
render and do nothing, and the answer capture that runs after Send would file
whatever text the page happens to contain as an answer.

## Then test, because registration is the easy part

Everything else is generic heuristics, so a provider either works for free or
fails in a way no amount of registry editing fixes. Work through the
per-provider table in `TESTING.md` and record the first failing step.

### If login spins forever

Cloudflare Turnstile. Zotero's own source states the rule in
`chrome/content/zotero/xpcom/zotero.js`: *"Turnstile won't pass with Zotero/ in
the UA string, and future requests need the same UA as the one that passed
Turnstile."* Every embedded browser therefore gets
`browsingContext.customUserAgent = Zotero.VersionHeader.getPlainFirefoxUA()`
before the first load — see `applyPlainUserAgent` in `WebAIWorkspace.tsx`. If a
provider still stalls, check that the UA actually applied; a stale
`browsingContext` throws and the code falls back to the default UA.

### If the page is blank

The content browser does a top-level load, so frame-busting headers are not the
cause. Check instead for a redirect to a login wall, a region block, or a
non-XUL host document forcing the `<iframe>` fallback, which frame-busting
providers will refuse.

There is no load-failure detection, so nothing will log this.

### If the prompt does not appear in the composer

`findWebChatComposer` failed to find or rank the composer. Custom elements and
shadow DOM are the usual cause. The submit query pierces shadow roots; confirm
whether the composer query reaches yours.

### If the prompt appears but does not send

`submitWebChatPrompt` exhausted its ladder. Providers that require a real user
gesture, or that disable the send button until an internal state settles, land
here.

### If the reply is never captured

`readLatestAssistantTextFromDocument` could not identify the assistant message.
Capture polls on a timer rather than observing mutations, so a provider that
streams slowly past 120 × 1500 ms will also time out.

## When to build a capability layer

Today provider knowledge is scattered across roughly eight sites: the registry,
a hardcoded session-restore list (now fixed), a Z.ai captcha layout mode, a
~250-line DeepSeek thinking-block serializer, and regexes stripping provider
names from captured text.

If a new provider needs any special handling, **do not** add a ninth branch and
**do not** tune the global scorers — that risks regressing providers that
currently work. Introduce a per-provider capability record instead:

```ts
interface WebAIServiceCapabilities {
  composerSelector?: string;
  submitSelector?: string;
  assistantSelector?: string;
  serializeThinking?: (el: Element) => string;
}
```

with the generic heuristics as the fallback when a field is absent. That keeps
per-provider knowledge in one place and makes each override explicit.

## Frame scripts

When the content document is not directly reachable, injection runs through
`insertPromptWithFrameScript`, which builds a script by stringifying helper
functions with `fn.toString()`. **Any new helper called during injection must be
added to that list**, or it will be undefined in the content process — and the
failure appears only on the frame-script path, not in normal testing.
