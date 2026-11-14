import type { ReactNode } from "react";
import { createElement } from "react";

/**
 * A hand-rolled Markdown subset, and deliberately a small one.
 *
 * Supported: fenced code blocks, inline code, bold, italic, links, unordered and
 * ordered lists, paragraphs and single newlines. That is the whole vocabulary a
 * streaming chat answer needs today; tables, images, headings and math are not
 * here, and a real parser (streamdown or remark) stays deferred until they are.
 *
 * Injection safety is structural, not a sanitiser: the parser produces a tree, and
 * the renderer turns text into React text nodes. There is no HTML string anywhere
 * in this file and no `dangerouslySetInnerHTML` in the renderer, so `<img
 * onerror=...>` in a model answer is characters on screen, never an element.
 *
 * Two streaming-specific choices:
 *  - an unterminated fence still renders as a code block, because while tokens are
 *    arriving the closing fence does not exist yet;
 *  - an unclosed `*` or backtick stays literal, so a half-typed marker does not
 *    swallow the rest of the answer.
 */

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "bold"; children: InlineNode[] }
  | { type: "italic"; children: InlineNode[] }
  | { type: "link"; href: string; children: InlineNode[] };

export type BlockNode =
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "code"; lang: string | null; value: string }
  | { type: "list"; ordered: boolean; items: InlineNode[][] };

/** Only absolute web and mail links are rendered as links; anything else is text. */
function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href) || /^mailto:/i.test(href);
}

function fenceLanguage(line: string): { lang: string | null } | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("```")) return null;
  const lang = trimmed.slice(3).trim();
  return { lang: lang === "" ? null : lang };
}

function isFenceClose(line: string): boolean {
  return line.trim() === "```";
}

const UNORDERED_ITEM = /^\s*[-*]\s+(.*)$/;
const ORDERED_ITEM = /^\s*\d{1,9}\.\s+(.*)$/;

function listItemText(line: string): { ordered: boolean; text: string } | null {
  const unordered = UNORDERED_ITEM.exec(line);
  if (unordered !== null) return { ordered: false, text: unordered[1] ?? "" };
  const ordered = ORDERED_ITEM.exec(line);
  if (ordered !== null) return { ordered: true, text: ordered[1] ?? "" };
  return null;
}

function parseLink(input: string, start: number): { node: InlineNode; next: number } | null {
  const labelEnd = input.indexOf("]", start + 1);
  if (labelEnd === -1) return null;
  if (input[labelEnd + 1] !== "(") return null;
  const hrefEnd = input.indexOf(")", labelEnd + 2);
  if (hrefEnd === -1) return null;

  const href = input.slice(labelEnd + 2, hrefEnd).trim();
  // Rejected schemes fall through as text: the caller keeps the "[" and the rest
  // of the characters are emitted literally by the normal path.
  if (!isSafeHref(href)) return null;

  const label = input.slice(start + 1, labelEnd);
  return { node: { type: "link", href, children: parseInline(label) }, next: hrefEnd + 1 };
}

export function parseInline(input: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buffer = "";
  let index = 0;

  const flush = (): void => {
    if (buffer === "") return;
    nodes.push({ type: "text", value: buffer });
    buffer = "";
  };

  while (index < input.length) {
    const char = input[index] ?? "";

    if (char === "`") {
      const end = input.indexOf("`", index + 1);
      if (end === -1) {
        buffer += char;
        index += 1;
        continue;
      }
      flush();
      nodes.push({ type: "code", value: input.slice(index + 1, end) });
      index = end + 1;
      continue;
    }

    if (char === "*") {
      const bold = input.startsWith("**", index);
      const marker = bold ? "**" : "*";
      const from = index + marker.length;
      const end = input.indexOf(marker, from);
      const inner = end === -1 ? "" : input.slice(from, end);

      // A marker with nothing (or only space) between it and its pair is text, not
      // emphasis: `2 * 3` and a lone `*` mid-stream must survive as typed.
      if (end === -1 || inner.trim() === "") {
        buffer += marker;
        index = from;
        continue;
      }

      flush();
      const children = parseInline(inner);
      nodes.push(bold ? { type: "bold", children } : { type: "italic", children });
      index = end + marker.length;
      continue;
    }

    if (char === "[") {
      const link = parseLink(input, index);
      if (link !== null) {
        flush();
        nodes.push(link.node);
        index = link.next;
        continue;
      }
      buffer += char;
      index += 1;
      continue;
    }

    buffer += char;
    index += 1;
  }

  flush();
  return nodes;
}

export function parseMarkdown(input: string): BlockNode[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const blocks: BlockNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = fenceLanguage(line);
    if (fence !== null) {
      index += 1;
      const body: string[] = [];
      // No closing fence is not an error: during a stream the answer is still
      // arriving, and what has arrived so far is what the user should see.
      while (index < lines.length && !isFenceClose(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", lang: fence.lang, value: body.join("\n") });
      continue;
    }

    const item = listItemText(line);
    if (item !== null) {
      const items: InlineNode[][] = [];
      const ordered = item.ordered;
      while (index < lines.length) {
        const current = listItemText(lines[index] ?? "");
        if (current === null || current.ordered !== ordered) break;
        items.push(parseInline(current.text));
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (
        current.trim() === "" ||
        fenceLanguage(current) !== null ||
        listItemText(current) !== null
      ) {
        break;
      }
      paragraph.push(current.trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
  }

  return blocks;
}

function renderText(value: string, keyPrefix: string): ReactNode[] {
  const segments = value.split("\n");
  const rendered: ReactNode[] = [];

  segments.forEach((segment, index) => {
    if (index > 0) rendered.push(createElement("br", { key: `${keyPrefix}-br-${index}` }));
    if (segment !== "") rendered.push(segment);
  });

  return rendered;
}

function renderInline(nodes: readonly InlineNode[], keyPrefix: string): ReactNode[] {
  const rendered: ReactNode[] = [];

  nodes.forEach((node, index) => {
    const key = `${keyPrefix}-${index}`;

    switch (node.type) {
      case "text":
        rendered.push(...renderText(node.value, key));
        break;
      case "code":
        rendered.push(createElement("code", { key }, node.value));
        break;
      case "bold":
        rendered.push(createElement("strong", { key }, renderInline(node.children, key)));
        break;
      case "italic":
        rendered.push(createElement("em", { key }, renderInline(node.children, key)));
        break;
      case "link":
        rendered.push(
          createElement(
            "a",
            { key, href: node.href, target: "_blank", rel: "noreferrer noopener" },
            renderInline(node.children, key),
          ),
        );
        break;
    }
  });

  return rendered;
}

function renderBlock(block: BlockNode, key: string): ReactNode {
  switch (block.type) {
    case "paragraph":
      return createElement("p", { key }, renderInline(block.children, key));
    case "code":
      return createElement(
        "pre",
        { key },
        createElement(
          "code",
          block.lang === null ? {} : { className: `language-${block.lang}` },
          block.value,
        ),
      );
    case "list":
      return createElement(
        block.ordered ? "ol" : "ul",
        { key },
        block.items.map((item, index) =>
          createElement(
            "li",
            { key: `${key}-item-${index}` },
            renderInline(item, `${key}-item-${index}`),
          ),
        ),
      );
  }
}

/** Parses and renders in one step. Returns React nodes; never an HTML string. */
export function renderMarkdown(input: string): ReactNode[] {
  return parseMarkdown(input).map((block, index) => renderBlock(block, `block-${index}`));
}
