// Turning keystrokes into blocks.
//
// Everything here goes through document.execCommand. It is deprecated and it
// is also the only way to change a contenteditable without throwing away the
// browser's undo stack -- a note pad where Cmd-Z stops working after the first
// heading is worse than one built on a deprecated API. Measured in the reader:
// formatBlock, insertUnorderedList, insertOrderedList, insertHorizontalRule and
// insertHTML all produce clean markup there, and undo walks back through them.
//
// Two places Gecko does not behave the way a block editor should, both handled
// below: Enter on an empty list item stays in the list, and `outdent` leaves a
// bare <br> behind instead of a paragraph.
import {
  NoteBlockId,
  TODO_DONE,
  TODO_OPEN,
  escapeHTML,
  stripTodoMarker,
  todoStateOf,
} from "../ui/noteBlocks";
import { insertTable } from "./readerNoteTable";

export interface EditContext {
  doc: Document;
  editor: HTMLElement;
}

// `div` is in here because Enter in a contenteditable does not produce the
// same element everywhere: Gecko gives a paragraph, Blink gives a div. Without
// it, every block after the first one on the web fell outside the model and no
// shortcut, menu or heading worked there. The editor itself is excluded below,
// or a caret sitting loose in it would count as a block.
const BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, td, th, div";
const HEADING_LEVEL: Partial<Record<NoteBlockId, string>> = {
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h4",
};

function selectionOf(ctx: EditContext): Selection | null {
  const selection = ctx.doc.getSelection?.();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  return ctx.editor.contains(range.commonAncestorContainer) ? selection : null;
}

/** The paragraph, heading, list item or cell the caret is in. */
export function currentBlock(ctx: EditContext): HTMLElement | null {
  const selection = selectionOf(ctx);
  if (!selection) {
    return null;
  }
  const node = selection.getRangeAt(0).startContainer;
  const element =
    node.nodeType === 1 ? (node as Element) : (node.parentElement as Element);
  const block = element?.closest(BLOCK_SELECTOR) as HTMLElement | null;
  return block && block !== ctx.editor && ctx.editor.contains(block)
    ? block
    : null;
}

/**
 * True when everything the selection covers is heading text.
 *
 * currentBlock answers from the range's START, which is right for a caret and
 * wrong for a decision about the whole selection: dragging from the end of a
 * heading down through a paragraph begins in the heading, so currentBlock says
 * "Heading 1" even though the heading contributes no visible text to the
 * selection and the paragraph is what the user means. Bold was switched off on
 * that answer, which made a normal gesture look like a broken feature.
 *
 * Only a selection that is ENTIRELY inside headings has nothing for bold to do.
 */
export function selectionIsAllHeadings(ctx: EditContext): boolean {
  const selection = selectionOf(ctx);
  if (!selection) {
    return false;
  }
  const range = selection.getRangeAt(0);
  const headings = Array.from(
    ctx.editor.querySelectorAll("h1, h2, h3, h4, h5, h6"),
  ) as HTMLElement[];
  const insideAHeading = (node: Node | null): boolean => {
    const element =
      node?.nodeType === 1 ? (node as Element) : (node?.parentElement as Element);
    const found = element?.closest("h1, h2, h3, h4, h5, h6") as HTMLElement | null;
    return !!found && ctx.editor.contains(found);
  };
  if (!insideAHeading(range.startContainer) || !insideAHeading(range.endContainer)) {
    return false;
  }
  // Both ends sit in headings, but the selection may still run across ordinary
  // text between two of them.
  for (const block of Array.from(ctx.editor.children) as HTMLElement[]) {
    if (headings.includes(block)) {
      continue;
    }
    if (range.intersectsNode(block) && String(block.textContent || "").length) {
      return false;
    }
  }
  return true;
}

export function currentCell(ctx: EditContext): HTMLElement | null {
  const block = currentBlock(ctx);
  const cell = block?.closest("td, th") as HTMLElement | null;
  return cell && ctx.editor.contains(cell) ? cell : null;
}

function listOf(block: HTMLElement | null): HTMLElement | null {
  const list = block?.closest("ul, ol") as HTMLElement | null;
  return list || null;
}

function run(ctx: EditContext, command: string, value?: string): boolean {
  const before = ctx.editor.innerHTML;
  try {
    const ok = ctx.doc.execCommand(command, false, value);
    if (!ok || ctx.editor.innerHTML === before) {
      // Not an error: toggling a mark off a caret, or a command the selection
      // gives nothing to do, both land here. It is logged because a command that
      // silently does nothing is invisible from the outside, and chasing one of
      // those from the symptom costs a day.
      Zotero.debug(
        `Paperly note: execCommand(${command}) returned ${ok} and changed nothing`,
      );
    }
    return ok;
  } catch (e) {
    Zotero.debug(`Paperly note: execCommand(${command}) threw ${e}`);
    return false;
  }
}

/** The text node and offset a character index inside a block lands on. */
function pointAt(
  ctx: EditContext,
  block: Node,
  offset: number,
): { node: Node; offset: number } | null {
  const walker = ctx.doc.createTreeWalker(block, 4 /* SHOW_TEXT */);
  let seen = 0;
  let node = walker.nextNode();
  while (node) {
    const length = (node.nodeValue || "").length;
    if (seen + length >= offset) {
      return { node, offset: offset - seen };
    }
    seen += length;
    node = walker.nextNode();
  }
  return null;
}

/** Selects a run of characters inside a block, by character index. */
function selectRange(
  ctx: EditContext,
  block: HTMLElement,
  start: number,
  end: number,
): boolean {
  const selection = ctx.doc.getSelection?.();
  const from = pointAt(ctx, block, start);
  const to = pointAt(ctx, block, end);
  if (!selection || !from || !to) {
    return false;
  }
  const range = ctx.doc.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/** The text of the current block up to the caret. */
function textBeforeCaret(ctx: EditContext, block: HTMLElement): string {
  const selection = selectionOf(ctx);
  if (!selection) {
    return "";
  }
  const range = selection.getRangeAt(0).cloneRange();
  range.setStart(block, 0);
  return range.toString();
}

/** The block the caret is in and the text before it, for the "/" menu. */
export function caretText(
  ctx: EditContext,
): { block: HTMLElement; before: string } | null {
  const block = currentBlock(ctx);
  return block ? { block, before: textBeforeCaret(ctx, block) } : null;
}

/** Deletes a run of characters in a block, keeping the undo stack. */
export function deleteTextRange(
  ctx: EditContext,
  block: HTMLElement,
  start: number,
  end: number,
): void {
  if (end > start && selectRange(ctx, block, start, end)) {
    run(ctx, "delete");
  }
}

/** Selects from the start of the block to the caret and deletes it. */
function deleteToCaret(ctx: EditContext, block: HTMLElement): void {
  const selection = selectionOf(ctx);
  if (!selection) {
    return;
  }
  const caret = selection.getRangeAt(0);
  const range = ctx.doc.createRange();
  range.setStart(block, 0);
  range.setEnd(caret.startContainer, caret.startOffset);
  selection.removeAllRanges();
  selection.addRange(range);
  run(ctx, "delete");
}

function listCommand(list: HTMLElement | null): string | null {
  if (!list) {
    return null;
  }
  return list.tagName === "OL" ? "insertOrderedList" : "insertUnorderedList";
}

/** Leaves whatever list the caret is in, if it is in one. */
function clearList(ctx: EditContext): void {
  const command = listCommand(listOf(currentBlock(ctx)));
  if (command) {
    run(ctx, command);
  }
}

function ensureList(ctx: EditContext, ordered: boolean): void {
  const list = listOf(currentBlock(ctx));
  const wanted = ordered ? "OL" : "UL";
  if (list?.tagName === wanted) {
    return;
  }
  if (list) {
    // Toggling the other kind on from inside a list nests it; turn this one
    // off first so the item changes kind instead of gaining a level.
    run(ctx, listCommand(list) as string);
  }
  run(ctx, ordered ? "insertOrderedList" : "insertUnorderedList");
}

/**
 * Turns a heading back into a paragraph before a list is made out of it.
 *
 * Measured on Blink: asking for a list while the caret is in an <h2> puts the
 * list INSIDE the heading, and the whitelist then flattens it back to a plain
 * heading on save -- so the list someone asked for is gone the next time the
 * note is opened.
 */
function clearHeading(ctx: EditContext): void {
  if (/^H[1-6]$/.test(currentBlock(ctx)?.tagName || "")) {
    run(ctx, "formatBlock", "p");
  }
}

function setTodoMarker(ctx: EditContext, on: boolean): void {
  const item = currentBlock(ctx)?.closest("li") as HTMLElement | null;
  if (!item) {
    return;
  }
  const state = todoStateOf(item);
  if (on === !!state) {
    return;
  }
  if (on) {
    const selection = ctx.doc.getSelection?.();
    const start = pointAt(ctx, item, 0);
    if (selection && start) {
      const range = ctx.doc.createRange();
      range.setStart(start.node, start.offset);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      selectRange(ctx, item, 0, 0);
    }
    run(ctx, "insertText", `${TODO_OPEN} `);
    return;
  }
  const text = item.textContent || "";
  const markerLength = text.length - stripTodoMarker(text).length;
  if (markerLength > 0 && selectRange(ctx, item, 0, markerLength)) {
    run(ctx, "delete");
  }
}

/**
 * Applies a block type to wherever the caret is.
 *
 * Order matters: a list has to be turned off before a heading is applied, or
 * the heading ends up inside the list item.
 */
export function applyBlock(ctx: EditContext, id: NoteBlockId): void {
  ctx.editor.focus({ preventScroll: true });
  if (id === "table") {
    insertTable(ctx);
    return;
  }
  if (id === "divider") {
    run(ctx, "insertHorizontalRule");
    ensureTrailingParagraph(ctx);
    return;
  }
  if (id === "bullet" || id === "todo") {
    clearHeading(ctx);
    ensureList(ctx, false);
    setTodoMarker(ctx, id === "todo");
    return;
  }
  if (id === "number") {
    clearHeading(ctx);
    setTodoMarker(ctx, false);
    ensureList(ctx, true);
    return;
  }
  setTodoMarker(ctx, false);
  clearList(ctx);
  run(ctx, "formatBlock", HEADING_LEVEL[id] || "p");
}

// What may sit inside a block but never directly under the editor.
const INLINE_TAGS = new Set([
  "BR",
  "SPAN",
  "B",
  "STRONG",
  "I",
  "EM",
  "U",
  "A",
  "FONT",
  "S",
  "SUB",
  "SUP",
]);

const BLOCK_CHILD = "p, div, h1, h2, h3, h4, h5, h6, ul, ol, table, hr";

/**
 * Keeps the top level of the editor a flat row of blocks.
 *
 * Two things break it, both measured rather than guessed. Select everything,
 * press Backspace and type: the editor is left holding a bare text node and no
 * block at all, and nothing that works on "the current block" works again.
 * And Enter does not produce the same element everywhere -- Blink wraps what
 * follows in a <div>, so a list and the text after it ended up inside one
 * container and the shortcuts read the whole lot as a single block.
 *
 * Nodes are moved, never rebuilt, so a live Range keeps pointing at the same
 * text and the caret does not jump.
 */
export function normalizeStructure(ctx: EditContext): boolean {
  const editor = ctx.editor;
  let changed = false;

  const sweep = (): boolean => {
    let touched = false;
    let loose: Node[] = [];
    const wrap = (): void => {
      if (!loose.length) {
        return;
      }
      const paragraph = ctx.doc.createElement("p");
      loose[0].parentNode?.insertBefore(paragraph, loose[0]);
      for (const node of loose) {
        paragraph.appendChild(node);
      }
      loose = [];
      touched = true;
    };
    for (const child of Array.from(editor.childNodes) as Node[]) {
      const inline =
        child.nodeType === 3 ||
        (child.nodeType === 1 && INLINE_TAGS.has((child as Element).tagName));
      if (inline) {
        loose.push(child);
        continue;
      }
      wrap();
      if (
        child.nodeType !== 1 ||
        !["DIV", "P"].includes((child as Element).tagName)
      ) {
        continue;
      }
      const container = child as HTMLElement;
      if (container.querySelector(BLOCK_CHILD)) {
        // A wrapper around blocks: lift them out and drop the wrapper.
        while (container.firstChild) {
          editor.insertBefore(container.firstChild, container);
        }
        container.remove();
      } else if (container.tagName === "DIV") {
        // A wrapper around text: it is a paragraph that says div.
        const paragraph = ctx.doc.createElement("p");
        while (container.firstChild) {
          paragraph.appendChild(container.firstChild);
        }
        container.replaceWith(paragraph);
      } else {
        continue;
      }
      touched = true;
    }
    wrap();
    return touched;
  };

  // Lifting one wrapper out can expose another; three passes is far more than
  // any editor produces and keeps this from ever looping.
  for (let pass = 0; pass < 3 && sweep(); pass += 1) {
    changed = true;
  }

  if (!editor.firstElementChild) {
    const paragraph = ctx.doc.createElement("p");
    paragraph.appendChild(ctx.doc.createElement("br"));
    editor.appendChild(paragraph);
    const selection = ctx.doc.getSelection?.();
    const range = ctx.doc.createRange();
    range.setStart(paragraph, 0);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    changed = true;
  }
  return changed;
}

/** The editor must always end in something you can put the caret into. */
export function ensureTrailingParagraph(ctx: EditContext): void {
  const last = ctx.editor.lastElementChild;
  if (last && last.tagName !== "HR" && last.tagName !== "TABLE") {
    return;
  }
  const paragraph = ctx.doc.createElement("p");
  paragraph.appendChild(ctx.doc.createElement("br"));
  ctx.editor.appendChild(paragraph);
}

// ---------------------------------------------------------------- marks -----

// Marks the toolbar can switch on and off. `code` is not in the browser's
// command set at all, so it is the one that has to be built by hand below.
export type NoteMarkId = "bold" | "italic" | "underline" | "strike" | "code";

const MARK_COMMANDS: Record<Exclude<NoteMarkId, "code">, string> = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  strike: "strikeThrough",
};

// What each mark looks like once it is in the note. The toolbar reads these
// rather than queryCommandState, which answers from the COMPUTED style and
// therefore says "bold" for every heading the pad draws at weight 650, and
// "underline" for every link the browser underlines itself. What is stored is
// the tag, so the tag is what the toolbar shows.
const MARK_SELECTORS: Record<NoteMarkId, string> = {
  bold: "b, strong",
  italic: "i, em",
  underline: "u",
  strike: "s, strike, del",
  // Two shapes, both meaning code: the tag the note is stored as, and the
  // monospace span the browser writes while it is being typed. See toggleCode.
  code: 'code, span[style*="monospace"]',
};

/**
 * What the code mark is written as while it is being typed.
 *
 * There is no execCommand for code and no element both engines will let
 * through: measured, Blink's insertHTML strips <code> out every time, whatever
 * attributes are on it, while keeping <b> beside it. What both DO write is
 * this -- `fontName` under styleWithCSS gives `<span style="font-family:
 * monospace">` on Gecko and on Blink alike, and that span is one of the things
 * Zotero's own code mark parses. The whitelist in ui/noteBlocks turns it back
 * into <code> when the note is stored, so what is saved is still a tag.
 */
const CODE_FONT = "monospace";

/** What "no highlight" is written as. Measured: Gecko stores rgba(0,0,0,0). */
export const NO_HIGHLIGHT = "transparent";

/**
 * Makes the browser express a mark as a TAG rather than as a style.
 *
 * With styleWithCSS on, bold is a span with font-weight on it; with it off it
 * is <b>, which is what the whitelist in ui/noteBlocks keeps and what Zotero's
 * own schema parses. Both engines already default to off -- this is one call
 * so the pad does not depend on that. It is document state, so once is enough,
 * and it also covers the browser's own Cmd-B, which never passes through here.
 */
export function pinCommandStyle(ctx: EditContext): void {
  run(ctx, "styleWithCSS", "false");
}

/** What is switched on where the selection is, for drawing the toolbar. */
export interface MarkState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  /** The address of the link the selection sits in, if it sits in one. */
  link: string | null;
  /** The highlight behind the selection, as the browser reports it. */
  highlight: string | null;
}

/** The innermost matching element the whole selection is inside. */
function enclosing(ctx: EditContext, selector: string): HTMLElement | null {
  const selection = selectionOf(ctx);
  if (!selection) {
    return null;
  }
  const node = selection.getRangeAt(0).commonAncestorContainer;
  const element =
    node.nodeType === 1 ? (node as Element) : (node.parentElement as Element);
  const found = element?.closest(selector) as HTMLElement | null;
  return found && found !== ctx.editor && ctx.editor.contains(found)
    ? found
    : null;
}

export function markStateAt(ctx: EditContext): MarkState {
  const link = enclosing(ctx, "a[href]");
  const highlight = enclosing(ctx, 'span[style*="background-color"]');
  const painted = `${highlight?.style.backgroundColor ?? ""}`;
  return {
    bold: !!enclosing(ctx, MARK_SELECTORS.bold),
    italic: !!enclosing(ctx, MARK_SELECTORS.italic),
    underline: !!enclosing(ctx, MARK_SELECTORS.underline),
    strike: !!enclosing(ctx, MARK_SELECTORS.strike),
    code: !!enclosing(ctx, MARK_SELECTORS.code),
    link: link?.getAttribute("href") || null,
    // A see-through span is how a highlight was taken off; it is not one.
    highlight:
      painted && painted !== "transparent" && !/,\s*0\s*\)$/.test(painted)
        ? painted
        : null,
  };
}

/** Selects a whole element, so one command covers all of it. */
function selectElement(ctx: EditContext, element: Element): boolean {
  const selection = ctx.doc.getSelection?.();
  if (!selection) {
    return false;
  }
  const range = ctx.doc.createRange();
  range.selectNode(element);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/**
 * Turns the code mark on or off.
 *
 * Off is an insertHTML of the plain text, which is also what makes it one step
 * on the undo stack -- and plain text is the whole of it either way: Zotero's
 * schema has `code` excluding every other mark, so bold inside code is not
 * something either editor can store.
 */
function toggleCode(ctx: EditContext): void {
  const inside = enclosing(ctx, MARK_SELECTORS.code);
  const selection = selectionOf(ctx);
  if (!selection) {
    return;
  }
  if (inside) {
    const plain = inside.textContent || "";
    if (selectElement(ctx, inside)) {
      run(ctx, "insertHTML", plain ? escapeHTML(plain) : "<br>");
    }
    return;
  }
  if (!selection.toString()) {
    return;
  }
  run(ctx, "styleWithCSS", "true");
  run(ctx, "fontName", CODE_FONT);
  run(ctx, "styleWithCSS", "false");
}

/**
 * Pulls the selection back off headings at either end, when there is ordinary
 * text between them to work on.
 *
 * Bold is the reason. The pad draws headings at weight 650, so Gecko reads a
 * selection that touches one as already bold and its bold command UN-bolds the
 * lot: measured, a drag from the heading down through a paragraph produced
 * `<h1><span style="font-weight: normal;">Hello </span></h1>` and left the
 * paragraph plain. Dragging from the end of a heading into the paragraph is an
 * ordinary gesture -- the heading contributes no visible text to the selection --
 * so the fix is to act on what the user can see is selected, not on the block the
 * range happens to start in.
 *
 * Returns false and changes nothing when there is no ordinary text to keep,
 * which leaves an all-heading selection to be refused by the toolbar instead.
 */
function trimHeadingEdges(ctx: EditContext): boolean {
  const selection = selectionOf(ctx);
  if (!selection || selection.isCollapsed) {
    return false;
  }
  const HEADINGS = "h1, h2, h3, h4, h5, h6";
  const headingOf = (node: Node | null): HTMLElement | null => {
    const element =
      node?.nodeType === 1 ? (node as Element) : (node?.parentElement as Element);
    const found = element?.closest(HEADINGS) as HTMLElement | null;
    return found && ctx.editor.contains(found) ? found : null;
  };

  const range = selection.getRangeAt(0).cloneRange();
  const startHeading = headingOf(range.startContainer);
  const endHeading = headingOf(range.endContainer);
  if (!startHeading && !endHeading) {
    return false;
  }
  // Wholly inside one heading: nothing to trim to.
  if (startHeading && startHeading === endHeading) {
    return false;
  }

  if (startHeading) {
    const after = startHeading.nextElementSibling;
    if (!after) {
      return false;
    }
    range.setStartBefore(after);
  }
  if (endHeading) {
    const before = endHeading.previousElementSibling;
    if (!before) {
      return false;
    }
    range.setEndAfter(before);
  }
  if (range.collapsed || !range.toString()) {
    return false;
  }
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

export function toggleMark(ctx: EditContext, id: NoteMarkId): void {
  ctx.editor.focus({ preventScroll: true });
  if (id === "code") {
    toggleCode(ctx);
    return;
  }
  if (id === "bold") {
    trimHeadingEdges(ctx);
  }
  run(ctx, MARK_COMMANDS[id]);
}

/** Paints the selection, or takes the paint off with NO_HIGHLIGHT. */
export function setHighlight(ctx: EditContext, color: string): void {
  ctx.editor.focus({ preventScroll: true });
  // Measured: with styleWithCSS off, Gecko puts the value through HTML's
  // legacy colour parsing, which reads #ffd40080 as #ff4080 -- yellow comes
  // out pink. With it on the value is read as CSS and the half-opacity Zotero
  // stores its highlights at survives. It goes straight back off, because off
  // is what keeps bold a <b> rather than a styled span.
  run(ctx, "styleWithCSS", "true");
  run(ctx, "hiliteColor", color);
  run(ctx, "styleWithCSS", "false");
}

export function setLink(ctx: EditContext, href: string): void {
  ctx.editor.focus({ preventScroll: true });
  run(ctx, "createLink", href);
}

export function clearLink(ctx: EditContext): void {
  ctx.editor.focus({ preventScroll: true });
  // unlink only touches what is selected, so a caret resting inside a link
  // would otherwise leave most of it linked.
  const inside = enclosing(ctx, "a[href]");
  if (inside) {
    selectElement(ctx, inside);
  }
  run(ctx, "unlink");
}

/**
 * Takes every mark off the selection.
 *
 * Measured in the reader: removeFormat clears the marks and the colour spans
 * but leaves links exactly where they were, which is what the unlink is for.
 */
export function clearFormatting(ctx: EditContext): void {
  ctx.editor.focus({ preventScroll: true });
  run(ctx, "removeFormat");
  run(ctx, "unlink");
}

/** Which of the pad's block types the caret is in. */
export function blockIdOf(ctx: EditContext): NoteBlockId | null {
  const block = currentBlock(ctx);
  if (!block) {
    return null;
  }
  if (block.tagName === "LI") {
    if (listOf(block)?.tagName === "OL") {
      return "number";
    }
    return todoStateOf(block) ? "todo" : "bullet";
  }
  const heading = /^H([1-4])$/.exec(block.tagName);
  return heading ? (`h${heading[1]}` as NoteBlockId) : "text";
}

// ------------------------------------------------------------ input rules ---

// What you can type instead of opening the menu, matching the hints the menu
// shows and the shortcuts Notion documents.
const INPUT_RULES: { pattern: RegExp; block: NoteBlockId }[] = [
  { pattern: /^#\s$/, block: "h1" },
  { pattern: /^##\s$/, block: "h2" },
  { pattern: /^###\s$/, block: "h3" },
  { pattern: /^####\s$/, block: "h4" },
  { pattern: /^[-*+]\s$/, block: "bullet" },
  { pattern: /^1\.\s$/, block: "number" },
  { pattern: /^\[\s?\]\s$/, block: "todo" },
  { pattern: /^---$/, block: "divider" },
];

/**
 * Converts a block when what was typed at its start is a shortcut.
 *
 * Returns true when it did, so the caller knows the document changed under it.
 */
export function applyInputRules(ctx: EditContext): boolean {
  const block = currentBlock(ctx);
  if (!block || block.tagName === "TD" || block.tagName === "TH") {
    return false;
  }
  const isListItem = block.tagName === "LI";
  const typed = textBeforeCaret(ctx, block);
  for (const rule of INPUT_RULES) {
    if (!rule.pattern.test(typed)) {
      continue;
    }
    // Inside a list, only the to-do marker makes sense as a shortcut; the
    // others would silently unwrap the list someone is in the middle of.
    if (isListItem && rule.block !== "todo") {
      continue;
    }
    deleteToCaret(ctx, block);
    applyBlock(ctx, rule.block);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- to-dos ----

/** Marks the list items that are to-dos, so the CSS can draw them as boxes. */
export function decorateTodos(editor: HTMLElement): void {
  for (const item of Array.from(editor.querySelectorAll("li")) as HTMLElement[]) {
    const state = todoStateOf(item);
    if (state) {
      if (item.getAttribute("data-todo") !== state) {
        item.setAttribute("data-todo", state);
      }
    } else if (item.hasAttribute("data-todo")) {
      item.removeAttribute("data-todo");
    }
  }
}

/** The rect of a list item's first character: its checkbox. */
function markerRect(ctx: EditContext, item: HTMLElement): DOMRect | null {
  const walker = ctx.doc.createTreeWalker(item, 4 /* SHOW_TEXT */);
  const node = walker.nextNode();
  if (!node || !(node.nodeValue || "").length) {
    return null;
  }
  const range = ctx.doc.createRange();
  range.setStart(node, 0);
  range.setEnd(node, 1);
  const rect = range.getBoundingClientRect();
  return rect.width || rect.height ? rect : null;
}

/**
 * Ticks or unticks a to-do if the click landed on its box.
 *
 * The box is the item's first character, so the hit test is that character's
 * own rect -- no invisible overlay to keep in step with the text.
 */
export function toggleTodoAt(
  ctx: EditContext,
  x: number,
  y: number,
  target: Element | null,
): boolean {
  const item = target?.closest("li[data-todo]") as HTMLElement | null;
  if (!item || !ctx.editor.contains(item)) {
    return false;
  }
  const rect = markerRect(ctx, item);
  if (
    !rect ||
    x < rect.left - 2 ||
    x > rect.right + 2 ||
    y < rect.top - 2 ||
    y > rect.bottom + 2
  ) {
    return false;
  }
  const selection = ctx.doc.getSelection?.();
  const walker = ctx.doc.createTreeWalker(item, 4 /* SHOW_TEXT */);
  const node = walker.nextNode();
  if (!selection || !node) {
    return false;
  }
  const range = ctx.doc.createRange();
  range.setStart(node, 0);
  range.setEnd(node, 1);
  selection.removeAllRanges();
  selection.addRange(range);
  ctx.editor.focus({ preventScroll: true });
  run(
    ctx,
    "insertText",
    todoStateOf(item) === "done" ? TODO_OPEN : TODO_DONE,
  );
  return true;
}

// --------------------------------------------------------------- the keys ---

function isEmptyItem(item: HTMLElement): boolean {
  const text = (item.textContent || "").replace(/ /g, " ");
  return !stripTodoMarker(text).trim();
}

/**
 * Enter on an empty list item leaves the list.
 *
 * Gecko keeps adding items instead, which is the one thing every editor does
 * differently. Toggling the list command off is the command-level way to do
 * it; the paragraph it leaves behind sometimes has no tag of its own, which is
 * what the formatBlock afterwards is for.
 */
function exitList(ctx: EditContext, list: HTMLElement): void {
  run(ctx, listCommand(list) as string);
  // Only when the item is still an item. A caret that came out of the list
  // loose is left for normalizeStructure: asking for a paragraph here made a
  // second one next to the one Gecko had already created.
  if (currentBlock(ctx)?.tagName === "LI") {
    run(ctx, "formatBlock", "p");
  }
}

/**
 * Returns true when the key was dealt with here and the browser should not
 * also act on it.
 */
export function handleEditorKeyDown(
  ctx: EditContext,
  event: KeyboardEvent,
): boolean {
  const key = event.key;

  if (key === "Enter" && !event.shiftKey) {
    const block = currentBlock(ctx);
    const item = block?.closest("li") as HTMLElement | null;
    const list = listOf(block);
    if (item && list && isEmptyItem(item)) {
      // An empty to-do still holds its box; it has to go with the item, or
      // leaving the list leaves a stray tick behind.
      setTodoMarker(ctx, false);
      exitList(ctx, list);
      return true;
    }
    if (block && (block.tagName === "TD" || block.tagName === "TH")) {
      // A cell holds one block. Enter inside it breaks the line rather than
      // splitting the cell into paragraphs.
      if (!run(ctx, "insertLineBreak")) {
        run(ctx, "insertHTML", "<br>");
      }
      return true;
    }
    if (item && todoStateOf(item)) {
      // Carry the checkbox onto the next line, unticked, the way a to-do list
      // is meant to work.
      run(ctx, "insertParagraph");
      run(ctx, "insertText", `${TODO_OPEN} `);
      return true;
    }
    return false;
  }

  if (key === "Backspace") {
    const selection = selectionOf(ctx);
    const block = currentBlock(ctx);
    if (!selection || !block || !selection.getRangeAt(0).collapsed) {
      return false;
    }
    if (textBeforeCaret(ctx, block) !== "") {
      return false;
    }
    if (block.tagName === "LI") {
      const list = listOf(block);
      if (list && block === list.firstElementChild) {
        exitList(ctx, list);
        return true;
      }
      return false;
    }
    if (/^H[1-6]$/.test(block.tagName)) {
      // Backspace at the very start of a heading turns it back into text
      // instead of gluing it onto the block above.
      run(ctx, "formatBlock", "p");
      return true;
    }
  }

  return false;
}
