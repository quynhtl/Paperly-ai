// The tools Paperly gives the agent: read the paper, the selection, the
// highlights, search the library, find related work -- and add a note, which
// waits for the user's Allow in the chat.
//
// Each tool takes the paper's item key explicitly. Nothing here reads "the
// tab that happens to be open", because the user may switch tabs while the
// agent is still working.

import { getReaderCurrentPage, getReaderSelectedText } from "../readerPrivate";
import { markdownToNoteHtml } from "./markdown";
import type { McpHost, McpTool, McpToolResult } from "./mcpProtocol";
import { errorMessage, setLibrary } from "./util";

const PAGES_PER_CALL = 10;
const PAGE_TEXT_LIMIT = 15000;
const CALL_TEXT_LIMIT = 60000;
const SECTION_SIZE = 4000;
const ABSTRACT_LIMIT = 3000;

export interface ToolCallContext {
  /** The chat turn this call belongs to, from the X-Paperly-Turn header. */
  turnId: string | null;
}

export interface NoteApprovalRequest {
  turnId: string;
  title: string;
  markdown: string;
  paperTitle: string;
}

export interface PaperToolDependencies {
  /** Resolves true only when the user pressed Allow in the chat. */
  requestNoteApproval(request: NoteApprovalRequest): Promise<"allowed" | "denied" | "expired" | "no_turn">;
  version: string;
}

const ITEM_KEY = {
  type: "string",
  description: "The paper's 8-character item key, as given in your instructions or by search_library.",
};

export const PAPER_TOOLS: McpTool[] = [
  {
    name: "get_current_paper",
    title: "Paper details",
    description:
      "Details of a paper in the user's Paperly library: title, authors, year, venue, DOI, abstract, page count, whether it is open in the reader and on which page, and how many highlights and notes it has. Call this first when a question is about a paper.",
    inputSchema: {
      type: "object",
      properties: { item_key: ITEM_KEY },
      required: ["item_key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "read_pages",
    title: "Read pages",
    description:
      "Text of pages of a paper's PDF, each prefixed with [page N]. Read only the pages you need, at most 10 per call; get_current_paper tells you the page count. Pages are the PDF's own pages, starting at 1.",
    inputSchema: {
      type: "object",
      properties: {
        item_key: ITEM_KEY,
        from: { type: "integer", minimum: 1, description: "First page to read." },
        to: { type: "integer", minimum: 1, description: "Last page to read (inclusive). Defaults to `from`." },
      },
      required: ["item_key", "from"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_selection",
    title: "Selected text",
    description:
      "The text the user has selected in this paper in Paperly's reader right now, with its page. Use it when the user says \"this\", \"the selection\" or \"the highlighted passage\".",
    inputSchema: {
      type: "object",
      properties: { item_key: ITEM_KEY },
      required: ["item_key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_annotations",
    title: "Highlights and comments",
    description:
      "The user's highlights, underlines, notes and comments on a paper, with page labels, in reading order.",
    inputSchema: {
      type: "object",
      properties: {
        item_key: ITEM_KEY,
        limit: { type: "integer", minimum: 1, maximum: 300, description: "At most this many (default 100)." },
      },
      required: ["item_key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "search_library",
    title: "Search the library",
    description:
      "Searches the user's whole Paperly library: titles, authors, years, notes, highlights and full text. Returns item keys that the other tools accept.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "At most this many (default 10)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "find_related",
    title: "Find related work",
    description:
      "Looks for related papers on arXiv and Semantic Scholar (the query is sent to those services). Returns titles, authors, years, links and short abstracts.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A topic, title or key phrase." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "At most this many from each service (default 6)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "add_note",
    title: "Add a note",
    description:
      "Saves a note on a paper in the user's library. Paperly shows the note to the user first and saves it only if they press Allow; if they decline, tell them and do not try again. Use it only when the user asks to save something. `content` is Markdown; write math as $...$ and $$...$$.",
    inputSchema: {
      type: "object",
      properties: {
        item_key: ITEM_KEY,
        title: { type: "string", description: "A short title for the note." },
        content: { type: "string", description: "The note, in Markdown." },
      },
      required: ["item_key", "title", "content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

const HOST_INSTRUCTIONS =
  "Paperly's tools read the user's own library. Pass the item key from your instructions; read only the pages you need.";

/* ------------------------------------------------------------------ items */

async function resolveItem(key: unknown): Promise<Zotero.Item> {
  const text = String(key || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(text)) {
    throw new Error(`"${String(key)}" is not an item key; keys look like ABCD1234.`);
  }
  const libraries = [
    Zotero.Libraries.userLibraryID,
    ...Zotero.Libraries.getAll()
      .map((library: { libraryID: number }) => library.libraryID)
      .filter((id: number) => id !== Zotero.Libraries.userLibraryID),
  ];
  for (const libraryID of libraries) {
    const item = (await Zotero.Items.getByLibraryAndKeyAsync(libraryID, text)) as Zotero.Item | false;
    if (item && !item.deleted) {
      return item;
    }
  }
  throw new Error(`No item with key ${text} in this library.`);
}

function field(item: Zotero.Item, name: string): string {
  try {
    return String(item.getField(name as any) || "").trim();
  } catch {
    return "";
  }
}

function paperOf(item: Zotero.Item): Zotero.Item {
  return item.isAttachment() && item.parentItem ? (item.parentItem as Zotero.Item) : item;
}

async function attachmentOf(item: Zotero.Item): Promise<Zotero.Item | null> {
  if (item.isAttachment()) {
    return item;
  }
  if (item.isRegularItem()) {
    const best = (await item.getBestAttachment()) as Zotero.Item | false;
    return best || null;
  }
  return null;
}

function authorsOf(item: Zotero.Item, limit = 12): string {
  const creators = item.getCreators() as Array<{ firstName?: string; lastName?: string; fieldMode?: number }>;
  const names = creators.map((creator) =>
    creator.fieldMode === 1 || !creator.firstName
      ? creator.lastName || ""
      : `${creator.firstName} ${creator.lastName || ""}`.trim(),
  ).filter(Boolean);
  if (names.length > limit) {
    return `${names.slice(0, limit).join(", ")}, et al. (${names.length} authors)`;
  }
  return names.join(", ");
}

function yearOf(item: Zotero.Item): string {
  const date = field(item, "date");
  if (!date) {
    return "";
  }
  try {
    const parsed = (Zotero.Date as any).strToDate(date);
    if (parsed?.year) {
      return String(parsed.year);
    }
  } catch {
    // fall through
  }
  return /\b(1[5-9]\d\d|20\d\d)\b/.exec(date)?.[1] || "";
}

function venueOf(item: Zotero.Item): string {
  for (const name of ["publicationTitle", "proceedingsTitle", "conferenceName", "bookTitle", "websiteTitle", "university", "institution", "publisher"]) {
    const value = field(item, name);
    if (value) {
      return value;
    }
  }
  return "";
}

function titleOf(item: Zotero.Item): string {
  return item.getDisplayTitle() || field(item, "title") || "(untitled)";
}

/* ---------------------------------------------------------------- readers */

interface ReaderLike {
  itemID?: number;
  tabID?: string;
  type?: string;
  _internalReader?: any;
}

function readersFor(attachment: Zotero.Item): ReaderLike[] {
  const all = ((Zotero.Reader as any)._readers || []) as ReaderLike[];
  const selected = (Zotero.getMainWindow() as any)?.Zotero_Tabs?.selectedID;
  return all
    .filter((reader) => reader && reader.itemID === attachment.id)
    .sort((a, b) => Number(b.tabID === selected) - Number(a.tabID === selected));
}

function pdfDocumentOf(reader: ReaderLike): any | null {
  const view = reader._internalReader?._primaryView;
  const win = view?._iframeWindow;
  const app = win?.PDFViewerApplication || win?.wrappedJSObject?.PDFViewerApplication;
  return app?.pdfDocument || null;
}

/** Text of one page through the reader's own PDF.js (exact page numbers). */
async function readerPageText(documentProxy: any, pageNumber: number): Promise<string> {
  let page = await documentProxy.getPage(pageNumber);
  // Promises resolved in the reader's content compartment come back wrapped;
  // without unwrapping, PDF.js's prototype methods are invisible from here.
  page = page?.wrappedJSObject || page;
  let content = await page.getTextContent();
  content = content?.wrappedJSObject || content;
  let text = "";
  for (const item of content.items || []) {
    if (typeof item.str === "string") {
      text += item.str;
    }
    if (item.hasEOL) {
      text += "\n";
    }
  }
  return text.replace(/[ \t]+\n/g, "\n").trim();
}

function selectionPage(reader: ReaderLike): number | null {
  const ranges = reader._internalReader?._primaryView?._selectionRanges;
  const pageIndex = ranges?.[0]?.position?.pageIndex;
  return typeof pageIndex === "number" ? pageIndex + 1 : null;
}

/* ------------------------------------------------------------------ text */

interface PagesResult {
  pages: { number: number; text: string }[];
  total: number | null;
  notes: string[];
  sections?: boolean;
}

async function indexedText(attachment: Zotero.Item, needPages: number): Promise<{ text: string; indexed: number; total: number }> {
  const FullText = Zotero.FullText as any;
  let pages = await FullText.getPages(attachment.id);
  const state = await FullText.getIndexedState(attachment);
  const partial = pages && pages.total && pages.indexedPages && pages.indexedPages < Math.min(pages.total, needPages);
  if (state !== FullText.INDEX_STATE_INDEXED || partial) {
    await FullText.indexItems([attachment.id], { complete: true, ignoreErrors: true });
    pages = await FullText.getPages(attachment.id);
  }
  const path = FullText.getItemCacheFile(attachment).path;
  const text = (await IOUtils.exists(path)) ? String(await Zotero.File.getContentsAsync(path)) : "";
  return { text, indexed: Number(pages?.indexedPages) || 0, total: Number(pages?.total) || 0 };
}

async function readPages(attachment: Zotero.Item, from: number, to: number): Promise<PagesResult> {
  const notes: string[] = [];
  const reader = readersFor(attachment).find((candidate) => candidate.type === "pdf");
  const documentProxy = reader ? pdfDocumentOf(reader) : null;
  if (documentProxy) {
    const total = Number(documentProxy.numPages) || null;
    const last = total ? Math.min(to, total) : to;
    const pages = [];
    for (let number = from; number <= last; number++) {
      pages.push({ number, text: await readerPageText(documentProxy, number) });
    }
    return { pages, total, notes };
  }

  if (!attachment.isFileAttachment()) {
    throw new Error("This item has no file to read.");
  }
  const { text, indexed, total } = await indexedText(attachment, to);
  if (!text.trim()) {
    throw new Error("Paperly has no text for this file (it may be a scanned PDF without a text layer).");
  }
  if (!attachment.isPDFAttachment()) {
    // EPUBs and web snapshots have no pages: hand out fixed-size sections.
    const count = Math.ceil(text.length / SECTION_SIZE);
    const pages = [];
    for (let number = from; number <= Math.min(to, count); number++) {
      pages.push({ number, text: text.slice((number - 1) * SECTION_SIZE, number * SECTION_SIZE) });
    }
    notes.push(`This file is not a PDF, so its text comes in sections of ${SECTION_SIZE} characters, numbered like pages (${count} in all).`);
    return { pages, total: count, notes, sections: true };
  }
  const parts = text.split("\f");
  const pageCount = total || parts.length;
  if (indexed && parts.length < indexed) {
    notes.push("Some pages of this PDF have no text, so page numbers may be off by a little.");
  }
  if (indexed && indexed < pageCount && to > indexed) {
    notes.push(`Only the first ${indexed} pages are indexed.`);
  }
  const pages = [];
  for (let number = from; number <= Math.min(to, parts.length); number++) {
    pages.push({ number, text: parts[number - 1].trim() });
  }
  return { pages, total: pageCount, notes };
}

/* ----------------------------------------------------------------- tools */

async function getCurrentPaper(args: Record<string, unknown>): Promise<McpToolResult> {
  const item = await resolveItem(args.item_key);
  if (item.isNote()) {
    return { text: `${item.key} is a note, not a paper.`, isError: true };
  }
  const paper = paperOf(item);
  const attachment = await attachmentOf(item);
  const lines = [`Title: ${titleOf(paper)}`];
  const authors = authorsOf(paper);
  if (authors) lines.push(`Authors: ${authors}`);
  const year = yearOf(paper);
  if (year) lines.push(`Year: ${year}`);
  const venue = venueOf(paper);
  if (venue) lines.push(`Venue: ${venue}`);
  const doi = field(paper, "DOI");
  if (doi) lines.push(`DOI: ${doi}`);
  const url = field(paper, "url");
  if (url) lines.push(`URL: ${url}`);
  lines.push(`Item type: ${Zotero.ItemTypes.getName(paper.itemTypeID)}`);
  lines.push(`Item key: ${paper.key}${attachment && attachment.id !== paper.id ? ` (its file: ${attachment.key})` : ""}`);

  if (attachment) {
    const reader = readersFor(attachment).find((candidate) => candidate.type === "pdf");
    const documentProxy = reader ? pdfDocumentOf(reader) : null;
    if (documentProxy) {
      const current = getReaderCurrentPage(reader);
      lines.push(`Pages: ${documentProxy.numPages} (open in the reader${current ? `, now on page ${current}` : ""})`);
    } else {
      const pages = await (Zotero.FullText as any).getPages(attachment.id).catch(() => null);
      if (pages?.total) {
        lines.push(`Pages: ${pages.total}${pages.indexedPages && pages.indexedPages < pages.total ? ` (${pages.indexedPages} indexed)` : ""}`);
      } else {
        lines.push(`File: ${attachment.attachmentContentType || "unknown type"} (not yet indexed; read_pages indexes it)`);
      }
    }
    if (attachment.isFileAttachment()) {
      try {
        lines.push(`Highlights and comments: ${attachment.getAnnotations().length} (get_annotations)`);
      } catch {
        // not a reader file type
      }
    }
  } else {
    lines.push("File: none (there is no PDF or other file to read)");
  }
  if (paper.isRegularItem()) {
    lines.push(`Notes: ${paper.getNotes().length}`);
  }
  const abstract = field(paper, "abstractNote");
  if (abstract) {
    lines.push("", "Abstract:", abstract.length > ABSTRACT_LIMIT ? `${abstract.slice(0, ABSTRACT_LIMIT)}…` : abstract);
  }
  return { text: lines.join("\n") };
}

async function readPagesTool(args: Record<string, unknown>): Promise<McpToolResult> {
  const item = await resolveItem(args.item_key);
  const attachment = await attachmentOf(item);
  if (!attachment) {
    return { text: `${titleOf(paperOf(item))} has no file to read.`, isError: true };
  }
  const from = Number(args.from);
  let to = args.to === undefined || args.to === null ? from : Number(args.to);
  if (to < from) {
    return { text: `"to" (${to}) is before "from" (${from}).`, isError: true };
  }
  const notes: string[] = [];
  if (to - from + 1 > PAGES_PER_CALL) {
    to = from + PAGES_PER_CALL - 1;
    notes.push(`At most ${PAGES_PER_CALL} pages per call: read ${from}–${to}; ask again for the rest.`);
  }
  const result = await readPages(attachment, from, to);
  if (result.total && from > result.total) {
    return { text: `This ${result.sections ? "file has" : "PDF has"} ${result.total} ${result.sections ? "sections" : "pages"}; there is no ${from}.`, isError: true };
  }
  const label = result.sections ? "section" : "page";
  let budget = CALL_TEXT_LIMIT;
  const chunks: string[] = [];
  for (const page of result.pages) {
    if (budget <= 0) {
      notes.push(`Stopped before ${label} ${page.number} to keep this short; ask for it separately.`);
      break;
    }
    let text = page.text || "(no text on this page)";
    if (text.length > PAGE_TEXT_LIMIT) {
      text = `${text.slice(0, PAGE_TEXT_LIMIT)}… (the rest of this ${label} was cut)`;
    }
    text = text.slice(0, budget);
    budget -= text.length;
    chunks.push(`[${label} ${page.number}]\n${text}`);
  }
  const footer = [...result.notes, ...notes, result.total ? `(${result.total} ${label}s in all)` : ""].filter(Boolean);
  return { text: [chunks.join("\n\n"), footer.join("\n")].filter(Boolean).join("\n\n") };
}

async function getSelection(args: Record<string, unknown>): Promise<McpToolResult> {
  const item = await resolveItem(args.item_key);
  const attachment = await attachmentOf(item);
  if (!attachment) {
    return { text: "This paper has no file open in the reader, so nothing is selected." };
  }
  const readers = readersFor(attachment);
  if (!readers.length) {
    return { text: "This paper is not open in the reader, so nothing is selected." };
  }
  for (const reader of readers) {
    const text = getReaderSelectedText(reader);
    if (text) {
      const page = selectionPage(reader);
      return { text: `Selected${page ? ` on page ${page}` : ""}:\n\n${text}` };
    }
  }
  // The selection popup's last text, which Paperly keeps for the tab in front.
  const context = (Zotero as any).PaperlyExtensions?.getContext?.();
  const selected = context?.reader;
  if (selected?.attachment?.id === attachment.id && selected.selectedText) {
    return {
      text: `Selected${selected.pageLabel ? ` on page ${selected.pageLabel}` : ""} (most recent selection):\n\n${selected.selectedText}`,
    };
  }
  return { text: "Nothing is selected in this paper right now." };
}

const COLOR_NAMES: Record<string, string> = {
  "#ffd400": "yellow",
  "#ff6666": "red",
  "#5fb236": "green",
  "#2ea8e5": "blue",
  "#a28ae5": "purple",
  "#e56eee": "magenta",
  "#f19837": "orange",
  "#aaaaaa": "gray",
};

async function getAnnotations(args: Record<string, unknown>): Promise<McpToolResult> {
  const item = await resolveItem(args.item_key);
  const attachment = await attachmentOf(item);
  if (!attachment || !attachment.isFileAttachment()) {
    return { text: "This paper has no file, so it has no highlights." };
  }
  const limit = Number(args.limit) || 100;
  const annotations = (attachment.getAnnotations() as Zotero.Item[])
    .slice()
    .sort((a, b) => String(a.annotationSortIndex).localeCompare(String(b.annotationSortIndex)));
  if (!annotations.length) {
    return { text: "The user has no highlights or comments on this paper yet." };
  }
  const lines = annotations.slice(0, limit).map((annotation) => {
    const color = COLOR_NAMES[String(annotation.annotationColor || "").toLowerCase()] || annotation.annotationColor || "";
    const page = annotation.annotationPageLabel ? `p. ${annotation.annotationPageLabel}` : "p. ?";
    const kind = `${annotation.annotationType}${color ? `, ${color}` : ""}`;
    const quoted = annotation.annotationText ? ` "${String(annotation.annotationText).trim()}"` : "";
    const comment = annotation.annotationComment ? ` — comment: ${String(annotation.annotationComment).trim()}` : "";
    return `${page} [${kind}]${quoted}${comment}`;
  });
  if (annotations.length > limit) {
    lines.push(`(${annotations.length - limit} more not shown)`);
  }
  return { text: lines.join("\n") };
}

async function searchLibrary(args: Record<string, unknown>): Promise<McpToolResult> {
  const query = String(args.query || "").trim();
  const limit = Number(args.limit) || 10;
  const seen = new Set<number>();
  const found: Zotero.Item[] = [];
  for (const library of Zotero.Libraries.getAll() as Array<{ libraryID: number; libraryType: string }>) {
    if (!["user", "group"].includes(library.libraryType)) {
      continue;
    }
    const search = new Zotero.Search();
    (search as unknown as { libraryID: number }).libraryID = library.libraryID;
    search.addCondition("quicksearch-everything", "contains", query);
    const ids = (await search.search()) as number[];
    for (const item of (await Zotero.Items.getAsync(ids)) as Zotero.Item[]) {
      const top = item.isTopLevelItem() ? item : (item.topLevelItem as Zotero.Item);
      if (!top || top.deleted || seen.has(top.id) || top.isNote() || top.isAnnotation?.()) {
        continue;
      }
      seen.add(top.id);
      found.push(top);
    }
    if (found.length >= limit * 3) {
      break;
    }
  }
  if (!found.length) {
    return { text: `Nothing in the library matches "${query}".` };
  }
  found.sort((a, b) => String(b.dateModified).localeCompare(String(a.dateModified)));
  const lines = found.slice(0, limit).map((item) => {
    const authors = authorsOf(item, 3);
    const year = yearOf(item);
    return `${item.key} · ${titleOf(item)}${authors ? ` — ${authors}` : ""}${year ? ` (${year})` : ""}`;
  });
  if (found.length > limit) {
    lines.push(`(${found.length - limit} more; narrow the query to see them)`);
  }
  return { text: lines.join("\n") };
}

async function httpGet(url: string, accept: string): Promise<string> {
  const request = await Zotero.HTTP.request("GET", url, {
    headers: { Accept: accept },
    responseType: "text",
    timeout: 15000,
    successCodes: [200],
  } as any);
  return String((request as any).response ?? (request as any).responseText ?? "");
}

async function findRelated(args: Record<string, unknown>): Promise<McpToolResult> {
  const query = String(args.query || "").trim();
  const limit = Math.min(20, Number(args.limit) || 6);
  const results: string[] = [];
  const titles = new Set<string>();
  const problems: string[] = [];

  const scholar = (async () => {
    const url =
      "https://api.semanticscholar.org/graph/v1/paper/search?" +
      `query=${encodeURIComponent(query)}&limit=${limit}&fields=title,authors,year,venue,url,abstract,externalIds`;
    const data = JSON.parse(await httpGet(url, "application/json"));
    return (Array.isArray(data?.data) ? data.data : []).map((paper: any) => ({
      title: String(paper.title || "").trim(),
      authors: (paper.authors || []).slice(0, 4).map((author: any) => author.name).join(", ") + ((paper.authors || []).length > 4 ? ", et al." : ""),
      year: paper.year ? String(paper.year) : "",
      venue: String(paper.venue || ""),
      link: paper.externalIds?.DOI ? `https://doi.org/${paper.externalIds.DOI}` : String(paper.url || ""),
      abstract: String(paper.abstract || ""),
      source: "Semantic Scholar",
    }));
  })();
  const arxiv = (async () => {
    const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${limit}&sortBy=relevance`;
    const xml = await httpGet(url, "application/atom+xml");
    const win = Zotero.getMainWindow() as any;
    const parsed = new win.DOMParser().parseFromString(xml, "application/xml");
    return Array.from(parsed.getElementsByTagName("entry") as ArrayLike<Element>).map((entry) => {
      const text = (tag: string) => entry.getElementsByTagName(tag)[0]?.textContent?.replace(/\s+/g, " ").trim() || "";
      const authors = Array.from(entry.getElementsByTagName("author") as ArrayLike<Element>).map(
        (author) => author.getElementsByTagName("name")[0]?.textContent?.trim() || "",
      );
      return {
        title: text("title"),
        authors: authors.slice(0, 4).join(", ") + (authors.length > 4 ? ", et al." : ""),
        year: text("published").slice(0, 4),
        venue: "arXiv",
        link: text("id"),
        abstract: text("summary"),
        source: "arXiv",
      };
    });
  })();
  for (const [name, promise] of [["Semantic Scholar", scholar], ["arXiv", arxiv]] as const) {
    try {
      for (const paper of await promise) {
        const key = paper.title.toLowerCase().replace(/\W+/g, " ").trim();
        if (!paper.title || titles.has(key)) {
          continue;
        }
        titles.add(key);
        const abstract = paper.abstract.length > 400 ? `${paper.abstract.slice(0, 400)}…` : paper.abstract;
        results.push(
          `• ${paper.title}${paper.authors ? ` — ${paper.authors}` : ""}${paper.year ? ` (${paper.year})` : ""}` +
            `${paper.venue && paper.venue !== paper.source ? `, ${paper.venue}` : ""} [${paper.source}]` +
            `${paper.link ? `\n  ${paper.link}` : ""}${abstract ? `\n  ${abstract}` : ""}`,
        );
      }
    } catch (error) {
      problems.push(`${name} did not answer (${errorMessage(error)}).`);
    }
  }
  if (!results.length) {
    return { text: problems.length ? problems.join(" ") : `No related papers found for "${query}".`, isError: problems.length === 2 };
  }
  return { text: [...results, ...(problems.length ? ["", ...problems] : [])].join("\n") };
}

async function addNote(
  args: Record<string, unknown>,
  context: ToolCallContext,
  dependencies: PaperToolDependencies,
): Promise<McpToolResult> {
  const item = await resolveItem(args.item_key);
  const paper = paperOf(item);
  const title = String(args.title || "").trim().slice(0, 200) || "Note";
  const markdown = String(args.content || "").trim();
  if (!markdown) {
    return { text: "The note is empty.", isError: true };
  }
  if (!context.turnId) {
    return { text: "Notes can only be added from Paperly's own chat, where the user can approve them.", isError: true };
  }
  const answer = await dependencies.requestNoteApproval({
    turnId: context.turnId,
    title,
    markdown,
    paperTitle: titleOf(paper),
  });
  if (answer === "denied") {
    return { text: "The user declined. The note was not saved." };
  }
  if (answer === "expired") {
    return { text: "The user did not answer, so the note was not saved." };
  }
  if (answer === "no_turn") {
    return { text: "This chat turn has ended, so the note was not saved.", isError: true };
  }
  const note = new Zotero.Item("note");
  setLibrary(note, paper.libraryID);
  if (paper.isRegularItem()) {
    note.parentID = paper.id;
  }
  note.setNote(markdownToNoteHtml(markdown, title));
  await note.saveTx();
  return {
    text: paper.isRegularItem()
      ? `Saved the note "${title}" on "${titleOf(paper)}" (note key ${note.key}).`
      : `Saved the note "${title}" in the library (note key ${note.key}); this file has no parent item to attach it to.`,
  };
}

export function createPaperToolHost(context: ToolCallContext, dependencies: PaperToolDependencies): McpHost {
  return {
    serverInfo: { name: "paperly", title: "Paperly", version: dependencies.version },
    instructions: HOST_INSTRUCTIONS,
    tools: () => PAPER_TOOLS,
    async call(name, args) {
      Zotero.debug(`Paperly Agent: tool ${name}`);
      switch (name) {
        case "get_current_paper":
          return getCurrentPaper(args);
        case "read_pages":
          return readPagesTool(args);
        case "get_selection":
          return getSelection(args);
        case "get_annotations":
          return getAnnotations(args);
        case "search_library":
          return searchLibrary(args);
        case "find_related":
          return findRelated(args);
        case "add_note":
          return addNote(args, context, dependencies);
        default:
          return { text: `Unknown tool ${name}.`, isError: true };
      }
    },
  };
}

/** Title, authors and year for the system prompt, or null when the key is gone. */
export async function describePaper(libraryID: number, key: string): Promise<{ title: string; authors: string; year: string } | null> {
  try {
    const item = (await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key)) as Zotero.Item | false;
    if (!item) {
      return null;
    }
    const paper = paperOf(item);
    return { title: titleOf(paper), authors: authorsOf(paper, 4), year: yearOf(paper) };
  } catch {
    return null;
  }
}
