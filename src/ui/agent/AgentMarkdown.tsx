// A reply's Markdown as React elements, with math through KaTeX.
//
// Text only ever becomes text nodes. The one place HTML is parsed is KaTeX's
// own output (it escapes the TeX it is given, and `trust` is off), and that
// goes through DOMParser as text/html: the main window is an XHTML document,
// where innerHTML would parse as XML and choke on KaTeX's markup.

import katex from "katex";
import React, { memo, useLayoutEffect, useRef, useState } from "react";
import { parseMarkdown } from "../../modules/agent/markdown";
import type { Block, Inline } from "../../modules/agent/markdown";
import { copyTextToClipboard } from "../../utils/clipboard";

const parsed = new Map<string, Block[]>();

/** Streaming re-renders the same finished parts again and again; parse each once. */
function parseCached(text: string): Block[] {
  const hit = parsed.get(text);
  if (hit) {
    return hit;
  }
  const blocks = parseMarkdown(text);
  parsed.set(text, blocks);
  if (parsed.size > 300) {
    parsed.delete(parsed.keys().next().value as string);
  }
  return blocks;
}

export const MathNode = memo(function MathNode({ tex, display }: { tex: string; display: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    let html = "";
    try {
      html = katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        output: "html",
        strict: "ignore",
        trust: false,
        maxSize: 30,
        maxExpand: 1000,
      });
    } catch {
      element.textContent = display ? `$$${tex}$$` : `$${tex}$`;
      return;
    }
    const owner = element.ownerDocument;
    const view = owner?.defaultView as unknown as (Window & typeof globalThis) | null;
    if (!owner || !view) {
      element.textContent = tex;
      return;
    }
    const body = new view.DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html").body;
    if (!body) {
      element.textContent = tex;
      return;
    }
    const nodes = Array.from(body.childNodes as unknown as ArrayLike<Node>).map((node) => owner.importNode(node, true));
    element.replaceChildren(...nodes);
  }, [tex, display]);
  return (
    <span
      className={display ? "paperly-agent-math paperly-agent-math--display" : "paperly-agent-math"}
      ref={ref}
      title={tex}
    />
  );
});

function openLink(event: React.MouseEvent, href: string) {
  event.preventDefault();
  event.stopPropagation();
  if (/^(https?:|mailto:)/i.test(href)) {
    Zotero.launchURL(href);
  }
}

function renderInline(nodes: Inline[], keyPrefix: string): React.ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.t) {
      case "text":
        return <React.Fragment key={key}>{node.v}</React.Fragment>;
      case "code":
        return (
          <code className="paperly-agent-inline-code" key={key}>
            {node.v}
          </code>
        );
      case "math":
        return node.display ? (
          <span className="paperly-agent-math-block" key={key}>
            <MathNode display tex={node.v} />
          </span>
        ) : (
          <MathNode display={false} key={key} tex={node.v} />
        );
      case "strong":
        return <strong key={key}>{renderInline(node.c, key)}</strong>;
      case "em":
        return <em key={key}>{renderInline(node.c, key)}</em>;
      case "del":
        return <del key={key}>{renderInline(node.c, key)}</del>;
      case "link":
        return (
          <a
            className="paperly-agent-link"
            href={node.href}
            key={key}
            onClick={(event) => openLink(event, node.href)}
            title={node.href}
          >
            {renderInline(node.c, key)}
          </a>
        );
      case "br":
        return <br key={key} />;
      default:
        return null;
    }
  });
}

function CodeBlock({ lang, text, copyLabel, copiedLabel }: { lang: string; text: string; copyLabel: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="paperly-agent-codeblock">
      <div className="paperly-agent-codeblock-bar">
        <span>{lang || "text"}</span>
        <button
          className="paperly-agent-ghost-button"
          onClick={() => {
            copyTextToClipboard(text);
            setCopied(true);
            const win = Zotero.getMainWindow?.();
            win?.setTimeout(() => setCopied(false), 1500);
          }}
          type="button"
        >
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

interface RenderOptions {
  copyLabel: string;
  copiedLabel: string;
}

function renderBlocks(blocks: Block[], keyPrefix: string, options: RenderOptions, tight = false): React.ReactNode[] {
  return blocks.map((block, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (block.t) {
      case "p":
        return tight ? (
          <React.Fragment key={key}>{renderInline(block.c, key)}</React.Fragment>
        ) : (
          <p key={key}>{renderInline(block.c, key)}</p>
        );
      case "h": {
        const Tag = (block.level <= 2 ? "h3" : block.level === 3 ? "h4" : "h5") as "h3" | "h4" | "h5";
        return <Tag key={key}>{renderInline(block.c, key)}</Tag>;
      }
      case "code":
        return <CodeBlock key={key} lang={block.lang} text={block.v} {...options} />;
      case "math":
        return (
          <div className="paperly-agent-math-block" key={key}>
            <MathNode display tex={block.v} />
          </div>
        );
      case "quote":
        return <blockquote key={key}>{renderBlocks(block.c, key, options)}</blockquote>;
      case "list": {
        const items = block.items.map((item, itemIndex) => {
          const single = item.length === 1 && item[0].t === "p";
          return <li key={`${key}-${itemIndex}`}>{renderBlocks(item, `${key}-${itemIndex}`, options, single)}</li>;
        });
        return block.ordered ? (
          <ol key={key} start={block.start}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        );
      }
      case "table":
        return (
          <div className="paperly-agent-table" key={key}>
            <table>
              <thead>
                <tr>
                  {block.head.map((cell, column) => (
                    <th key={column} style={block.align[column] ? { textAlign: block.align[column]! } : undefined}>
                      {renderInline(cell, `${key}-h${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, column) => (
                      <td key={column} style={block.align[column] ? { textAlign: block.align[column]! } : undefined}>
                        {renderInline(cell, `${key}-${rowIndex}-${column}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "hr":
        return <hr key={key} />;
      default:
        return null;
    }
  });
}

export function AgentMarkdown({ text, copyLabel, copiedLabel }: { text: string; copyLabel: string; copiedLabel: string }) {
  return <div className="paperly-agent-markdown">{renderBlocks(parseCached(text), "md", { copyLabel, copiedLabel })}</div>;
}
