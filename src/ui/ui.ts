import { config } from "../../package.json";
import { registerSidebarRefreshHandler } from "./sidebarRuntime";
import { removeWebAIColumn, toggleWebAIColumn } from "../modules/webAIColumn";
// Cycle-safe: readerIntegration imports UIFactory from this module too, but
// neither side reads the other's binding at module-evaluation time -- both
// references live inside function bodies.
import {
  removeReaderTabbarButton,
  syncReaderTabbarButton,
} from "../modules/readerIntegration";

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
  // Up to 0.9.39 a second panel sat in the item pane's "No items selected"
  // head, next to the column. The column is the only panel now.
  "ai-assistant-pane-library-mount",
];

const windowRefreshCleanup = new WeakMap<Window, () => void>();
const windowSurfaceRefresh = new WeakMap<
  Window,
  () => Promise<void>
>();
const windowScopeRetryTimer = new WeakMap<Window, number>();
const windowReaderSectionWasExpanded = new WeakMap<Window, boolean>();

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
    this.clearScopeRetryTimer(win);
    windowReaderSectionWasExpanded.delete(win);
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

}
