/**
 * Makes `target="_blank"` links work inside the WebAI column.
 *
 * Zotero answers every new-window request from content with
 * `browserWindowShim.js`, whose `_openURIInNewTab()` creates a `<browser>`,
 * sets `hidden = true`, and returns it without ever loading the URI. The file's
 * own header explains why that is fine for Zotero: "our browsers will never be
 * visible" -- they are translation and authentication scratch browsers, so a
 * link that wants a new tab genuinely has nowhere to go.
 *
 * The WebAI column is the first content browser in a Zotero window that the
 * user actually looks at, so for it the shim turns every such click into a
 * silent no-op -- Google AI Mode's citation cards being the case that surfaced
 * it. Nothing throws and nothing is logged; the page simply never appears.
 *
 * Rather than change Zotero's shim, this wraps it: the two entry points that
 * carry a URI divert the request only when its opener is one of our frames.
 * Everything else -- every translator, every login browser -- is forwarded to
 * the shim untouched.
 */

const FRAME_CLASS = "ai-assistant-web-browser";

// nsIBrowserDOMWindow.OPEN_PRINT_BROWSER, the one destination that must always
// reach the shim, because it routes to PrintUtils rather than to a tab.
const OPEN_PRINT_BROWSER = 4;

type OpenURIFn = (
  uri: nsIURI | null,
  openWindowInfo: unknown,
  where: number,
  flags: number,
  triggeringPrincipal: unknown,
  csp: unknown,
) => unknown;

type OpenURIInFrameFn = (
  uri: nsIURI | null,
  params: unknown,
  where: number,
  flags: number,
  name: string,
) => unknown;

/**
 * nsIBrowserDOMWindow as Zotero's shim implements it.
 *
 * Reading `window.browserDOMWindow` hands back an XPConnect reflection whose
 * interface members are **read-only** -- assigning to `openURI` throws
 * '"openURI" is read-only', which is why the methods cannot be patched in
 * place. The window's own attribute is writable, so the object is replaced by
 * a wrapper that forwards every member it does not care about.
 */
interface BrowserDOMWindowLike {
  createContentWindow?: OpenURIFn;
  createContentWindowInFrame?: OpenURIInFrameFn;
  openURI?: OpenURIFn;
  openURIInFrame?: OpenURIInFrameFn;
  canClose?: () => boolean;
  tabCount?: number;
}

interface OpenWindowInfoLike {
  parent?: { top?: { embedderElement?: unknown } } | null;
}

interface OpenURIInFrameParamsLike extends OpenWindowInfoLike {
  openWindowInfo?: OpenWindowInfoLike | null;
  openerBrowser?: unknown;
  triggeringPrincipal?: unknown;
}

// Keyed by window so a second main window gets its own wrapper, and so
// uninstall can put back exactly the object that was there.
const installed = new WeakMap<Window, BrowserDOMWindowLike>();

function browserDOMWindowSlot(win: Window): {
  browserDOMWindow?: BrowserDOMWindowLike;
} {
  // Cast rather than widen: zotero-types declares browserDOMWindow with the
  // full nsIBrowserDOMWindow signatures, which a forwarding wrapper cannot
  // satisfy -- it has to accept and return null.
  return win as unknown as { browserDOMWindow?: BrowserDOMWindowLike };
}

function safeSpec(uri: nsIURI | null): string {
  try {
    return uri?.spec || "(no uri)";
  } catch {
    return "(unreadable uri)";
  }
}

function asElement(value: unknown): Element | null {
  return value && typeof value === "object" && "classList" in value
    ? (value as Element)
    : null;
}

/**
 * The `<browser>` the request came from, or null when it is not one of ours.
 *
 * `openerBrowser` is the direct answer when Gecko provides it; the shim itself
 * reads it. When it does not -- a link with `rel="noopener"`, for instance --
 * the opener browsing context still leads back to the embedder element.
 */
function resolveWebAIFrame(
  openerBrowser: unknown,
  openWindowInfo: OpenWindowInfoLike | null | undefined,
): Element | null {
  const direct = asElement(openerBrowser);
  if (direct?.classList.contains(FRAME_CLASS)) {
    return direct;
  }
  const embedder = asElement(openWindowInfo?.parent?.top?.embedderElement);
  return embedder?.classList.contains(FRAME_CLASS) ? embedder : null;
}

function isDivertibleTarget(where: number): boolean {
  return where !== OPEN_PRINT_BROWSER;
}

/**
 * Loads the URI into the frame that asked for it. Returns false when the load
 * could not be started, so the caller can fall back to Zotero's shim.
 */
function divertIntoFrame(
  frame: Element,
  uri: nsIURI,
  triggeringPrincipal: unknown,
): boolean {
  let spec: string;
  let scheme: string;
  try {
    spec = uri.spec;
    scheme = uri.scheme;
  } catch {
    return false;
  }
  if (!spec) {
    return false;
  }

  if (scheme !== "http" && scheme !== "https") {
    // mailto:, a store link, a protocol handler -- none of those belong in a
    // reading column. Hand them to the OS, which is what "Open External" does.
    try {
      Zotero.launchURL(spec);
      return true;
    } catch (error) {
      ztoolkit.log("Failed to hand a WebAI link to the OS:", String(error));
      return false;
    }
  }

  const browser = frame as Element & {
    loadURI?: (target: nsIURI, options?: unknown) => void;
  };
  if (typeof browser.loadURI !== "function" || !frame.isConnected) {
    return false;
  }

  try {
    // No primeBrowserRemoteness() here. The frame has already been primed --
    // it is showing a page -- and priming is deliberately once-only, because
    // changeRemoteness() rebuilds the frameLoader and the loadURI that follows
    // is dropped without an error.
    browser.loadURI(uri, {
      triggeringPrincipal:
        triggeringPrincipal ??
        Services.scriptSecurityManager.getSystemPrincipal(),
    });
  } catch (error) {
    ztoolkit.log(
      "Failed to divert a WebAI link into the column:",
      String(error),
    );
    return false;
  }

  // The panel notices through its nsIWebProgress listener, the same way it
  // notices a link the page navigated to by itself.
  return true;
}

export function installWebAINewWindowHandler(win: Window): void {
  if (installed.has(win)) {
    return;
  }
  const slot = browserDOMWindowSlot(win);
  const original = slot.browserDOMWindow;
  if (!original) {
    // browserWindowShim.js installs it on DOMContentLoaded, long before a
    // plugin's main-window hook runs, so this means the shim is gone.
    ztoolkit.log(
      "No browserDOMWindow on this window; WebAI links will not open.",
    );
    return;
  }

  // Gecko picks between the openURI* and createContentWindow* pairs depending
  // on which process performs the load, and between the plain and *InFrame
  // variants depending on remoteness. All four can carry the URI of a link the
  // user just clicked, so all four are checked; the createContentWindow* pair
  // is handed a null URI when the page only wants an empty window, and then
  // there is nothing to divert.
  const divert = (
    entryPoint: string,
    uri: nsIURI | null,
    where: number,
    openerBrowser: unknown,
    openWindowInfo: OpenWindowInfoLike | null | undefined,
    principal: unknown,
  ): boolean => {
    if (!uri || !isDivertibleTarget(where)) {
      return false;
    }
    try {
      const frame = resolveWebAIFrame(openerBrowser, openWindowInfo);
      ztoolkit.log(
        `New-window request via ${entryPoint}, where=${where}, opener=` +
          `${frame ? "webai" : "other"}: ${safeSpec(uri)}`,
      );
      return !!frame && divertIntoFrame(frame, uri, principal);
    } catch (error) {
      // This runs inside Gecko's new-window path for the whole window, so a
      // throw here would break Zotero's own browsers too. Fall through to the
      // shim instead.
      ztoolkit.log("WebAI link diversion failed:", String(error));
      return false;
    }
  };

  const wrapper: BrowserDOMWindowLike & { QueryInterface?: unknown } = {
    QueryInterface: ChromeUtils.generateQI(["nsIBrowserDOMWindow"]),

    openURI(uri, openWindowInfo, where, flags, principal, csp) {
      const info = openWindowInfo as OpenWindowInfoLike | null;
      if (divert("openURI", uri, where, null, info, principal)) {
        return null;
      }
      return original.openURI?.(
        uri,
        openWindowInfo,
        where,
        flags,
        principal,
        csp,
      );
    },

    createContentWindow(uri, openWindowInfo, where, flags, principal, csp) {
      const info = openWindowInfo as OpenWindowInfoLike | null;
      if (divert("createContentWindow", uri, where, null, info, principal)) {
        return null;
      }
      return original.createContentWindow?.(
        uri,
        openWindowInfo,
        where,
        flags,
        principal,
        csp,
      );
    },

    openURIInFrame(uri, params, where, flags, name) {
      const typed = params as OpenURIInFrameParamsLike | null;
      if (
        divert(
          "openURIInFrame",
          uri,
          where,
          typed?.openerBrowser,
          typed?.openWindowInfo ?? typed,
          typed?.triggeringPrincipal,
        )
      ) {
        return null;
      }
      return original.openURIInFrame?.(uri, params, where, flags, name);
    },

    createContentWindowInFrame(uri, params, where, flags, name) {
      const typed = params as OpenURIInFrameParamsLike | null;
      if (
        divert(
          "createContentWindowInFrame",
          uri,
          where,
          typed?.openerBrowser,
          typed?.openWindowInfo ?? typed,
          typed?.triggeringPrincipal,
        )
      ) {
        return null;
      }
      return original.createContentWindowInFrame?.(
        uri,
        params,
        where,
        flags,
        name,
      );
    },

    canClose: () => original.canClose?.() ?? true,
    get tabCount() {
      return original.tabCount ?? 1;
    },
  };

  try {
    slot.browserDOMWindow = wrapper;
  } catch (error) {
    // Replacing a window global must never take the plugin's main-window
    // bootstrap down with it: links not opening is recoverable, a window with
    // no panel is not.
    ztoolkit.log(
      "Could not wrap browserDOMWindow; WebAI links will not open:",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  installed.set(win, original);
}

export function uninstallWebAINewWindowHandler(win: Window): void {
  const original = installed.get(win);
  if (!original) {
    return;
  }
  installed.delete(win);
  try {
    browserDOMWindowSlot(win).browserDOMWindow = original;
  } catch (error) {
    ztoolkit.log("Failed to restore browserDOMWindow:", String(error));
  }
}
