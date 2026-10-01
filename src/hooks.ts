import { initLocale } from "./utils/locale";
import { config, version } from "../package.json";
import { createZToolkit } from "./utils/ztoolkit";
import { UIFactory } from "./ui/ui";
import { initReaderIntegration, cleanupReaderIntegration } from "./modules/readerIntegration";
import { flushPaperNoteSaves } from "./services/readerNoteStore";
import { registerScopeNotifier, unregisterScopeNotifier } from "./services/scopeResolver";
import { EventBus } from "./utils/eventBus";
import { createWindowEventDispatcher } from "./utils/windowLifecycle";
import {
  registerWebAIColumnMenu,
  removeWebAIColumn,
} from "./modules/webAIColumn";
import {
  installWebAINewWindowHandler,
  uninstallWebAINewWindowHandler,
} from "./modules/webAINewWindow";
import {
  installFloatingBot,
  registerFloatingBotMenu,
  removeFloatingBotMenu,
  uninstallAllFloatingBots,
  uninstallFloatingBot,
} from "./modules/floatingBot";
import { buildStartupDiagnostic } from "./utils/startupDiagnostics";
import { registerPreferencesPane } from "./modules/preferencesPane";
import { registerBotSettings } from "./modules/botSettings";
import {
  registerReadingStatus,
  unregisterReadingStatus,
} from "./modules/readingStatus";
import {
  initReadingStatusStore,
  shutdownReadingStatusStore,
} from "./services/readingStatusStore";
import {
  registerStarredPapers,
  unregisterStarredPapers,
} from "./modules/starredPapers";
import type { ScopeContext } from "./types/scope";

let scopeChangeCallback: ((scope: ScopeContext | null) => void) | null = null;
const scopeChangeDispatcher =
  createWindowEventDispatcher<Window, ScopeContext | null>("scopeChange");
const BRANDED_PREFERENCES_ICON =
  `chrome://${config.addonRef}/content/icons/icon-20.png`;

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  ztoolkit.log(
    buildStartupDiagnostic({
      addonID: config.addonID,
      stage: "startup",
      version,
    }),
  );

  // Register reader integration
  try {
    initReaderIntegration();
    ztoolkit.log("Reader integration initialized");
  } catch (e) {
    ztoolkit.log("Reader integration init failed:", e);
  }

  // Reading status, before anything that draws it: the column refuses to
  // register unless the store loaded, so the order here is what decides whether
  // the feature appears at all. Failure is contained -- it leaves the rest of
  // the plugin untouched.
  try {
    if (await initReadingStatusStore()) {
      registerReadingStatus();
    }
  } catch (e) {
    ztoolkit.log("Reading status init failed:", e);
  }

  // Independent of the above: the star is a tag on the item, so it has no store
  // to load and nothing to fail before it can be drawn.
  try {
    registerStarredPapers();
  } catch (e) {
    ztoolkit.log("Starred papers init failed:", e);
  }

  // Register preferences pane
  try {
    await Zotero.PreferencePanes.register({
      pluginID: addon.data.config.addonID,
      src: `chrome://${addon.data.config.addonRef}/content/preferences.xhtml`,
      id: `${addon.data.config.addonRef}-prefpane`,
      label: "Paperly AI",
      image: BRANDED_PREFERENCES_ICON,
    });
    ztoolkit.log("Preferences pane registered");
  } catch (e) {
    ztoolkit.log("Preferences pane registration failed:", e);
  }

  // Load UI for all windows
  const mainWindows = Zotero.getMainWindows();
  if (mainWindows.length > 0) {
    const results = await Promise.allSettled(mainWindows.map((win) => onMainWindowLoad(win)));
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        ztoolkit.log(`Window bootstrap failed for index ${index}:`, result.reason);
      }
    });
  }

}

const STYLESHEET_LINK_ID = "zotero-webai-stylesheet";

// Per-window, not nsIStyleSheetService: loadAndRegisterSheet applies the sheet to
// EVERY document in the process -- every Zotero window, the preferences window,
// each reader iframe, other plugins' panes, and the chatgpt.com / claude.ai page
// inside our own embedded <browser>. A per-window <link> keeps the blast radius
// to the windows we actually decorate, and makes teardown provably complete.
function loadStylesheet(win: Window) {
  const doc = win.document;
  if (doc.getElementById(STYLESHEET_LINK_ID)) {
    return;
  }
  const link = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "link",
  ) as HTMLLinkElement;
  link.id = STYLESHEET_LINK_ID;
  link.rel = "stylesheet";
  link.href = `chrome://${addon.data.config.addonRef}/content/styles.css`;
  (doc.documentElement || doc.body)?.appendChild(link);
}

function unloadStylesheet(win: Window) {
  win.document.getElementById(STYLESHEET_LINK_ID)?.remove();
}

async function onMainWindowLoad(win: Window): Promise<void> {
  addon.data.ztoolkit = createZToolkit();
  ztoolkit.log(
    buildStartupDiagnostic({
      addonID: config.addonID,
      stage: "main-window-load",
      version,
    }),
  );

  win.MozXULElement?.insertFTLIfNeeded?.(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  // Setup event bus on window
  win.__aiAssistantEventBus = EventBus.getInstance();
  scopeChangeDispatcher.addWindow(win);

  loadStylesheet(win);
  registerWebAIColumnMenu(win);
  // The menu entry goes up whether or not the bot does: it is the switch that
  // brings the bot back after it has been turned off.
  registerFloatingBotMenu(win);
  void installFloatingBot(win);
  // Cheap and inert until a link inside the column asks for a new tab, so it is
  // installed for the life of the window rather than tied to the column.
  installWebAINewWindowHandler(win);

  try {
    UIFactory.registerChatPanel(win);
    ztoolkit.log(
      buildStartupDiagnostic({
        addonID: config.addonID,
        stage: "sidebar-registered",
        version,
      }),
    );
  } catch (error) {
    ztoolkit.log(
      buildStartupDiagnostic({
        addonID: config.addonID,
        version,
        stage: "sidebar-registration-failed",
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  if (!scopeChangeCallback) {
    scopeChangeCallback = (scope) => {
      scopeChangeDispatcher.dispatch(scope);
      UIFactory.refreshAllWindows();
    };

    try {
      registerScopeNotifier(scopeChangeCallback);
      ztoolkit.log("Scope notifier registered");
    } catch (e) {
      ztoolkit.log("Scope notifier registration failed:", e);
    }
  }

  UIFactory.refreshWindow(win);
  ztoolkit.log(
    buildStartupDiagnostic({
      addonID: config.addonID,
      stage: "ui-ready",
      version,
    }),
  );
}

async function onMainWindowUnload(win: Window): Promise<void> {
  scopeChangeDispatcher.removeWindow(win);

  // Awaited, not fire-and-forget: this is the last chance for keystrokes that
  // are still inside the note panel's debounce window.
  try {
    await flushPaperNoteSaves();
  } catch (e) {
    ztoolkit.log("Reader note flush failed on window unload:", e);
  }

  try {
    UIFactory.removeChatPanel(win);
  } catch (e) {
    ztoolkit.log("Sidebar removal failed for window:", e);
  }

  removeWebAIColumn(win);
  uninstallFloatingBot(win);
  removeFloatingBotMenu(win);
  uninstallWebAINewWindowHandler(win);
  unloadStylesheet(win);
  addon.data.dialog?.window?.close();
}

async function onShutdown(): Promise<void> {
  unregisterScopeNotifier();
  scopeChangeCallback = null;
  scopeChangeDispatcher.clear();

  // Zotero awaits shutdown listeners before it closes the database, so a save
  // started here still commits -- as long as it is awaited.
  try {
    await flushPaperNoteSaves();
  } catch (e) {
    ztoolkit.log("Reader note flush failed on shutdown:", e);
  }

  try {
    cleanupReaderIntegration();
  } catch (e) {
    ztoolkit.log("Reader integration cleanup failed:", e);
  }

  try {
    unregisterReadingStatus();
    shutdownReadingStatusStore();
    unregisterStarredPapers();
  } catch (e) {
    ztoolkit.log("Reading status shutdown failed:", e);
  }

  uninstallAllFloatingBots();
  for (const win of Zotero.getMainWindows()) {
    removeFloatingBotMenu(win);
    uninstallWebAINewWindowHandler(win);
    unloadStylesheet(win);
  }
  UIFactory.shutdown();
  EventBus.dispose();
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  addon.data.alive = false;

  try {
    delete (Zotero as typeof Zotero & Record<string, unknown>)[
      addon.data.config.addonInstance
    ];
  } catch {
    // Ignore
  }
}

async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  ztoolkit.log("notify", event, type, ids, extraData);
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      if (data.window) {
        registerPreferencesPane(data.window as Window);
        registerBotSettings(data.window as Window);
      }
      break;
    default:
      return;
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
};
