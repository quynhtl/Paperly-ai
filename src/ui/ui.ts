import React from "react";
import { bindReactDomGlobals } from "../utils/reactGlobals";
import { config } from "../../package.json";
import { EventBus } from "../utils/eventBus";
import { Sidebar } from "./components/Sidebar";
import {
  createSectionSidebarHost,
  resolveSidebarLocation,
  type SidebarHostState,
  type SidebarLocation,
  type SidebarSurfaceHost,
} from "./sidebarSection";
import { registerSidebarRefreshHandler } from "./sidebarRuntime";
import { typography } from "./typography";
import { removeWebAIColumn, toggleWebAIColumn } from "../modules/webAIColumn";
// Cycle-safe: readerIntegration imports UIFactory from this module too, but
// neither side reads the other's binding at module-evaluation time -- both
// references live inside function bodies.
import {
  removeReaderTabbarButton,
  syncReaderTabbarButton,
} from "../modules/readerIntegration";

interface ItemMessagePaneLike extends HTMLElement {
  renderCustomHead?(
    callback?: (args: {
      append: (...nodes: unknown[]) => void;
      doc: Document;
    }) => void,
  ): void;
}

const SECTION_PANE_ID = "ai-assistant-sidebar";
// Zotero namespaces plugin panes as CSS.escape(`${pluginID}-${paneID}`)
// (xpcom/pluginAPI/pluginAPIBase.mjs, _namespacedMainKey), so the live attribute
// value contains literal backslashes, and the attribute is `data-pane` -- not
// data-pane-id/paneid, which nothing in Zotero ever emits. Match on the
// unescaped value instead of trying to build a selector for it.

const LEGACY_STANDALONE_ARTIFACT_IDS = [
  "ai-assistant-library-empty-state",
  "ai-assistant-library-empty-state-sidenav-btn",
  "zotero-ai-assistant-tb-chat-toggle",
];

const windowHosts = new WeakMap<Window, SidebarHostState>();
const windowRefreshCleanup = new WeakMap<Window, () => void>();
const windowSurfaceRefresh = new WeakMap<
  Window,
  () => Promise<void>
>();
const windowScopeRetryTimer = new WeakMap<Window, number>();
const windowLibraryEmptyStateRetryTimer = new WeakMap<
  Window,
  number
>();
const windowLibraryEmptyStateRetryBudget = new WeakMap<
  Window,
  number
>();
const windowReaderSectionWasExpanded = new WeakMap<Window, boolean>();

let reactDomClientPromise: Promise<typeof import("react-dom/client")> | null =
  null;

export class UIFactory {
  static registerChatPanel(win: Window) {
    this.removeLegacyStandaloneArtifacts(win);
    // WebAI is no longer an item-pane section. Unregister unconditionally so a
    // profile upgrading from a build that registered it loses the sidenav entry
    // and the section in the scroll.
    this.unregisterLegacySection();
    this.ensureWindowRefreshRegistration(win);
    this.ensureTabSelectionRefreshRegistration(win);
  }

  static removeChatPanel(win: Window) {
    const hosts = windowHosts.get(win);
    if (hosts) {
      [hosts.library, hosts.reader].forEach((hostState) => {
        hostState?.reactRoot?.unmount();
        if (hostState?.attachmentTarget !== "section-body") {
          hostState?.mountPoint.remove();
        }
      });
      windowHosts.delete(win);
    }

    this.clearScopeRetryTimer(win);
    this.clearLibraryEmptyStateRetryTimer(win);
    windowLibraryEmptyStateRetryBudget.delete(win);
    windowReaderSectionWasExpanded.delete(win);
    this.renderLibraryEmptyStateHead(win, false);
    this.removeTabSelectionRefreshRegistration(win);
    windowRefreshCleanup.get(win)?.();
    windowRefreshCleanup.delete(win);
    windowSurfaceRefresh.delete(win);
    removeReaderTabbarButton(win);
    removeWebAIColumn(win);
    this.removeLegacyStandaloneArtifacts(win);
  }

  static refreshWindow(win: Window) {
    syncReaderTabbarButton(win);
    void this.requestSurfaceRefresh(win);
    this.syncLibraryEmptyStateHost(win);
  }

  static refreshAllWindows() {
    for (const win of Zotero.getMainWindows()) {
      this.refreshWindow(win);
    }
  }

  static shutdown() {
    for (const win of Zotero.getMainWindows()) {
      try {
        this.removeChatPanel(win);
      } catch {
        // Ignore teardown issues while shutting down.
      }
    }

    this.unregisterLegacySection();
  }

  private static unregisterLegacySection(): void {
    try {
      Zotero.ItemPaneManager.unregisterSection(SECTION_PANE_ID);
    } catch {
      // Not registered in this profile, which is the normal case now.
    }
  }

  private static ensureWindowRefreshRegistration(win: Window) {
    if (windowRefreshCleanup.has(win)) {
      return;
    }

    const unregister = registerSidebarRefreshHandler(() => {
      if (!win.closed) {
        void this.requestSurfaceRefresh(win);
        this.refreshWindow(win);
      }
    });
    windowRefreshCleanup.set(win, unregister);
  }

  private static ensureTabSelectionRefreshRegistration(win: Window) {
    if (win.__aiAssistantTabObserverId) {
      return;
    }

    const callback = {
      notify: (event: string, type: string) => {
        if (event === "select" && type === "tab" && !win.closed) {
          void this.requestSurfaceRefresh(win);
          this.refreshWindow(win);
        }
      },
    };

    try {
      win.__aiAssistantTabObserverId = Zotero.Notifier.registerObserver(
        callback,
        ["tab"],
        `${config.addonID}-ui-tab-refresh`,
      );
    } catch (error) {
      ztoolkit.log(
        "Failed to register Paperly AI tab refresh observer:",
        error,
      );
      win.__aiAssistantTabObserverId = null;
    }
  }

  private static removeTabSelectionRefreshRegistration(win: Window) {
    const observerId = win.__aiAssistantTabObserverId;
    if (!observerId) {
      return;
    }

    try {
      Zotero.Notifier.unregisterObserver(observerId);
    } catch {
      // Ignore stale observer cleanup errors.
    }
    win.__aiAssistantTabObserverId = null;
  }

  // One surface for every tab: the column, which is a sibling of #tabs-deck and
  // so lives outside Zotero's tab model. A panel inside the reader tab cannot be
  // shared -- each tab is its own <tab-content>, so following the active paper
  // would mean reparenting the panel, and moving a <browser> in the DOM destroys
  // its frameLoader and reloads whatever is signed in inside it.
  static async openSidebarFromReaderToolbar(win: Window): Promise<void> {
    try {
      await toggleWebAIColumn(win);
    } catch (error) {
      ztoolkit.log("Failed to toggle the Paperly AI column:", error);
    }
  }

  private static ensureWindowHosts(win: Window): SidebarHostState {
    const existing = windowHosts.get(win);
    if (existing) {
      return existing;
    }

    const nextHosts: SidebarHostState = {};
    windowHosts.set(win, nextHosts);
    return nextHosts;
  }

  private static clearScopeRetryTimer(win: Window) {
    const retryTimer = windowScopeRetryTimer.get(win);
    if (retryTimer == null) {
      return;
    }

    win.clearTimeout(retryTimer);
    windowScopeRetryTimer.delete(win);
  }

  private static async requestSurfaceRefresh(win: Window): Promise<void> {
    try {
      await windowSurfaceRefresh.get(win)?.();
    } catch (error) {
      ztoolkit.log("Failed to refresh the Paperly AI surface:", error);
    }
  }

  private static syncLibraryEmptyStateHost(win: Window): void {
    const selectedLocation = this.getSelectedLocation(win);
    if (selectedLocation !== "library") {
      this.clearLibraryEmptyStateRetryTimer(win);
      windowLibraryEmptyStateRetryBudget.delete(win);
      this.renderLibraryEmptyStateHead(win, false);
      return;
    }

    const selectedItems = win.ZoteroPane?.getSelectedItems?.() ?? [];
    const shouldRender = selectedItems.length === 0;
    const didRender = this.renderLibraryEmptyStateHead(win, shouldRender);

    if (!shouldRender || didRender) {
      this.clearLibraryEmptyStateRetryTimer(win);
      windowLibraryEmptyStateRetryBudget.delete(win);
      return;
    }

    this.scheduleLibraryEmptyStateRetry(win);
  }

  private static renderLibraryEmptyStateHead(
    win: Window,
    shouldRender: boolean,
  ): boolean {
    const messagePane = this.getLibraryMessagePane(win.document);
    if (!messagePane?.renderCustomHead) {
      return false;
    }

    const libraryHost = windowHosts.get(win)?.library;
    if (!shouldRender) {
      messagePane.renderCustomHead();
      if (libraryHost?.attachmentTarget === "message-head") {
        libraryHost.reactRoot?.unmount();
        libraryHost.reactRoot = null;
        libraryHost.bootstrapped = false;
        libraryHost.bootstrappingPromise = null;
        libraryHost.attachmentTarget = null;
      }
      return true;
    }

    const host = this.getOrCreateLibraryMessageHeadHost(win);
    messagePane.renderCustomHead(({ append }) => {
      append(host.mountPoint);
      host.attachmentTarget = "message-head";
    });

    void this.ensureHostBootstrapped(win, host, "library").catch((error) => {
      ztoolkit.log(
        "Failed to bootstrap Paperly AI library empty-state host:",
        error,
      );
      this.renderBootstrapFailure(host, "library", error);
    });
    return true;
  }

  private static getOrCreateLibraryMessageHeadHost(
    win: Window,
  ): SidebarSurfaceHost {
    const hosts = this.ensureWindowHosts(win);
    const existing = hosts.library;
    if (existing?.attachmentTarget === "message-head") {
      return existing;
    }

    if (existing) {
      existing.reactRoot?.unmount();
    }

    const host = createSectionSidebarHost(
      "library",
      win.document as unknown as Document,
    );
    hosts.library = host;
    return host;
  }

  private static getLibraryMessagePane(
    doc: Pick<Document, "getElementById">,
  ): ItemMessagePaneLike | null {
    return doc.getElementById(
      "zotero-item-message",
    ) as ItemMessagePaneLike | null;
  }

  private static scheduleLibraryEmptyStateRetry(win: Window): void {
    if (windowLibraryEmptyStateRetryTimer.has(win)) {
      return;
    }

    const retries = windowLibraryEmptyStateRetryBudget.get(win) ?? 0;
    if (retries >= 5) {
      return;
    }
    windowLibraryEmptyStateRetryBudget.set(win, retries + 1);

    const timer = win.setTimeout(() => {
      windowLibraryEmptyStateRetryTimer.delete(win);
      this.syncLibraryEmptyStateHost(win);
    }, 100);
    windowLibraryEmptyStateRetryTimer.set(win, timer);
  }

  private static clearLibraryEmptyStateRetryTimer(
    win: Window,
  ): void {
    const retryTimer = windowLibraryEmptyStateRetryTimer.get(win);
    if (retryTimer == null) {
      return;
    }

    win.clearTimeout(retryTimer);
    windowLibraryEmptyStateRetryTimer.delete(win);
  }

  private static ensureHostBootstrapped(
    win: Window,
    hostState: SidebarSurfaceHost,
    location: SidebarLocation,
  ): Promise<void> {
    if (hostState.bootstrapped) {
      return Promise.resolve();
    }

    if (hostState.bootstrappingPromise) {
      return hostState.bootstrappingPromise;
    }

    hostState.bootstrappingPromise = (async () => {
      const { createRoot } = await this.getReactDomClient(win);
      if (!hostState.reactRoot) {
        hostState.reactRoot = createRoot(hostState.reactRootElement);
      }

      hostState.reactRoot.render(
        React.createElement(Sidebar, {
          eventBus: EventBus.getInstance(),
          hostWindow: win,
          location,
        }),
      );
      hostState.bootstrapped = true;
    })()
      .catch((error) => {
        hostState.reactRoot?.unmount();
        hostState.reactRoot = null;
        hostState.bootstrapped = false;
        throw error;
      })
      .finally(() => {
        hostState.bootstrappingPromise = null;
      });

    return hostState.bootstrappingPromise;
  }

  private static getSelectedLocation(
    win: Window,
  ): SidebarLocation | null {
    return resolveSidebarLocation(win.Zotero_Tabs?.selectedType || "");
  }

  private static async getReactDomClient(win: Window) {
    if (!reactDomClientPromise) {
      bindReactDomGlobals(win);
      reactDomClientPromise = import("react-dom/client");
    }
    return reactDomClientPromise;
  }

  private static removeLegacyStandaloneArtifacts(win: Window) {
    const root = (win.document.documentElement ||
      win.document.body) as ParentNode | null;
    for (const artifactId of LEGACY_STANDALONE_ARTIFACT_IDS) {
      this.collectElementsById(root, artifactId).forEach((element) => {
        element.remove();
      });
    }
  }

  private static collectElementsById(
    root: ParentNode | null,
    id: string,
  ): HTMLElement[] {
    if (!root || !("children" in root)) {
      return [];
    }

    const matches: HTMLElement[] = [];
    const stack = Array.from((root as Element).children);

    while (stack.length > 0) {
      const next = stack.shift();
      if (!next || typeof next !== "object" || !("children" in next)) {
        continue;
      }

      if ((next as HTMLElement).id === id) {
        matches.push(next as HTMLElement);
      }

      stack.unshift(...Array.from((next as Element).children));
    }

    return matches;
  }

  private static renderBootstrapFailure(
    hostState: SidebarSurfaceHost,
    location: SidebarLocation,
    error: unknown,
  ) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Unknown sidebar bootstrap failure";

    if (hostState.reactRoot) {
      try {
        hostState.reactRoot.render(
          React.createElement(SectionErrorCard, { location, message }),
        );
        return;
      } catch {
        // Fall back to direct DOM content below.
      }
    }

    const root = hostState.reactRootElement;
    const doc = root.ownerDocument;
    if (!doc) {
      root.textContent = message;
      return;
    }
    root.replaceChildren();

    const title = doc.createElement("div");
    title.textContent = `${location === "reader" ? "Reader" : "Library"} panel unavailable`;
    Object.assign(title.style, {
      color: "#7f1d1d",
      fontSize: typography.headingSm,
      fontWeight: "700",
      marginBottom: "8px",
    });

    const detail = doc.createElement("div");
    detail.textContent = message;
    Object.assign(detail.style, {
      color: "#991b1b",
      fontSize: typography.meta,
      lineHeight: "1.5",
    });

    Object.assign(root.style, {
      background: "#fff1f2",
      border: "1px solid #fecdd3",
      borderRadius: "14px",
      boxSizing: "border-box",
      margin: "12px",
      padding: "12px",
    });
    root.appendChild(title);
    root.appendChild(detail);
  }
}

function SectionErrorCard({
  location,
  message,
}: {
  location: SidebarLocation;
  message: string;
}) {
  return React.createElement(
    "div",
    {
      style: {
        background: "#fff1f2",
        border: "1px solid #fecdd3",
        borderRadius: "14px",
        boxSizing: "border-box",
        color: "#881337",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        height: "100%",
        margin: "12px",
        padding: "14px",
      },
    },
    React.createElement(
      "div",
      {
        style: {
          fontSize: typography.headingSm,
          fontWeight: 700,
        },
      },
      `${location === "reader" ? "Reader" : "Library"} sidebar fallback`,
    ),
    React.createElement(
      "div",
      {
        style: {
          fontSize: typography.meta,
          lineHeight: 1.5,
        },
      },
      message,
    ),
  );
}
