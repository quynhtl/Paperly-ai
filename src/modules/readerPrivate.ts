type SelectionRangeLike = {
  text?: unknown;
};

type PDFViewerLike = {
  currentPageNumber?: unknown;
};

type ReaderPrimaryViewLike = {
  _iframeWindow?: {
    PDFViewerApplication?: {
      pdfViewer?: PDFViewerLike;
    };
  };
  _selectionRanges?: SelectionRangeLike[];
};

type ReaderPrivateLike = {
  _internalReader?: {
    _primaryView?: ReaderPrimaryViewLike;
  };
};

type ReaderTabLike = {
  data?: unknown;
  id?: string | number;
};

function getReaderPrimaryView(reader: unknown): ReaderPrimaryViewLike | null {
  if (!reader || typeof reader !== "object") {
    return null;
  }

  const internalReader = (reader as ReaderPrivateLike)._internalReader;
  if (!internalReader || typeof internalReader !== "object") {
    return null;
  }

  const primaryView = internalReader._primaryView;
  if (!primaryView || typeof primaryView !== "object") {
    return null;
  }

  return primaryView;
}

function toNumericID(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

export function getReaderSelectedText(reader: unknown): string | null {
  const primaryView = getReaderPrimaryView(reader);
  if (!primaryView?._selectionRanges?.length) {
    return null;
  }

  const selectedText = primaryView._selectionRanges
    .map((range) => (typeof range?.text === "string" ? range.text : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();

  return selectedText || null;
}

export function getReaderCurrentPage(reader: unknown): number | undefined {
  const pdfViewer = getReaderPrimaryView(reader)?._iframeWindow?.PDFViewerApplication?.pdfViewer;
  const pageNumber = pdfViewer?.currentPageNumber;
  if (typeof pageNumber === "number" && Number.isFinite(pageNumber) && pageNumber > 0) {
    return pageNumber;
  }

  return undefined;
}

export function extractReaderAttachmentIDFromTabData(data: unknown): number | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const source = data as Record<string, unknown>;
  const directCandidate = toNumericID(
    source.itemID ??
      source.itemId ??
      source.attachmentID ??
      source.attachmentId ??
      source.id,
  );
  if (directCandidate) {
    return directCandidate;
  }

  for (const value of Object.values(source)) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const nested = value as Record<string, unknown>;
    const nestedCandidate = toNumericID(
      nested.itemID ??
        nested.itemId ??
        nested.attachmentID ??
        nested.attachmentId ??
        nested.id,
    );
    if (nestedCandidate) {
      return nestedCandidate;
    }
  }

  return null;
}

export function findReaderTabByID(
  tabs: unknown,
  selectedTabID: string,
): ReaderTabLike | null {
  if (!Array.isArray(tabs) || !selectedTabID) {
    return null;
  }

  return (
    tabs.find((tab) => `${(tab as ReaderTabLike | null)?.id ?? ""}` === selectedTabID) ?? null
  );
}

/**
 * What the open reader's toolbar actually needs to lay out without its sections
 * painting over each other, or null when no reader is open.
 *
 * The toolbar is `justify-content: space-between` over three sections that keep
 * their intrinsic width whatever width the bar itself gets -- squeeze it and
 * the gaps close, then the sections overlap. So reading the three live widths
 * gives the real requirement at any bar width, and it drops on its own once the
 * narrow-reader styles take over. Measured on a 37-page PDF: 793px normally,
 * 620px once those apply.
 */
export function getReaderToolbarMinWidth(win: Window): number | null {
  try {
    const tabs = (
      win as Window & {
        Zotero_Tabs?: { selectedID?: string; selectedType?: string };
      }
    ).Zotero_Tabs;
    if (!`${tabs?.selectedType || ""}`.toLowerCase().includes("reader")) {
      return null;
    }
    const reader = Zotero.Reader?.getByTabID?.(`${tabs?.selectedID || ""}`) as
      | { _iframeWindow?: Window }
      | undefined;
    const doc = reader?._iframeWindow?.document;
    const toolbar = doc?.querySelector(".toolbar") as HTMLElement | null;
    if (!toolbar) {
      return null;
    }
    const sections = ["start", "center", "end"].map(
      (name) => toolbar.querySelector(`.${name}`) as HTMLElement | null,
    );
    if (sections.some((section) => !section)) {
      return null;
    }
    const content = sections.reduce(
      (total, section) => total + (section as HTMLElement).offsetWidth,
      0,
    );
    const style = doc?.defaultView?.getComputedStyle(toolbar);
    const padding =
      (parseFloat(style?.paddingLeft || "0") || 0) +
      (parseFloat(style?.paddingRight || "0") || 0);
    return content > 0 ? Math.ceil(content + padding) : null;
  } catch {
    // A reader mid-teardown has no document. The caller falls back.
    return null;
  }
}
