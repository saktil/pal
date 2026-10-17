import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";

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

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(markdown.render(text), { ADD_ATTR: ["target"] });
}
