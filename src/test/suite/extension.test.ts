import * as assert from "node:assert";

import * as vscode from "vscode";

import type { ParlanceApi } from "../../extension";

const EXT_ID = "xwzhangSZU.parlance";
const SAMPLE = "个人信息处理者负有合规义务";

async function getApi(): Promise<ParlanceApi> {
  const ext = vscode.extensions.getExtension<ParlanceApi>(EXT_ID);
  assert.ok(ext, `extension ${EXT_ID} not found`);
  return ext.activate();
}

async function selectAll(content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content, language: "plaintext" });
  const editor = await vscode.window.showTextDocument(doc);
  const end = doc.lineAt(doc.lineCount - 1).range.end;
  editor.selection = new vscode.Selection(0, 0, end.line, end.character);
}

describe("Parlance extension — no API key required", () => {
  it("activates without throwing", async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, "extension is present");
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  it("registers the findSimilarPhrasing command", async () => {
    await getApi();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("parlance.findSimilarPhrasing"),
      "parlance.findSimilarPhrasing should be registered",
    );
  });

  it("registers the generateSuggestions command", async () => {
    await getApi();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("parlance.generateSuggestions"),
      "parlance.generateSuggestions should be registered",
    );
  });

  it("does not throw when run with no selection", async () => {
    await getApi();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    // No active editor → command shows a warning and returns; must not throw.
    await vscode.commands.executeCommand("parlance.findSimilarPhrasing");
  });

  it("enters the error state when zsearchPath is invalid", async () => {
    const api = await getApi();
    const cfg = vscode.workspace.getConfiguration("parlance");
    await cfg.update("zsearchPath", "zsearch-nope-xyz", vscode.ConfigurationTarget.Global);
    try {
      await selectAll(SAMPLE);
      await vscode.commands.executeCommand("parlance.findSimilarPhrasing");
      const state = api.getLastState();
      assert.ok(state, "panel state should be set");
      assert.strictEqual(state.kind, "error", `expected error, got ${state.kind}`);
      assert.ok(state.message && state.message.length > 0, "error has a message");
    } finally {
      await cfg.update("zsearchPath", undefined, vscode.ConfigurationTarget.Global);
    }
  });
});

describe("Parlance golden path — requires GEMINI_API_KEY + a populated index", () => {
  it("returns real passages for a Chinese selection", async function () {
    if (!process.env.GEMINI_API_KEY) {
      console.log("[skip] GEMINI_API_KEY not in env — skipping live golden path");
      this.skip();
    }
    this.timeout(120000);

    const api = await getApi();
    const cfg = vscode.workspace.getConfiguration("parlance");
    await cfg.update("zsearchPath", undefined, vscode.ConfigurationTarget.Global);
    await cfg.update("topK", 5, vscode.ConfigurationTarget.Global);
    try {
      await selectAll(SAMPLE);
      await vscode.commands.executeCommand("parlance.findSimilarPhrasing");
      const state = api.getLastState();
      assert.ok(state, "panel state should be set");
      assert.strictEqual(
        state.kind,
        "results",
        `expected results, got ${state.kind}: ${state.message ?? ""}`,
      );
      assert.ok((state.count ?? 0) >= 1, "at least one passage returned");
    } finally {
      await cfg.update("topK", undefined, vscode.ConfigurationTarget.Global);
    }
  });
});

describe("Parlance suggestions golden path — requires GEMINI_API_KEY", () => {
  it("generates grounded suggestions after a real search", async function () {
    if (!process.env.GEMINI_API_KEY) {
      console.log("[skip] GEMINI_API_KEY not in env — skipping live suggestion path");
      this.skip();
    }
    this.timeout(120000);

    const api = await getApi();
    const cfg = vscode.workspace.getConfiguration("parlance");
    await cfg.update("zsearchPath", undefined, vscode.ConfigurationTarget.Global);
    await cfg.update("topK", 5, vscode.ConfigurationTarget.Global);
    // Pin a reliably-available model so this pipeline test is deterministic: the
    // product default (gemini-3.5-flash) can be transiently 503-overloaded, and
    // the suggestion path itself is model-agnostic.
    await cfg.update("suggestModel", "gemini-2.5-flash", vscode.ConfigurationTarget.Global);
    try {
      await selectAll(SAMPLE);
      await vscode.commands.executeCommand("parlance.findSimilarPhrasing");
      assert.strictEqual(api.getLastState()?.kind, "results", "search produced results");

      // The command fires the handler without awaiting it; poll until it leaves "loading".
      await vscode.commands.executeCommand("parlance.generateSuggestions");
      const start = Date.now();
      while (Date.now() - start < 90000) {
        const cur = api.getLastSuggestionState();
        if (cur && cur.kind !== "loading") break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const st = api.getLastSuggestionState();
      assert.ok(st, "suggestion state set");
      assert.strictEqual(st.kind, "suggestions", `expected suggestions, got ${st.kind}: ${st.message ?? ""}`);
      assert.ok((st.count ?? 0) >= 1, "at least one rewrite");
      assert.strictEqual(st.model, "gemini-2.5-flash", "badge reflects the pinned Gemini model");
    } finally {
      await cfg.update("topK", undefined, vscode.ConfigurationTarget.Global);
      await cfg.update("suggestModel", undefined, vscode.ConfigurationTarget.Global);
    }
  });
});

describe("Parlance Qwen fallback golden path — requires DASHSCOPE_API_KEY", () => {
  it("falls back to Qwen when the Gemini model is unavailable", async function () {
    if (!process.env.DASHSCOPE_API_KEY || !process.env.GEMINI_API_KEY) {
      console.log("[skip] need both GEMINI_API_KEY + DASHSCOPE_API_KEY — skipping Qwen fallback path");
      this.skip();
    }
    this.timeout(120000);

    const api = await getApi();
    const cfg = vscode.workspace.getConfiguration("parlance");
    await cfg.update("zsearchPath", undefined, vscode.ConfigurationTarget.Global);
    await cfg.update("topK", 5, vscode.ConfigurationTarget.Global);
    // Force the Gemini primary to fail (nonexistent model) so the Qwen fallback runs.
    await cfg.update("suggestModel", "gemini-nonexistent-model-xyz", vscode.ConfigurationTarget.Global);
    await cfg.update("fallbackModel", "qwen-plus", vscode.ConfigurationTarget.Global);
    try {
      await selectAll(SAMPLE);
      await vscode.commands.executeCommand("parlance.findSimilarPhrasing");
      assert.strictEqual(api.getLastState()?.kind, "results", "search produced results");

      await vscode.commands.executeCommand("parlance.generateSuggestions");
      const start = Date.now();
      while (Date.now() - start < 90000) {
        const cur = api.getLastSuggestionState();
        if (cur && cur.kind !== "loading") break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const st = api.getLastSuggestionState();
      assert.ok(st, "suggestion state set");
      assert.strictEqual(st.kind, "suggestions", `expected suggestions via Qwen fallback, got ${st.kind}: ${st.message ?? ""}`);
      assert.ok((st.count ?? 0) >= 1, "at least one rewrite from the Qwen fallback");
      assert.strictEqual(st.model, "qwen-plus", "badge reflects the Qwen fallback model");
    } finally {
      await cfg.update("suggestModel", undefined, vscode.ConfigurationTarget.Global);
      await cfg.update("fallbackModel", undefined, vscode.ConfigurationTarget.Global);
      await cfg.update("topK", undefined, vscode.ConfigurationTarget.Global);
    }
  });
});
