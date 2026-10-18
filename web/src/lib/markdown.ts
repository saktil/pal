import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { escapeHtml, highlight } from "./highlight.ts";
import { ICONS } from "./icons.ts";

// Model output is untrusted: no raw HTML, then a sanitizer as the actual boundary.
const markdown = new MarkdownIt({ html: false, linkify: true });
const defaultLink = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index]?.attrSet("target", "_blank");
  tokens[index]?.attrSet("rel", "noopener noreferrer");
  return defaultLink === undefined
    ? renderer.renderToken(tokens, index, options)
    : defaultLink(tokens, index, options, env, renderer);
};

const copyIcon = `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="${ICONS.copy}"/></svg>`;
/** A code block with its language and a Copy button; `codeCopy` in copy.ts handles the click. */
function codeBlock(code: string, info: string): string {
  const language = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return (
    `<div class="code"><div class="codehead"><span>${escapeHtml(language)}</span>` +
    `<button type="button" class="codecopy" data-copy>${copyIcon}<span>Copy</span></button></div>` +
    `<pre><code>${highlight(code.replace(/\n$/, ""), language)}</code></pre></div>`
  );
}
markdown.renderer.rules.fence = (tokens, index) => codeBlock(tokens[index]?.content ?? "", tokens[index]?.info ?? "");
markdown.renderer.rules.code_block = (tokens, index) => codeBlock(tokens[index]?.content ?? "", "");

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(markdown.render(text), { ADD_ATTR: ["target"] });
}
