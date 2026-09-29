import type { CommandPreset } from "./presets";
import { getPref, setPref } from "../utils/prefs";
import { config } from "../../package.json";
import type { ScopeType } from "../types/scope";

export const DEFAULT_EVIDENCE_PROVIDER_MODE = "mcp-http";
export type EvidenceProviderMode =
  | typeof DEFAULT_EVIDENCE_PROVIDER_MODE
  | "mcp-web-search";
type LegacyEvidenceProviderMode = "builtin-search";
export type WorkspaceLayoutMode = "stacked" | "compact";
export type IconPlacementMode = "both" | "reader-sidebar" | "reader-toolbar";
export type ThemeMode = "auto" | "light" | "dark";
export type ThinkingEffort = "none" | "low" | "medium" | "high" | "xhigh";

export interface PersistedSettings {
  configSyncEnabled: boolean;
  configSyncEndpoint?: string;
  configSyncPassword?: string;
  configSyncRemotePath?: string;
  configSyncSnapshot?: string;
  configSyncUsername?: string;
  customPresets: string;
  defaultThinkingEffort: ThinkingEffort;
  evidenceEnabled: boolean;
  evidenceProviderMode: EvidenceProviderMode;
  iconPlacement: IconPlacementMode;
  keyboardShortcut: string;
  maxContextBudget: number;
  mcpAuthToken?: string;
  mcpEndpoint?: string;
  mcpToolArgumentsTemplate?: string;
  mcpToolName?: string;
  quickPromptsEnabled: boolean;
  selectionToolbarEnabled: boolean;
  themeMode: ThemeMode;
  tokenDisplayEnabled: boolean;
  workspaceLayout: WorkspaceLayoutMode;
}

export type Settings = PersistedSettings;

export const DEFAULT_MCP_TOOL_ARGUMENTS_TEMPLATE =
  '{"q":"{{query}}","limit":1000,"mode":"complete","relevanceScoring":true,"sort":"relevance"}';
export const DEFAULT_MCP_ENDPOINT = "http://127.0.0.1:23120/mcp";
export const DEFAULT_CONFIG_SYNC_REMOTE_PATH = "Zotero-WebAI-config.json";

export const DEFAULT_SETTINGS: Settings = {
  configSyncEnabled: false,
  configSyncEndpoint: "",
  configSyncPassword: "",
  configSyncRemotePath: DEFAULT_CONFIG_SYNC_REMOTE_PATH,
  configSyncSnapshot: "",
  configSyncUsername: "",
  customPresets: "",
  defaultThinkingEffort: "none",
  evidenceEnabled: false,
  evidenceProviderMode: DEFAULT_EVIDENCE_PROVIDER_MODE,
  iconPlacement: "both",
  keyboardShortcut: "I",
  maxContextBudget: 4000,
  mcpAuthToken: "",
  mcpEndpoint: DEFAULT_MCP_ENDPOINT,
  mcpToolArgumentsTemplate: DEFAULT_MCP_TOOL_ARGUMENTS_TEMPLATE,
  mcpToolName: "search_library",
  quickPromptsEnabled: true,
  selectionToolbarEnabled: true,
  themeMode: "auto",
  tokenDisplayEnabled: true,
  workspaceLayout: "stacked",
};

export const PREFERENCES_PANE_ID = `${config.addonRef}-prefpane`;

function normalizeEvidenceProviderMode(
  mode: string | LegacyEvidenceProviderMode | undefined,
): EvidenceProviderMode {
  if (mode === "mcp-http" || mode === "mcp-web-search") {
    return mode;
  }
  return DEFAULT_EVIDENCE_PROVIDER_MODE;
}

function normalizeBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function normalizeWorkspaceLayoutMode(value: unknown): WorkspaceLayoutMode {
  return value === "compact" || value === "stacked"
    ? value
    : DEFAULT_SETTINGS.workspaceLayout;
}

function normalizeIconPlacementMode(value: unknown): IconPlacementMode {
  return value === "reader-sidebar" ||
    value === "reader-toolbar" ||
    value === "both"
    ? value
    : DEFAULT_SETTINGS.iconPlacement;
}

function normalizeThemeMode(value: unknown): ThemeMode {
  return value === "light" || value === "dark" || value === "auto"
    ? value
    : DEFAULT_SETTINGS.themeMode;
}

function normalizeThinkingEffort(value: unknown): ThinkingEffort {
  return value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
    ? value
    : DEFAULT_SETTINGS.defaultThinkingEffort;
}

export type CustomCommandPreset = Partial<CommandPreset> & {
  hidden?: boolean;
  id?: string;
  mode?: "append" | "replace";
  slashCommand?: string;
  showInSidebar?: boolean;
};

export type ParsedCustomCommandPreset = CustomCommandPreset & {
  id: string;
};

export interface EditableCustomCommandPreset {
  aliasesText: string;
  description: string;
  enabled: boolean;
  evidenceHint: boolean;
  group: NonNullable<CommandPreset["group"]>;
  hidden?: boolean;
  id: string;
  label: string;
  promptPrefix: string;
  slashCommand: string;
  showInSidebar: boolean;
  scopeHint: ScopeType[];
}

export interface CustomPresetsParseResult {
  presets: ParsedCustomCommandPreset[];
  error: string | null;
}

function normalizeCustomPresetsValue(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function slugifyPresetId(value: string, index: number): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return slug || `custom-${index + 1}`;
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function serializeStringArray(value: string[]): string {
  return value.map((item) => item.trim()).filter(Boolean).join(", ");
}

function normalizeScopeHints(value: unknown): CommandPreset["scopeHint"] {
  const validScopeTypes = new Set([
    "paper",
    "pdf",
    "collection",
    "manual-selection",
  ]);
  const scopes = normalizeStringArray(value).filter((scope) =>
    validScopeTypes.has(scope),
  ) as NonNullable<CommandPreset["scopeHint"]>;

  return scopes.length > 0 ? scopes : undefined;
}

function normalizePresetGroup(value: unknown): CommandPreset["group"] {
  return value === "analysis" || value === "evidence" || value === "reading"
    ? value
    : "reading";
}

export function parseCustomPresets(value: string): CustomPresetsParseResult {
  const normalized = normalizeCustomPresetsValue(value);
  if (!normalized) {
    return { presets: [], error: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch (error) {
    return {
      presets: [],
      error:
        error instanceof Error && error.message
          ? `Invalid custom suggestions JSON: ${error.message}`
          : "Invalid custom suggestions JSON",
    };
  }

  const rawPresets = Array.isArray(parsed) ? parsed : [parsed];
  const presets: ParsedCustomCommandPreset[] = [];
  const usedIds = new Set<string>();
  for (const [index, rawPreset] of rawPresets.entries()) {
    if (!rawPreset || typeof rawPreset !== "object") {
      continue;
    }

    const source = rawPreset as Record<string, unknown>;
    const rawId = String(source.id || "").trim();
    const label = String(source.label || "").trim();
    const promptPrefix = String(
      source.promptPrefix || source.prompt || "",
    ).trim();
    const slashCommand = String(
      source.slashCommand || source.command || rawId || "",
    ).trim();
    if (!rawId && !label) {
      continue;
    }

    let id = slugifyPresetId(rawId || label, index);
    while (usedIds.has(id)) {
      id = `${id}-${index + 1}`;
    }
    usedIds.add(id);

    const preset: ParsedCustomCommandPreset = {
      id,
      mode: source.mode === "replace" ? "replace" : "append",
    };
    if (source.aliases !== undefined) {
      preset.aliases = normalizeStringArray(source.aliases);
    }
    if (source.description !== undefined) {
      preset.description = String(source.description || "").trim();
    }
    if (source.evidenceHint !== undefined) {
      preset.evidenceHint = normalizeBoolean(source.evidenceHint);
    }
    if (source.group !== undefined) {
      preset.group = normalizePresetGroup(source.group);
    }
    if (label) {
      preset.label = label;
    }
    if (promptPrefix) {
      preset.promptPrefix = promptPrefix;
    }
    preset.slashCommand = slashCommand || id;
    if (source.scopeHint !== undefined || source.scopes !== undefined) {
      preset.scopeHint = normalizeScopeHints(source.scopeHint ?? source.scopes);
    }
    if (source.hidden !== undefined) {
      preset.hidden = normalizeBoolean(source.hidden);
    }
    if (source.showInSidebar !== undefined) {
      preset.showInSidebar = normalizeBoolean(source.showInSidebar);
    }

    presets.push(preset);
  }

  return { presets, error: null };
}

export function toEditableCustomPreset(
  preset: ParsedCustomCommandPreset,
): EditableCustomCommandPreset {
  return {
    aliasesText: serializeStringArray(preset.aliases || []),
    description: String(preset.description || "").trim(),
    enabled: true,
    evidenceHint: Boolean(preset.evidenceHint),
    group: normalizePresetGroup(preset.group),
    hidden: Boolean(preset.hidden),
    id: preset.id,
    label: String(preset.label || "").trim(),
    promptPrefix: String(preset.promptPrefix || "").trim(),
    slashCommand: String(preset.slashCommand || preset.id || "").trim(),
    showInSidebar: Boolean(preset.showInSidebar),
    scopeHint: (preset.scopeHint || ["paper", "pdf"]) as ScopeType[],
  };
}

export function createEmptyEditableCustomPreset(
  index = 0,
): EditableCustomCommandPreset {
  return {
    aliasesText: "",
    description: "",
    enabled: true,
    evidenceHint: false,
    group: "reading",
    hidden: false,
    id: `custom-action-${index + 1}`,
    label: "",
    promptPrefix: "",
    slashCommand: `custom-action-${index + 1}`,
    showInSidebar: false,
    scopeHint: ["paper", "pdf"],
  };
}

export function parseEditableCustomPresets(
  value: string,
): EditableCustomCommandPreset[] {
  return parseCustomPresets(value).presets.map((preset) =>
    toEditableCustomPreset(preset),
  );
}

export function stringifyEditableCustomPresets(
  presets: EditableCustomCommandPreset[],
): string {
  const normalized = presets
    .filter((preset) => preset.enabled !== false || preset.hidden)
    .map((preset, index) => {
      const id = slugifyPresetId(preset.id || preset.label, index);
      return {
        aliases: normalizeStringArray(preset.aliasesText),
        description: String(preset.description || "").trim(),
        evidenceHint: Boolean(preset.evidenceHint),
        group: normalizePresetGroup(preset.group),
        hidden: Boolean(preset.hidden),
        id,
        label: String(preset.label || "").trim(),
        promptPrefix: String(preset.promptPrefix || "").trim(),
        slashCommand: String(preset.slashCommand || id).trim(),
        showInSidebar: Boolean(preset.showInSidebar),
        scopeHint: preset.scopeHint?.length
          ? preset.scopeHint
          : ["paper", "pdf"],
      };
    })
    .filter((preset) => preset.label || preset.promptPrefix || preset.hidden);

  if (normalized.length === 0) {
    return "";
  }

  return JSON.stringify(normalized, null, 2);
}

export function buildCustomCommandAIPrompt(): string {
  return [
    "Create Paperly AI custom slash commands as a JSON array",
    "Output JSON only, with no Markdown fences and no explanation",
    "Each object may include id, label, description, promptPrefix, aliases, scopeHint, showInSidebar, and evidenceHint",
    'Use lower-case hyphenated ids, aliases as an array, and scopeHint values from ["paper","pdf","collection","manual-selection"]',
    "Keep showInSidebar true only for the few commands that should appear on the sidebar home panel",
    "Write promptPrefix text for research reading: be specific, ask for concise structure, separate paper evidence from inference, and ask for uncertainty when relevant",
    "My command ideas are:",
  ].join("\n");
}

export function mergeEditableCustomPresets(
  existing: EditableCustomCommandPreset[],
  imported: EditableCustomCommandPreset[],
): EditableCustomCommandPreset[] {
  const merged = [...existing];
  for (const preset of imported) {
    const index = merged.findIndex((candidate) => candidate.id === preset.id);
    if (index >= 0) {
      merged[index] = preset;
    } else {
      merged.push(preset);
    }
  }
  return merged;
}

export function getSettings(): Settings {
  return {
    configSyncEnabled: normalizeBoolean(getPref("configSyncEnabled")),
    configSyncEndpoint: ((getPref("configSyncEndpoint") || "") as string).trim(),
    configSyncPassword: (getPref("configSyncPassword") || "") as string,
    configSyncRemotePath:
      ((getPref("configSyncRemotePath") || "") as string).trim() ||
      DEFAULT_CONFIG_SYNC_REMOTE_PATH,
    configSyncSnapshot: (getPref("configSyncSnapshot") || "") as string,
    configSyncUsername: (getPref("configSyncUsername") || "") as string,
    customPresets: normalizeCustomPresetsValue(getPref("customPresets")),
    defaultThinkingEffort: normalizeThinkingEffort(getPref("defaultThinkingEffort")),
    evidenceEnabled: normalizeBoolean(getPref("evidenceEnabled")),
    evidenceProviderMode: normalizeEvidenceProviderMode(
      getPref("evidenceProviderMode") as string | undefined,
    ),
    iconPlacement: normalizeIconPlacementMode(getPref("iconPlacement")),
    keyboardShortcut: (getPref("keyboardShortcut") ||
      DEFAULT_SETTINGS.keyboardShortcut) as string,
    maxContextBudget: Number(
      getPref("maxContextBudget") || DEFAULT_SETTINGS.maxContextBudget,
    ),
    mcpAuthToken: (getPref("mcpAuthToken") || "") as string,
    mcpEndpoint:
      ((getPref("mcpEndpoint") || "") as string).trim() ||
      DEFAULT_SETTINGS.mcpEndpoint,
    mcpToolArgumentsTemplate:
      ((getPref("mcpToolArgumentsTemplate") || "") as string).trim() ||
      DEFAULT_MCP_TOOL_ARGUMENTS_TEMPLATE,
    mcpToolName:
      ((getPref("mcpToolName") || "") as string).trim() ||
      DEFAULT_SETTINGS.mcpToolName,
    quickPromptsEnabled: getPref("quickPromptsEnabled") === undefined
      ? DEFAULT_SETTINGS.quickPromptsEnabled
      : normalizeBoolean(getPref("quickPromptsEnabled")),
    selectionToolbarEnabled: getPref("selectionToolbarEnabled") === undefined
      ? DEFAULT_SETTINGS.selectionToolbarEnabled
      : normalizeBoolean(getPref("selectionToolbarEnabled")),
    themeMode: normalizeThemeMode(getPref("themeMode")),
    tokenDisplayEnabled: getPref("tokenDisplayEnabled") === undefined
      ? DEFAULT_SETTINGS.tokenDisplayEnabled
      : normalizeBoolean(getPref("tokenDisplayEnabled")),
    workspaceLayout: normalizeWorkspaceLayoutMode(getPref("workspaceLayout")),
  };
}

export function saveSettings(settings: Partial<PersistedSettings>): void {
  if (settings.configSyncEnabled !== undefined) {
    setPref("configSyncEnabled", settings.configSyncEnabled);
  }
  if (settings.configSyncEndpoint !== undefined) {
    setPref("configSyncEndpoint", settings.configSyncEndpoint.trim());
  }
  if (settings.configSyncPassword !== undefined) {
    setPref("configSyncPassword", settings.configSyncPassword);
  }
  if (settings.configSyncRemotePath !== undefined) {
    setPref(
      "configSyncRemotePath",
      settings.configSyncRemotePath.trim() || DEFAULT_CONFIG_SYNC_REMOTE_PATH,
    );
  }
  if (settings.configSyncSnapshot !== undefined) {
    setPref("configSyncSnapshot", settings.configSyncSnapshot);
  }
  if (settings.configSyncUsername !== undefined) {
    setPref("configSyncUsername", settings.configSyncUsername);
  }
  if (settings.customPresets !== undefined) {
    setPref(
      "customPresets",
      normalizeCustomPresetsValue(settings.customPresets),
    );
  }
  if (settings.maxContextBudget !== undefined) {
    setPref("maxContextBudget", settings.maxContextBudget);
  }
  if (settings.keyboardShortcut !== undefined) {
    setPref("keyboardShortcut", settings.keyboardShortcut);
  }
  if (settings.evidenceEnabled !== undefined) {
    setPref("evidenceEnabled", settings.evidenceEnabled);
  }
  if (settings.evidenceProviderMode !== undefined) {
    setPref(
      "evidenceProviderMode",
      normalizeEvidenceProviderMode(settings.evidenceProviderMode),
    );
  }
  if (settings.iconPlacement !== undefined) {
    setPref("iconPlacement", normalizeIconPlacementMode(settings.iconPlacement));
  }
  if (settings.mcpAuthToken !== undefined) {
    setPref("mcpAuthToken", settings.mcpAuthToken);
  }
  if (settings.mcpEndpoint !== undefined) {
    setPref("mcpEndpoint", settings.mcpEndpoint);
  }
  if (settings.mcpToolArgumentsTemplate !== undefined) {
    setPref(
      "mcpToolArgumentsTemplate",
      settings.mcpToolArgumentsTemplate.trim() ||
        DEFAULT_MCP_TOOL_ARGUMENTS_TEMPLATE,
    );
  }
  if (settings.mcpToolName !== undefined) {
    setPref(
      "mcpToolName",
      settings.mcpToolName.trim() || DEFAULT_SETTINGS.mcpToolName || "search_library",
    );
  }
  if (settings.workspaceLayout !== undefined) {
    setPref(
      "workspaceLayout",
      normalizeWorkspaceLayoutMode(settings.workspaceLayout),
    );
  }
  if (settings.themeMode !== undefined) {
    setPref("themeMode", normalizeThemeMode(settings.themeMode));
  }
  if (settings.defaultThinkingEffort !== undefined) {
    setPref("defaultThinkingEffort", normalizeThinkingEffort(settings.defaultThinkingEffort));
  }
  if (settings.selectionToolbarEnabled !== undefined) {
    setPref("selectionToolbarEnabled", settings.selectionToolbarEnabled);
  }
  if (settings.tokenDisplayEnabled !== undefined) {
    setPref("tokenDisplayEnabled", settings.tokenDisplayEnabled);
  }
  if (settings.quickPromptsEnabled !== undefined) {
    setPref("quickPromptsEnabled", settings.quickPromptsEnabled);
  }
}

export function getSettingsIssue(): string | null {
  return null;
}

export function getEvidenceSettingsIssue(
  settings: Settings = getSettings(),
): string | null {
  if (settings.evidenceProviderMode === "mcp-http") {
    if (!settings.mcpEndpoint?.trim()) {
      return "MCP endpoint not configured. Open plugin Settings to enable MCP tools.";
    }
    return null;
  }

  return null;
}

function mergeSettings(overrides?: Partial<Settings>): Settings {
  const settings = getSettings();
  if (!overrides) {
    return settings;
  }

  return {
    ...settings,
    ...overrides,
    evidenceProviderMode: normalizeEvidenceProviderMode(
      overrides.evidenceProviderMode ?? settings.evidenceProviderMode,
    ),
    mcpAuthToken: String(overrides.mcpAuthToken ?? settings.mcpAuthToken ?? ""),
    mcpEndpoint: String(
      overrides.mcpEndpoint ?? settings.mcpEndpoint ?? DEFAULT_MCP_ENDPOINT,
    ),
    mcpToolArgumentsTemplate: String(
      overrides.mcpToolArgumentsTemplate ??
        settings.mcpToolArgumentsTemplate ??
        DEFAULT_MCP_TOOL_ARGUMENTS_TEMPLATE,
    ),
    mcpToolName: String(
      overrides.mcpToolName ?? settings.mcpToolName ?? "search_library",
    ),
  };
}

export function getEvidenceAuditLabel(
  providerMode: EvidenceProviderMode,
): string {
  if (providerMode === "mcp-http") {
    return "MCP";
  }
  return "Default verification";
}

export async function validateEvidenceSettings(
  overrides?: Partial<Settings>,
): Promise<{
  valid: boolean;
  error?: string;
}> {
  const settings = mergeSettings(overrides);

  if (settings.evidenceProviderMode === "mcp-http") {
    if (!settings.mcpEndpoint?.trim()) {
      return { valid: false, error: "MCP endpoint is required" };
    }
    try {
      JSON.parse(
        (settings.mcpToolArgumentsTemplate ||
          DEFAULT_MCP_TOOL_ARGUMENTS_TEMPLATE).replace(
          /\{\{\s*query\s*\}\}/g,
          "ping",
        ),
      );
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error:
          error instanceof Error
            ? `Invalid MCP arguments template: ${error.message}`
            : "Invalid MCP arguments template",
      };
    }
  }

  return { valid: true };
}
