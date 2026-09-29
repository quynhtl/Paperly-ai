// The table block: inserting one, and the handles that make it draggable.
//
// The table is ordinary HTML, not Markdown -- a Zotero note is an HTML
// document, and prosemirror-tables is in the note editor's schema, so a table
// written here opens as a real table in Zotero, syncs, and can be edited on the
// other side. Column widths travel in `data-colwidth`, which is the attribute
// that schema reads (verified: a pad-written table keeps its widths when opened
// in Zotero's own editor).
//
// Structural edits go through execCommand("insertHTML") on the whole table
// rather than moving nodes about, so each one is a single step on the browser's
// undo stack. Resizing is the exception: it writes the attribute directly,
// because taking over the selection on every drag would move the caret out from
// under whoever is typing.
import { sanitizeNoteBlocks } from "../ui/noteBlocks";
import { isChineseLocale } from "../utils/locale";

export interface TableContext {
  doc: Document;
  editor: HTMLElement;
}

const DEFAULT_ROWS = 3;
const DEFAULT_COLUMNS = 3;
const MIN_COLUMN = 56;
/** The left and right margin a table keeps, to leave room for the handles. */
// Left and right margin together. The right side is the wider of the two on
// purpose: it is the lane the "add column" button stands in, and it has to
// clear the editor's own scrollbar.
const TABLE_MARGIN = 30;
/** How far outside the table the drag handles sit. */
const GRIP = 9;
/** The "+" buttons. Big enough to hit: they were 7px square and unclickable. */
const ADD = 16;
const ADD_GAP = 4;
/**
 * How far off the table the pointer may stray before the handles go away.
 *
 * Every handle sits OUTSIDE the table -- above it, beside it, below it -- so
 * the pointer has to cross a strip of plain editor to reach one. Clearing them
 * the moment it left the table took them away IN that strip: measured with a
 * real mouse, two pixels of travel was enough, and the "+" buttons could not be
 * reached by hand at all. Synthetic tests jump straight to the target and never
 * saw it.
 */
const HOVER_SLACK = 8;

function text(en: string, zh: string): string {
  return isChineseLocale() ? zh : en;
}

// ----------------------------------------------------------------- model ----

function rowsOf(table: HTMLElement): HTMLTableRowElement[] {
  return Array.from(table.querySelectorAll("tr")) as HTMLTableRowElement[];
}

function cellsOf(row: Element): HTMLTableCellElement[] {
  return (Array.from(row.children) as Element[]).filter(
    (cell) => cell.tagName === "TD" || cell.tagName === "TH",
  ) as HTMLTableCellElement[];
}

function columnCount(table: HTMLElement): number {
  return Math.max(...rowsOf(table).map((row) => cellsOf(row).length), 0);
}

/** Canonical HTML for a table, through the same whitelist as everything else. */
function tableHTML(ctx: TableContext, table: Element): string {
  const holder = ctx.doc.createElement("div");
  holder.appendChild(table.cloneNode(true));
  return sanitizeNoteBlocks(holder, true).html;
}

/**
 * Swaps a table for a changed copy of itself in one undoable step.
 *
 * Selecting the table and pasting over it is what keeps Cmd-Z working: moving
 * nodes by hand would leave the undo stack pointing at a table that no longer
 * exists.
 */
function replaceTable(
  ctx: TableContext,
  table: HTMLElement,
  build: (clone: HTMLElement) => void,
): void {
  const clone = table.cloneNode(true) as HTMLElement;
  build(clone);
  if (!clone.querySelector("tr")) {
    // The last row or column went: drop the table rather than leaving an
    // empty one that cannot be clicked into.
    const selection = ctx.doc.getSelection?.();
    const range = ctx.doc.createRange();
    range.selectNode(table);
    selection?.removeAllRanges();
    selection?.addRange(range);
    ctx.editor.focus({ preventScroll: true });
    ctx.doc.execCommand("delete");
    return;
  }
  const html = tableHTML(ctx, clone);
  const selection = ctx.doc.getSelection?.();
  const range = ctx.doc.createRange();
  range.selectNode(table);
  selection?.removeAllRanges();
  selection?.addRange(range);
  ctx.editor.focus({ preventScroll: true });
  ctx.doc.execCommand("insertHTML", false, html);
}

/**
 * The table the caret is in, or the one it was just put after.
 *
 * insertHTML leaves the caret immediately after what it inserted, so a table
 * that has just been written is the previous sibling of wherever the caret
 * ended up. Looking for "the last table in the note" would find the wrong one
 * as soon as a note has two.
 */
function tableNearCaret(ctx: TableContext): HTMLElement | null {
  const selection = ctx.doc.getSelection?.();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }
  const node = selection.getRangeAt(0).startContainer;
  let element: Element | null =
    node.nodeType === 1 ? (node as Element) : node.parentElement;
  const inside = element?.closest("table") as HTMLElement | null;
  if (inside && ctx.editor.contains(inside)) {
    return inside;
  }
  while (element && element.parentElement && element.parentElement !== ctx.editor) {
    element = element.parentElement;
  }
  if (element?.tagName === "TABLE") {
    return element as HTMLElement;
  }
  const previous = element?.previousElementSibling;
  return previous?.tagName === "TABLE" ? (previous as HTMLElement) : null;
}

function blankCell(doc: Document, header: boolean): HTMLElement {
  const cell = doc.createElement(header ? "th" : "td");
  cell.appendChild(doc.createElement("br"));
  return cell;
}

/** A new row, carrying the column widths the table already has. */
function blankRow(ctx: TableContext, table: HTMLElement): HTMLElement {
  const widths = (() => {
    const first = table.querySelector("tr");
    return first
      ? cellsOf(first).map((cell) => cell.getAttribute("data-colwidth"))
      : [];
  })();
  const row = ctx.doc.createElement("tr");
  const columns = Math.max(columnCount(table), 1);
  for (let index = 0; index < columns; index += 1) {
    const cell = blankCell(ctx.doc, false);
    const width = widths[index];
    if (width) {
      cell.setAttribute("data-colwidth", width);
    }
    row.appendChild(cell);
  }
  return row;
}

// -------------------------------------------------------------- inserting ---

export function insertTable(
  ctx: TableContext,
  rows = DEFAULT_ROWS,
  columns = DEFAULT_COLUMNS,
): void {
  const cells = (tag: string): string => `<${tag}><br></${tag}>`;
  const head = `<tr>${cells("th").repeat(columns)}</tr>`;
  const body = `<tr>${cells("td").repeat(columns)}</tr>`.repeat(
    Math.max(1, rows - 1),
  );
  ctx.editor.focus({ preventScroll: true });
  // The trailing paragraph is what lets someone carry on typing under a table
  // that would otherwise be the last thing in the note.
  ctx.doc.execCommand(
    "insertHTML",
    false,
    `<table><tbody>${head}${body}</tbody></table><p><br></p>`,
  );
  focusCell(ctx, tableNearCaret(ctx)?.querySelector("th, td") as
    | HTMLElement
    | undefined);
}

// ---------------------------------------------------------------- widths ----

/** Applies stored column widths to the rendered table. */
export function applyColumnWidths(editor: HTMLElement): void {
  for (const table of Array.from(
    editor.querySelectorAll("table"),
  ) as HTMLElement[]) {
    const first = table.querySelector("tr");
    if (!first) {
      continue;
    }
    const widths = cellsOf(first).map((cell) =>
      Number(cell.getAttribute("data-colwidth") || 0),
    );
    const sized = widths.some((width) => width > 0);
    (table as HTMLElement).style.tableLayout = sized ? "fixed" : "auto";
    for (const row of rowsOf(table as HTMLElement)) {
      cellsOf(row).forEach((cell, index) => {
        const width = widths[index];
        cell.style.width = sized && width ? `${width}px` : "";
      });
    }
  }
}

function writeColumnWidths(table: HTMLElement, widths: number[]): void {
  for (const row of rowsOf(table)) {
    cellsOf(row).forEach((cell, index) => {
      const width = Math.round(widths[index] || 0);
      if (width > 0) {
        cell.setAttribute("data-colwidth", `${width}`);
        cell.style.width = `${width}px`;
      } else {
        cell.removeAttribute("data-colwidth");
        cell.style.width = "";
      }
    });
  }
  table.style.tableLayout = widths.some((width) => width > 0) ? "fixed" : "auto";
}

// ------------------------------------------------------------- navigation ---

/** Tab and Shift-Tab between cells; Tab past the last cell adds a row. */
export function moveBetweenCells(
  ctx: TableContext,
  cell: HTMLElement,
  forward: boolean,
): boolean {
  const table = cell.closest("table") as HTMLElement | null;
  if (!table) {
    return false;
  }
  const cells = Array.from(
    table.querySelectorAll("th, td"),
  ) as HTMLElement[];
  const index = cells.indexOf(cell);
  if (index < 0) {
    return false;
  }
  const next = cells[index + (forward ? 1 : -1)];
  if (!next) {
    if (!forward) {
      return false;
    }
    replaceTable(ctx, table, (clone) => {
      clone.querySelector("tbody")?.appendChild(blankRow(ctx, table));
    });
    const grown = tableNearCaret(ctx);
    const after = grown
      ? (Array.from(grown.querySelectorAll("th, td")) as HTMLElement[])
      : [];
    focusCell(ctx, after[cells.length]);
    return true;
  }
  focusCell(ctx, next);
  return true;
}

function focusCell(ctx: TableContext, cell?: HTMLElement): void {
  if (!cell) {
    return;
  }
  const selection = ctx.doc.getSelection?.();
  const range = ctx.doc.createRange();
  range.selectNodeContents(cell);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
  ctx.editor.focus({ preventScroll: true });
}

// ------------------------------------------------------------- structure ----

function insertColumn(
  ctx: TableContext,
  table: HTMLElement,
  index: number,
  after: boolean,
): void {
  const at = index + (after ? 1 : 0);
  replaceTable(ctx, table, (clone) => {
    for (const row of rowsOf(clone)) {
      const cells = cellsOf(row);
      const cell = blankCell(ctx.doc, cells[0]?.tagName === "TH");
      if (at >= cells.length) {
        row.appendChild(cell);
      } else {
        row.insertBefore(cell, cells[at]);
      }
    }
  });
}

function deleteColumn(
  ctx: TableContext,
  table: HTMLElement,
  index: number,
): void {
  replaceTable(ctx, table, (clone) => {
    for (const row of rowsOf(clone)) {
      cellsOf(row)[index]?.remove();
    }
    for (const row of rowsOf(clone)) {
      if (!cellsOf(row).length) {
        row.remove();
      }
    }
  });
}

function insertRow(
  ctx: TableContext,
  table: HTMLElement,
  index: number,
  after: boolean,
): void {
  const at = index + (after ? 1 : 0);
  replaceTable(ctx, table, (clone) => {
    const row = blankRow(ctx, table);
    const rows = rowsOf(clone);
    if (at >= rows.length) {
      clone.querySelector("tbody")?.appendChild(row);
    } else {
      rows[at].parentNode?.insertBefore(row, rows[at]);
    }
  });
}

function deleteRow(ctx: TableContext, table: HTMLElement, index: number): void {
  replaceTable(ctx, table, (clone) => {
    rowsOf(clone)[index]?.remove();
  });
}

function moveColumn(
  ctx: TableContext,
  table: HTMLElement,
  from: number,
  to: number,
): void {
  if (from === to) {
    return;
  }
  replaceTable(ctx, table, (clone) => {
    for (const row of rowsOf(clone)) {
      const cells = cellsOf(row);
      const moving = cells[from];
      if (!moving) {
        continue;
      }
      moving.remove();
      const rest = cellsOf(row);
      if (to >= rest.length) {
        row.appendChild(moving);
      } else {
        row.insertBefore(moving, rest[to]);
      }
    }
  });
}

function moveRow(
  ctx: TableContext,
  table: HTMLElement,
  from: number,
  to: number,
): void {
  if (from === to) {
    return;
  }
  replaceTable(ctx, table, (clone) => {
    const rows = rowsOf(clone);
    const moving = rows[from];
    if (!moving) {
      return;
    }
    const parent = moving.parentNode;
    moving.remove();
    const rest = rowsOf(clone);
    if (to >= rest.length) {
      parent?.appendChild(moving);
    } else {
      rest[to].parentNode?.insertBefore(moving, rest[to]);
    }
  });
}

// ------------------------------------------------------------- the handles --

export interface TableUIOptions extends TableContext {
  /** Sits over the editor, outside it: a child would be part of the note. */
  overlay: HTMLElement;
  onChange: () => void;
}

interface Handles {
  columns: HTMLElement[];
  resizers: HTMLElement[];
  rows: HTMLElement[];
  addColumn: HTMLElement;
  addRow: HTMLElement;
  line: HTMLElement;
}

interface Drag {
  kind: "column" | "row" | "resize";
  index: number;
  handle: HTMLElement;
  startX: number;
  startY: number;
  startWidths: number[];
  moved: boolean;
  target: number;
}

/**
 * The handles: a bar over every column, one beside every row, a grab zone on
 * each column border, and a + at each far edge.
 *
 * They are built once per table and only repositioned afterwards. Rebuilding
 * them mid-drag would destroy the very element holding the pointer capture.
 */
/**
 * A rectangle relative to the overlay.
 *
 * A plain object, not a DOMRect: this module runs in the plugin sandbox, which
 * has no DOM constructors of its own. `new DOMRect(...)` threw there, and
 * because the reader swallows exceptions from its own document the only
 * symptom was handles that were drawn but never positioned.
 */
interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export function installTableUI(options: TableUIOptions): () => void {
  const { doc, editor, overlay, onChange } = options;
  const ctx: TableContext = { doc, editor };
  let table: HTMLElement | null = null;
  let handles: Handles | null = null;
  let drag: Drag | null = null;
  let menu: HTMLElement | null = null;

  const box = (element: Element | null | undefined): Box => {
    if (!element) {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    const rect = element.getBoundingClientRect();
    const base = overlay.getBoundingClientRect();
    const left = rect.left - base.left;
    const top = rect.top - base.top;
    return {
      left,
      top,
      right: left + rect.width,
      bottom: top + rect.height,
      width: rect.width,
      height: rect.height,
    };
  };

  const node = (className: string, title = ""): HTMLElement => {
    const element = doc.createElement("button");
    element.type = "button";
    element.className = className;
    if (title) {
      element.title = title;
    }
    overlay.appendChild(element);
    return element;
  };

  /**
   * Is the pointer still at the table, counting everything drawn around it?
   *
   * The union of the table and its own handles, so a handle placed further out
   * later widens this on its own rather than needing a second number kept in
   * step with the first.
   */
  const withinReach = (x: number, y: number): boolean => {
    if (!table?.isConnected) {
      return false;
    }
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    const grow = (rect: DOMRect): void => {
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    };
    grow(table.getBoundingClientRect());
    for (const handle of Array.from(overlay.children) as HTMLElement[]) {
      if (!handle.hidden) {
        grow(handle.getBoundingClientRect());
      }
    }
    return (
      x >= left - HOVER_SLACK &&
      x <= right + HOVER_SLACK &&
      y >= top - HOVER_SLACK &&
      y <= bottom + HOVER_SLACK
    );
  };

  const closeMenu = (): void => {
    menu?.remove();
    menu = null;
  };

  const clear = (): void => {
    closeMenu();
    overlay.replaceChildren();
    handles = null;
    table = null;
  };

  const headerCells = (): HTMLTableCellElement[] => {
    const first = table?.querySelector("tr");
    return first ? cellsOf(first) : [];
  };

  const dragTitle = text(
    "Drag to move, click for options",
    "拖动可移动，点击查看选项",
  );

  const build = (target: HTMLElement): void => {
    overlay.replaceChildren();
    table = target;
    const cells = headerCells();
    const columns = cells.map((_, index) => {
      const grip = node("paperly-note-grip-col", dragTitle);
      grip.addEventListener("pointerdown", (event) =>
        startDrag("column", index, event as PointerEvent, grip),
      );
      return grip;
    });
    const resizers = cells.slice(0, -1).map((_, index) => {
      const handle = node(
        "paperly-note-resize",
        text("Drag to resize", "拖动调整宽度"),
      );
      handle.addEventListener("pointerdown", (event) =>
        startDrag("resize", index, event as PointerEvent, handle),
      );
      return handle;
    });
    const rows = rowsOf(target).map((_, index) => {
      const grip = node("paperly-note-grip-row", dragTitle);
      grip.addEventListener("pointerdown", (event) =>
        startDrag("row", index, event as PointerEvent, grip),
      );
      return grip;
    });

    const addColumn = node("paperly-note-tableadd", text("Add column", "添加列"));
    addColumn.textContent = "+";
    addColumn.addEventListener("pointerdown", (event) => event.preventDefault());
    addColumn.addEventListener("click", () => {
      const held = table;
      if (held) {
        insertColumn(ctx, held, headerCells().length - 1, true);
        clear();
        onChange();
      }
    });

    const addRow = node("paperly-note-tableadd", text("Add row", "添加行"));
    addRow.textContent = "+";
    addRow.addEventListener("pointerdown", (event) => event.preventDefault());
    addRow.addEventListener("click", () => {
      const held = table;
      if (held) {
        insertRow(ctx, held, rowsOf(held).length - 1, true);
        clear();
        onChange();
      }
    });

    const line = doc.createElement("div");
    line.className = "paperly-note-dropline";
    line.hidden = true;
    overlay.appendChild(line);

    handles = { columns, resizers, rows, addColumn, addRow, line };
    layout();
  };

  const layout = (): void => {
    if (!table || !handles) {
      return;
    }
    if (!table.isConnected) {
      clear();
      return;
    }
    const rect = box(table);
    const cells = headerCells();
    handles.columns.forEach((grip, index) => {
      const cell = cells[index];
      if (!cell) {
        grip.hidden = true;
        return;
      }
      const cellBox = box(cell);
      grip.hidden = false;
      grip.style.left = `${cellBox.left}px`;
      grip.style.top = `${rect.top - GRIP}px`;
      grip.style.width = `${Math.max(10, cellBox.width - 2)}px`;
      grip.style.height = `${GRIP - 2}px`;
    });
    handles.resizers.forEach((handle, index) => {
      const cell = cells[index];
      if (!cell) {
        handle.hidden = true;
        return;
      }
      const cellBox = box(cell);
      handle.hidden = false;
      handle.style.left = `${cellBox.right - 3}px`;
      handle.style.top = `${rect.top}px`;
      handle.style.width = "6px";
      handle.style.height = `${rect.height}px`;
    });
    const rows = rowsOf(table);
    handles.rows.forEach((grip, index) => {
      const row = rows[index];
      if (!row) {
        grip.hidden = true;
        return;
      }
      const rowBox = box(row);
      grip.hidden = false;
      grip.style.left = `${rect.left - GRIP}px`;
      grip.style.top = `${rowBox.top}px`;
      grip.style.width = `${GRIP - 2}px`;
      grip.style.height = `${Math.max(10, rowBox.height - 2)}px`;
    });
    // Beside the table and under it, each centred on the edge it adds to.
    handles.addColumn.style.left = `${rect.right + ADD_GAP}px`;
    handles.addColumn.style.top = `${rect.top + (rect.height - ADD) / 2}px`;
    handles.addRow.style.left = `${rect.left + (rect.width - ADD) / 2}px`;
    handles.addRow.style.top = `${rect.bottom + ADD_GAP}px`;
  };

  const openMenu = (kind: "column" | "row", index: number): void => {
    closeMenu();
    const held = table;
    const handle =
      kind === "column" ? handles?.columns[index] : handles?.rows[index];
    if (!held || !handle) {
      return;
    }
    const panel = doc.createElement("div");
    panel.className = "paperly-note-tablemenu";
    panel.style.left = `${parseFloat(handle.style.left) + 2}px`;
    panel.style.top = `${parseFloat(handle.style.top) + GRIP + 2}px`;
    const entries: [string, () => void][] =
      kind === "column"
        ? [
            [text("Insert left", "在左侧插入"), () => insertColumn(ctx, held, index, false)],
            [text("Insert right", "在右侧插入"), () => insertColumn(ctx, held, index, true)],
            [text("Delete column", "删除该列"), () => deleteColumn(ctx, held, index)],
          ]
        : [
            [text("Insert above", "在上方插入"), () => insertRow(ctx, held, index, false)],
            [text("Insert below", "在下方插入"), () => insertRow(ctx, held, index, true)],
            [text("Delete row", "删除该行"), () => deleteRow(ctx, held, index)],
          ];
    for (const [label, action] of entries) {
      const item = doc.createElement("button");
      item.type = "button";
      item.textContent = label;
      item.addEventListener("pointerdown", (event) => event.preventDefault());
      item.addEventListener("click", () => {
        action();
        clear();
        onChange();
      });
      panel.appendChild(item);
    }
    overlay.appendChild(panel);
    menu = panel;
  };

  const startDrag = (
    kind: Drag["kind"],
    index: number,
    event: PointerEvent,
    handle: HTMLElement,
  ): void => {
    event.preventDefault();
    closeMenu();
    drag = {
      kind,
      index,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      startWidths: headerCells().map(
        (cell) => cell.getBoundingClientRect().width,
      ),
      moved: false,
      target: index,
    };
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Without capture the drag still works while the pointer is inside.
    }
  };

  /**
   * Which slot a drop at this point belongs in.
   *
   * Read from the event rather than accumulated while the pointer moves: a
   * pointermove that never arrives, or one that throws halfway through drawing
   * the indicator, would otherwise decide where the column lands.
   */
  const slotAt = (kind: "column" | "row", x: number, y: number): number => {
    const boxes =
      kind === "column"
        ? headerCells().map((cell) => cell.getBoundingClientRect())
        : rowsOf(table as HTMLElement).map((row) =>
            row.getBoundingClientRect(),
          );
    for (let index = 0; index < boxes.length; index += 1) {
      const middle =
        kind === "column"
          ? boxes[index].left + boxes[index].width / 2
          : boxes[index].top + boxes[index].height / 2;
      if ((kind === "column" ? x : y) < middle) {
        return index;
      }
    }
    return boxes.length;
  };

  const moveDrag = (event: PointerEvent): void => {
    if (!drag || !table || !handles) {
      return;
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      drag.moved = true;
    }
    if (drag.kind === "resize") {
      // A border drag moves the boundary between two columns: what one gains
      // the other gives up. Growing a column on its own would push the table
      // wider than the pad on every drag.
      const widths = drag.startWidths.slice();
      const here = drag.startWidths[drag.index] || MIN_COLUMN;
      const next = drag.startWidths[drag.index + 1] || MIN_COLUMN;
      const span = here + next;
      widths[drag.index] = Math.min(
        Math.max(MIN_COLUMN, here + dx),
        span - MIN_COLUMN,
      );
      widths[drag.index + 1] = span - widths[drag.index];
      writeColumnWidths(table, widths);
      layout();
      return;
    }
    const line = handles.line;
    line.hidden = false;
    const rect = box(table);
    const target = slotAt(drag.kind, event.clientX, event.clientY);
    drag.target = target;
    if (drag.kind === "column") {
      const cells = headerCells();
      const edge =
        target >= cells.length
          ? box(cells[cells.length - 1]).right
          : box(cells[target]).left;
      line.style.left = `${edge - 1}px`;
      line.style.top = `${rect.top}px`;
      line.style.width = "2px";
      line.style.height = `${rect.height}px`;
      return;
    }
    const rows = rowsOf(table);
    const edge =
      target >= rows.length
        ? box(rows[rows.length - 1]).bottom
        : box(rows[target]).top;
    line.style.left = `${rect.left}px`;
    line.style.top = `${edge - 1}px`;
    line.style.width = `${rect.width}px`;
    line.style.height = "2px";
  };

  const endDrag = (event: Event): void => {
    if (!drag) {
      return;
    }
    const finished = drag;
    const held = table;
    drag = null;
    try {
      finished.handle.releasePointerCapture((event as PointerEvent).pointerId);
    } catch {
      // Already released if the pointer left the window.
    }
    if (handles) {
      handles.line.hidden = true;
    }
    if (!held) {
      return;
    }
    if (finished.kind === "resize") {
      // The widths are already on the cells. They are written straight there
      // rather than through insertHTML because taking over the selection would
      // move the caret out from under whoever is typing.
      onChange();
      layout();
      return;
    }
    if (!finished.moved) {
      openMenu(finished.kind, finished.index);
      return;
    }
    // Dropping to the right of where it came from means one fewer slot once
    // the row or column is lifted out, which is what the -1 is.
    let target = slotAt(
      finished.kind,
      (event as PointerEvent).clientX,
      (event as PointerEvent).clientY,
    );
    if (target > finished.index) {
      target -= 1;
    }
    if (finished.kind === "column") {
      moveColumn(ctx, held, finished.index, target);
    } else {
      moveRow(ctx, held, finished.index, target);
    }
    clear();
    onChange();
  };

  const onPointerMove = (event: Event): void => {
    const pointer = event as PointerEvent;
    if (drag) {
      moveDrag(pointer);
      return;
    }
    const target = pointer.target as Element | null;
    const over = target?.closest("table") as HTMLElement | null;
    if (over && editor.contains(over)) {
      if (over !== table) {
        build(over);
      }
      return;
    }
    // The handles sit outside the table on purpose, so neither the pointer
    // being on one of them nor the short trip to reach one is a reason to put
    // them away. Nor is an open menu, which is what was being aimed at.
    if (menu || overlay.contains(target as Node)) {
      return;
    }
    if (!withinReach(pointer.clientX, pointer.clientY)) {
      clear();
    }
  };

  const onScroll = (): void => layout();
  /**
   * The handles sit in a layer over the editor, not in it, so moving the
   * pointer from the table onto a handle LEAVES the editor. Clearing on that
   * took the handles away under the pointer the moment anyone tried to grab
   * one -- and only with a real pointer, which is why it survived every
   * synthetic test.
   */
  const onLeave = (event: Event): void => {
    const to = (event as PointerEvent).relatedTarget as Node | null;
    if (drag || menu || (to && overlay.contains(to))) {
      return;
    }
    clear();
  };
  const onDocPointerDown = (event: Event): void => {
    if (menu && !menu.contains(event.target as Node)) {
      closeMenu();
    }
  };

  editor.addEventListener("pointermove", onPointerMove);
  editor.addEventListener("pointerleave", onLeave);
  editor.addEventListener("scroll", onScroll);
  overlay.addEventListener("pointermove", onPointerMove);
  overlay.addEventListener("pointerup", endDrag);
  overlay.addEventListener("pointercancel", endDrag);
  doc.addEventListener("pointerdown", onDocPointerDown, true);

  return () => {
    editor.removeEventListener("pointermove", onPointerMove);
    editor.removeEventListener("pointerleave", onLeave);
    editor.removeEventListener("scroll", onScroll);
    overlay.removeEventListener("pointermove", onPointerMove);
    overlay.removeEventListener("pointerup", endDrag);
    overlay.removeEventListener("pointercancel", endDrag);
    doc.removeEventListener("pointerdown", onDocPointerDown, true);
    clear();
  };
}

// -------------------------------------------------------------------- CSS ---

export function tableStyles(panelId: string): string {
  return `
#${panelId} .paperly-note-editor table {
  border-collapse: collapse;
  width: calc(100% - ${TABLE_MARGIN}px);
  margin: 10px 20px 10px 10px;
  font-size: 0.94em;
}
#${panelId} .paperly-note-editor th,
#${panelId} .paperly-note-editor td {
  /* A stored width is the whole cell, padding and border included. Without
     this every column rendered 15px wider than it was told to be and the
     table ran off the side of the pad. */
  box-sizing: border-box;
  border: 1px solid color-mix(in srgb, var(--paperly-note-fg) 26%, var(--paperly-note-bg));
  padding: 4px 7px;
  vertical-align: top;
  min-width: ${MIN_COLUMN}px;
  text-align: start;
}
#${panelId} .paperly-note-editor th {
  font-weight: 600;
  background: color-mix(in srgb, var(--paperly-note-fg) 8%, var(--paperly-note-bg));
}

#${panelId} .paperly-note-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}
#${panelId} .paperly-note-overlay > * {
  position: absolute;
  pointer-events: auto;
  margin: 0;
  padding: 0;
}
#${panelId} .paperly-note-grip-col,
#${panelId} .paperly-note-grip-row {
  border: 0;
  border-radius: 3px;
  cursor: grab;
  background: color-mix(in srgb, var(--paperly-note-fg) 22%, var(--paperly-note-bg));
}
#${panelId} .paperly-note-grip-col:hover,
#${panelId} .paperly-note-grip-row:hover {
  background: color-mix(in srgb, var(--paperly-note-fg) 45%, var(--paperly-note-bg));
}
#${panelId} .paperly-note-resize {
  border: 0;
  background: transparent;
  cursor: col-resize;
}
#${panelId} .paperly-note-resize:hover {
  background: color-mix(in srgb, var(--paperly-note-fg) 30%, transparent);
}
#${panelId} .paperly-note-tableadd {
  width: ${ADD}px;
  height: ${ADD}px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
  font: 600 13px/1 inherit;
  color: inherit;
  opacity: 0.5;
  background: color-mix(in srgb, var(--paperly-note-fg) 14%, var(--paperly-note-bg));
}
#${panelId} .paperly-note-tableadd:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--paperly-note-fg) 30%, var(--paperly-note-bg));
}
#${panelId} .paperly-note-dropline {
  border-radius: 1px;
  background: color-mix(in srgb, var(--paperly-note-fg) 70%, var(--paperly-note-bg));
}
#${panelId} .paperly-note-tablemenu {
  z-index: 2;
  display: flex;
  flex-direction: column;
  min-width: 132px;
  padding: 4px;
  border-radius: 7px;
  background: var(--paperly-note-bg, #fff);
  border: 1px solid color-mix(in srgb, var(--paperly-note-fg) 20%, var(--paperly-note-bg));
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.18);
}
#${panelId} .paperly-note-tablemenu button {
  padding: 5px 8px;
  border: 0;
  border-radius: 5px;
  text-align: start;
  font: inherit;
  font-size: 12px;
  color: inherit;
  background: transparent;
  cursor: pointer;
}
#${panelId} .paperly-note-tablemenu button:hover {
  background: color-mix(in srgb, var(--paperly-note-fg) 12%, var(--paperly-note-bg));
}
`;
}
