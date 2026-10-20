pref("extensions.zotero.zotero-webai.customPresets", "");
pref("extensions.zotero.zotero-webai.workspaceLayout", "stacked");
pref("extensions.zotero.zotero-webai.iconPlacement", "both");
pref("extensions.zotero.zotero-webai.maxContextBudget", 4000);
pref("extensions.zotero.zotero-webai.sidebarVisible", true);
pref("extensions.zotero.zotero-webai.evidenceEnabled", false);
pref(
  "extensions.zotero.zotero-webai.evidenceProviderMode",
  "mcp-http",
);
pref("extensions.zotero.zotero-webai.mcpEndpoint", "http://127.0.0.1:23120/mcp");
pref("extensions.zotero.zotero-webai.mcpToolName", "search_library");
pref(
  "extensions.zotero.zotero-webai.mcpToolArgumentsTemplate",
  "{\"q\":\"{{query}}\",\"limit\":1000,\"mode\":\"complete\",\"relevanceScoring\":true,\"sort\":\"relevance\"}",
);
pref("extensions.zotero.zotero-webai.mcpAuthToken", "");
pref("extensions.zotero.zotero-webai.configSyncEnabled", false);
pref("extensions.zotero.zotero-webai.configSyncEndpoint", "");
pref("extensions.zotero.zotero-webai.configSyncRemotePath", "Zotero-WebAI-config.json");
pref("extensions.zotero.zotero-webai.configSyncUsername", "");
pref("extensions.zotero.zotero-webai.configSyncPassword", "");
pref("extensions.zotero.zotero-webai.configSyncSnapshot", "");

pref("extensions.zotero.zotero-webai.themeMode", "auto");
pref("extensions.zotero.zotero-webai.defaultThinkingEffort", "none");
pref("extensions.zotero.zotero-webai.selectionToolbarEnabled", true);
pref("extensions.zotero.zotero-webai.tokenDisplayEnabled", true);
pref("extensions.zotero.zotero-webai.quickPromptsEnabled", true);

pref("extensions.zotero.zotero-webai.readerNoteFont", "inter");
pref("extensions.zotero.zotero-webai.readerNoteBackground", "paper");
pref("extensions.zotero.zotero-webai.readerNoteGeometry", "");
pref("extensions.zotero.zotero-webai.readerNoteEmojiRecent", "");
pref("extensions.zotero.zotero-webai.readerNoteEmojiSkin", 0);

// The Paperly AI column: open when the window loads, until the user closes it
// (the bot, View > Paperly AI Panel, or the panel's own close button).
pref("extensions.zotero.zotero-webai.columnOpen", true);

pref("extensions.zotero.zotero-webai.floatingBot", true);
pref("extensions.zotero.zotero-webai.floatingBotPosition", "");
pref("extensions.zotero.zotero-webai.floatingBotCharacter", "");
pref("extensions.zotero.zotero-webai.floatingBotCustomCharacters", "");

// Paperly Agent: the Conversation view's chat with the user's own Claude Code
// or Codex CLI. "agent" shows it; "web" keeps the older relay to the web page.
pref("extensions.zotero.zotero-webai.agent.conversationMode", "agent");
pref("extensions.zotero.zotero-webai.agent.engine", "claude");
pref("extensions.zotero.zotero-webai.agent.claudeModel", "");
pref("extensions.zotero.zotero-webai.agent.codexModel", "");
pref("extensions.zotero.zotero-webai.agent.effort", "");
pref("extensions.zotero.zotero-webai.agent.webSearch", true);
// Full paths, for a CLI installed somewhere Paperly does not look.
pref("extensions.zotero.zotero-webai.agent.claudePath", "");
pref("extensions.zotero.zotero-webai.agent.codexPath", "");
// The local endpoint's secret; generated on first use.
pref("extensions.zotero.zotero-webai.agent.token", "");
