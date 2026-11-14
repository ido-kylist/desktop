import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseMarkdown, renderMarkdown } from "../../src/renderer/src/lib/markdown.js";

/**
 * The renderer is exercised for real (React → string), not only the tokenizer: the
 * injection guarantee is about what ends up as markup, so that is what is asserted.
 */
function render(input: string): string {
  return renderToStaticMarkup(createElement("div", null, renderMarkdown(input)));
}

describe("markdown: blocks", () => {
  it("renders plain text as a paragraph", () => {
    expect(render("Hello there.")).toBe("<div><p>Hello there.</p></div>");
  });

  it("splits paragraphs on blank lines and keeps a single newline as a line break", () => {
    const html = render("first line\nsecond line\n\nsecond paragraph");
    expect(html).toBe("<div><p>first line<br/>second line</p><p>second paragraph</p></div>");
  });

  it("renders unordered and ordered lists", () => {
    expect(render("- one\n- two")).toBe("<div><ul><li>one</li><li>two</li></ul></div>");
    expect(render("1. first\n2. second")).toBe("<div><ol><li>first</li><li>second</li></ol></div>");
  });
});

describe("markdown: inline", () => {
  it("nests inline code inside bold", () => {
    const html = render("**bold with `code` inside**");
    expect(html).toBe("<div><p><strong>bold with <code>code</code> inside</strong></p></div>");
  });

  it("renders italic and hidden emphasis in ordinary text literally", () => {
    expect(render("*slow* answer")).toBe("<div><p><em>slow</em> answer</p></div>");
    // `2 * 3` is arithmetic, not an italic run.
    expect(render("2 * 3")).toBe("<div><p>2 * 3</p></div>");
  });

  it("renders http and mailto links and refuses a script scheme", () => {
    expect(render("[docs](https://example.com/a)")).toContain(
      '<a href="https://example.com/a" target="_blank" rel="noreferrer noopener">docs</a>',
    );

    const unsafe = render("[click](javascript:alert(1))");
    expect(unsafe).not.toContain("<a ");
    expect(unsafe).toContain("click");
    expect(unsafe).toContain("(javascript:alert(1))");
  });

  it("leaves an unclosed marker literal instead of swallowing the rest", () => {
    expect(render("a ** b and ` c")).toBe("<div><p>a ** b and ` c</p></div>");
  });
});

describe("markdown: fenced code", () => {
  it("captures a closed fence with its language", () => {
    const blocks = parseMarkdown("```ts\nconst x = 1;\n```");
    expect(blocks).toEqual([{ type: "code", lang: "ts", value: "const x = 1;" }]);
  });

  it("renders an unterminated fence as a code block (the stream has not finished)", () => {
    const blocks = parseMarkdown("```js\nconst x = 1;");
    expect(blocks).toEqual([{ type: "code", lang: "js", value: "const x = 1;" }]);

    const html = render("```js\nconst x = 1;");
    expect(html).toContain('<pre><code class="language-js">const x = 1;</code></pre>');
  });

  it("renders a long code block whole, without truncation", () => {
    const body = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n");
    const html = render(`\`\`\`\n${body}\n\`\`\``);

    expect(html.startsWith("<div><pre><code>")).toBe(true);
    expect(html.endsWith("</code></pre></div>")).toBe(true);
    expect(html).toContain("line 1\n");
    expect(html).toContain("line 200");
    expect(html.match(/<pre>/g)).toHaveLength(1);
  });
});

describe("markdown: injection", () => {
  it("renders an HTML payload as literal text, never as an element", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const html = render(payload);

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // The payload is text inside the paragraph, not an attribute or a tag.
    expect(html).toBe(`<div><p>${"&lt;img src=x onerror=alert(1)&gt;"}</p></div>`);
  });

  it("escapes HTML inside a fenced code block too", () => {
    const html = render("```\n<script>alert(1)</script>\n```");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
