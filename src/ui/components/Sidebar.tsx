import React, {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  assembleContext,
  type AssembledContext,
} from "../../services/contextAssembler";
import { takeLookupRequest } from "../../services/lookupRequest";
import { getCurrentScope } from "../../services/scopeResolver";
import { getSettings, saveSettings, type Settings } from "../../services/settingsManager";
import type { ScopeContext } from "../../types/scope";
import { createHostEvent } from "../../utils/domEvents";
import { debugLog } from "../../utils/debugLog";
import { getRequestedLanguage, isChineseLocale } from "../../utils/locale";
import {
  buildReaderActionDraft,
  mergeReaderActionScope,
  type ReaderActionDetail,
} from "../readerActionFlow";
import { isSidebarLocationSelected } from "../sidebarSection";
import { getSidebarTheme, isDarkTheme, type ThemeMode } from "../theme";
import { typography } from "../typography";
import {
  WebAIWorkspace,
  type IncomingWebPrompt,
  type WebAIPanelView,
} from "./WebAIWorkspace";
import { ModelSelector } from "./ModelSelector";
import {
  getDefaultService,
  getServiceByID,
  isKnownServiceID,
  SERVICES,
  type WebAIService,
} from "../webAIServices";
import { ThemeToggle } from "./ThemeToggle";
import { TokenUsageBar } from "./TokenUsageBar";
import {
  ThinkingEffortSelector,
  type ThinkingEffort,
} from "./ThinkingEffortSelector";

// Zotero's own toolbar height -- `$height-toolbar` in both
// `scss/abstracts/_variables.scss` and the reader's copy of it. The panel's top
// bar matches it so the rule under it continues the rule under the reader's
// toolbar instead of starting 14px lower.
const TOOLBAR_HEIGHT = 41;

interface SidebarProps {
  eventBus: EventTarget;
  hostWindow: Window;
  location: "library" | "reader";
  // Supplied by whatever hosts the sidebar, so the header can offer a close
  // button without the component knowing what it is mounted into.
  onClose?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  eventBus,
  hostWindow,
  location,
  onClose,
}) => {
  const [scope, setScope] = useState<ScopeContext | null>(null);
  const [contextSummary, setContextSummary] = useState<AssembledContext | null>(
    null,
  );
  const [settings, setSettings] = useState<Settings>(getSettings);
  const [incomingPrompt, setIncomingPrompt] =
    useState<IncomingWebPrompt | null>(null);
  // Nothing reads this: "auto" resolves through matchMedia, which React cannot
  // observe, so a system theme change has to force a render by hand. It used to
  // be a `key` on the shell, which unmounted the workspace -- and with it the
  // <browser> holding the page the user was logged in to -- on every toggle.
  const [, refreshTheme] = useReducer((tick: number) => tick + 1, 0);
  // The provider lives here rather than in WebAIWorkspace so that the single
  // selector in the shell header owns it. WebAIWorkspace reacts to the change.
  const [service, setService] = useState<WebAIService>(getDefaultService);
  // A look-up asked for from the reader's selection popup. Carries its own id
  // so that asking twice for different text is two requests, rather than one
  // state value React considers unchanged.
  const [lookupRequest, setLookupRequest] = useState<{
    id: string;
    serviceID: WebAIService["id"];
    text: string;
  } | null>(null);
  const scopeSyncVersionRef = useRef(0);

  // --- New state for modern UI features ---
  const [themeMode, setThemeMode] = useState<ThemeMode>(
    () => settings.themeMode || "auto",
  );
  const [thinkingEffort, setThinkingEffort] = useState<ThinkingEffort>(
    () => settings.defaultThinkingEffort || "none",
  );
  const [selectionText, setSelectionText] = useState<string>("");
  // Mirrored from the workspace so the footer can follow it. The thinking
  // effort and the token meter both describe a prompt, and the web view has
  // none -- showing them there was chrome for a mode the user is not in.
  const [panelView, setPanelView] = useState<WebAIPanelView>("web");
  const [tokenInput, setTokenInput] = useState(0);
  const [tokenOutput, setTokenOutput] = useState(0);
  const [contextTokenUsed, setContextTokenUsed] = useState(0);
  const contextTokenMax = settings.maxContextBudget || 4000;

  const theme = getSidebarTheme(hostWindow, themeMode);
  const dark = isDarkTheme(hostWindow, themeMode);
  const isZh = isChineseLocale(getRequestedLanguage());

  // --- Theme mode change handler ---
  const handleThemeModeChange = useCallback((mode: ThemeMode) => {
    setThemeMode(mode);
    try {
      saveSettings({ themeMode: mode });
    } catch {
      // Ignore save errors for optional new fields
    }
  }, []);

  // --- Token usage event listener ---
  useEffect(() => {
    const handleTokenUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail) {
        if (typeof detail.inputTokens === "number") setTokenInput(detail.inputTokens);
        if (typeof detail.outputTokens === "number") setTokenOutput(detail.outputTokens);
        if (typeof detail.contextUsed === "number") setContextTokenUsed(detail.contextUsed);
      }
    };
    eventBus.addEventListener("tokenUsageUpdate", handleTokenUpdate);
    return () => eventBus.removeEventListener("tokenUsageUpdate", handleTokenUpdate);
  }, [eventBus]);

  // --- Selection text event listener ---
  useEffect(() => {
    const handleSelectionUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setSelectionText(typeof detail?.text === "string" ? detail.text : "");
    };
    // Raised by the reader's selection popup. The selection itself already
    // arrived through selectionTextUpdate above, so switching the provider is
    // all this has to do -- the workspace loads the result page on the way in.
    const applyLookupRequest = (detail: {
      serviceID?: unknown;
      text?: unknown;
    }) => {
      // Carry the text as well: if the column was closed, this Sidebar mounted
      // after selectionTextUpdate fired and never saw it.
      if (typeof detail?.text === "string" && detail.text.trim()) {
        setSelectionText(detail.text);
      }
      if (isKnownServiceID(detail?.serviceID)) {
        setService(getServiceByID(detail.serviceID));
        setLookupRequest({
          id: `lookup-${Date.now()}`,
          serviceID: detail.serviceID,
          text: typeof detail?.text === "string" ? detail.text : "",
        });
      }
    };
    const handleLookupRequest = (event: Event) => {
      // Handled live, so there is nothing left for the next mount to replay.
      takeLookupRequest();
      applyLookupRequest((event as CustomEvent).detail || {});
    };
    eventBus.addEventListener("selectionTextUpdate", handleSelectionUpdate);
    eventBus.addEventListener("webAILookupRequest", handleLookupRequest);
    // A look-up asked for while the column was closed was dispatched before
    // this effect ran -- measured at 45ms too early -- so it is waiting here
    // rather than lost. This is the only moment it can be collected.
    const waiting = takeLookupRequest();
    if (waiting) {
      applyLookupRequest(waiting);
    }
    return () => {
      eventBus.removeEventListener("selectionTextUpdate", handleSelectionUpdate);
      eventBus.removeEventListener("webAILookupRequest", handleLookupRequest);
    };
  }, [eventBus]);

  const syncSidebarScope = async (
    nextScope: ScopeContext | null,
  ): Promise<void> => {
    const version = ++scopeSyncVersionRef.current;
    setScope(nextScope);
    const summary = await summarizeScope(nextScope);
    if (version === scopeSyncVersionRef.current) {
      setContextSummary(summary);
    }
  };

  const syncResolvedScope = () => {
    void syncSidebarScope(getCurrentScope());
  };

  useEffect(() => {
    const refreshSettings = () => {
      setSettings(getSettings());
      if (location === "reader") {
        syncResolvedScope();
      }
    };

    refreshSettings();
    const handleSettingsChange = () => {
      refreshSettings();
    };
    hostWindow.addEventListener("focus", refreshSettings);
    eventBus.addEventListener("settingsChange", handleSettingsChange);
    return () => {
      hostWindow.removeEventListener("focus", refreshSettings);
      eventBus.removeEventListener("settingsChange", handleSettingsChange);
    };
  }, [eventBus, hostWindow, location]);

  useEffect(() => {
    const mediaQuery = hostWindow.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mediaQuery) {
      return;
    }

    const handleThemeChange = () => {
      refreshTheme();
    };

    mediaQuery.addEventListener?.("change", handleThemeChange);
    mediaQuery.addListener?.(handleThemeChange);

    return () => {
      mediaQuery.removeEventListener?.("change", handleThemeChange);
      mediaQuery.removeListener?.(handleThemeChange);
    };
  }, [hostWindow]);

  useEffect(() => {
    const handleScopeChange = (event: Event) => {
      const nextScope = (event as CustomEvent).detail as ScopeContext | null;
      void syncSidebarScope(nextScope);
    };

    eventBus.addEventListener("scopeChange", handleScopeChange);
    return () => eventBus.removeEventListener("scopeChange", handleScopeChange);
  }, [eventBus]);

  useEffect(() => {
    const handleReaderSelectionAction = (event: Event) => {
      const selectedType = Zotero.getMainWindow()?.Zotero_Tabs?.selectedType;
      const detail = (event as CustomEvent).detail as ReaderActionDetail;
      if (!isSidebarLocationSelected(`${selectedType || ""}`, location)) {
        debugLog.debug("sidebar.readerAction.ignored", {
          action: detail?.action,
          location,
          reason: "surface-mismatch",
          selectedType,
          surface: "sidebar",
          traceId: detail?.traceId,
        });
        return;
      }

      const prompt = buildReaderActionDraft(detail);
      const currentScope = mergeReaderActionScope(getCurrentScope(), detail);
      void (async () => {
        await syncSidebarScope(currentScope);
        setIncomingPrompt({
          id: detail.traceId || `reader-${Date.now()}`,
          label: detail.action === "explain" ? "Selection explain" : "Selection ask",
          prompt,
          sourceMode: "selection",
        });
        debugLog.info("sidebar.readerAction.webPrompt", {
          action: detail.action,
          messageChars: prompt.length,
          scopeId: currentScope?.id,
          scopeType: currentScope?.type,
          surface: "sidebar",
          traceId: detail.traceId,
        });
      })().catch((error) => {
        debugLog.error("sidebar.readerAction.error", error, {
          action: detail.action,
          surface: "sidebar",
          traceId: detail.traceId,
        });
        ztoolkit.log("Failed to handle reader selection action:", error);
      });
    };

    eventBus.addEventListener(
      "readerSelectionAction",
      handleReaderSelectionAction,
    );
    return () =>
      eventBus.removeEventListener(
        "readerSelectionAction",
        handleReaderSelectionAction,
      );
  }, [eventBus, location]);

  useEffect(() => {
    syncResolvedScope();

    if (location !== "reader") {
      return;
    }

    const retry = hostWindow.setTimeout(() => {
      syncResolvedScope();
    }, 150);

    return () => {
      hostWindow.clearTimeout(retry);
    };
  }, [hostWindow, location]);

  const handleRefreshScope = () => {
    syncResolvedScope();
    setSettings(getSettings());
    eventBus.dispatchEvent(createHostEvent("settingsChange", hostWindow));
  };

  const tokenDisplayEnabled = settings.tokenDisplayEnabled !== false;

  return (
    <SidebarErrorBoundary>
      <div
        className="zotero-webai-shell"
        data-layout={settings.workspaceLayout}
        data-location={location}
        data-theme={dark ? "dark" : "light"}
        style={{
          ...styles.container,
          background: theme.background,
          color: theme.text,
        }}
      >
        <header
          className="zotero-webai-shell-header"
          style={{
            ...styles.shellHeader,
            background: theme.surfaceBackground,
          }}
        >
          <div
            style={{
              ...styles.shellHeaderTop,
              borderBottomColor: theme.softBorder,
            }}
          >
            <span style={{ ...styles.shellTitle, color: theme.text }}>
              Paperly AI
            </span>
            <div style={styles.shellHeaderActions}>
              {onClose && (
                <button
                  aria-label={isZh ? "关闭 Paperly AI" : "Close Paperly AI"}
                  className="zotero-webai-shell-close"
                  onClick={onClose}
                  title={isZh ? "关闭 Paperly AI" : "Close Paperly AI"}
                  type="button"
                  style={{
                    alignItems: "center",
                    appearance: "none",
                    background: "transparent",
                    border: `1px solid ${theme.modelSelectorBorder}`,
                    borderRadius: 6,
                    color: theme.text,
                    cursor: "pointer",
                    display: "inline-flex",
                    flex: "0 0 auto",
                    height: 26,
                    justifyContent: "center",
                    order: 9,
                    width: 26,
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                    <path
                      d="M2 2L10 10M10 2L2 10"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              )}
              <ModelSelector
                hostWindow={hostWindow}
                isZh={isZh}
                onSelect={setService}
                selected={service}
                services={SERVICES}
                theme={theme}
              />
              <ThemeToggle
                isDark={dark}
                theme={theme}
                isZh={isZh}
                onToggle={handleThemeModeChange}
              />
            </div>
          </div>
          {/* What a prompt would be about. The web view has no prompt -- the
              page is the whole surface there -- so this was three lines of
              chrome describing something that mode cannot use. */}
          {panelView === "chat" && (
            <div
              className="zotero-webai-shell-scope"
              style={{
                ...styles.scopeBand,
                background: theme.panelBackground,
                borderBottomColor: theme.softBorder,
              }}
            >
              <div style={styles.scopeMainLine}>
                <span style={{ ...styles.scopeEyebrow, color: theme.mutedText }}>
                  {isZh ? "当前范围" : "Current Scope"}
                </span>
                <span style={{ ...styles.scopeSurface, color: theme.badgeText }}>
                  {location === "reader"
                    ? isZh
                      ? "阅读器"
                      : "Reader"
                    : isZh
                      ? "条目栏"
                      : "Library"}
                </span>
              </div>
              <div style={{ ...styles.scopeTitle, color: theme.text }}>
                {scope?.label || (isZh ? "未选择条目" : "No item selected")}
              </div>
              <div style={{ ...styles.scopeMeta, color: theme.mutedText }}>
                {formatContextState(contextSummary, scope, isZh)}
              </div>
            </div>
          )}
        </header>

        <div
          className="zotero-webai-shell-body"
          style={{
            ...styles.webWorkspacePane,
            ...(settings.workspaceLayout === "compact"
              ? styles.compactWorkspacePane
              : {}),
          }}
        >
          <WebAIWorkspace
            contextSummary={contextSummary}
            customPresets={settings.customPresets}
            hostWindow={hostWindow}
            isDark={dark}
            incomingPrompt={incomingPrompt}
            location={location}
            onIncomingPromptHandled={(id) => {
              setIncomingPrompt((current) =>
                current?.id === id ? null : current,
              );
            }}
            onScopeRefresh={handleRefreshScope}
            lookupRequest={lookupRequest}
            onPanelViewChange={setPanelView}
            onLookupRequestHandled={(id) => {
              setLookupRequest((current) =>
                current?.id === id ? null : current,
              );
            }}
            onSelectService={setService}
            scope={scope}
            selectionText={selectionText}
            service={service}
            settings={settings}
            theme={theme}
          />
        </div>

        {/* Thinking effort selector + Token usage bar at the bottom */}
        {panelView === "chat" && (
          <div style={styles.shellFooter}>
            <div style={styles.footerLeft}>
              <ThinkingEffortSelector
                value={thinkingEffort}
                theme={theme}
                isZh={isZh}
                onChange={setThinkingEffort}
              />
            </div>
            <TokenUsageBar
              inputTokens={tokenInput}
              outputTokens={tokenOutput}
              contextUsed={contextTokenUsed}
              contextMax={contextTokenMax}
              theme={theme}
              isZh={isZh}
              visible={tokenDisplayEnabled}
            />
          </div>
        )}
      </div>
    </SidebarErrorBoundary>
  );
};

class SidebarErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { message: string | null }
> {
  state = { message: null };

  static getDerivedStateFromError(error: unknown) {
    return {
      message:
        error instanceof Error && error.message
          ? error.message
          : "Unknown sidebar render failure",
    };
  }

  componentDidCatch(error: unknown) {
    debugLog.error("sidebar.render.error", error, {
      surface: "sidebar",
    });
  }

  render() {
    if (this.state.message) {
      return (
        <div style={styles.errorBoundary}>
          <div style={styles.errorBoundaryTitle}>
            Paperly AI sidebar unavailable
          </div>
          <div style={styles.errorBoundaryMessage}>{this.state.message}</div>
        </div>
      );
    }

    return this.props.children;
  }
}

function formatContextState(
  contextSummary: AssembledContext | null,
  scope: ScopeContext | null,
  isZh: boolean,
): string {
  if (!scope) {
    return isZh ? "等待 Zotero 当前条目或 PDF" : "Waiting for the current Zotero item or PDF";
  }
  if (!contextSummary) {
    return isZh ? `${formatScopeType(scope.type, isZh)} - 正在读取上下文` : `${formatScopeType(scope.type, isZh)} - reading context`;
  }

  const parts = [formatScopeType(scope.type, isZh)];
  if (contextSummary.fullText) {
    parts.push(
      isZh
        ? `全文 ${contextSummary.fullText.length.toLocaleString()} 字符`
        : `Full text ${contextSummary.fullText.length.toLocaleString()} chars`,
    );
  } else if (contextSummary.metadata) {
    parts.push(isZh ? "元数据可用" : "metadata ready");
  } else {
    parts.push(isZh ? "上下文待加载" : "context pending");
  }
  if (contextSummary.selectedText) {
    parts.push(
      isZh
        ? `选区 ${contextSummary.selectedText.length.toLocaleString()} 字符`
        : `selection ${contextSummary.selectedText.length.toLocaleString()} chars`,
    );
  }
  if (contextSummary.blockingMessage) {
    parts.push(isZh ? "需要检查全文" : "full text needs attention");
  }
  return parts.join(" - ");
}

function formatScopeType(type: ScopeContext["type"], isZh: boolean): string {
  if (type === "pdf") return isZh ? "PDF" : "PDF";
  if (type === "paper") return isZh ? "论文" : "Paper";
  if (type === "collection") return isZh ? "集合" : "Collection";
  return isZh ? "手动选择" : "Manual selection";
}

async function summarizeScope(
  scope: ScopeContext | null,
): Promise<AssembledContext | null> {
  if (!scope) {
    return null;
  }

  try {
    return await assembleContext(scope);
  } catch (error) {
    ztoolkit.log("Failed to summarize scope context:", error);
    return null;
  }
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: "#f7f7f7",
    boxSizing: "border-box",
    color: "#222",
    display: "flex",
    flexDirection: "column",
    height: "100%",
    maxWidth: "100%",
    minHeight: "0",
    minWidth: 0,
    overflowX: "hidden",
    width: "100%",
  },
  webWorkspacePane: {
    boxSizing: "border-box",
    display: "flex",
    flex: "1 1 auto",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    padding: 0,
  },
  compactWorkspacePane: {
    fontSize: "0.96em",
  },
  shellHeader: {
    alignItems: "stretch",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    flex: "0 0 auto",
    minWidth: 0,
  },
  // A bar the height of Zotero's own toolbar, padding and rule included, so the
  // two panes divide at the same y. The name sits on one line: the second line
  // it used to carry made the bar 55px, and the paper beside it starts at 41.
  shellHeaderTop: {
    alignItems: "center",
    borderBottom: "1px solid",
    boxSizing: "border-box",
    display: "flex",
    flex: "0 0 auto",
    gap: "8px",
    height: `${TOOLBAR_HEIGHT}px`,
    justifyContent: "space-between",
    minWidth: 0,
    padding: "0 10px",
  },
  shellHeaderActions: {
    alignItems: "center",
    display: "flex",
    flex: "0 0 auto",
    gap: "6px",
  },
  shellFooter: {
    alignItems: "center",
    borderTop: "1px solid",
    borderTopColor: "inherit",
    display: "flex",
    flex: "0 0 auto",
    gap: "4px",
    minWidth: 0,
    padding: "0 4px",
  },
  footerLeft: {
    alignItems: "center",
    display: "flex",
    flex: "0 0 auto",
    padding: "4px 8px",
  },
  shellTitle: {
    flex: "1 1 auto",
    fontSize: typography.body,
    fontWeight: 800,
    lineHeight: 1.25,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // A band, not a card: inside a header that already has an edge, the rounded
  // box was a box in a box. Its rule is the header's lower edge in chat mode.
  scopeBand: {
    borderBottom: "1px solid",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    gap: "3px",
    minWidth: 0,
    padding: "8px 10px",
  },
  scopeMainLine: {
    alignItems: "center",
    display: "flex",
    gap: "6px",
    justifyContent: "space-between",
    minWidth: 0,
  },
  scopeEyebrow: {
    fontSize: typography.caption,
    fontWeight: 700,
    letterSpacing: 0,
    lineHeight: 1.2,
    textTransform: "uppercase",
  },
  scopeSurface: {
    fontSize: typography.caption,
    fontWeight: 700,
    lineHeight: 1.2,
    whiteSpace: "nowrap",
  },
  scopeTitle: {
    fontSize: typography.body,
    fontWeight: 700,
    lineHeight: 1.3,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  scopeMeta: {
    fontSize: typography.caption,
    lineHeight: 1.3,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  errorBoundary: {
    background: "#fbf1f1",
    boxSizing: "border-box",
    color: "#7f1d1d",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    height: "100%",
    overflow: "auto",
    padding: "12px",
  },
  errorBoundaryTitle: {
    fontSize: typography.headingSm,
    fontWeight: 700,
    lineHeight: 1.3,
  },
  errorBoundaryMessage: {
    fontSize: typography.body,
    lineHeight: 1.45,
    overflowWrap: "anywhere",
  },
};
