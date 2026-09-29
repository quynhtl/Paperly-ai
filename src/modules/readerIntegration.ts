import React from "react";
import { createRoot } from "react-dom/client";
import type { ReaderActionDetail } from "../ui/readerActionFlow";
import { config } from "../../package.json";
import { getReaderCurrentPage, getReaderSelectedText } from "./readerPrivate";
import { createTraceId, debugLog } from "../utils/debugLog";
import { UIFactory } from "../ui/ui";
import {
  isWebAIColumnOpen,
  openWebAIColumn,
  subscribeWebAIColumnChange,
} from "./webAIColumn";
import type { WebAIServiceId } from "../ui/webAIServices";
import { copyTextToClipboard } from "../utils/clipboard";
import { createHostCustomEvent } from "../utils/domEvents";
import { getSettings } from "../services/settingsManager";
import { restoreFloatingBot } from "./floatingBot";
import { rememberLookupRequest } from "../services/lookupRequest";
import { EventBus } from "../utils/eventBus";
import { SelectionToolbar } from "../ui/components/SelectionToolbar";
import { getSidebarTheme } from "../ui/theme";
import { bindReactDomGlobals } from "../utils/reactGlobals";
import {
  destroyAllReaderNoteSurfaces,
  ensureReaderNoteButton,
} from "./readerNotePanel";

type ReaderSelectionPopupEvent = Parameters<
  typeof Zotero.Reader.registerEventListener<"renderTextSelectionPopup">
>[1] extends (event: infer T) => unknown
  ? T
  : never;

type ReaderViewContextMenuEvent = Parameters<
  typeof Zotero.Reader.registerEventListener<"createViewContextMenu">
>[1] extends (event: infer T) => unknown
  ? T
  : never;

type ReaderAnnotationContextMenuEvent = Parameters<
  typeof Zotero.Reader.registerEventListener<"createAnnotationContextMenu">
>[1] extends (event: infer T) => unknown
  ? T
  : never;

type ReaderToolbarEvent = Parameters<
  typeof Zotero.Reader.registerEventListener<"renderToolbar">
>[1] extends (event: infer T) => unknown
  ? T
  : never;

interface ReaderLike {
  itemID?: number;
  type?: string;
  _instanceID?: number | string;
  _iframeWindow?: Window;
  _window?: Window;
  tabID?: number | string;
}

const TOOLBAR_BUTTON_ID = "zotero-webai-reader-toolbar-button";
const TABBAR_BUTTON_ID = "zotero-webai-reader-tabbar-button";
// 48, not 24: styles.css draws the button's img at 24px, so a 24px file would
// be upscaled on every retina screen. 48 is exactly its 2x, and already exists
// for the plugin manager. The preferences pane keeps icon-20, because its size
// is Zotero's to decide, not ours.
const ICON_SRC = `chrome://${config.addonRef}/content/icons/icon-48.png`;

function isChineseLocale(): boolean {
  try {
    const locale =
      (globalThis as unknown as { Zotero?: { locale?: string } }).Zotero?.locale ||
      ((globalThis as unknown as { Zotero?: { Prefs?: { get?: (key: string, global?: boolean) => unknown } } }).Zotero?.Prefs?.get?.("intl.accept_languages", true) as string) ||
      "";
    return String(locale).toLowerCase().startsWith("zh");
  } catch {
    return false;
  }
}

let popupHandler:
  | ((event: ReaderSelectionPopupEvent) => void | Promise<void>)
  | null = null;
let contextMenuHandler:
  | ((event: ReaderViewContextMenuEvent) => void | Promise<void>)
  | null = null;
let annotationContextMenuHandler:
  | ((event: ReaderAnnotationContextMenuEvent) => void | Promise<void>)
  | null = null;
let toolbarHandler:
  | ((event: ReaderToolbarEvent) => void | Promise<void>)
  | null = null;
let settingsHandler: ((event: Event) => void) | null = null;
let columnUnsubscribe: (() => void) | null = null;

let activeDocSelectionListener: {
  doc: Document;
  handler: () => void;
} | null = null;

function dismissSelectionToolbar(doc: Document) {
  const mountPoint = doc.getElementById("zotero-webai-selection-toolbar-mount");
  if (mountPoint) {
    const root = (mountPoint as any)._reactRoot;
    if (root) {
      try {
        root.unmount();
      } catch (err) {
        // Ignore unmount errors
      }
      (mountPoint as any)._reactRoot = null;
    }
    mountPoint.remove();
  }
}

function showSelectionToolbar(
  text: string,
  rect: DOMRect,
  doc: Document,
  page: number,
  readerItemID: number,
  reader: ReaderLike,
) {
  const settings = getSettings();
  if (settings.selectionToolbarEnabled === false) {
    return;
  }

  let mountPoint = doc.getElementById("zotero-webai-selection-toolbar-mount");
  if (!mountPoint) {
    mountPoint = doc.createElement("div");
    mountPoint.id = "zotero-webai-selection-toolbar-mount";
    if (doc.body) {
      doc.body.appendChild(mountPoint);
    } else {
      return;
    }
  }

  const position = {
    top: rect.top,
    left: rect.left + rect.width / 2,
  };

  const mainWindow = Zotero.getMainWindow();
  // React DOM reads `window` off the global scope, and a plugin sandbox has
  // none until something binds one. Without this the first render throws
  // ReferenceError before the column has ever been opened.
  bindReactDomGlobals(mainWindow as unknown as Window);
  const themeMode = settings.themeMode || "auto";
  const theme = getSidebarTheme(mainWindow, themeMode);
  const zh = isChineseLocale();

  let root = (mountPoint as any)._reactRoot;
  if (!root) {
    root = createRoot(mountPoint);
    (mountPoint as any)._reactRoot = root;
  }

  const onAction = (actionId: string, selectedText: string) => {
    dispatchReaderAction(actionId as any, selectedText, page, readerItemID, reader, doc);
    dismissSelectionToolbar(doc);
  };

  const onDismiss = () => {
    dismissSelectionToolbar(doc);
  };

  root.render(
    React.createElement(SelectionToolbar, {
      selectedText: text,
      position,
      theme,
      isZh: zh,
      onAction,
      onDismiss,
    })
  );
}

function dispatchReaderAction(
  action: ReaderActionDetail["action"],
  text: string,
  page: number,
  readerItemID: number,
  reader?: ReaderLike,
  doc?: Document,
): void {
  const traceId = createTraceId(`reader-${action}`);
  const normalizedText = text.trim();
  const win = Zotero.getMainWindow?.() as
    | (Window & { __aiAssistantEventBus?: EventTarget })
    | null;
  const eventBus = win?.__aiAssistantEventBus;
  if (!normalizedText) {
    debugLog.warn("reader.action.blocked", {
      action,
      page,
      readerItemID,
      reason: "empty-selection",
      selectedTextChars: 0,
      surface: "reader",
      traceId,
    });
    return;
  }
  if (!win || !eventBus) {
    debugLog.warn("reader.action.blocked", {
      action,
      page,
      readerItemID,
      reason: "missing-event-bus",
      selectedTextChars: normalizedText.length,
      surface: "reader",
      traceId,
    });
    return;
  }

  const detail: ReaderActionDetail = {
    action,
    text: normalizedText,
    page,
    readerItemID,
    traceId,
  };

  debugLog.info("reader.action.dispatch", {
    action,
    page,
    readerItemID,
    selectedTextChars: normalizedText.length,
    surface: "reader",
    traceId,
  });

  void (async () => {
    try {
      await UIFactory.openSidebarFromReaderToolbar(win);
      await delayForReaderPanelListener(win);
    } catch (error) {
      debugLog.error("reader.action.openPanel.error", error, {
        action,
        page,
        readerItemID,
        surface: "reader",
        traceId,
      });
    }

    eventBus.dispatchEvent(
      new win.CustomEvent("readerSelectionAction", {
        detail,
      }),
    );
  })();
}

function delayForReaderPanelListener(win: Window): Promise<void> {
  return new Promise((resolve) => {
    win.setTimeout(resolve, 80);
  });
}

function onRenderTextSelectionPopup(event: ReaderSelectionPopupEvent): void {
  const { reader, doc, params, append } = event;

  if (reader?.type !== "pdf") {
    debugLog.debug("reader.popup.skip", {
      reason: "non-pdf-reader",
      readerType: String(reader?.type || ""),
      surface: "reader",
    });
    return;
  }

  const annotation = params?.annotation as
    | { pageIndex?: number; text?: string }
    | undefined;
  const annotationText = annotation?.text || "";
  if (!annotationText.trim()) {
    debugLog.warn("reader.popup.skip", {
      hasSelection: false,
      reason: "empty-annotation-text",
      readerItemID: reader?.itemID,
      selectedTextChars: 0,
      surface: "reader",
    });
    return;
  }

  const page = (annotation?.pageIndex ?? 0) + 1;
  const readerItemID = reader?.itemID;
  if (!readerItemID) {
    debugLog.warn("reader.popup.skip", {
      hasSelection: true,
      page,
      reason: "missing-reader-item-id",
      selectedTextChars: annotationText.trim().length,
      surface: "reader",
    });
    return;
  }

  debugLog.info("reader.popup.render", {
    hasSelection: true,
    page,
    readerItemID,
    selectedTextChars: annotationText.trim().length,
    surface: "reader",
  });

  const sel = doc.getSelection();
  let rect: DOMRect | null = null;
  if (sel && sel.rangeCount > 0) {
    rect = sel.getRangeAt(0).getBoundingClientRect();
  }

  const mainWindow = Zotero.getMainWindow?.();
  const eventBus = (mainWindow as any)?.__aiAssistantEventBus;
  if (eventBus && mainWindow) {
    eventBus.dispatchEvent(
      new mainWindow.CustomEvent("selectionTextUpdate", {
        detail: { text: annotationText },
      }),
    );
  }

  if (activeDocSelectionListener) {
    activeDocSelectionListener.doc.removeEventListener(
      "selectionchange",
      activeDocSelectionListener.handler
    );
    activeDocSelectionListener = null;
  }

  const onSelectionChange = () => {
    const currentSel = doc.getSelection();
    if (!currentSel || currentSel.isCollapsed || !currentSel.toString().trim()) {
      if (eventBus && mainWindow) {
        eventBus.dispatchEvent(
          new mainWindow.CustomEvent("selectionTextUpdate", {
            detail: { text: "" },
          }),
        );
      }
      dismissSelectionToolbar(doc);
      doc.removeEventListener("selectionchange", onSelectionChange);
      if (activeDocSelectionListener?.handler === onSelectionChange) {
        activeDocSelectionListener = null;
      }
    }
  };
  doc.addEventListener("selectionchange", onSelectionChange);
  activeDocSelectionListener = { doc, handler: onSelectionChange };

  const settings = getSettings();
  const toolbarWanted = settings.selectionToolbarEnabled !== false;
  const container = doc.createElement("div");
  container.className = "ai-assistant-selection-popup";
  container.style.cssText = "display: flex; flex-direction: column; gap: 2px;";
  const zh = isChineseLocale();

  // Look-up actions go in Zotero's own popup rather than the plugin's floating
  // toolbar: this is the sanctioned extension point for selection actions, it
  // is anchored to the selection, and it is where the user is already looking
  // when they meet a word they do not know.
  const lookupRow = doc.createElement("div");
  // wrap, because three labels in a popup sized to the selection can run out
  // of room; sharing a second line beats clipping one of them.
  lookupRow.style.cssText = "display: flex; flex-wrap: wrap; gap: 4px;";
  lookupRow.appendChild(
    createLookupButton(doc, "translate", zh ? "翻译" : "Translate", annotationText),
  );
  lookupRow.appendChild(
    createLookupButton(doc, "cambridge", zh ? "词典" : "Dictionary", annotationText),
  );
  // Brand name, so the label is the same in every locale.
  lookupRow.appendChild(
    createLookupButton(doc, "google", "Google", annotationText),
  );
  container.appendChild(lookupRow);

  // Explain and Ask belong here only when the floating toolbar is switched
  // off; with it on they are already one click away and would be offered twice.
  if (!toolbarWanted) {
    const label = doc.createElement("span");
    label.textContent = "Paperly AI";
    label.style.cssText =
      "font-size: 0.92em; color: inherit; opacity: 0.72; user-select: none; padding-left: 4px;";
    container.appendChild(label);

    const row = doc.createElement("div");
    row.style.cssText = "display: flex; gap: 4px;";

    const explainBtn = doc.createElement("button");
    explainBtn.className = "toolbar-button wide-button";
    explainBtn.style.cssText = "flex: 1;";
    explainBtn.textContent = zh ? "解释" : "Explain";
    explainBtn.addEventListener("click", () => {
      dispatchReaderAction("explain", annotationText, page, readerItemID, reader, doc);
    });

    const askBtn = doc.createElement("button");
    askBtn.className = "toolbar-button wide-button";
    askBtn.style.cssText = "flex: 1;";
    askBtn.textContent = zh ? "提问..." : "Ask...";
    askBtn.addEventListener("click", () => {
      dispatchReaderAction("ask", annotationText, page, readerItemID, reader, doc);
    });

    row.appendChild(explainBtn);
    row.appendChild(askBtn);
    container.appendChild(row);
  }

  // Appended BEFORE the floating toolbar is built, and the toolbar is wrapped.
  // This popup is rendered from inside a DOM event listener, which SWALLOWS
  // whatever is thrown in it: one bad render in the toolbar used to take the
  // look-up row down with it and there was nothing in the console to say so.
  append(container);

  if (toolbarWanted && rect) {
    try {
      showSelectionToolbar(annotationText, rect, doc, page, readerItemID, reader);
    } catch (error) {
      // ztoolkit.log, not debugLog: this one has to be visible in the ordinary
      // debug output without a diagnostic setting being on first. A silently
      // swallowed render here is precisely what hid this bug.
      ztoolkit.log(
        "readerIntegration: selection toolbar failed to render",
        String((error as Error)?.stack || error),
      );
    }
  }
}

function createLookupButton(
  doc: Document,
  serviceID: WebAIServiceId,
  label: string,
  text: string,
): HTMLElement {
  const button = doc.createElement("button");
  // Zotero's own popup button classes, so these sit in the row looking native.
  button.className = "toolbar-button wide-button";
  button.style.cssText = "flex: 1;";
  button.textContent = label;
  button.addEventListener("click", () => {
    void openLookupForSelection(serviceID, text);
  });
  return button;
}

async function openLookupForSelection(
  serviceID: WebAIServiceId,
  text: string,
): Promise<void> {
  const win = Zotero.getMainWindow?.() as Window | null;
  if (!win) {
    return;
  }
  try {
    // Left in the store as well as dispatched. If the column was closed the
    // Sidebar subscribes ~45ms after this event goes out -- measured -- and
    // takes the request from the store on the way in instead.
    rememberLookupRequest({ serviceID, text });
    await openWebAIColumn(win);
    const eventBus = (win as Window & { __aiAssistantEventBus?: EventTarget })
      .__aiAssistantEventBus;
    eventBus?.dispatchEvent(
      createHostCustomEvent("webAILookupRequest", { serviceID, text }, win),
    );
  } catch (error) {
    ztoolkit.log("Failed to open the look-up column:", error);
  }
}

/**
 * The text of the annotations a context menu was opened on, in document order.
 *
 * `params.ids` are annotation item keys. Only highlight and underline
 * annotations carry text; an image or ink annotation yields "", which is what
 * disables the items below.
 */
function getAnnotationsText(reader: ReaderLike, ids: string[]): string {
  if (!ids.length) {
    return "";
  }
  try {
    const itemIDs = (reader as { annotationItemIDs?: number[] })
      .annotationItemIDs;
    if (!Array.isArray(itemIDs) || !itemIDs.length) {
      return "";
    }
    const wanted = new Set(ids);
    return Zotero.Items.get(itemIDs)
      .filter((item) => wanted.has(item.key))
      .map((item) => String(item.annotationText || "").trim())
      .filter(Boolean)
      .join("\n\n");
  } catch (error) {
    debugLog.warn("reader.annotationMenu.textUnavailable", {
      detail: error instanceof Error ? error.message : String(error),
      surface: "reader",
    });
    return "";
  }
}

/**
 * Acts on the text of an existing highlight.
 *
 * Once text is highlighted, clicking it selects the annotation rather than the
 * text underneath, so the selection popup -- and with it Translate, Dictionary
 * and Google -- can no longer be reached for that passage. That is Zotero's
 * own behaviour (`getActionAtPosition` in the reader's `pdf-view.js`; hold Alt
 * to select text under an annotation instead).
 *
 * Its annotation popup takes no plugin content: the reader exposes
 * `renderTextSelectionPopup` for a live selection and nothing for an existing
 * annotation. The context menu is the one supported surface, and Zotero's own
 * items there are all about editing the annotation -- colour, page label,
 * delete -- with nothing that reads the text back out, not even a copy.
 */
function onCreateAnnotationContextMenu(
  event: ReaderAnnotationContextMenuEvent,
): void {
  const { reader, params, append } = event;
  const text = getAnnotationsText(reader as ReaderLike, params?.ids || []);
  if (!text) {
    // Every item below acts on text, so an image or ink annotation gets none.
    return;
  }
  const zh = isChineseLocale();

  debugLog.info("reader.annotationMenu.create", {
    annotationCount: params?.ids?.length || 0,
    selectedTextChars: text.length,
    surface: "reader",
  });

  const appendMenuItems = append as unknown as (...items: unknown[]) => void;
  appendMenuItems(
    {
      label: zh ? "复制文本" : "Copy Text",
      onCommand: () => copyTextToClipboard(text),
    },
    {
      label: zh ? "翻译" : "Translate",
      onCommand: () => void openLookupForSelection("translate", text),
    },
    {
      label: zh ? "词典" : "Dictionary",
      onCommand: () => void openLookupForSelection("cambridge", text),
    },
    {
      // Brand name, so the label is the same in every locale.
      label: "Google",
      onCommand: () => void openLookupForSelection("google", text),
    },
  );
}

function onCreateViewContextMenu(event: ReaderViewContextMenuEvent): void {
  const { reader, append } = event;

  if (reader?.type !== "pdf") {
    debugLog.debug("reader.contextMenu.skip", {
      reason: "non-pdf-reader",
      readerType: String(reader?.type || ""),
      surface: "reader",
    });
    return;
  }

  const readerItemID = reader?.itemID;

  const selectedText = getReaderSelectedText(reader);
  const page = getReaderCurrentPage(reader) ?? 1;

  const hasSelection = !!selectedText && selectedText.length > 0;
  const zh = isChineseLocale();

  debugLog.info("reader.contextMenu.create", {
    hasSelection,
    page,
    readerItemID,
    selectedTextChars: selectedText?.length || 0,
    surface: "reader",
  });

  const appendMenuItems = append as unknown as (...items: unknown[]) => void;
  appendMenuItems(
    {
      label: zh ? "用 Paperly AI 解释" : "Explain with Paperly AI",
      disabled: !hasSelection,
      persistent: true,
      onCommand: () => {
        if (selectedText && readerItemID) {
          dispatchReaderAction("explain", selectedText, page, readerItemID, reader);
          return;
        }
        debugLog.warn("reader.action.blocked", {
          action: "explain",
          page,
          readerItemID,
          reason: selectedText ? "missing-reader-item-id" : "empty-selection",
          selectedTextChars: selectedText?.length || 0,
          surface: "reader",
        });
      },
    },
    {
      label: zh ? "向 Paperly AI 提问..." : "Ask Paperly AI...",
      disabled: !hasSelection,
      persistent: true,
      onCommand: () => {
        if (selectedText && readerItemID) {
          dispatchReaderAction("ask", selectedText, page, readerItemID, reader);
          return;
        }
        debugLog.warn("reader.action.blocked", {
          action: "ask",
          page,
          readerItemID,
          reason: selectedText ? "missing-reader-item-id" : "empty-selection",
          selectedTextChars: selectedText?.length || 0,
          surface: "reader",
        });
      },
    },
  );
}

const TOOLBAR_FIT_STYLE_ID = "paperly-reader-toolbar-fit";

/**
 * Lets the reader's own toolbar survive a narrow reader.
 *
 * Zotero's reader toolbar is 793px of controls with no responsive rule of its
 * own -- no width media query, no ResizeObserver, no measuring in JS. Below
 * that the three sections paint over each other, and the page counter goes
 * first: `#numPages`' text is `position: absolute` so it takes no width at all
 * and the annotation tools are drawn straight over it. Measured in stock
 * Zotero with this plugin's column closed, the counter is covered by 15.6px at
 * a window of 800px, so this is not something the AI column causes -- it only
 * makes it easy to reach, because the column takes width from the paper.
 *
 * Rather than stop the column from taking that width, the toolbar is tightened
 * while the reader is narrow: every control is still there, just on smaller
 * metrics. Measured, the same toolbar goes from 792.6px to 620px -- 173px the
 * paper no longer needs.
 *
 * The breakpoint is the reader document's own viewport, which is the reader
 * pane, and it sits above the 831px where the counter starts being covered.
 */
function toolbarFitStyleSheet(): string {
  return `
@media (max-width: 900px) {
  .toolbar { padding-inline: 4px 2px; }
  .toolbar .start,
  .toolbar .center { gap: 2px; }
  .toolbar .end { gap: 4px; }
  .toolbar .divider { margin: 0 2px; }
  .toolbar .toolbar-button { width: 24px; height: 24px; }
  .toolbar .toolbar-button .progress-ring {
    width: 24px;
    height: 24px;
    padding: 5px;
  }
  .toolbar .toolbar-dropdown-button { width: 34px; gap: 2px; }
  .toolbar .toolbar-text-input { height: 24px; }
  .toolbar #pageNumber { width: 40px; padding: 0 4px; }
  /* The page total. Its text is out of flow, so it cannot be squeezed -- only
     covered. There is no room for it here, and the input beside it still shows
     the page you are on. */
  .toolbar #numPages { display: none; }
}
`;
}

// Scoped to the reader document on purpose: `.toolbar` also matches Zotero's
// own main-window toolbar, and this must never reach it.
function ensureToolbarFitStyles(doc: Document): void {
  if (doc.getElementById(TOOLBAR_FIT_STYLE_ID)) {
    return;
  }
  const style = doc.createElement("style");
  style.id = TOOLBAR_FIT_STYLE_ID;
  style.textContent = toolbarFitStyleSheet();
  (doc.head || doc.documentElement)?.appendChild(style);
}

function onRenderToolbar(event: ReaderToolbarEvent): void {
  const toolbarEvent = event as ReaderToolbarEvent & {
    append?: (...nodes: unknown[]) => void;
    doc?: Document;
    reader?: ReaderLike;
  };
  const { append, doc, reader } = toolbarEvent;
  if (!doc) {
    return;
  }

  try {
    ensureToolbarFitStyles(doc);
  } catch (error) {
    ztoolkit.log("readerIntegration: toolbar fit styles failed:", error);
  }

  // The note button binds to THIS reader, not to whichever window is focused:
  // one reader document is one paper.
  //
  // Wrapped, because Zotero.Reader._dispatchEvent walks its listener list with
  // no try/catch: anything thrown here stops every listener registered after
  // this one, in this plugin and in any other.
  if (reader) {
    try {
      ensureReaderNoteButton(doc, reader, append);
    } catch (error) {
      ztoolkit.log("readerIntegration: note button failed:", error);
    }
  }

  // renderToolbar is dispatched from the reader iframe, so the most recent main
  // window is by definition the one that owns this reader.
  const win = Zotero.getMainWindow?.() as Window | null;
  if (!win) {
    return;
  }
  syncActiveReaderWebAIEntrypoints(win, doc, append);
}


// Host the button in #zotero-tabs-toolbar, the static XUL hbox beside the tab
// bar that already holds Zotero's tabs-menu, progress-queue and sync buttons.
// Zotero itself puts a plain HTML <div class="zotero-tb-separator"> in there, so
// an HTML child is the established pattern.
//
// #tab-bar-container is off limits: tabs.js hands it to ReactDOM.createRoot, so
// React reconciles its children. Worse, the wrapper React renders inside it gets
// only `flex-grow: 1` and no `display`, so it is a BLOCK box -- an inline-flex
// button dropped there forms its own line box ABOVE the tab strip and doubles
// the title bar's height, which collides with the macOS
// `#titlebar { margin-bottom: -36px }` overlay. That is the tab-bar breakage.
//
// The toolbar exists at parse time and is owned by nobody, so there is no
// startup race and no need to watch the DOM for it.
function ensureReaderTabbarButton(win: Window): boolean {
  const doc = win.document;
  if (!doc) {
    return false;
  }

  // No longer gated on an open reader: the button toggles the AI column, which
  // lives outside the tab deck and works in the library view too. Gating it was
  // a leftover from when the surface was a panel inside the reader tab, and it
  // left the library with no way to switch the column off.
  const shouldShow = shouldShowToolbarIcon(getSettings().iconPlacement);

  // Look the button up before branching on shouldShow: a connector-mode pane
  // reload re-runs ZoteroPane._loadPane, and the id guard keeps that idempotent.
  let button = doc.getElementById(TABBAR_BUTTON_ID) as HTMLElement | null;
  if (!button) {
    if (!shouldShow) {
      return false;
    }
    const toolbar = doc.getElementById("zotero-tabs-toolbar");
    if (!toolbar) {
      return false;
    }
    button = createTabbarButton(doc, win);
    // Left of the progress-queue box: past the tabs-menu separator, among the
    // app-level controls. #zotero-pq-buttons is static markup so it is always
    // there, unlike #zotero-tb-sync-error which is hidden="true" by default.
    // insertBefore with a null anchor degrades to appendChild.
    toolbar.insertBefore(button, doc.getElementById("zotero-pq-buttons"));
  }

  button.hidden = !shouldShow;
  // It is a toggle now, so say which way it is pointing.
  const open = isWebAIColumnOpen(win);
  button.setAttribute("aria-pressed", open ? "true" : "false");
  button.classList.toggle("is-active", open);
  // The return value gates the in-reader fallback below, so it must mean
  // "visible", not "exists" -- returning true while hidden would leave the user
  // with no icon at all.
  return shouldShow;
}

// Driven by UIFactory.refreshWindow, which the per-window Zotero.Notifier
// "select"/"tab" observer already fires. Tab selection is the only signal this
// button's visibility depends on, which is what lets the old document-wide
// MutationObserver go away.
export function syncReaderTabbarButton(win: Window): void {
  ensureReaderTabbarButton(win);
}

export function removeReaderTabbarButton(win: Window): void {
  win.document?.getElementById(TABBAR_BUTTON_ID)?.remove();
}

// Fallback for when #zotero-tabs-toolbar is missing: puts the icon inside the
// reader's own toolbar instead. Only reached when ensureReaderTabbarButton
// returned false, so do not delete it as dead.
function ensureReaderToolbarButton(
  doc: Document,
  append?: (...nodes: unknown[]) => void,
): void {
  const mainWindow = Zotero.getMainWindow?.();
  const existing = doc.getElementById(TOOLBAR_BUTTON_ID) as HTMLElement | null;
  const iconPlacement = getSettings().iconPlacement;
  if (!shouldShowToolbarIcon(iconPlacement)) {
    existing?.remove();
    return;
  }
  if (existing) {
    positionReaderToolbarButton(doc, existing);
    return;
  }

  const button = doc.createElement("button");
  button.id = TOOLBAR_BUTTON_ID;
  button.className = "toolbar-button zotero-webai-reader-toolbar-button";
  button.type = "button";
  button.title = "Paperly AI";
  button.setAttribute("aria-label", "Paperly AI");

  const icon = doc.createElement("img");
  icon.alt = "";
  icon.src = ICON_SRC;
  button.appendChild(icon);

  button.addEventListener("click", () => {
    if (mainWindow) {
      void UIFactory.openSidebarFromReaderToolbar(mainWindow);
    }
  });

  if (append) {
    append(button);
  } else {
    const toolbar = findReaderToolbar(doc);
    toolbar?.appendChild(button);
  }
  positionReaderToolbarButton(doc, button);
}

function shouldShowToolbarIcon(iconPlacement: string): boolean {
  return iconPlacement === "both" || iconPlacement === "reader-toolbar";
}

function syncActiveReaderWebAIEntrypoints(
  win: Window,
  doc?: Document | null,
  append?: (...nodes: unknown[]) => void,
): void {
  const reader = getActiveReader(win);
  const tabbarButtonReady = ensureReaderTabbarButton(win);
  const readerDoc = doc || reader?._iframeWindow?.document || null;
  if (readerDoc && !tabbarButtonReady) {
    ensureReaderToolbarButton(readerDoc, append);
  }
}

// Takes the window explicitly. Zotero.getMainWindow() is getMostRecentWindow(),
// so with two main windows open the old version read the selected tab from
// whichever window was FOCUSED while writing the button into another one.
function getActiveReader(win: Window): ReaderLike | null {
  const tabs = (
    win as Window & {
      Zotero_Tabs?: {
        _selectedID?: string;
        selectedID?: string;
        selectedType?: string;
      };
    }
  ).Zotero_Tabs;
  const selectedType = `${tabs?.selectedType || ""}`.toLowerCase();
  if (!selectedType.includes("reader")) {
    return null;
  }
  const selectedID = `${tabs?.selectedID || tabs?._selectedID || ""}`;
  if (!selectedID) {
    return null;
  }
  return Zotero.Reader.getByTabID(selectedID) as ReaderLike | null;
}


function createTabbarButton(doc: Document, win: Window): HTMLElement {
  const button = doc.createElement("button");
  button.id = TABBAR_BUTTON_ID;
  button.className = "zotero-webai-reader-toolbar-button zotero-webai-reader-tabbar-button";
  button.type = "button";
  button.title = "Paperly AI";
  button.setAttribute("aria-label", "Paperly AI");
  // Every Zotero title-bar button carries tabindex="-1" because zoteroPane.js
  // builds a closed keyboard actionsMap over their hardcoded ids. An HTML
  // <button> is focusable by default and would land in the Tab chain at a
  // position that map has no entry for, breaking title-bar focus navigation.
  // The keyboard path to the panel is the View menu item instead.
  button.setAttribute("tabindex", "-1");

  const icon = doc.createElement("img");
  icon.alt = "";
  icon.src = ICON_SRC;
  button.appendChild(icon);

  button.addEventListener("click", () => {
    // Also the way back for a dismissed bot. It does not replace the click's
    // own job -- the panel still toggles -- so no press is ever spent purely on
    // undoing the X.
    void restoreFloatingBot(win);
    void UIFactory.openSidebarFromReaderToolbar(win);
  });
  return button;
}

function positionReaderToolbarButton(doc: Document, button: HTMLElement): void {
  const parent = button.parentElement;
  if (!parent) {
    const win = doc.defaultView;
    if (win) {
      win.setTimeout(() => {
        positionReaderToolbarButton(doc, button);
      }, 0);
    } else {
      (globalThis as any).setTimeout(() => {
        positionReaderToolbarButton(doc, button);
      }, 0);
    }
    return;
  }

  const toolbar = findReaderToolbar(doc);
  if (parent === toolbar) {
    const anchor = findMiddleToolbarAnchor(toolbar);
    if (anchor && anchor !== button && anchor.nextSibling !== button) {
      toolbar.insertBefore(button, anchor.nextSibling);
    }
    return;
  }

  const positionButton = () => {
    const translateButton = Array.from(parent.children).find((child) => {
      if (child === button) return false;
      const id = child.id?.toLowerCase() || "";
      const className = child.className?.toLowerCase() || "";
      const title = child.getAttribute("title")?.toLowerCase() || "";
      const label = child.getAttribute("aria-label")?.toLowerCase() || "";
      return (
        id.includes("translate") ||
        className.includes("translate") ||
        title.includes("translate") ||
        title.includes("翻译") ||
        label.includes("translate") ||
        label.includes("翻译")
      );
    });
    if (translateButton && button.nextSibling !== translateButton) {
      parent.insertBefore(button, translateButton);
    }
  };

  positionButton();

  const MutationObserverClass = doc.defaultView?.MutationObserver || globalThis.MutationObserver;
  if (typeof MutationObserverClass === "function") {
    const existingObserver = (button as any)._siblingObserver;
    if (existingObserver) {
      try {
        existingObserver.disconnect();
      } catch (e) {
        // ignore
      }
    }
    const observer = new MutationObserverClass(() => {
      positionButton();
    });
    observer.observe(parent, { childList: true });
    (button as any)._siblingObserver = observer;
  }
}

function findReaderToolbar(doc: Document): HTMLElement | null {
  const selectors = [
    "#toolbarContainer #toolbarViewer",
    "#toolbarViewer",
    "#viewer-toolbar",
    ".reader-toolbar",
    ".toolbar",
    "[role='toolbar']",
  ];

  for (const selector of selectors) {
    const match = doc.querySelector(selector) as HTMLElement | null;
    if (match) {
      return match;
    }
  }
  return null;
}

function findMiddleToolbarAnchor(toolbar: HTMLElement): Element | null {
  const selectors = [
    "[data-l10n-id*='page']",
    "[aria-label*='Page']",
    "[title*='Page']",
    "[aria-label*='PDF']",
    "[title*='PDF']",
    "input[type='number']",
  ];

  for (const selector of selectors) {
    const match = toolbar.querySelector(selector);
    if (match) {
      return match.closest("button,toolbarbutton,div,span") || match;
    }
  }

  const controls = Array.from(
    toolbar.querySelectorAll(
      "button,toolbarbutton,[role='button']",
    ) as NodeListOf<Element>,
  );
  const fallback = controls[
    Math.max(0, Math.floor(controls.length / 2) - 1)
  ] as Element | undefined;
  return fallback || null;
}
export function initReaderIntegration(): void {
  if (typeof Zotero?.Reader?.registerEventListener !== "function") {
    debugLog.warn("reader.integration.skip", {
      reason: "reader-api-unavailable",
      surface: "reader",
    });
    ztoolkit.log("readerIntegration: Reader API not available, skipping");
    return;
  }

  cleanupReaderIntegration();

  popupHandler = onRenderTextSelectionPopup;
  contextMenuHandler = onCreateViewContextMenu;
  annotationContextMenuHandler = onCreateAnnotationContextMenu;
  toolbarHandler = onRenderToolbar;
  settingsHandler = () => {
    for (const win of Zotero.getMainWindows()) {
      syncActiveReaderWebAIEntrypoints(win);
    }
  };

  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    popupHandler,
    config.addonID,
  );
  Zotero.Reader.registerEventListener(
    "createViewContextMenu",
    contextMenuHandler,
    config.addonID,
  );
  Zotero.Reader.registerEventListener(
    "createAnnotationContextMenu",
    annotationContextMenuHandler,
    config.addonID,
  );
  Zotero.Reader.registerEventListener(
    "renderToolbar",
    toolbarHandler,
    config.addonID,
  );
  EventBus.getInstance().addEventListener("settingsChange", settingsHandler);
  // Keep the button's pressed state honest however the column was toggled --
  // tab-bar button, close button in the header, or the View menu item.
  columnUnsubscribe = subscribeWebAIColumnChange((win) => {
    ensureReaderTabbarButton(win);
  });
  // Loop over windows rather than only the focused one: enabling the plugin
  // mid-session from the Add-ons manager does not re-run onMainWindowLoad.
  for (const win of Zotero.getMainWindows()) {
    ensureReaderTabbarButton(win);
  }

  debugLog.info("reader.integration.registered", {
    surface: "reader",
  });
  ztoolkit.log("readerIntegration: Registered reader event listeners");
}

export function cleanupReaderIntegration(): void {
  if (activeDocSelectionListener) {
    try {
      activeDocSelectionListener.doc.removeEventListener(
        "selectionchange",
        activeDocSelectionListener.handler
      );
      dismissSelectionToolbar(activeDocSelectionListener.doc);
    } catch {
      // Ignore cleanup issues
    }
    activeDocSelectionListener = null;
  }
  if (popupHandler) {
    Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", popupHandler);
    popupHandler = null;
  }
  if (contextMenuHandler) {
    Zotero.Reader.unregisterEventListener("createViewContextMenu", contextMenuHandler);
    contextMenuHandler = null;
  }
  if (annotationContextMenuHandler) {
    Zotero.Reader.unregisterEventListener(
      "createAnnotationContextMenu",
      annotationContextMenuHandler,
    );
    annotationContextMenuHandler = null;
  }
  if (toolbarHandler) {
    Zotero.Reader.unregisterEventListener("renderToolbar", toolbarHandler);
    toolbarHandler = null;
  }
  if (settingsHandler) {
    EventBus.getInstance().removeEventListener("settingsChange", settingsHandler);
    settingsHandler = null;
  }
  columnUnsubscribe?.();
  columnUnsubscribe = null;
  destroyAllReaderNoteSurfaces();
  for (const win of Zotero.getMainWindows()) {
    removeReaderTabbarButton(win);
  }
}
