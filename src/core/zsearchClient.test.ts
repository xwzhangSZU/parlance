import { describe, it, expect } from "vitest";
import { findPhrases, classifyError, ZsearchClientError } from "./zsearchClient";
import type { CommandRunner, PhraseHit } from "./types";

const HIT: PhraseHit = {
  key: "ABCD", chunk_idx: 0, distance: 0.1, snippet: "你好",
  title: "T", creators: ["Lee, K"], date: "2024", venue: null, doi: null,
};

function runnerReturning(result: { stdout?: string; stderr?: string; code?: number }): CommandRunner {
  return async () => ({ stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0 });
}

describe("findPhrases", () => {
  it("rejects an empty selection", async () => {
    await expect(findPhrases("   ", { zsearchPath: "zsearch", topK: 10 }, runnerReturning({})))
      .rejects.toMatchObject({ kind: "empty-selection" });
  });

  it("parses a JSON array of hits on success", async () => {
    const run = runnerReturning({ stdout: JSON.stringify([HIT]), code: 0 });
    const hits = await findPhrases("测试", { zsearchPath: "zsearch", topK: 10 }, run);
    expect(hits).toEqual([HIT]);
  });

  it("passes the right args to zsearch", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run: CommandRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: "[]", stderr: "", code: 0 };
    };
    await findPhrases("  hello  ", { zsearchPath: "/venv/zsearch", topK: 5 }, run);
    expect(calls[0].cmd).toBe("/venv/zsearch");
    expect(calls[0].args).toEqual(["phrases", "hello", "--json", "-k", "5"]);
  });

  it("classifies a missing binary as not-installed", async () => {
    const run = runnerReturning({ stderr: "ENOENT", code: 127 });
    await expect(findPhrases("x", { zsearchPath: "zsearch", topK: 10 }, run))
      .rejects.toMatchObject({ kind: "not-installed" });
  });

  it("classifies a missing API key as no-api-key", async () => {
    const run = runnerReturning({ stderr: "RuntimeError: GEMINI_API_KEY not set", code: 1 });
    await expect(findPhrases("x", { zsearchPath: "zsearch", topK: 10 }, run))
      .rejects.toMatchObject({ kind: "no-api-key" });
  });

  it("classifies an empty index as no-index", async () => {
    const run = runnerReturning({ stderr: "sqlite3.OperationalError: no such table: items", code: 1 });
    await expect(findPhrases("x", { zsearchPath: "zsearch", topK: 10 }, run))
      .rejects.toMatchObject({ kind: "no-index" });
  });

  it("treats non-JSON stdout as an unknown error", async () => {
    const run = runnerReturning({ stdout: "not json", code: 0 });
    await expect(findPhrases("x", { zsearchPath: "zsearch", topK: 10 }, run))
      .rejects.toMatchObject({ kind: "unknown" });
  });
});

describe("classifyError", () => {
  it("returns a ZsearchClientError", () => {
    expect(classifyError("command not found")).toBeInstanceOf(ZsearchClientError);
  });
});
