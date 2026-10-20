// Markdown as the agents write it, parsed into a small tree.
//
// The chat view renders the tree as React elements (never as HTML strings),
// and "Save as note" turns it into the HTML a Zotero note holds. Both paths
// escape every piece of text, so a reply cannot inject markup.
//
// Covers what Claude and Codex actually produce: headings, paragraphs, bullet
// and numbered lists (nested), block quotes, fenced code, GFM tables, rules,
// and math as $...$, $$...$$, \(...\) and \[...\]. It is forgiving rather than
// strict: the text is often half-written, because it is re-parsed on every
// streamed chunk.
//
// No runtime imports: the tests load this file straight into Node.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "math"; v: string; display?: boolean }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "math"; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])(?: +|$)(.*)$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function expandTabs(line: string): string {
  return line.replace(/\t/g, "    ");
}

function indentOf(line: string): number {
  return /^ */.exec(line)![0].length;
}

function isFenceClose(line: string, fence: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= fence.length && trimmed[0] === fence[0] && /^(`+|~+)$/.test(trimmed);
}

function startsBlock(line: string): boolean {
  return (
    FENCE_OPEN.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    /^\s*(\$\$|\\\[)/.test(line)
  );
}

function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) {
    text = text.slice(1);
  }
  if (text.endsWith("|") && !text.endsWith("\\|")) {
    text = text.slice(0, -1);
  }
  const cells: string[] = [];
  let current = "";
  let inCode = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\" && text[index + 1] === "|") {
      current += "|";
      index++;
      continue;
    }
    if (char === "`") {
      inCode = !inCode;
    }
    if (char === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function parseAlign(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) {
    return "center";
  }
  if (right) {
    return "right";
  }
  if (left) {
    return "left";
  }
  return null;
}

function parseList(lines: string[], start: number): [Block, number] {
  const first = LIST_ITEM.exec(lines[start])!;
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNumber = ordered ? parseInt(first[2], 10) : 1;
  const items: string[][] = [];
  let index = start;
  while (index < lines.length) {
    const match = LIST_ITEM.exec(lines[index]);
    if (!match || match[1].length !== baseIndent || /\d/.test(match[2]) !== ordered) {
      break;
    }
    const contentIndent = match[1].length + match[2].length + 1;
    const itemLines = [match[3]];
    index++;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        let next = index + 1;
        while (next < lines.length && !lines[next].trim()) {
          next++;
        }
        if (next < lines.length && indentOf(lines[next]) >= contentIndent) {
          itemLines.push("");
          index++;
          continue;
        }
        break;
      }
      const indent = indentOf(line);
      if (indent >= contentIndent) {
        itemLines.push(line.slice(contentIndent));
        index++;
        continue;
      }
      const nested = LIST_ITEM.exec(line);
      if (nested) {
        if (nested[1].length <= baseIndent) {
          break;
        }
        itemLines.push(line.slice(Math.min(indent, contentIndent)));
        index++;
        continue;
      }
      if (startsBlock(line)) {
        break;
      }
      // A lazy continuation of the item's paragraph.
      itemLines.push(line.trim());
      index++;
    }
    items.push(itemLines);
  }
  return [
    { t: "list", ordered, start: startNumber, items: items.map((item) => parseBlockLines(item)) },
    index,
  ];
}

function parseBlockLines(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const body: string[] = [];
      index++;
      while (index < lines.length && !isFenceClose(lines[index], fence[1])) {
        body.push(lines[index]);
        index++;
      }
      index++; // the closing fence, or past the end while still streaming
      blocks.push({ t: "code", lang: fence[2] || "", v: body.join("\n") });
      continue;
    }

    const mathOpen = /^\s*(\$\$|\\\[)(.*)$/.exec(line);
    if (mathOpen) {
      const close = mathOpen[1] === "$$" ? "$$" : "\\]";
      const rest = mathOpen[2];
      const closeAt = rest.indexOf(close);
      if (closeAt >= 0) {
        blocks.push({ t: "math", v: rest.slice(0, closeAt).trim() });
        const after = rest.slice(closeAt + close.length).trim();
        if (after) {
          blocks.push({ t: "p", c: parseInline(after) });
        }
        index++;
        continue;
      }
      const body = [rest];
      index++;
      while (index < lines.length && !lines[index].includes(close)) {
        body.push(lines[index]);
        index++;
      }
      if (index < lines.length) {
        body.push(lines[index].slice(0, lines[index].indexOf(close)));
        index++;
      }
      blocks.push({ t: "math", v: body.join("\n").trim() });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: "h", level: heading[1].length, c: parseInline(heading[2] || "") });
      index++;
      continue;
    }

    if (RULE.test(line) && !LIST_ITEM.exec(line)?.[3]) {
      blocks.push({ t: "hr" });
      index++;
      continue;
    }

    if (
      line.includes("|") &&
      index + 1 < lines.length &&
      TABLE_DELIMITER.test(lines[index + 1]) &&
      lines[index + 1].includes("-")
    ) {
      const head = splitTableRow(line);
      const align = splitTableRow(lines[index + 1]).map(parseAlign);
      const rows: Inline[][][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        const cells = splitTableRow(lines[index]);
        rows.push(head.map((_, column) => parseInline(cells[column] ?? "")));
        index++;
      }
      blocks.push({ t: "table", align: head.map((_, column) => align[column] ?? null), head: head.map((cell) => parseInline(cell)), rows });
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && lines[index].trim()) {
        const quoted = QUOTE.exec(lines[index]);
        if (quoted) {
          body.push(quoted[1]);
        } else if (startsBlock(lines[index])) {
          break;
        } else {
          body.push(lines[index]);
        }
        index++;
      }
      blocks.push({ t: "quote", c: parseBlockLines(body) });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const [list, next] = parseList(lines, index);
      blocks.push(list);
      index = next;
      continue;
    }

    const paragraph: string[] = [line];
    index++;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
      paragraph.push(lines[index]);
      index++;
    }
    blocks.push({ t: "p", c: parseInline(paragraph.map((part) => part.replace(/^ +/, "")).join("\n")) });
  }
  return blocks;
}

export function parseMarkdown(text: string): Block[] {
  return parseBlockLines(String(text || "").replace(/\r\n?/g, "\n").split("\n").map(expandTabs));
}

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;
const BARE_URL = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/g;

function pushText(out: Inline[], text: string) {
  if (!text) {
    return;
  }
  // Bare URLs become links; the rest stays text.
  let last = 0;
  BARE_URL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BARE_URL.exec(text))) {
    if (match.index > last) {
      appendText(out, text.slice(last, match.index));
    }
    out.push({ t: "link", href: match[0], c: [{ t: "text", v: match[0] }] });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    appendText(out, text.slice(last));
  }
}

function appendText(out: Inline[], text: string) {
  const previous = out[out.length - 1];
  if (previous && previous.t === "text") {
    previous.v += text;
  } else {
    out.push({ t: "text", v: text });
  }
}

function findClosing(text: string, marker: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const found = text.indexOf(marker, index);
    if (found < 0) {
      return -1;
    }
    if (text[found - 1] === "\\") {
      index = found + marker.length;
      continue;
    }
    return found;
  }
  return -1;
}

export function parseInline(source: string): Inline[] {
  const text = String(source || "");
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => {
    pushText(out, buffer);
    buffer = "";
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "\\" && next !== undefined) {
      if (next === "(" || next === "[") {
        const close = next === "(" ? "\\)" : "\\]";
        const end = text.indexOf(close, index + 2);
        if (end > index + 2) {
          flush();
          out.push({ t: "math", v: text.slice(index + 2, end).trim(), display: next === "[" });
          index = end + 2;
          continue;
        }
      }
      if (next === "\n") {
        flush();
        out.push({ t: "br" });
        index += 2;
        continue;
      }
      if (/[\\`*_{}[\]()#+\-.!|~$<>]/.test(next)) {
        buffer += next;
        index += 2;
        continue;
      }
    }

    if (char === "`") {
      let run = 1;
      while (text[index + run] === "`") {
        run++;
      }
      const fence = "`".repeat(run);
      const end = text.indexOf(fence, index + run);
      if (end >= 0) {
        flush();
        let code = text.slice(index + run, end);
        if (/^ .* $/.test(code)) {
          code = code.slice(1, -1);
        }
        out.push({ t: "code", v: code.replace(/\n/g, " ") });
        index = end + run;
        continue;
      }
      buffer += fence;
      index += run;
      continue;
    }

    if (char === "$") {
      if (next === "$") {
        const end = findClosing(text, "$$", index + 2);
        if (end > index + 2) {
          flush();
          out.push({ t: "math", v: text.slice(index + 2, end).trim(), display: true });
          index = end + 2;
          continue;
        }
      } else if (next !== undefined && !/\s/.test(next)) {
        // $...$ only when it looks like math: no space just inside either
        // dollar, and no digit right after the closing one ("$5 and $10").
        let end = index + 1;
        let found = -1;
        while ((end = text.indexOf("$", end)) >= 0) {
          if (text[end - 1] === "\\") {
            end++;
            continue;
          }
          if (/\s/.test(text[end - 1]) || /\d/.test(text[end + 1] || "")) {
            end++;
            continue;
          }
          found = end;
          break;
        }
        if (found > index + 1 && !text.slice(index + 1, found).includes("\n\n")) {
          flush();
          out.push({ t: "math", v: text.slice(index + 1, found) });
          index = found + 1;
          continue;
        }
      }
    }

    if (char === "[") {
      const close = text.indexOf("]", index + 1);
      if (close > index && text[close + 1] === "(") {
        const end = text.indexOf(")", close + 2);
        if (end > close) {
          const href = text.slice(close + 2, end).trim().split(/\s+/)[0] || "";
          flush();
          const label = parseInline(text.slice(index + 1, close));
          if (SAFE_LINK.test(href)) {
            out.push({ t: "link", href, c: label });
          } else {
            out.push(...label);
          }
          index = end + 1;
          continue;
        }
      }
    }

    if (char === "<" && /^<https?:\/\/[^>\s]+>/.test(text.slice(index))) {
      const end = text.indexOf(">", index);
      const href = text.slice(index + 1, end);
      flush();
      out.push({ t: "link", href, c: [{ t: "text", v: href }] });
      index = end + 1;
      continue;
    }

    if (char === "~" && next === "~") {
      const end = findClosing(text, "~~", index + 2);
      if (end > index + 2) {
        flush();
        out.push({ t: "del", c: parseInline(text.slice(index + 2, end)) });
        index = end + 2;
        continue;
      }
    }

    if (char === "*" || char === "_") {
      const double = next === char;
      const marker = double ? char + char : char;
      const opensWord = !/\s/.test(text[index + marker.length] || " ");
      const intraword = char === "_" && /\w/.test(text[index - 1] || "");
      if (opensWord && !intraword) {
        let end = findClosing(text, marker, index + marker.length);
        // A single * must not close on half of a **.
        while (!double && end >= 0 && text[end + 1] === char) {
          end = findClosing(text, marker, end + 2);
        }
        if (
          end > index + marker.length &&
          !/\s/.test(text[end - 1]) &&
          !(char === "_" && /\w/.test(text[end + marker.length] || ""))
        ) {
          flush();
          const inner = parseInline(text.slice(index + marker.length, end));
          out.push(double ? { t: "strong", c: inner } : { t: "em", c: inner });
          index = end + marker.length;
          continue;
        }
      }
    }

    if (char === "\n") {
      if (/ {2,}$/.test(buffer)) {
        buffer = buffer.replace(/ +$/, "");
        flush();
        out.push({ t: "br" });
      } else {
        buffer += " ";
      }
      index++;
      continue;
    }

    buffer += char;
    index++;
  }
  flush();
  return out;
}

/** Plain text of an inline run, for titles and copies. */
export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.t) {
        case "text":
        case "code":
          return node.v;
        case "math":
          return node.display ? `$$${node.v}$$` : `$${node.v}$`;
        case "br":
          return "\n";
        default:
          return inlineText(node.c);
      }
    })
    .join("");
}

export function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineHtml(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.t) {
        case "text":
          return escapeHtml(node.v);
        case "code":
          return `<code>${escapeHtml(node.v)}</code>`;
        case "math":
          // Zotero's note editor keeps inline math as <span class="math">$…$</span>;
          // display math inside a paragraph has to stay inline there too.
          return `<span class="math">$${escapeHtml(node.v)}$</span>`;
        case "strong":
          return `<strong>${inlineHtml(node.c)}</strong>`;
        case "em":
          return `<em>${inlineHtml(node.c)}</em>`;
        case "del":
          return `<span style="text-decoration: line-through">${inlineHtml(node.c)}</span>`;
        case "link":
          return `<a href="${escapeHtml(node.href)}">${inlineHtml(node.c)}</a>`;
        case "br":
          return "<br>";
        default:
          return "";
      }
    })
    .join("");
}

function blocksHtml(blocks: Block[]): string {
  return blocks
    .map((block) => {
      switch (block.t) {
        case "p":
          return `<p>${inlineHtml(block.c)}</p>`;
        case "h": {
          const level = Math.min(6, Math.max(1, block.level));
          return `<h${level}>${inlineHtml(block.c)}</h${level}>`;
        }
        case "code":
          return `<pre>${escapeHtml(block.v)}</pre>`;
        case "math":
          return `<pre class="math">$$${escapeHtml(block.v)}$$</pre>`;
        case "quote":
          return `<blockquote>${blocksHtml(block.c)}</blockquote>`;
        case "list": {
          const tag = block.ordered ? "ol" : "ul";
          const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
          return `<${tag}${start}>${block.items.map((item) => `<li>${blocksHtml(item)}</li>`).join("")}</${tag}>`;
        }
        case "table": {
          const head = `<tr>${block.head.map((cell) => `<th>${inlineHtml(cell)}</th>`).join("")}</tr>`;
          const rows = block.rows
            .map((row) => `<tr>${row.map((cell) => `<td>${inlineHtml(cell)}</td>`).join("")}</tr>`)
            .join("");
          return `<table>${head}${rows}</table>`;
        }
        case "hr":
          return "<hr>";
        default:
          return "";
      }
    })
    .join("");
}

/** A Zotero note's HTML for Markdown text; every piece of text is escaped. */
export function markdownToNoteHtml(markdown: string, title?: string): string {
  const heading = title ? `<h1>${escapeHtml(title)}</h1>` : "";
  return `<div data-schema-version="9">${heading}${blocksHtml(parseMarkdown(markdown))}</div>`;
}
