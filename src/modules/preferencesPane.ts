import {
  DEFAULT_CONFIG_SYNC_REMOTE_PATH,
  DEFAULT_EVIDENCE_PROVIDER_MODE,
  DEFAULT_MCP_TOOL_ARGUMENTS_TEMPLATE,
  DEFAULT_SETTINGS,
  getSettings,
  parseCustomPresets,
  saveSettings,
  type PersistedSettings,
  validateEvidenceSettings,
} from "../services/settingsManager";
import { copyTextToClipboard } from "../utils/clipboard";
import { createHostEvent } from "../utils/domEvents";
import { createTraceId, debugLog, exportDebugLog } from "../utils/debugLog";
import { EventBus } from "../utils/eventBus";
import { isChineseLocale } from "../utils/locale";

type PreferencesDocument = Document & {
  l10n?: {
    formatValue?: (id: string) => Promise<string> | string;
  } | null;
};

type PreferencesFieldElement = HTMLElement & {
  checked?: boolean;
  disabled?: boolean;
  value: string;
  __aiAssistantListeners?: Map<string, EventListener>;
};

type PreferencesInteractiveElement = HTMLElement & {
  __aiAssistantListeners?: Map<string, EventListener>;
};

type PreferencesStatusElement = HTMLElement & {
  dataset: DOMStringMap & {
    variant?: string;
  };
};

type PreferencesContainerElement = HTMLElement;

export interface PreferencesPaneDeps {
  exportDebugLog: typeof exportDebugLog;
  getSettings: typeof getSettings;
  saveSettings: typeof saveSettings;
  validateEvidenceSettings: typeof validateEvidenceSettings;
}

export interface SlashCardDraft {
  error?: string | null;
  id: string;
  isNew?: boolean;
  kind: "builtin" | "custom";
  promptPrefix: string;
  slashCommand: string;
  title: string;
}

export interface SlashSettingsState {
  builtins: SlashCardDraft[];
  custom: SlashCardDraft[];
}

type SlashCardEditInput = Pick<SlashCardDraft, "promptPrefix" | "title"> &
  Partial<Pick<SlashCardDraft, "slashCommand">>;

const ROOT_ID = "zotero-ai-assistant-prefs";
const SAVE_BUTTON_ID = "zotero-ai-assistant-pref-save";
const EXPORT_DEBUG_LOG_BUTTON_ID =
  "zotero-ai-assistant-pref-export-debug-log";
const STATUS_ID = "zotero-ai-assistant-pref-status";
const EVIDENCE_PROVIDER_ID = "zotero-ai-assistant-pref-evidence-provider";
const EVIDENCE_VALIDATE_BUTTON_ID =
  "zotero-ai-assistant-pref-evidence-validate";
const EVIDENCE_STATUS_ID = "zotero-ai-assistant-pref-evidence-status";
const WORKSPACE_LAYOUT_ID = "zotero-ai-assistant-pref-workspace-layout";
const ICON_PLACEMENT_ID = "zotero-ai-assistant-pref-icon-placement";
const MCP_SETTINGS_ID = "zotero-ai-assistant-pref-mcp-settings";
const MCP_ENDPOINT_ID = "zotero-ai-assistant-pref-mcp-endpoint";
const MCP_AUTH_TOKEN_ID = "zotero-ai-assistant-pref-mcp-auth-token";
const CUSTOM_PRESETS_ID = "zotero-ai-assistant-pref-custom-presets";
const SLASH_CUSTOM_ID = "zotero-ai-assistant-pref-slash-custom";
const SLASH_ADD_ID = "zotero-ai-assistant-pref-slash-add";
const SLASH_LIMIT_STATUS_ID = "zotero-ai-assistant-pref-slash-limit-status";
const BACKUP_TEXT_ID = "zotero-ai-assistant-pref-backup-json";
const BACKUP_GENERATE_ID = "zotero-ai-assistant-pref-backup-generate";
const BACKUP_COPY_ID = "zotero-ai-assistant-pref-backup-copy";
const BACKUP_EXPORT_ID = "zotero-ai-assistant-pref-backup-export";
const BACKUP_IMPORT_ID = "zotero-ai-assistant-pref-backup-import";
const BACKUP_STATUS_ID = "zotero-ai-assistant-pref-backup-status";
const SYNC_ENABLED_ID = "zotero-ai-assistant-pref-sync-enabled";
const SYNC_ENDPOINT_ID = "zotero-ai-assistant-pref-sync-endpoint";
const SYNC_REMOTE_PATH_ID = "zotero-ai-assistant-pref-sync-remote-path";
const SYNC_USERNAME_ID = "zotero-ai-assistant-pref-sync-username";
const SYNC_PASSWORD_ID = "zotero-ai-assistant-pref-sync-password";
const SYNC_TEST_ID = "zotero-ai-assistant-pref-sync-test";
const SYNC_PUSH_ID = "zotero-ai-assistant-pref-sync-push";
const SYNC_PULL_ID = "zotero-ai-assistant-pref-sync-pull";
const SYNC_STATUS_ID = "zotero-ai-assistant-pref-sync-status";

const THEME_MODE_ID = "zotero-ai-assistant-pref-theme-mode";
const THINKING_EFFORT_ID = "zotero-ai-assistant-pref-thinking-effort";
const SELECTION_TOOLBAR_ID = "zotero-ai-assistant-pref-selection-toolbar";
const TOKEN_DISPLAY_ID = "zotero-ai-assistant-pref-token-display";
const QUICK_PROMPTS_ID_PREF = "zotero-ai-assistant-pref-quick-prompts";

const MAX_CUSTOM_SLASH_COMMANDS = 1000;
const BUTTON_ACTIVATION_DEDUPE_WINDOW_MS = 300;
const HTML_NS = "http://www.w3.org/1999/xhtml";

function normalizeToken(value: string): string {
  return String(value || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\s+/g, "");
}

function isBlankCard(
  card: Pick<SlashCardDraft, "promptPrefix" | "slashCommand" | "title">,
): boolean {
  return (
    !card.title.trim() &&
    !normalizeToken(card.slashCommand) &&
    !card.promptPrefix.trim()
  );
}

function copyForState(card: SlashCardDraft): SlashCardDraft {
  return {
    error: card.error ?? null,
    id: card.id,
    isNew: Boolean(card.isNew),
    kind: card.kind,
    promptPrefix: card.promptPrefix,
    slashCommand: card.slashCommand,
    title: card.title,
  };
}

function createCustomCardId(existing: SlashCardDraft[]): string {
  const taken = new Set(existing.map((card) => card.id));
  let index = existing.length + 1;
  while (taken.has(`custom-action-${index}`)) {
    index += 1;
  }
  return `custom-action-${index}`;
}

function getValidationCopy(_zh: boolean) {
  return {
    duplicateSlash: "This title is already in use",
    promptRequired: "Prompt text is required",
    titleRequired: "Title is required",
  };
}

export function createSlashSettingsState(
  customPresetsValue: string,
): SlashSettingsState {
  const parsedCustom = parseCustomPresets(customPresetsValue).presets;

  return {
    builtins: [],
    custom: parsedCustom.map((preset) => ({
      id: preset.id,
      isNew: false,
      kind: "custom" as const,
      promptPrefix: String(preset.promptPrefix || "").trim(),
      slashCommand: String(
        preset.slashCommand || preset.label || preset.id || "",
      ).trim(),
      title: String(preset.label || "").trim(),
    })),
  };
}

export function serializeSlashSettingsState(
  state: SlashSettingsState,
): string {
  const serializedCustom = state.custom
    .filter((card) => !card.error && !isBlankCard(card))
    .map((card) => ({
      id: card.id,
      label: card.title.trim(),
      promptPrefix: card.promptPrefix.trim(),
      slashCommand: normalizeToken(card.title),
    }));

  return serializedCustom.length > 0
    ? JSON.stringify(serializedCustom, null, 2)
    : "";
}

export function addCustomSlashCard(
  state: SlashSettingsState,
): SlashSettingsState {
  if (state.custom.length >= MAX_CUSTOM_SLASH_COMMANDS) {
    return state;
  }

  return {
    ...state,
    custom: [
      ...state.custom.map(copyForState),
      {
        id: createCustomCardId(state.custom),
        isNew: true,
        kind: "custom",
        promptPrefix: "",
        slashCommand: "",
        title: "",
      },
    ],
  };
}

export function restoreBuiltInSlashCard(
  state: SlashSettingsState,
  _id: string,
): SlashSettingsState {
  return state;
}

export function validateSlashCardDraft(
  state: SlashSettingsState,
  draft: SlashCardDraft,
  zh = isChineseLocale(),
): string | null {
  const copy = getValidationCopy(zh);
  if (!draft.title.trim()) {
    return copy.titleRequired;
  }

  if (!draft.promptPrefix.trim()) {
    return copy.promptRequired;
  }

  const normalizedSlash = normalizeToken(draft.title);
  const duplicate = state.custom
    .filter((card) => !(card.kind === draft.kind && card.id === draft.id))
    .some(
      (card) =>
        normalizeToken(card.title).toLowerCase() ===
        normalizedSlash.toLowerCase(),
    );
  return duplicate ? copy.duplicateSlash : null;
}

function replaceCard(
  cards: SlashCardDraft[],
  nextCard: SlashCardDraft,
): SlashCardDraft[] {
  return cards.map((card) =>
    card.id === nextCard.id && card.kind === nextCard.kind
      ? copyForState(nextCard)
      : copyForState(card),
  );
}

export function commitSlashCardEdit(
  state: SlashSettingsState,
  target: Pick<SlashCardDraft, "id" | "kind">,
  updates: SlashCardEditInput,
  zh = isChineseLocale(),
): {
  saved: boolean;
  state: SlashSettingsState;
} {
  const collection =
    target.kind === "builtin" ? state.builtins : state.custom;
  const current = collection.find(
    (card) => card.id === target.id && card.kind === target.kind,
  );
  if (!current) {
    return { saved: false, state };
  }

  const nextCard: SlashCardDraft = {
    ...copyForState(current),
    error: null,
    promptPrefix: updates.promptPrefix,
    slashCommand: updates.title,
    title: updates.title,
  };

  if (nextCard.kind === "custom" && nextCard.isNew && isBlankCard(nextCard)) {
    return {
      saved: false,
      state: {
        ...state,
        custom: state.custom
          .filter((card) => card.id !== nextCard.id)
          .map(copyForState),
      },
    };
  }

  const error = validateSlashCardDraft(state, nextCard, zh);
  if (error) {
    nextCard.error = error;
    return {
      saved: false,
      state:
        nextCard.kind === "builtin"
          ? {
              ...state,
              builtins: replaceCard(state.builtins, nextCard),
            }
          : {
              ...state,
              custom: replaceCard(state.custom, nextCard),
            },
    };
  }

  nextCard.error = null;
  nextCard.isNew = false;
  return {
    saved: true,
    state:
      nextCard.kind === "builtin"
        ? {
            ...state,
            builtins: replaceCard(state.builtins, nextCard),
          }
        : {
            ...state,
            custom: replaceCard(state.custom, nextCard),
          },
  };
}

export function registerPreferencesPane(
  win: Window,
  deps: PreferencesPaneDeps = {
    exportDebugLog,
    getSettings,
    saveSettings,
    validateEvidenceSettings,
  },
): void {
  const doc = win.document as PreferencesDocument;
  const root = doc.getElementById(ROOT_ID);
  if (!root) {
    return;
  }

  const settings = deps.getSettings();
  let slashState = createSlashSettingsState(settings.customPresets);
  debugLog.info("settings.pane.load", { surface: "settings" });
  hydrateForm(doc, settings, slashState);

  const persist = () => {
    const traceId = createTraceId("settings-save");
    const values = readFormValues(doc);
    debugLog.info("settings.save.start", {
      evidenceProviderMode: values.evidenceProviderMode,
      hasMcpEndpoint: Boolean(values.mcpEndpoint?.trim()),
      surface: "settings",
      traceId,
    });

    const customPresetsResult = parseCustomPresets(values.customPresets || "");
    if (customPresetsResult.error) {
      setStatusText(
        getStatusElement(doc),
        `Could not save slash commands: ${customPresetsResult.error}`,
        "error",
      );
      debugLog.warn("settings.save.blocked", {
        reason: "invalid-custom-presets",
        surface: "settings",
        traceId,
      });
      return;
    }

    deps.saveSettings(values);
    applyEvidenceProviderVisibility(doc, values.evidenceProviderMode);
    EventBus.getInstance().dispatchEvent(
      createHostEvent("settingsChange", win),
    );
    debugLog.info("settings.save.success", {
      surface: "settings",
      traceId,
    });
    setLocalizedStatus(doc, "ai-assistant-pref-status-saved", "success");
  };

  const validateEvidence = async () => {
    const traceId = createTraceId("settings-evidence-validate");
    const values = readFormValues(doc);
    debugLog.info("settings.evidence.validate.start", {
      evidenceProviderMode: values.evidenceProviderMode,
      hasMcpEndpoint: Boolean(values.mcpEndpoint?.trim()),
      surface: "settings",
      traceId,
    });
    setStatusText(
      getEvidenceStatusElement(doc),
      "Validating evidence provider...",
      "success",
    );
    const result = await deps.validateEvidenceSettings(values);
    if (result.valid) {
      debugLog.info("settings.evidence.validate.success", {
        surface: "settings",
        traceId,
      });
      setStatusText(
        getEvidenceStatusElement(doc),
        "Evidence provider settings look good",
        "success",
      );
      return;
    }

    debugLog.warn("settings.evidence.validate.error", {
      errorMessage: result.error || "Evidence validation failed",
      surface: "settings",
      traceId,
    });
    setStatusText(
      getEvidenceStatusElement(doc),
      result.error || "Evidence validation failed",
      "error",
    );
  };

  const exportLog = async () => {
    const traceId = createTraceId("settings-export-debug-log");
    const status = getStatusElement(doc);
    const outputPath = buildDebugLogExportPath();
    debugLog.info("settings.debugLog.export.start", {
      hasOutputPath: Boolean(outputPath),
      surface: "settings",
      traceId,
    });
    if (!outputPath) {
      setStatusText(
        status,
        "Could not determine a debug log export path",
        "error",
      );
      return;
    }

    try {
      const exportedPath = await deps.exportDebugLog(outputPath);
      setStatusText(status, `Debug log exported to ${exportedPath}`, "success");
      debugLog.info("settings.debugLog.export.success", {
        surface: "settings",
        traceId,
      });
    } catch (error) {
      const message =
        error instanceof Error && error.message ? error.message : "Export failed";
      setStatusText(status, `Debug log export failed: ${message}`, "error");
      debugLog.error("settings.debugLog.export.error", error, {
        surface: "settings",
        traceId,
      });
    }
  };

  const generateBackup = () => {
    const backupText = buildSettingsBackupJSON(readFormValues(doc));
    const field = getField(doc, BACKUP_TEXT_ID);
    if (field) {
      field.value = backupText;
    }
    setStatusText(
      getBackupStatusElement(doc),
      "Configuration backup JSON generated.",
      "success",
    );
  };

  const copyBackup = () => {
    const field = getField(doc, BACKUP_TEXT_ID);
    const value = field?.value?.trim() || buildSettingsBackupJSON(readFormValues(doc));
    if (field) {
      field.value = value;
    }
    copyTextToClipboard(value);
    setStatusText(
      getBackupStatusElement(doc),
      "Configuration backup JSON copied.",
      "success",
    );
  };

  const exportBackup = async () => {
    const field = getField(doc, BACKUP_TEXT_ID);
    const value = field?.value?.trim() || buildSettingsBackupJSON(readFormValues(doc));
    if (field) {
      field.value = value;
    }
    const target = buildBackupExportPath();
    if (!target) {
      setStatusText(
        getBackupStatusElement(doc),
        "Could not determine a backup export path.",
        "error",
      );
      return;
    }
    try {
      await writeLocalTextFile(target, value);
      setStatusText(
        getBackupStatusElement(doc),
        `Configuration backup exported to ${target}`,
        "success",
      );
    } catch (error) {
      setStatusText(
        getBackupStatusElement(doc),
        `Backup export failed: ${formatErrorMessage(error)}`,
        "error",
      );
    }
  };

  const importBackup = () => {
    const field = getField(doc, BACKUP_TEXT_ID);
    const value = field?.value?.trim() || "";
    const result = parseSettingsBackupJSON(value);
    if (!result.ok) {
      setStatusText(
        getBackupStatusElement(doc),
        result.error || "Invalid backup JSON.",
        "error",
      );
      return;
    }

    deps.saveSettings(result.settings);
    slashState = createSlashSettingsState(result.settings.customPresets || "");
    hydrateForm(doc, deps.getSettings(), slashState);
    rerenderSlash();
    EventBus.getInstance().dispatchEvent(
      createHostEvent("settingsChange", win),
    );
    setStatusText(
      getBackupStatusElement(doc),
      "Configuration backup imported.",
      "success",
    );
  };

  const saveSyncSettings = () => {
    deps.saveSettings(readFormValues(doc));
    EventBus.getInstance().dispatchEvent(
      createHostEvent("settingsChange", win),
    );
  };

  const testSync = async () => {
    saveSyncSettings();
    setStatusText(getSyncStatusElement(doc), "Testing sync endpoint...", "success");
    const result = await testConfigSync(readFormValues(doc), doc);
    setStatusText(
      getSyncStatusElement(doc),
      result.message,
      result.ok ? "success" : "error",
    );
  };

  const pushSync = async () => {
    saveSyncSettings();
    const backup = buildSettingsBackupJSON(readFormValues(doc));
    setStatusText(getSyncStatusElement(doc), "Uploading configuration...", "success");
    const result = await pushConfigSync(readFormValues(doc), backup, doc);
    if (result.ok) {
      deps.saveSettings({ configSyncSnapshot: backup });
    }
    setStatusText(
      getSyncStatusElement(doc),
      result.message,
      result.ok ? "success" : "error",
    );
  };

  const pullSync = async () => {
    saveSyncSettings();
    setStatusText(getSyncStatusElement(doc), "Downloading configuration...", "success");
    const result = await pullConfigSync(readFormValues(doc), doc);
    if (!result.ok || !result.backupText) {
      setStatusText(
        getSyncStatusElement(doc),
        result.message,
        "error",
      );
      return;
    }
    const parsed = parseSettingsBackupJSON(result.backupText);
    if (!parsed.ok) {
      setStatusText(
        getSyncStatusElement(doc),
        parsed.error || "Downloaded backup JSON is invalid.",
        "error",
      );
      return;
    }
    deps.saveSettings({
      ...parsed.settings,
      configSyncSnapshot: result.backupText,
    });
    slashState = createSlashSettingsState(parsed.settings.customPresets || "");
    hydrateForm(doc, deps.getSettings(), slashState);
    rerenderSlash();
    EventBus.getInstance().dispatchEvent(
      createHostEvent("settingsChange", win),
    );
    setStatusText(
      getSyncStatusElement(doc),
      "Configuration downloaded and applied.",
      "success",
    );
  };

  const rerenderSlash = () => {
    renderSlashSettings(doc, slashState);
    syncSlashStorageField(doc, slashState);
    bindSlashCardInteractions(doc, () => slashState, (nextState, shouldSave) => {
      slashState = nextState;
      rerenderSlash();
      if (shouldSave) {
        persist();
      }
    });
  };

  bindFieldEvent(doc, CUSTOM_PRESETS_ID, "change", () => {
    const raw = getField(doc, CUSTOM_PRESETS_ID)?.value || "";
    const parsed = parseCustomPresets(raw);
    if (parsed.error) {
      setStatusText(getStatusElement(doc), parsed.error, "error");
      return;
    }

    slashState = createSlashSettingsState(raw);
    rerenderSlash();
    persist();
  });
  bindTriggeredFieldEvents(
    doc,
    EVIDENCE_PROVIDER_ID,
    ["change", "command"],
    () => persist(),
  );
  bindTriggeredFieldEvents(
    doc,
    WORKSPACE_LAYOUT_ID,
    ["change", "command"],
    () => persist(),
  );
  bindTriggeredFieldEvents(
    doc,
    ICON_PLACEMENT_ID,
    ["change", "command"],
    () => persist(),
  );
  bindFieldEvent(doc, MCP_ENDPOINT_ID, "change", () => persist());
  bindFieldEvent(doc, MCP_AUTH_TOKEN_ID, "change", () => persist());
  bindFieldEvent(doc, SYNC_ENABLED_ID, "change", () => persist());
  bindFieldEvent(doc, SYNC_ENDPOINT_ID, "change", () => persist());
  bindFieldEvent(doc, SYNC_REMOTE_PATH_ID, "change", () => persist());
  bindFieldEvent(doc, SYNC_USERNAME_ID, "change", () => persist());
  bindFieldEvent(doc, SYNC_PASSWORD_ID, "change", () => persist());
  bindTriggeredFieldEvents(doc, THEME_MODE_ID, ["change", "command"], () => persist());
  bindTriggeredFieldEvents(doc, THINKING_EFFORT_ID, ["change", "command"], () => persist());
  bindFieldEvent(doc, SELECTION_TOOLBAR_ID, "change", () => persist());
  bindFieldEvent(doc, TOKEN_DISPLAY_ID, "change", () => persist());
  bindFieldEvent(doc, QUICK_PROMPTS_ID_PREF, "change", () => persist());
  bindButtonActivation(doc, SLASH_ADD_ID, () => {
    const next = addCustomSlashCard(slashState);
    if (next === slashState) {
      return;
    }
    slashState = next;
    rerenderSlash();
  });
  bindButtonActivation(doc, SAVE_BUTTON_ID, () => persist());
  bindButtonActivation(doc, EXPORT_DEBUG_LOG_BUTTON_ID, () => {
    void exportLog();
  });
  bindButtonActivation(doc, EVIDENCE_VALIDATE_BUTTON_ID, () => {
    void validateEvidence();
  });
  bindButtonActivation(doc, BACKUP_GENERATE_ID, () => generateBackup());
  bindButtonActivation(doc, BACKUP_COPY_ID, () => copyBackup());
  bindButtonActivation(doc, BACKUP_EXPORT_ID, () => {
    void exportBackup();
  });
  bindButtonActivation(doc, BACKUP_IMPORT_ID, () => importBackup());
  bindButtonActivation(doc, SYNC_TEST_ID, () => {
    void testSync();
  });
  bindButtonActivation(doc, SYNC_PUSH_ID, () => {
    void pushSync();
  });
  bindButtonActivation(doc, SYNC_PULL_ID, () => {
    void pullSync();
  });
  rerenderSlash();
}

function hydrateForm(
  doc: PreferencesDocument,
  settings: ReturnType<typeof getSettings>,
  slashState: SlashSettingsState,
): void {
  const customPresetsField = getField(doc, CUSTOM_PRESETS_ID);
  const evidenceProviderField = getField(doc, EVIDENCE_PROVIDER_ID);
  const iconPlacementField = getField(doc, ICON_PLACEMENT_ID);
  const mcpAuthTokenField = getField(doc, MCP_AUTH_TOKEN_ID);
  const mcpEndpointField = getField(doc, MCP_ENDPOINT_ID);
  const syncEnabledField = getField(doc, SYNC_ENABLED_ID);
  const syncEndpointField = getField(doc, SYNC_ENDPOINT_ID);
  const syncPasswordField = getField(doc, SYNC_PASSWORD_ID);
  const syncRemotePathField = getField(doc, SYNC_REMOTE_PATH_ID);
  const syncUsernameField = getField(doc, SYNC_USERNAME_ID);
  const workspaceLayoutField = getField(doc, WORKSPACE_LAYOUT_ID);
  const themeModeField = getField(doc, THEME_MODE_ID);
  const thinkingEffortField = getField(doc, THINKING_EFFORT_ID);
  const selectionToolbarField = getField(doc, SELECTION_TOOLBAR_ID);
  const tokenDisplayField = getField(doc, TOKEN_DISPLAY_ID);
  const quickPromptsField = getField(doc, QUICK_PROMPTS_ID_PREF);

  if (customPresetsField) {
    customPresetsField.value = serializeSlashSettingsState(slashState);
  }
  if (evidenceProviderField) {
    evidenceProviderField.value = settings.evidenceProviderMode;
  }
  if (workspaceLayoutField) {
    workspaceLayoutField.value = settings.workspaceLayout;
  }
  if (iconPlacementField) {
    iconPlacementField.value = settings.iconPlacement;
  }
  if (mcpAuthTokenField) {
    mcpAuthTokenField.value = settings.mcpAuthToken || "";
  }
  if (mcpEndpointField) {
    mcpEndpointField.value = settings.mcpEndpoint || "";
  }
  if (syncEnabledField) {
    syncEnabledField.checked = settings.configSyncEnabled;
  }
  if (syncEndpointField) {
    syncEndpointField.value = settings.configSyncEndpoint || "";
  }
  if (syncRemotePathField) {
    syncRemotePathField.value =
      settings.configSyncRemotePath || DEFAULT_CONFIG_SYNC_REMOTE_PATH;
  }
  if (syncUsernameField) {
    syncUsernameField.value = settings.configSyncUsername || "";
  }
  if (syncPasswordField) {
    syncPasswordField.value = settings.configSyncPassword || "";
  }
  if (themeModeField) {
    themeModeField.value = settings.themeMode || "auto";
  }
  if (thinkingEffortField) {
    thinkingEffortField.value = settings.defaultThinkingEffort || "none";
  }
  if (selectionToolbarField) {
    selectionToolbarField.checked = settings.selectionToolbarEnabled !== false;
  }
  if (tokenDisplayField) {
    tokenDisplayField.checked = settings.tokenDisplayEnabled !== false;
  }
  if (quickPromptsField) {
    quickPromptsField.checked = settings.quickPromptsEnabled !== false;
  }
  applyEvidenceProviderVisibility(doc, settings.evidenceProviderMode);
}

function renderSlashSettings(
  doc: PreferencesDocument,
  state: SlashSettingsState,
): void {
  const custom = doc.getElementById(SLASH_CUSTOM_ID) as
    | PreferencesContainerElement
    | null;
  if (!custom) {
    return;
  }

  replaceContainerChildren(
    custom,
    createSlashSectionElement(doc, {
      cards: state.custom,
      emptyText: "No custom skills yet",
      kind: "custom",
      title: "My skills",
    }),
  );
  updateSlashLimitStatus(doc, state);
}

function createSlashSectionElement(
  doc: PreferencesDocument,
  {
    cards,
    emptyText,
    kind,
    title,
  }: {
    cards: SlashCardDraft[];
    emptyText: string;
    kind: "builtin" | "custom";
    title: string;
  },
): HTMLElement {
  const section = createHtmlElement(doc, "section", {
    style: "display: flex; flex-direction: column; gap: 12px;",
  });
  const header = createHtmlElement(doc, "div", {
    style: "display: flex; flex-direction: column; gap: 5px;",
  });
  header.appendChild(createHtmlElement(doc, "strong", { text: title }));
  header.appendChild(
    createHtmlElement(doc, "span", {
      style: "opacity: 0.78;",
      text:
        "Add your own skills here. Leaving a card saves it automatically, and blank new cards are discarded.",
    }),
  );
  section.appendChild(header);

  const body = createHtmlElement(doc, "div", {
    style: "display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px;",
  });
  if (cards.length === 0) {
    body.appendChild(
      createHtmlElement(doc, "div", {
        style:
          "border: 1px dashed rgba(0,0,0,0.18); border-radius: 10px; padding: 14px; color: rgba(0,0,0,0.62); background: rgba(127,127,127,0.04);",
        text: emptyText,
      }),
    );
  } else {
    cards.forEach((card) => {
      body.appendChild(createSlashCardElement(doc, card));
    });
  }

  section.appendChild(body);
  return section;
}

function createSlashCardElement(
  doc: PreferencesDocument,
  card: SlashCardDraft,
): HTMLElement {
  const cardElement = createHtmlElement(doc, "div", {
    attributes: {
      "data-slash-card": "true",
      "data-slash-card-id": card.id,
      "data-slash-card-kind": card.kind,
    },
    style:
      "border: 1px solid rgba(127,127,127,0.22); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 10px; background: rgba(127,127,127,0.08); box-shadow: 0 1px 4px rgba(0,0,0,0.04);",
  });

  const header = createHtmlElement(doc, "div", {
    style:
      "display: flex; justify-content: space-between; gap: 8px; align-items: center; flex-wrap: wrap;",
  });
  header.appendChild(
    createHtmlElement(doc, "strong", {
      text: "Custom skill",
    }),
  );
  header.appendChild(
    createHtmlElement(doc, "button", {
      attributes: {
        "data-slash-action": "delete",
        "data-slash-card-id": card.id,
        "data-slash-card-kind": card.kind,
        type: "button",
      },
      style:
        "border-radius: 999px; min-height: 26px; padding: 3px 10px;",
      text: "Delete skill",
    }),
  );
  cardElement.appendChild(header);
  cardElement.appendChild(
    createSlashFieldElement(doc, {
      label: "Title",
      name: "title",
      value: card.title,
    }),
  );
  cardElement.appendChild(
    createSlashFieldElement(doc, {
      label: "Prompt text",
      multiline: true,
      name: "promptPrefix",
      value: card.promptPrefix,
    }),
  );

  if (card.error) {
    cardElement.appendChild(
      createHtmlElement(doc, "div", {
        attributes: { "data-slash-error": "true" },
        style: "color: #b42318; font-size: 12px;",
        text: card.error,
      }),
    );
  }

  return cardElement;
}

function createSlashFieldElement(
  doc: PreferencesDocument,
  {
    label,
    multiline,
    name,
    value,
  }: {
    label: string;
    multiline?: boolean;
    name: "promptPrefix" | "title";
    value: string;
  },
): HTMLElement {
  const wrapper = createHtmlElement(doc, "label", {
    style: "display: flex; flex-direction: column; gap: 5px;",
  });
  wrapper.appendChild(createHtmlElement(doc, "span", { text: label }));
  const field = multiline
    ? createHtmlElement(doc, "textarea", {
        attributes: { "data-slash-field": name },
        style:
          "box-sizing: border-box; min-height: 92px; resize: vertical; width: 100%; border-radius: 8px; padding: 7px 9px;",
        value,
      })
    : createHtmlElement(doc, "input", {
        attributes: { "data-slash-field": name },
        style:
          "box-sizing: border-box; width: 100%; border-radius: 8px; padding: 7px 9px;",
        value,
      });
  wrapper.appendChild(field);
  return wrapper;
}

function createHtmlElement<K extends keyof HTMLElementTagNameMap>(
  doc: PreferencesDocument,
  tag: K,
  options: {
    attributes?: Record<string, string>;
    style?: string;
    text?: string;
    value?: string;
  } = {},
): HTMLElementTagNameMap[K] {
  const element = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (options.style) {
    element.setAttribute("style", options.style);
  }
  Object.entries(options.attributes || {}).forEach(([key, value]) => {
    element.setAttribute(key, value);
  });
  if (typeof options.text === "string") {
    element.textContent = options.text;
  }
  if (typeof options.value === "string") {
    (element as unknown as PreferencesFieldElement).value = options.value;
  }
  return element;
}

function replaceContainerChildren(
  container: PreferencesContainerElement,
  child: HTMLElement,
): void {
  if (typeof container.replaceChildren === "function") {
    container.replaceChildren(child);
    return;
  }

  container.textContent = "";
  container.appendChild(child);
}

function bindSlashCardInteractions(
  doc: PreferencesDocument,
  getState: () => SlashSettingsState,
  setState: (state: SlashSettingsState, shouldSave: boolean) => void,
): void {
  const containers = [
    doc.getElementById(SLASH_CUSTOM_ID),
  ].filter(Boolean) as Array<
    HTMLElement & {
      querySelectorAll?: (selector: string) => NodeListOf<Element>;
    }
  >;

  for (const container of containers) {
    if (typeof container.querySelectorAll !== "function") {
      continue;
    }

    const cards = container.querySelectorAll(
      "[data-slash-card]",
    ) as NodeListOf<HTMLElement>;
    cards.forEach((card: HTMLElement) => {
      card.addEventListener("focusout", (event: Event) => {
        const nextTarget = (event as FocusEvent).relatedTarget as
          | Node
          | null
          | undefined;
        if (
          nextTarget &&
          typeof card.contains === "function" &&
          card.contains(nextTarget)
        ) {
          return;
        }

        const kind = (card.getAttribute("data-slash-card-kind") ||
          "custom") as SlashCardDraft["kind"];
        const id = card.getAttribute("data-slash-card-id") || "";
        if (!id) {
          return;
        }
        const result = commitSlashCardEdit(
          getState(),
          { id, kind },
          readSlashCardValues(card),
        );
        const removedBlank =
          kind === "custom" &&
          !getState().custom.some((item) => item.id === id) &&
          !result.state.custom.some((item) => item.id === id);
        setState(result.state, result.saved || removedBlank);
      });
    });

    const actions = container.querySelectorAll(
      "[data-slash-action]",
    ) as NodeListOf<HTMLElement>;
    actions.forEach((button: HTMLElement) => {
      button.addEventListener("click", () => {
        const action = button.getAttribute("data-slash-action");
        const kind = (button.getAttribute("data-slash-card-kind") ||
          "custom") as SlashCardDraft["kind"];
        const id = button.getAttribute("data-slash-card-id") || "";
        if (!id) {
          return;
        }

        if (action === "delete" && kind === "custom") {
          setState(
            {
              ...getState(),
              custom: getState().custom
                .filter((card) => card.id !== id)
                .map(copyForState),
            },
            true,
          );
        }
      });
    });
  }
}

function readSlashCardValues(
  card: HTMLElement & {
    querySelector?: (selector: string) => Element | null;
  },
): Pick<SlashCardDraft, "promptPrefix" | "slashCommand" | "title"> {
  const readValue = (name: string) =>
    (
      card.querySelector?.(
        `[data-slash-field="${name}"]`,
      ) as PreferencesFieldElement | null
    )?.value || "";

  return {
    promptPrefix: readValue("promptPrefix"),
    slashCommand: readValue("title"),
    title: readValue("title"),
  };
}

function syncSlashStorageField(
  doc: PreferencesDocument,
  slashState: SlashSettingsState,
): void {
  const field = getField(doc, CUSTOM_PRESETS_ID);
  if (field) {
    field.value = serializeSlashSettingsState(slashState);
  }
}

function updateSlashLimitStatus(
  doc: PreferencesDocument,
  state: SlashSettingsState,
): void {
  const status = doc.getElementById(SLASH_LIMIT_STATUS_ID) as
    | PreferencesStatusElement
    | null;
  const addButton = getField(doc, SLASH_ADD_ID);
  if (status) {
    status.textContent = "You can add up to 1000 custom skills";
  }
  setDisabled(addButton, state.custom.length >= MAX_CUSTOM_SLASH_COMMANDS);
}

function readFormValues(doc: PreferencesDocument): Partial<PersistedSettings> {
  const customPresetsField = getField(doc, CUSTOM_PRESETS_ID);
  const evidenceProviderField = getField(doc, EVIDENCE_PROVIDER_ID);
  const iconPlacementField = getField(doc, ICON_PLACEMENT_ID);
  const mcpAuthTokenField = getField(doc, MCP_AUTH_TOKEN_ID);
  const mcpEndpointField = getField(doc, MCP_ENDPOINT_ID);
  const syncEnabledField = getField(doc, SYNC_ENABLED_ID);
  const syncEndpointField = getField(doc, SYNC_ENDPOINT_ID);
  const syncPasswordField = getField(doc, SYNC_PASSWORD_ID);
  const syncRemotePathField = getField(doc, SYNC_REMOTE_PATH_ID);
  const syncUsernameField = getField(doc, SYNC_USERNAME_ID);
  const workspaceLayoutField = getField(doc, WORKSPACE_LAYOUT_ID);
  const themeModeField = getField(doc, THEME_MODE_ID);
  const thinkingEffortField = getField(doc, THINKING_EFFORT_ID);
  const selectionToolbarField = getField(doc, SELECTION_TOOLBAR_ID);
  const tokenDisplayField = getField(doc, TOKEN_DISPLAY_ID);
  const quickPromptsField = getField(doc, QUICK_PROMPTS_ID_PREF);

  const selectedProvider = evidenceProviderField?.value;
  const evidenceProviderMode =
    selectedProvider === "mcp-http" || selectedProvider === "mcp-web-search"
      ? selectedProvider
      : DEFAULT_EVIDENCE_PROVIDER_MODE;
  const selectedLayout = workspaceLayoutField?.value;
  const workspaceLayout =
    selectedLayout === "compact" ||
    selectedLayout === "stacked"
      ? selectedLayout
      : DEFAULT_SETTINGS.workspaceLayout;
  const selectedIconPlacement = iconPlacementField?.value;
  const iconPlacement =
    selectedIconPlacement === "reader-sidebar" ||
    selectedIconPlacement === "reader-toolbar" ||
    selectedIconPlacement === "both"
      ? selectedIconPlacement
      : DEFAULT_SETTINGS.iconPlacement;

  return {
    configSyncEnabled: Boolean(syncEnabledField?.checked),
    configSyncEndpoint: syncEndpointField?.value?.trim?.() ?? "",
    configSyncPassword: syncPasswordField?.value ?? "",
    configSyncRemotePath:
      syncRemotePathField?.value?.trim?.() ?? DEFAULT_CONFIG_SYNC_REMOTE_PATH,
    configSyncUsername: syncUsernameField?.value ?? "",
    customPresets: customPresetsField?.value ?? "",
    evidenceProviderMode,
    iconPlacement,
    mcpAuthToken: mcpAuthTokenField?.value?.trim?.() ?? "",
    mcpEndpoint: mcpEndpointField?.value?.trim?.() ?? "",
    mcpToolArgumentsTemplate: DEFAULT_MCP_TOOL_ARGUMENTS_TEMPLATE,
    mcpToolName: DEFAULT_SETTINGS.mcpToolName,
    workspaceLayout,
    themeMode: themeModeField?.value === "light" || themeModeField?.value === "dark" || themeModeField?.value === "auto" ? themeModeField.value : "auto",
    defaultThinkingEffort: thinkingEffortField?.value as any || "none",
    selectionToolbarEnabled: selectionToolbarField?.checked !== false,
    tokenDisplayEnabled: tokenDisplayField?.checked !== false,
    quickPromptsEnabled: quickPromptsField?.checked !== false,
  };
}

function applyEvidenceProviderVisibility(
  doc: PreferencesDocument,
  providerMode: Partial<PersistedSettings>["evidenceProviderMode"] = DEFAULT_EVIDENCE_PROVIDER_MODE,
): void {
  const mcpSettings = doc.getElementById(MCP_SETTINGS_ID) as
    | (HTMLElement & { style?: { display?: string } })
    | null;

  if (mcpSettings?.style) {
    mcpSettings.style.display = providerMode === "mcp-http" ? "" : "none";
  }
}

function getField(
  doc: PreferencesDocument,
  id: string,
):
  | (PreferencesFieldElement & {
      addEventListener(type: string, listener: (...args: any[]) => void): void;
      removeEventListener?(
        type: string,
        listener: (...args: any[]) => void,
      ): void;
    })
  | null {
  return doc.getElementById(id) as any;
}

function getInteractiveElement(
  doc: PreferencesDocument,
  id: string,
):
  | (PreferencesInteractiveElement & {
      addEventListener(type: string, listener: (...args: any[]) => void): void;
      removeEventListener?(
        type: string,
        listener: (...args: any[]) => void,
      ): void;
    })
  | null {
  return doc.getElementById(id) as any;
}

function bindFieldEvent(
  doc: PreferencesDocument,
  id: string,
  type: string,
  listener: (event?: Event) => void,
): void {
  const field = getInteractiveElement(doc, id);
  if (!field) {
    return;
  }

  const listeners =
    field.__aiAssistantListeners ?? new Map<string, EventListener>();
  const previous = listeners.get(type);
  if (previous && typeof field.removeEventListener === "function") {
    field.removeEventListener(type, previous);
  }

  const eventListener = ((event: Event) => listener(event)) as EventListener;
  field.addEventListener(type, eventListener);
  listeners.set(type, eventListener);
  field.__aiAssistantListeners = listeners;
}

function bindTriggeredFieldEvents(
  doc: PreferencesDocument,
  id: string,
  types: string[],
  listener: () => void,
): void {
  const field = getInteractiveElement(doc, id);
  if (!field) {
    return;
  }

  let scheduledToken = 0;
  const invoke = () => {
    const token = ++scheduledToken;
    void Promise.resolve().then(() => {
      if (token === scheduledToken) {
        listener();
      }
    });
  };

  const listeners =
    field.__aiAssistantListeners ?? new Map<string, EventListener>();
  for (const type of types) {
    const listenerKey = `trigger:${type}`;
    const previous = listeners.get(listenerKey);
    if (previous && typeof field.removeEventListener === "function") {
      field.removeEventListener(type, previous);
    }

    const eventListener = (() => invoke()) as EventListener;
    field.addEventListener(type, eventListener);
    listeners.set(listenerKey, eventListener);
  }

  field.__aiAssistantListeners = listeners;
}

function bindButtonActivation(
  doc: PreferencesDocument,
  id: string,
  listener: () => void,
): void {
  let lastActivation:
    | {
        at: number;
        type: "click" | "command";
      }
    | null = null;

  const invokeFrom = (type: "click" | "command") => {
    const now = Date.now();
    if (
      lastActivation &&
      lastActivation.type !== type &&
      now - lastActivation.at <= BUTTON_ACTIVATION_DEDUPE_WINDOW_MS
    ) {
      lastActivation = null;
      return;
    }

    lastActivation = { at: now, type };
    listener();
  };

  bindFieldEvent(doc, id, "command", () => invokeFrom("command"));
  bindFieldEvent(doc, id, "click", () => invokeFrom("click"));
}

function bindExternalLink(
  doc: PreferencesDocument,
  id: string,
  href: string,
): void {
  bindFieldEvent(doc, id, "click", (event) => {
    openPreferencesLink(
      href,
      event as { preventDefault?: () => void } | undefined,
    );
  });
}

export function openPreferencesLink(
  href: string,
  event?: { preventDefault?: () => void },
): void {
  const launchURL = (
    globalThis as { Zotero?: { launchURL?: (url: string) => void } }
  ).Zotero?.launchURL;
  if (typeof launchURL !== "function") {
    return;
  }

  event?.preventDefault?.();
  launchURL(href);
}

function setLocalizedStatus(
  doc: PreferencesDocument,
  l10nId: string,
  variant: "success" | "error",
): void {
  const status = getStatusElement(doc);
  if (!status) {
    return;
  }

  status.dataset.variant = variant;
  const formatted = doc.l10n?.formatValue?.(l10nId);
  if (typeof (formatted as Promise<string>)?.then === "function") {
    void Promise.resolve(formatted).then((value) => {
      status.textContent = String(value);
    });
    return;
  }

  status.textContent = formatted ? String(formatted) : l10nId;
}

function setStatusText(
  status: PreferencesStatusElement | null,
  value: string,
  variant: "success" | "error",
): void {
  if (!status) {
    return;
  }

  status.dataset.variant = variant;
  status.textContent = value;
}

function setDisabled(
  field: (PreferencesFieldElement & {
    removeAttribute?: (name: string) => void;
    setAttribute?: (name: string, value: string) => void;
  }) | null,
  disabled: boolean,
): void {
  if (!field) {
    return;
  }

  field.disabled = disabled;
  if (disabled) {
    field.setAttribute?.("disabled", "disabled");
  } else {
    field.removeAttribute?.("disabled");
    field.disabled = false;
  }
}

function getStatusElement(
  doc: PreferencesDocument,
): PreferencesStatusElement | null {
  return doc.getElementById(STATUS_ID) as PreferencesStatusElement | null;
}

function getEvidenceStatusElement(
  doc: PreferencesDocument,
): PreferencesStatusElement | null {
  return doc.getElementById(
    EVIDENCE_STATUS_ID,
  ) as PreferencesStatusElement | null;
}

function getBackupStatusElement(
  doc: PreferencesDocument,
): PreferencesStatusElement | null {
  return doc.getElementById(BACKUP_STATUS_ID) as PreferencesStatusElement | null;
}

function getSyncStatusElement(
  doc: PreferencesDocument,
): PreferencesStatusElement | null {
  return doc.getElementById(SYNC_STATUS_ID) as PreferencesStatusElement | null;
}

function buildDebugLogExportPath(): string | null {
  const tempDir =
    (globalThis as { PathUtils?: { tempDir?: string } }).PathUtils?.tempDir ||
    (globalThis as { OS?: { Constants?: { Path?: { tmpDir?: string } } } }).OS
      ?.Constants?.Path?.tmpDir ||
    null;
  if (!tempDir) {
    return null;
  }

  const separator = tempDir.includes("\\") ? "\\" : "/";
  return `${tempDir}${separator}zotero-webai-debug-${Date.now()}.jsonl`;
}

function buildBackupExportPath(): string | null {
  const tempDir =
    (globalThis as { PathUtils?: { tempDir?: string } }).PathUtils?.tempDir ||
    (globalThis as { OS?: { Constants?: { Path?: { tmpDir?: string } } } }).OS
      ?.Constants?.Path?.tmpDir ||
    null;
  if (!tempDir) {
    return null;
  }

  const separator = tempDir.includes("\\") ? "\\" : "/";
  return `${tempDir}${separator}Paperly-AI-config-${Date.now()}.json`;
}

function buildSettingsBackupJSON(
  overrides?: Partial<PersistedSettings>,
): string {
  const settings = {
    ...getSettings(),
    ...overrides,
  };

  return JSON.stringify(
    {
      app: "Paperly AI",
      backupVersion: 1,
      exportedAt: new Date().toISOString(),
      settings: pickBackupSettings(settings),
    },
    null,
    2,
  );
}

function pickBackupSettings(
  settings: Partial<PersistedSettings>,
): Partial<PersistedSettings> {
  return {
    configSyncEnabled: Boolean(settings.configSyncEnabled),
    configSyncEndpoint: settings.configSyncEndpoint || "",
    configSyncPassword: settings.configSyncPassword || "",
    configSyncRemotePath:
      settings.configSyncRemotePath || DEFAULT_CONFIG_SYNC_REMOTE_PATH,
    configSyncUsername: settings.configSyncUsername || "",
    customPresets: settings.customPresets || "",
    evidenceProviderMode:
      settings.evidenceProviderMode || DEFAULT_EVIDENCE_PROVIDER_MODE,
    iconPlacement: settings.iconPlacement || DEFAULT_SETTINGS.iconPlacement,
    keyboardShortcut: settings.keyboardShortcut || DEFAULT_SETTINGS.keyboardShortcut,
    maxContextBudget:
      Number(settings.maxContextBudget) || DEFAULT_SETTINGS.maxContextBudget,
    mcpAuthToken: settings.mcpAuthToken || "",
    mcpEndpoint: settings.mcpEndpoint || DEFAULT_SETTINGS.mcpEndpoint,
    mcpToolArgumentsTemplate:
      settings.mcpToolArgumentsTemplate || DEFAULT_MCP_TOOL_ARGUMENTS_TEMPLATE,
    mcpToolName: settings.mcpToolName || DEFAULT_SETTINGS.mcpToolName,
    workspaceLayout: settings.workspaceLayout || DEFAULT_SETTINGS.workspaceLayout,
    themeMode: settings.themeMode || "auto",
    defaultThinkingEffort: settings.defaultThinkingEffort || "none",
    selectionToolbarEnabled: settings.selectionToolbarEnabled !== false,
    tokenDisplayEnabled: settings.tokenDisplayEnabled !== false,
    quickPromptsEnabled: settings.quickPromptsEnabled !== false,
  };
}

function parseSettingsBackupJSON(value: string): {
  error?: string;
  ok: boolean;
  settings: Partial<PersistedSettings>;
} {
  if (!value.trim()) {
    return { error: "Backup JSON is empty.", ok: false, settings: {} };
  }

  try {
    const parsed = JSON.parse(value) as
      | { settings?: Partial<PersistedSettings> }
      | Partial<PersistedSettings>;
    const source = (
      parsed && typeof parsed === "object" && "settings" in parsed
        ? parsed.settings
        : parsed
    ) as Partial<PersistedSettings> | undefined;
    if (!source || typeof source !== "object") {
      return { error: "Backup JSON does not contain settings.", ok: false, settings: {} };
    }
    return {
      ok: true,
      settings: pickBackupSettings(source),
    };
  } catch (error) {
    return {
      error: `Invalid backup JSON: ${formatErrorMessage(error)}`,
      ok: false,
      settings: {},
    };
  }
}

async function writeLocalTextFile(path: string, text: string): Promise<void> {
  const zoteroFile = (globalThis as { Zotero?: { File?: {
    putContentsAsync?: (target: string, contents: string) => Promise<unknown>;
  } } }).Zotero?.File;
  if (typeof zoteroFile?.putContentsAsync === "function") {
    await zoteroFile.putContentsAsync(path, text);
    return;
  }
  throw new Error("Zotero file writer is unavailable");
}

async function testConfigSync(
  settings: Partial<PersistedSettings>,
  doc: PreferencesDocument,
): Promise<{ message: string; ok: boolean }> {
  const url = buildConfigSyncURL(settings);
  if (!url) {
    return { message: "Sync endpoint is required.", ok: false };
  }
  try {
    const response = await fetchWithConfigSyncAuth(doc, url, {
      method: "GET",
    }, settings);
    if (response.ok) {
      return { message: "Sync endpoint connected; remote backup exists.", ok: true };
    }
    if (response.status === 404) {
      return {
        message: "Sync endpoint connected; remote backup file does not exist yet.",
        ok: true,
      };
    }
    return {
      message: `Sync test failed: HTTP ${response.status}`,
      ok: false,
    };
  } catch (error) {
    return {
      message: `Sync test failed: ${formatErrorMessage(error)}`,
      ok: false,
    };
  }
}

async function pushConfigSync(
  settings: Partial<PersistedSettings>,
  backupText: string,
  doc: PreferencesDocument,
): Promise<{ message: string; ok: boolean }> {
  const url = buildConfigSyncURL(settings);
  if (!url) {
    return { message: "Sync endpoint is required.", ok: false };
  }
  try {
    const response = await fetchWithConfigSyncAuth(doc, url, {
      body: backupText,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      method: "PUT",
    }, settings);
    if (response.ok || response.status === 201 || response.status === 204) {
      return { message: "Configuration uploaded to sync endpoint.", ok: true };
    }
    return {
      message: `Configuration upload failed: HTTP ${response.status}`,
      ok: false,
    };
  } catch (error) {
    return {
      message: `Configuration upload failed: ${formatErrorMessage(error)}`,
      ok: false,
    };
  }
}

async function pullConfigSync(
  settings: Partial<PersistedSettings>,
  doc: PreferencesDocument,
): Promise<{ backupText?: string; message: string; ok: boolean }> {
  const url = buildConfigSyncURL(settings);
  if (!url) {
    return { message: "Sync endpoint is required.", ok: false };
  }
  try {
    const response = await fetchWithConfigSyncAuth(doc, url, {
      method: "GET",
    }, settings);
    if (!response.ok) {
      return {
        message: `Configuration download failed: HTTP ${response.status}`,
        ok: false,
      };
    }
    return {
      backupText: await response.text(),
      message: "Configuration downloaded.",
      ok: true,
    };
  } catch (error) {
    return {
      message: `Configuration download failed: ${formatErrorMessage(error)}`,
      ok: false,
    };
  }
}

function buildConfigSyncURL(settings: Partial<PersistedSettings>): string {
  const endpoint = String(settings.configSyncEndpoint || "").trim();
  if (!endpoint) {
    return "";
  }
  const remotePath = String(
    settings.configSyncRemotePath || DEFAULT_CONFIG_SYNC_REMOTE_PATH,
  )
    .trim()
    .replace(/^\/+/, "");
  if (!remotePath || /\.json(?:[?#].*)?$/i.test(endpoint)) {
    return endpoint;
  }
  return `${endpoint.replace(/\/+$/, "")}/${encodeURI(remotePath)}`;
}

async function fetchWithConfigSyncAuth(
  doc: PreferencesDocument,
  url: string,
  init: RequestInit,
  settings: Partial<PersistedSettings>,
): Promise<Response> {
  const headers = new Headers(init.headers || {});
  const username = String(settings.configSyncUsername || "");
  const password = String(settings.configSyncPassword || "");
  if (username || password) {
    headers.set("Authorization", `Basic ${base64Encode(`${username}:${password}`, doc)}`);
  }
  const requestInit: RequestInit = {
    ...init,
    headers: Object.fromEntries(
      Array.from(headers.entries()),
    ) as Record<string, string>,
  };
  const fetcher = doc.defaultView?.fetch?.bind(doc.defaultView) || fetch;
  return fetcher(url, requestInit);
}

function base64Encode(value: string, doc: PreferencesDocument): string {
  const btoaFn = doc.defaultView?.btoa || (globalThis as { btoa?: (text: string) => string }).btoa;
  if (typeof btoaFn === "function") {
    return btoaFn(unescape(encodeURIComponent(value)));
  }
  return value;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
