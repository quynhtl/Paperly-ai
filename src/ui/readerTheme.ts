// The colours of the page the user is reading.
//
// Zotero's reader theme is one small object: an id, a background and a
// foreground. Which one applies is a light/dark decision times a preference.
// None of that is published as an event, and for a PDF only the BACKGROUND
// reaches the DOM -- `pdf-view.js` sets `--background-color` on the pdf.js
// iframe root and hands the foreground to pdf.js as a JS global, so reading the
// DOM alone gets sepia's cream right and its brown text wrong. Measured: the
// reader's own root reports `--background-color: #F4ECD8` and `--text-color:
// (none)`.
//
// So the theme is recomputed from the same inputs Zotero uses, and the DOM is
// consulted only as a cross-check for the background.

import { luminance } from "./noteColors";

interface ReaderThemeRecord {
  id: string;
  background: string;
  foreground: string;
}

// Copy of DEFAULT_THEMES in zotero-client/reader/src/common/defines.js. The
// reader is a webpack bundle, so a plugin cannot import it. If Zotero adds or
// recolours a built-in theme this copy goes stale -- the DOM cross-check below
// keeps at least the background honest when that happens.
const BUILTIN_THEMES: ReaderThemeRecord[] = [
  { id: "dark", background: "#2E3440", foreground: "#D8DEE9" },
  { id: "black", background: "#000000", foreground: "#FFFFFF" },
  { id: "snow", background: "#ECEFF4", foreground: "#3B4252" },
  { id: "sepia", background: "#F4ECD8", foreground: "#5B4636" },
];

// What the reader calls "Original": no theme selected.
const ORIGINAL: ReaderThemeRecord = {
  id: "",
  background: "#FFFFFF",
  foreground: "#000000",
};

export interface PaperTheme {
  /** The page colour. */
  background: string;
  /** The ink colour. For a PDF this is only knowable from the theme record. */
  foreground: string;
  /** Which of the two is lighter, by WCAG luminance. Drives shadows, not text. */
  scheme: "light" | "dark";
}

type ReaderLike = {
  _iframeWindow?: Window;
  _internalReader?: {
    _state?: { colorScheme?: string | null };
    _primaryView?: { _iframeWindow?: Window };
  };
};

const ZoteroSynced = Zotero as unknown as {
  SyncedSettings?: {
    get: (libraryID: number, setting: string) => unknown;
  };
};

function customThemes(): ReaderThemeRecord[] {
  try {
    const value = ZoteroSynced.SyncedSettings?.get(
      Zotero.Libraries.userLibraryID,
      "readerCustomThemes",
    );
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter(
      (entry): entry is ReaderThemeRecord =>
        !!entry &&
        typeof (entry as ReaderThemeRecord).id === "string" &&
        typeof (entry as ReaderThemeRecord).background === "string" &&
        typeof (entry as ReaderThemeRecord).foreground === "string",
    );
  } catch {
    return [];
  }
}

// Each view resolves light/dark from the READER IFRAME's own media query, not
// the chrome window's. Asking the same window the reader asks is the only way
// the panel cannot disagree with what is on screen.
function colorSchemeOf(reader: ReaderLike | null | undefined): "light" | "dark" {
  const forced = reader?._internalReader?._state?.colorScheme;
  if (forced === "light" || forced === "dark") {
    return forced;
  }
  try {
    const media = (
      reader?._iframeWindow as
        | { matchMedia?: (query: string) => { matches?: boolean } | null }
        | undefined
    )?.matchMedia?.("(prefers-color-scheme: dark)");
    if (media?.matches) {
      return "dark";
    }
  } catch {
    // A closed reader throws on matchMedia; fall through to light.
  }
  return "light";
}

function normalizeHex(value: unknown): string | null {
  const text = `${value ?? ""}`.trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(text) ? text : null;
}

/** The colours of the page this reader is showing. Never throws. */
export function resolveReaderPaperTheme(
  reader: ReaderLike | null | undefined,
): PaperTheme {
  const scheme = colorSchemeOf(reader);
  let record = ORIGINAL;
  try {
    const wanted = `${
      Zotero.Prefs.get(
        scheme === "dark" ? "reader.darkTheme" : "reader.lightTheme",
      ) ?? ""
    }`;
    if (wanted) {
      record =
        [...BUILTIN_THEMES, ...customThemes()].find(
          (theme) => theme.id === wanted,
        ) || ORIGINAL;
    }
  } catch {
    record = ORIGINAL;
  }

  let background = normalizeHex(record.background) || ORIGINAL.background;
  const foreground = normalizeHex(record.foreground) || ORIGINAL.foreground;

  // Cross-check the background against what is actually painted. This is the
  // one value the view publishes, and trusting it covers a stale copy of
  // BUILTIN_THEMES. The foreground has no DOM source for PDFs, so it stays.
  try {
    const root =
      reader?._internalReader?._primaryView?._iframeWindow?.document
        ?.documentElement;
    const painted = normalizeHex(
      (root as HTMLElement | undefined)?.style.getPropertyValue(
        "--background-color",
      ),
    );
    if (painted) {
      background = painted;
    }
  } catch {
    // Reading across the document boundary can throw while a view is swapping.
  }

  return {
    background,
    foreground,
    scheme: luminance(background) > luminance(foreground) ? "light" : "dark",
  };
}

// Everything that can change the answer, minus the per-reader media query,
// which the panel adds on its own window. Refcounted so several panels share
// one set of observers, and so the last one to close takes them down again --
// a Prefs observer that outlives its window is the classic leak here.
type ThemeListener = () => void;

const listeners = new Set<ThemeListener>();
let prefSymbols: unknown[] = [];
let notifierID: string | null = null;

function fanOut(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One bad listener must not stop the others.
    }
  }
}

function attachSources(): void {
  try {
    prefSymbols = [
      Zotero.Prefs.registerObserver("reader.lightTheme", fanOut),
      Zotero.Prefs.registerObserver("reader.darkTheme", fanOut),
    ];
  } catch {
    prefSymbols = [];
  }
  try {
    notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (_event: string, type: string, ids: (string | number)[]) => {
          if (
            type === "setting" &&
            `${ids?.[0] ?? ""}`.endsWith("/readerCustomThemes")
          ) {
            fanOut();
          }
        },
      },
      ["setting"],
      "paperly-reader-theme",
    );
  } catch {
    notifierID = null;
  }
}

function detachSources(): void {
  for (const symbol of prefSymbols) {
    try {
      Zotero.Prefs.unregisterObserver(symbol as symbol);
    } catch {
      // Already gone.
    }
  }
  prefSymbols = [];
  if (notifierID) {
    try {
      Zotero.Notifier.unregisterObserver(notifierID);
    } catch {
      // Already gone.
    }
    notifierID = null;
  }
}

/** Calls back when the reader theme preferences or the custom themes change. */
export function subscribeReaderThemeSources(
  listener: ThemeListener,
): () => void {
  if (listeners.size === 0) {
    attachSources();
  }
  listeners.add(listener);
  return () => {
    if (!listeners.delete(listener)) {
      return;
    }
    if (listeners.size === 0) {
      detachSources();
    }
  };
}
