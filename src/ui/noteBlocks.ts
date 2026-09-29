// The block model behind the note pad.
//
// A note is a Zotero child note, and a Zotero note is HTML -- not Markdown.
// So the pad stores real markup, and the set of tags it is allowed to store is
// the set Zotero's own note editor can parse back:
// zotero-client/note-editor/src/core/schema/nodes.js has paragraph, heading
// 1-6, bulletList, orderedList, listItem, horizontalRule and the
// prosemirror-tables nodes. Anything outside that survives in the database but
// is dropped the first time someone edits the note in Zotero, so the pad never
// writes it.
//
// Two consequences worth knowing before changing anything here:
//
//   * Column widths are stored as `data-colwidth`, because that is the
//     attribute prosemirror-tables reads. Measured: a table written by the pad
//     opens in Zotero's note editor with its widths intact.
//   * There is no checkbox node in that schema, so a to-do item is an ordinary
//     list item whose text begins with U+2610 or U+2611. The glyph IS the data.
//     It survives every editor, and the pad turns it back into a clickable box.
//
// Nothing here is specific to the desktop plugin: it takes nodes and returns
// strings, so the web port uses the same file.

/** An empty box and a ticked box. The first character of a to-do item. */
export const TODO_OPEN = "☐";
export const TODO_DONE = "☑";
const TODO_PREFIX = new RegExp(`^[${TODO_OPEN}${TODO_DONE}]\\s?`);

export type NoteBlockId =
  | "text"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "bullet"
  | "number"
  | "todo"
  | "table"
  | "divider";

export interface IconPath {
  d: string;
  /** Stroke the path at the reader's own 1.25 weight instead of filling it. */
  stroke?: boolean;
  evenOdd?: boolean;
}

export interface NoteBlockDef {
  id: NoteBlockId;
  en: string;
  zh: string;
  /** What you can type instead, shown on the right of the menu row. */
  hint?: string;
  /** Words the menu filters on, beyond the label itself. */
  keywords: string[];
  icon: IconPath[];
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Builds an icon node by node. innerHTML is not dependable when chrome code
 * writes into the reader's resource:// document, and these end up in both the
 * toolbar button and the block menu.
 */
export function buildIcon(
  doc: Document,
  size: number,
  paths: IconPath[],
): Element {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", `${size}`);
  svg.setAttribute("height", `${size}`);
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  for (const path of paths) {
    const node = doc.createElementNS(SVG_NS, "path");
    node.setAttribute("d", path.d);
    if (path.stroke) {
      node.setAttribute("fill", "none");
      node.setAttribute("stroke", "currentColor");
      node.setAttribute("stroke-width", "1.25");
      node.setAttribute("stroke-linejoin", "round");
      node.setAttribute("stroke-linecap", "round");
    } else {
      node.setAttribute("fill", "currentColor");
      if (path.evenOdd) {
        node.setAttribute("fill-rule", "evenodd");
        node.setAttribute("clip-rule", "evenodd");
      }
    }
    svg.appendChild(node);
  }
  return svg;
}

// Icons are drawn in a 18-unit box at the weight of the reader's own set: a
// letter-ish mark on the left for text blocks, marker plus rules for lists.
function rules(ys: number[], from = 7.4, to = 15.6): IconPath[] {
  return ys.map((y) => ({ d: `M${from} ${y}H${to}`, stroke: true }));
}

function dots(ys: number[]): IconPath[] {
  return ys.map((y) => ({
    d: `M3.7 ${y}a0.9 0.9 0 1 0 1.8 0a0.9 0.9 0 1 0-1.8 0Z`,
  }));
}

export const NOTE_BLOCKS: NoteBlockDef[] = [
  {
    id: "text",
    en: "Text",
    zh: "正文",
    keywords: ["paragraph", "plain", "body", "van ban", "doan"],
    icon: [
      { d: "M3.1 4.2H10.9", stroke: true },
      { d: "M7 4.2V14", stroke: true },
      ...rules([6.6, 10, 13.4], 12.2, 15.4),
    ],
  },
  {
    id: "h1",
    en: "Heading 1",
    zh: "标题 1",
    hint: "#",
    keywords: ["title", "h1", "tieu de", "big"],
    icon: [
      { d: "M3.2 4.4V13.6M9 4.4V13.6M3.2 9H9", stroke: true },
      { d: "M12 7.6L13.6 6.4V13.6", stroke: true },
    ],
  },
  {
    id: "h2",
    en: "Heading 2",
    zh: "标题 2",
    hint: "##",
    keywords: ["subtitle", "h2", "tieu de"],
    icon: [
      { d: "M3.2 4.4V13.6M8.6 4.4V13.6M3.2 9H8.6", stroke: true },
      {
        d: "M11.4 7.2c0-0.9 0.8-1.5 1.7-1.5s1.7 0.6 1.7 1.6c0 1.9-3.4 3-3.4 6.3h3.6",
        stroke: true,
      },
    ],
  },
  {
    id: "h3",
    en: "Heading 3",
    zh: "标题 3",
    hint: "###",
    keywords: ["h3", "tieu de"],
    icon: [
      { d: "M3.2 4.4V13.6M8.6 4.4V13.6M3.2 9H8.6", stroke: true },
      {
        d: "M11.5 6.3h3.2l-1.9 2.6c1.2 0 2.1 0.8 2.1 2.1s-1 2.3-2.3 2.3c-1 0-1.8-0.4-2.2-1",
        stroke: true,
      },
    ],
  },
  {
    id: "h4",
    en: "Heading 4",
    zh: "标题 4",
    hint: "####",
    keywords: ["h4", "tieu de"],
    icon: [
      { d: "M3.2 4.4V13.6M8.6 4.4V13.6M3.2 9H8.6", stroke: true },
      { d: "M14.2 5.8V13.6M14.2 11.4H10.9L13.6 5.9", stroke: true },
    ],
  },
  {
    id: "bullet",
    en: "Bulleted list",
    zh: "无序列表",
    hint: "-",
    keywords: ["unordered", "ul", "dau cham", "gach dau dong"],
    icon: [...dots([5.4, 9, 12.6]), ...rules([5.4, 9, 12.6])],
  },
  {
    id: "number",
    en: "Numbered list",
    zh: "有序列表",
    hint: "1.",
    keywords: ["ordered", "ol", "danh sach so"],
    icon: [
      { d: "M3.4 4.3L4.6 3.7V7.2M3.4 7.2H5.8", stroke: true },
      {
        d: "M3.4 10.5c0-0.5 0.5-0.9 1.1-0.9s1.1 0.4 1.1 1c0 1.1-2.2 1.9-2.2 3.6h2.4",
        stroke: true,
      },
      ...rules([5.4, 12.6]),
    ],
  },
  {
    id: "todo",
    en: "To-do list",
    zh: "待办列表",
    hint: "[]",
    keywords: ["checkbox", "task", "checklist", "viec can lam"],
    icon: [
      {
        d: "M2.6 4.6a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1Z",
        stroke: true,
      },
      { d: "M3.8 6.1L4.9 7.1L6.4 4.9", stroke: true },
      {
        d: "M2.6 11.2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1Z",
        stroke: true,
      },
      ...rules([6.1, 12.7], 9.6, 15.6),
    ],
  },
  {
    id: "table",
    en: "Table",
    zh: "表格",
    keywords: ["grid", "bang", "cot", "hang", "row", "column"],
    icon: [
      {
        d: "M3 4.6a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v8.8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z",
        stroke: true,
      },
      { d: "M3 7.4H15", stroke: true },
      { d: "M3 11H15", stroke: true },
      { d: "M9 7.4V14.4", stroke: true },
    ],
  },
  {
    id: "divider",
    en: "Divider",
    zh: "分隔线",
    hint: "---",
    keywords: ["rule", "hr", "line", "duong ke", "phan cach"],
    icon: [
      { d: "M2.6 9H15.4", stroke: true },
      { d: "M4.6 5.2H13.4", stroke: true },
      { d: "M4.6 12.8H13.4", stroke: true },
    ],
  },
];

export function noteBlockById(id: string): NoteBlockDef | null {
  return NOTE_BLOCKS.find((block) => block.id === id) || null;
}

// --------------------------------------------------------------- to-do ------

export function todoStateOf(item: Element): "open" | "done" | null {
  const first = (item.textContent || "").trimStart().charAt(0);
  if (first === TODO_OPEN) {
    return "open";
  }
  return first === TODO_DONE ? "done" : null;
}

export function stripTodoMarker(value: string): string {
  return value.replace(TODO_PREFIX, "");
}

// ------------------------------------------------------------ sanitizing ----

// The tags the pad is allowed to produce, which is a subset of what Zotero's
// note editor can parse back. Headings stop at 4 because that is what the
// block menu offers; a deeper heading in an existing note is kept, not lost.
const BLOCK_TAGS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "UL",
  "OL",
  "HR",
  "TABLE",
]);
// Tags that carry meaning the pad cannot show. Their text is kept, but the
// panel warns that opening the note in Zotero is the way to keep the rest.
const MEANINGFUL_TAGS = new Set(["IMG", "BLOCKQUOTE", "PRE", "MARK"]);

/**
 * The inline tags the pad keeps, and the tag each one is stored as.
 *
 * The right-hand side is what Zotero's own schema writes back out (the `toDOM`
 * of each mark in note-editor/src/core/schema/marks.js), so the same formatting
 * produces the same markup whether it was made here or in Zotero's note editor.
 * The left-hand side is wider than that, because it also has to read what the
 * browser's own editing code produces: Gecko writes <b>, not <strong>.
 */
const MARK_TAGS = new Map<string, string>([
  ["STRONG", "strong"],
  ["B", "strong"],
  ["EM", "em"],
  ["I", "em"],
  ["U", "u"],
  ["S", "s"],
  ["STRIKE", "s"],
  ["DEL", "s"],
  ["CODE", "code"],
  ["TT", "code"],
  ["KBD", "code"],
  ["SAMP", "code"],
  ["SUB", "sub"],
  ["SUP", "sup"],
]);

// Colour is the only CSS the pad stores, because it is how Zotero stores one:
// its textColor and backgroundColor marks parse `style: color` and
// `style: background-color` and write them back on a <span>. Two properties
// and a colour-shaped value only -- a style attribute is otherwise an open
// door.
//
// `transparent` is in the list on purpose. Taking a highlight off a few words
// inside a highlighted run does not remove the outer span, it puts a
// see-through one inside it -- so dropping that span would paint the words
// yellow again, which is measured, not imagined.
const COLOR_PROPERTIES = ["color", "background-color"];
const COLOR_VALUE =
  /^(#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\([\d\s.,%/]+\)|transparent|inherit)$/i;

// A note travels: it syncs, it opens in Zotero's own editor, it can be
// exported. `javascript:` has no business in one.
const SAFE_LINK = /^(https?:|mailto:|zotero:)/i;

export function escapeHTML(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface Report {
  dropped: boolean;
}

interface Mark {
  open: string;
  close: string;
}

function colorStyle(element: Element): string {
  const style = (element as HTMLElement).style;
  const parts: string[] = [];
  for (const name of COLOR_PROPERTIES) {
    const value = `${style?.getPropertyValue(name) ?? ""}`.trim();
    if (value && COLOR_VALUE.test(value)) {
      parts.push(`${name}: ${value}`);
    }
  }
  return parts.join("; ");
}

/**
 * How an inline element is stored, or null when only its contents are kept.
 *
 * Returning null is not a loss for a <span> that carries no colour or a <font>
 * from some older editor: those are wrappers around text and the text is all
 * they were ever holding. A link the pad refuses to store IS a loss, so that
 * one is reported.
 */
function markOf(element: Element, report: Report): Mark | null {
  const mapped = MARK_TAGS.get(element.tagName);
  if (mapped) {
    return { open: `<${mapped}>`, close: `</${mapped}>` };
  }
  if (element.tagName === "A") {
    const href = `${element.getAttribute("href") ?? ""}`.trim();
    if (!SAFE_LINK.test(href)) {
      report.dropped = true;
      return null;
    }
    const title = element.getAttribute("title");
    const extra = title ? ` title="${escapeHTML(title)}"` : "";
    return { open: `<a href="${escapeHTML(href)}"${extra}>`, close: "</a>" };
  }
  if (element.tagName === "SPAN") {
    // A monospace span IS the code mark: it is what both browsers write when
    // one is switched on, because neither will insert a <code> that survives.
    // Zotero reads it as code too. Stored as the tag, so the note keeps one
    // shape for it. See CODE_FONT in modules/readerNoteEditing.
    if (/monospace/i.test(`${(element as HTMLElement).style?.fontFamily ?? ""}`)) {
      return { open: "<code>", close: "</code>" };
    }
    const style = colorStyle(element);
    return style
      ? { open: `<span style="${escapeHTML(style)}">`, close: "</span>" }
      : null;
  }
  return null;
}

const CELL_WIDTH = /^\d+(,\d+)*$/;

/**
 * Drops the break Gecko keeps at the end of an editable block.
 *
 * A contenteditable block needs a trailing <br> to have any height, and the
 * browser adds one of its own (`<br type="_moz">`). Storing it would make every
 * block grow a blank line more each time the note was saved and reloaded.
 */
function trimTrailingBreak(content: string): string {
  return content.replace(/<br>$/, "");
}

/** Text, <br> and the marks above; everything else flattened to its text. */
function inlineOf(node: Node, report: Report): string {
  let out = "";
  for (const child of Array.from(node.childNodes) as Node[]) {
    if (child.nodeType === 3) {
      out += escapeHTML(child.nodeValue || "");
      continue;
    }
    if (child.nodeType !== 1) {
      continue;
    }
    const element = child as Element;
    if (element.tagName === "BR") {
      out += "<br>";
      continue;
    }
    if (MEANINGFUL_TAGS.has(element.tagName)) {
      report.dropped = true;
    }
    if (BLOCK_TAGS.has(element.tagName) && out && !out.endsWith("<br>")) {
      // A block inside what should be inline content: keep the break it
      // implied rather than running two paragraphs together.
      out += "<br>";
    }
    const inner = inlineOf(element, report);
    // An empty mark is not formatting, it is the leftover of an edit. The
    // browser makes plenty of them and storing one would only grow the note.
    const mark = inner ? markOf(element, report) : null;
    out += mark ? `${mark.open}${inner}${mark.close}` : inner;
  }
  return out;
}

function listOf(list: Element, report: Report, forEditor: boolean): string {
  const tag = list.tagName === "OL" ? "ol" : "ul";
  const items: string[] = [];
  for (const child of Array.from(list.children) as Element[]) {
    if (child.tagName !== "LI") {
      // Only a stray node; its text still belongs to the list.
      const text = inlineOf(child, report);
      if (text) {
        items.push(`<li>${text}</li>`);
      }
      continue;
    }
    const nested: string[] = [];
    for (const inner of Array.from(child.children) as Element[]) {
      if (inner.tagName === "UL" || inner.tagName === "OL") {
        nested.push(listOf(inner, report, forEditor));
      }
    }
    const holder = child.cloneNode(true) as Element;
    for (const inner of Array.from(holder.children) as Element[]) {
      if (inner.tagName === "UL" || inner.tagName === "OL") {
        inner.remove();
      }
    }
    let content = forEditor
      ? inlineOf(holder, report)
      : trimTrailingBreak(inlineOf(holder, report));
    if (!content && forEditor) {
      content = "<br>";
    }
    items.push(`<li>${content}${nested.join("")}</li>`);
  }
  if (!items.length) {
    return "";
  }
  const start = list.getAttribute("start");
  const attrs = tag === "ol" && start && /^\d+$/.test(start) ? ` start="${start}"` : "";
  return `<${tag}${attrs}>${items.join("")}</${tag}>`;
}

function tableOf(table: Element, report: Report, forEditor: boolean): string {
  const rows: string[] = [];
  for (const row of Array.from(table.querySelectorAll("tr")) as Element[]) {
    const cells: string[] = [];
    for (const cell of Array.from(row.children) as Element[]) {
      if (cell.tagName !== "TD" && cell.tagName !== "TH") {
        continue;
      }
      const tag = cell.tagName === "TH" ? "th" : "td";
      let attrs = "";
      const width = cell.getAttribute("data-colwidth");
      if (width && CELL_WIDTH.test(width)) {
        attrs += ` data-colwidth="${width}"`;
      }
      for (const name of ["colspan", "rowspan"]) {
        const value = cell.getAttribute(name);
        if (value && /^[1-9]\d?$/.test(value) && value !== "1") {
          attrs += ` ${name}="${value}"`;
        }
      }
      let content = forEditor
        ? inlineOf(cell, report)
        : trimTrailingBreak(inlineOf(cell, report));
      if (!content && forEditor) {
        content = "<br>";
      }
      cells.push(`<${tag}${attrs}>${content}</${tag}>`);
    }
    if (cells.length) {
      rows.push(`<tr>${cells.join("")}</tr>`);
    }
  }
  if (!rows.length) {
    return "";
  }
  return `<table><tbody>${rows.join("")}</tbody></table>`;
}

function blockOf(
  element: Element,
  report: Report,
  forEditor: boolean,
): string {
  const tag = element.tagName;
  if (tag === "HR") {
    return "<hr>";
  }
  if (tag === "UL" || tag === "OL") {
    return listOf(element, report, forEditor);
  }
  if (tag === "TABLE") {
    return tableOf(element, report, forEditor);
  }
  const name = tag === "P" ? "p" : tag.toLowerCase();
  let content = inlineOf(element, report);
  if (!forEditor) {
    content = trimTrailingBreak(content);
  }
  if (!content && forEditor) {
    // An empty paragraph with nothing in it has no height and cannot be
    // clicked into; the browser's own editing code writes the same <br>.
    content = "<br>";
  }
  return `<${name}>${content}</${name}>`;
}

/**
 * Canonicalises a block tree, in either direction.
 *
 * The same whitelist runs when loading a note into the pad and when saving the
 * pad back, so what is on screen and what is in the database can never drift:
 * saving re-parses the editor's own HTML through this. `forEditor` only decides
 * whether empty blocks get the <br> that makes them clickable.
 */
export function sanitizeNoteBlocks(
  body: Element,
  forEditor: boolean,
): { html: string; dropped: boolean } {
  const report: Report = { dropped: false };
  const out: string[] = [];
  let loose = "";
  const flushLoose = (): void => {
    if (loose.trim() || (loose && forEditor)) {
      out.push(`<p>${loose}</p>`);
    }
    loose = "";
  };
  for (const child of Array.from(body.childNodes) as Node[]) {
    if (child.nodeType === 3) {
      // Text straight under the body: a paragraph that lost its tag.
      loose += escapeHTML(child.nodeValue || "");
      continue;
    }
    if (child.nodeType !== 1) {
      continue;
    }
    const element = child as Element;
    if (element.tagName === "BR") {
      loose += "<br>";
      continue;
    }
    if (BLOCK_TAGS.has(element.tagName)) {
      flushLoose();
      const html = blockOf(element, report, forEditor);
      if (html) {
        out.push(html);
      }
      continue;
    }
    if (element.tagName === "DIV") {
      // Zotero wraps notes in <div data-schema-version>, and so did TinyMCE.
      flushLoose();
      const inner = sanitizeNoteBlocks(element, forEditor);
      report.dropped = report.dropped || inner.dropped;
      if (inner.html) {
        out.push(inner.html);
      }
      continue;
    }
    if (MEANINGFUL_TAGS.has(element.tagName)) {
      report.dropped = true;
    }
    loose += inlineOf(element, report);
  }
  flushLoose();
  return { html: out.join(""), dropped: report.dropped };
}

/** True when there is nothing worth saving: no text, no rule, no table. */
export function isEmptyBlocks(html: string): boolean {
  if (!html) {
    return true;
  }
  if (/<(hr|table)\b/i.test(html)) {
    return false;
  }
  return !html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;| /g, " ")
    .trim();
}
