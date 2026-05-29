import { describe, it, expect } from "vitest";

import { renderSuggestion } from "./renderSuggestion";
import type { Suggestion } from "../core/types";

const S: Suggestion = {
  diagnosis: "太笼统",
  rewrites: [
    { text: "改写一", basis: "段落1" },
    { text: "改写二", basis: "段落2" },
  ],
  phrasings: [{ text: "措辞一", source: "甲(2020)" }],
};

describe("renderSuggestion", () => {
  it("includes the model-generated warning banner", () => {
    expect(renderSuggestion(S)).toContain("模型生成");
  });

  it("renders one block per rewrite, each with a copy button", () => {
    const html = renderSuggestion(S);
    expect((html.match(/class="rw"/g) || []).length).toBe(2);
    expect((html.match(/class="copy-btn"/g) || []).length).toBe(2);
  });

  it("shows the basis and the phrasing source", () => {
    const html = renderSuggestion(S);
    expect(html).toContain("段落1");
    expect(html).toContain("甲(2020)");
  });

  it("escapes injection in model output", () => {
    const html = renderSuggestion({ ...S, diagnosis: "<script>x</script>" });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
