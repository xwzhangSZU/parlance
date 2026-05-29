import { describe, it, expect } from "vitest";

import { buildPrompt, generateSuggestions, isTransientGeminiError, SuggestError, withRetry } from "./suggestClient";
import type { GeminiGenerator, PhraseHit, Suggestion } from "./types";

const HITS: PhraseHit[] = [
  { key: "A", chunk_idx: 0, distance: 0.1, snippet: "学者甲的段落", title: "论甲", creators: ["甲, A"], date: "2020", venue: "X", doi: null },
  { key: "B", chunk_idx: 1, distance: 0.2, snippet: "学者乙的段落", title: "论乙", creators: ["乙, B"], date: "2021", venue: null, doi: null },
];
const GOOD: Suggestion = {
  diagnosis: "太笼统",
  rewrites: [{ text: "改写一", basis: "段落1" }],
  phrasings: [{ text: "措辞一", source: "甲(2020)" }],
};
const CFG = { model: "gemini-2.5-flash", maxPassages: 6, apiKey: "k" };

const genReturning = (s: string): GeminiGenerator => async () => s;

describe("generateSuggestions", () => {
  it("rejects empty hits as no-hits", async () => {
    await expect(generateSuggestions("x", [], CFG, genReturning("{}")))
      .rejects.toMatchObject({ kind: "no-hits" });
  });

  it("rejects a missing apiKey as no-api-key", async () => {
    await expect(generateSuggestions("x", HITS, { ...CFG, apiKey: undefined }, genReturning("{}")))
      .rejects.toMatchObject({ kind: "no-api-key" });
  });

  it("parses a valid suggestion", async () => {
    const out = await generateSuggestions("x", HITS, CFG, genReturning(JSON.stringify(GOOD)));
    expect(out).toEqual(GOOD);
  });

  it("classifies non-JSON as bad-output", async () => {
    await expect(generateSuggestions("x", HITS, CFG, genReturning("not json")))
      .rejects.toMatchObject({ kind: "bad-output" });
  });

  it("classifies an incomplete structure as bad-output", async () => {
    await expect(generateSuggestions("x", HITS, CFG, genReturning(JSON.stringify({ diagnosis: "d" }))))
      .rejects.toMatchObject({ kind: "bad-output" });
  });

  it("classifies a generator throw as network", async () => {
    const gen: GeminiGenerator = async () => { throw new Error("boom"); };
    await expect(generateSuggestions("x", HITS, CFG, gen)).rejects.toMatchObject({ kind: "network" });
  });

  it("classifies an auth failure from the generator as no-api-key", async () => {
    const gen: GeminiGenerator = async () => { throw { status: 403, message: "permission denied" }; };
    await expect(generateSuggestions("x", HITS, CFG, gen)).rejects.toMatchObject({ kind: "no-api-key" });
  });

  it("feeds the sentence and the passages into the prompt", async () => {
    let seen = "";
    const gen: GeminiGenerator = async (req) => { seen = req.prompt; return JSON.stringify(GOOD); };
    await generateSuggestions("我的草稿句", HITS, CFG, gen);
    expect(seen).toContain("我的草稿句");
    expect(seen).toContain("学者甲的段落");
    expect(seen).toContain("段落1");
  });
});

describe("buildPrompt", () => {
  it("caps the number of passages", () => {
    const many: PhraseHit[] = Array.from({ length: 10 }, (_, i) => ({ ...HITS[0], snippet: `P${i}` }));
    const p = buildPrompt("s", many, 3);
    expect(p).toContain("段落3");
    expect(p).not.toContain("段落4");
  });

  it("truncates long snippets", () => {
    const long: PhraseHit[] = [{ ...HITS[0], snippet: "字".repeat(2000) }];
    const p = buildPrompt("s", long, 6);
    expect(p).toContain("…");
    expect(p).not.toContain("字".repeat(1000));
  });
});

describe("isTransientGeminiError", () => {
  it("treats 5xx/429 status as transient", () => {
    expect(isTransientGeminiError({ status: 503 })).toBe(true);
    expect(isTransientGeminiError({ status: 429 })).toBe(true);
    expect(isTransientGeminiError({ status: 500 })).toBe(true);
  });

  it("treats UNAVAILABLE / fetch failures as transient", () => {
    expect(isTransientGeminiError({ message: "503 UNAVAILABLE high demand" })).toBe(true);
    expect(isTransientGeminiError({ message: "fetch failed" })).toBe(true);
  });

  it("treats 400 and generic errors as non-transient", () => {
    expect(isTransientGeminiError({ status: 400 })).toBe(false);
    expect(isTransientGeminiError(new Error("boom"))).toBe(false);
  });
});

describe("withRetry", () => {
  const noSleep = async () => {};

  it("retries a transient failure then succeeds", async () => {
    let n = 0;
    const fn = async () => {
      n++;
      if (n < 3) throw { status: 503 };
      return "ok";
    };
    const out = await withRetry(fn, { attempts: 3, isTransient: isTransientGeminiError, delayMs: () => 0, sleep: noSleep });
    expect(out).toBe("ok");
    expect(n).toBe(3);
  });

  it("gives up after the attempt budget on persistent transient errors", async () => {
    let n = 0;
    const fn = async () => {
      n++;
      throw { status: 503 };
    };
    await expect(
      withRetry(fn, { attempts: 3, isTransient: isTransientGeminiError, delayMs: () => 0, sleep: noSleep }),
    ).rejects.toMatchObject({ status: 503 });
    expect(n).toBe(3);
  });

  it("does not retry a non-transient error", async () => {
    let n = 0;
    const fn = async () => {
      n++;
      throw new Error("boom");
    };
    await expect(
      withRetry(fn, { attempts: 3, isTransient: isTransientGeminiError, delayMs: () => 0, sleep: noSleep }),
    ).rejects.toThrow("boom");
    expect(n).toBe(1);
  });
});
