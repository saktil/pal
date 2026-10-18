import { describe, expect, it } from "vitest";
import { highlight } from "../web/src/lib/highlight.ts";

const plain = (html: string) =>
  html
    .replaceAll(/<\/?span[^>]*>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
const spans = (html: string) =>
  [...html.matchAll(/<span class="hl-(\w)">([^<]*)<\/span>/g)].map((m) => `${m[1]}:${m[2]}`);

describe("code highlighting", () => {
  it("never changes or unescapes the code, in any language", () => {
    const samples: [string, string][] = [
      ["go", 'package main\n\nfunc main() {\n\tfmt.Println("<b>&") // done\n}'],
      ["html", '<a href="x">it\'s > 3 & <b>bold</b></a><!-- open'],
      ["bash", '$ FOO=1 make && echo "$HOME" # <tag>'],
      ["sql", "SELECT 'it''s' FROM t -- <x>"],
      ["unknown", "<script>alert(1)</script>"],
      ["", "a < b"],
    ];
    for (const [language, code] of samples) {
      const html = highlight(code, language);
      expect(plain(html)).toBe(code);
      expect(html.replaceAll(/<\/?span[^>]*>/g, "")).not.toMatch(/[<>]/);
    }
  });

  it("colors keywords, strings, numbers, comments, calls and types", () => {
    expect(spans(highlight('func main() { x := http.Server{Addr: ":80"}; return nil } // hi', "go"))).toEqual([
      "k:func",
      "f:main",
      "t:Server",
      "t:Addr",
      's:":80"',
      "k:return",
      "n:nil",
      "c:// hi",
    ]);
    expect(spans(highlight('{"ok": true, "n": 2}', "json"))).toEqual(['p:"ok"', "n:true", 'p:"n"', "n:2"]);
    expect(spans(highlight("SELECT count(*) FROM t", "sql"))).toEqual(["k:SELECT", "f:count", "k:FROM"]);
  });

  it("treats members as names and keeps unfinished strings to one line while code streams in", () => {
    expect(spans(highlight("map.get(key); event.type", "ts"))).toEqual(["f:get"]);
    expect(spans(highlight('const a = "open\nconst b = 1', "js"))).toEqual(["k:const", 's:"open', "k:const", "n:1"]);
  });

  it("resolves aliases and ignores names that are not languages", () => {
    expect(highlight("let x = 1", "TypeScript")).toContain("hl-k");
    expect(highlight("x", "constructor")).toBe("x");
    expect(highlight("x", "__proto__")).toBe("x");
  });
});
