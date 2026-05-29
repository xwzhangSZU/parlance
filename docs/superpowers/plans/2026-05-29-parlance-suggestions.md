# Parlance 迭代 2 — grounded 改写建议 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Parlance 面板里加一个按需「✍ 生成改写建议」功能:把用户句子 + 已检索段落交给 Gemini,返回 grounded 的诊断 + 带出处改写 + 可借用措辞,渲染在段落上方并标注"模型生成"。

**Architecture:** 纯前端增量(不改 zsearch)。检索仍由 `zsearchClient.findPhrases` 负责;新增 `suggestClient.generateSuggestions(text, hits, cfg, gen?)` 用 `@google/genai` 调 Gemini(transport 可注入,单测不联网),`renderSuggestion` 出 HTML,`PanelProvider` 保留 `lastQuery` 并新增 suggestion 状态机,`extension.ts` 注册命令并接线。只复制、不自动改用户正文。

**Tech Stack:** TypeScript + esbuild + vitest + jsdom(已在用)+ `@vscode/test-cli`(已在用)+ `@google/genai@^2.7.0`(已安装,esbuild 直接打包进 `dist/extension.js`,bundle 约 1.5MB,esbuild 仅给 size ⚠️ 非 error)。

**Spec:** `docs/superpowers/specs/2026-05-29-parlance-suggestions-design.md`

**已验证前置(planning 阶段 live-verify):**
- `@google/genai@2.7.0` API:`new GoogleGenAI({apiKey})` · `ai.models.generateContent({model, contents, config})` · `config.{systemInstruction, responseMimeType:"application/json", responseSchema(用 Type 枚举), temperature}` · response 取 `.text`(getter,`string | undefined`)。
- 默认模型 `gemini-2.5-flash`(已用用户 key 的 models 列表确认可用;`gemini-3.5-flash`/`gemini-2.5-pro` 亦可,留作 config 覆盖)。
- esbuild `--bundle --platform=node` 能干净打包 `@google/genai`。

**Contracts(全程一致):**
```ts
Suggestion = { diagnosis: string; rewrites: {text:string; basis:string}[]; phrasings: {text:string; source:string}[] }
SuggestConfig = { model: string; maxPassages: number; apiKey: string | undefined }
GeminiRequest = { apiKey: string; model: string; systemInstruction: string; prompt: string }
GeminiGenerator = (req: GeminiRequest) => Promise<string>   // 返回原始 JSON 文本
SuggestErrorKind = "no-api-key" | "no-hits" | "network" | "bad-output" | "unknown"
SuggestionState = { kind: "loading" | "suggestions" | "error"; count?: number; message?: string }
```
新命令 id `parlance.generateSuggestions`;新配置 `parlance.suggestModel`(默认 `gemini-2.5-flash`)、`parlance.suggestMaxPassages`(默认 6)。webview↔扩展消息新增:`suggest`(webview→ext)、`suggestion-loading`/`suggestions`/`suggestion-error`(ext→webview);`results` 消息新增 `count` 字段。

---

## Task 1: Suggestion 类型 + suggestClient(TDD,核心)

**Files:**
- Modify: `src/core/types.ts`(追加类型)
- Create: `src/core/suggestClient.ts`
- Test: `src/core/suggestClient.test.ts`
- 依赖:`@google/genai`(已在 `dependencies`;若缺:`npm install @google/genai@^2.7.0`)

- [ ] **Step 1: 追加类型到 `src/core/types.ts`**(在文件末尾追加)

```ts
export type SuggestErrorKind = "no-api-key" | "no-hits" | "network" | "bad-output" | "unknown";

export interface Suggestion {
  diagnosis: string;
  rewrites: { text: string; basis: string }[];
  phrasings: { text: string; source: string }[];
}

export interface SuggestConfig {
  model: string;
  maxPassages: number;
  apiKey: string | undefined;
}

export interface GeminiRequest {
  apiKey: string;
  model: string;
  systemInstruction: string;
  prompt: string;
}

export type GeminiGenerator = (req: GeminiRequest) => Promise<string>;
```

- [ ] **Step 2: 写失败测试 `src/core/suggestClient.test.ts`**

```ts
import { describe, it, expect } from "vitest";

import { buildPrompt, generateSuggestions, SuggestError } from "./suggestClient";
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
```

- [ ] **Step 3: 运行,确认失败**

Run: `npx vitest run src/core/suggestClient.test.ts`
Expected: FAIL — `Failed to resolve import "./suggestClient"`.

- [ ] **Step 4: 实现 `src/core/suggestClient.ts`**

```ts
import { GoogleGenAI, Type } from "@google/genai";

import type {
  GeminiGenerator,
  GeminiRequest,
  PhraseHit,
  Suggestion,
  SuggestConfig,
  SuggestErrorKind,
} from "./types";

const SNIPPET_CHAR_CAP = 800;

export class SuggestError extends Error {
  constructor(public kind: SuggestErrorKind, message: string) {
    super(message);
    this.name = "SuggestError";
  }
}

export const SYSTEM_INSTRUCTION = [
  "你是中文法学/社科学术写作助手。",
  "只能基于用户提供的句子和检索到的段落作答,不得发明法条号、出处、作者、年份、事实或段落中没有的内容。",
  "每条改写在 basis 注明依据的段落编号(如「段落2」)或出处;每条可借用措辞在 source 注明出处。",
  "若所给段落不足以支撑某改写,在 diagnosis 中诚实说明,而不是编造。",
  "用简体中文输出,且严格遵循给定的 JSON 结构。",
].join("\n");

const SUGGESTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    diagnosis: { type: Type.STRING },
    rewrites: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { text: { type: Type.STRING }, basis: { type: Type.STRING } },
        required: ["text", "basis"],
      },
    },
    phrasings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { text: { type: Type.STRING }, source: { type: Type.STRING } },
        required: ["text", "source"],
      },
    },
  },
  required: ["diagnosis", "rewrites", "phrasings"],
};

function sourceLabel(h: PhraseHit): string {
  const author = h.creators[0] ?? "佚名";
  const etal = h.creators.length > 1 ? " 等" : "";
  const year = h.date ? h.date.match(/\b(19|20)\d{2}\b/)?.[0] ?? "" : "";
  const title = h.title ?? "<无题>";
  return `${author}${etal}${year ? `(${year})` : ""}·${title}`;
}

export function buildPrompt(text: string, hits: PhraseHit[], maxPassages: number): string {
  const passages = hits.slice(0, maxPassages).map((h, i) => {
    const snippet =
      h.snippet.length > SNIPPET_CHAR_CAP ? `${h.snippet.slice(0, SNIPPET_CHAR_CAP)}…` : h.snippet;
    return `段落${i + 1}(${sourceLabel(h)}):\n${snippet}`;
  });
  return [
    `【我的句子】\n${text}`,
    `【检索到的学者段落】\n${passages.join("\n\n")}`,
    "【任务】基于上面的段落,给出:诊断(我的句子的问题)、2-3 条改写(每条注明依据哪段)、可借用的措辞/搭配(注明出处)。",
  ].join("\n\n");
}

export const defaultGenerator: GeminiGenerator = async (req: GeminiRequest): Promise<string> => {
  const ai = new GoogleGenAI({ apiKey: req.apiKey });
  const resp = await ai.models.generateContent({
    model: req.model,
    contents: req.prompt,
    config: {
      systemInstruction: req.systemInstruction,
      responseMimeType: "application/json",
      responseSchema: SUGGESTION_SCHEMA,
      temperature: 0.4,
    },
  });
  return resp.text ?? "";
};

function isRewrite(r: unknown): r is { text: string; basis: string } {
  return (
    typeof r === "object" &&
    r !== null &&
    typeof (r as { text?: unknown }).text === "string" &&
    typeof (r as { basis?: unknown }).basis === "string"
  );
}

function isPhrasing(p: unknown): p is { text: string; source: string } {
  return (
    typeof p === "object" &&
    p !== null &&
    typeof (p as { text?: unknown }).text === "string" &&
    typeof (p as { source?: unknown }).source === "string"
  );
}

function parseSuggestion(raw: string): Suggestion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SuggestError("bad-output", "模型返回的不是有效 JSON,请重试。");
  }
  const o = parsed as Record<string, unknown>;
  if (
    typeof o.diagnosis !== "string" ||
    !Array.isArray(o.rewrites) ||
    !o.rewrites.every(isRewrite) ||
    !Array.isArray(o.phrasings) ||
    !o.phrasings.every(isPhrasing)
  ) {
    throw new SuggestError("bad-output", "模型返回的结构不完整,请重试。");
  }
  return parsed as Suggestion;
}

export async function generateSuggestions(
  text: string,
  hits: PhraseHit[],
  cfg: SuggestConfig,
  gen: GeminiGenerator = defaultGenerator,
): Promise<Suggestion> {
  if (!hits.length) {
    throw new SuggestError("no-hits", "请先检索到相近段落,再生成改写建议。");
  }
  if (!cfg.apiKey) {
    throw new SuggestError(
      "no-api-key",
      "缺少 GEMINI_API_KEY,无法生成建议(检索不受影响)。请在能读到该变量的环境里启动 VS Code。",
    );
  }
  const prompt = buildPrompt(text, hits, cfg.maxPassages);
  let raw: string;
  try {
    raw = await gen({ apiKey: cfg.apiKey, model: cfg.model, systemInstruction: SYSTEM_INSTRUCTION, prompt });
  } catch {
    throw new SuggestError("network", "调用 Gemini 失败(网络或服务错误),请重试。");
  }
  return parseSuggestion(raw);
}
```

- [ ] **Step 5: 运行,确认通过**

Run: `npx vitest run src/core/suggestClient.test.ts`
Expected: PASS (9 passed)。

- [ ] **Step 6: typecheck**

Run: `npm run typecheck`
Expected: exit 0。

- [ ] **Step 7: Commit**

```bash
git add src/core/types.ts src/core/suggestClient.ts src/core/suggestClient.test.ts package.json package-lock.json
git commit -m "feat(core): add Gemini suggestClient with grounded prompt + JSON parsing"
```

---

## Task 2: renderSuggestion(TDD,纯 HTML)

**Files:**
- Create: `src/webview/renderSuggestion.ts`
- Test: `src/webview/renderSuggestion.test.ts`

- [ ] **Step 1: 写失败测试 `src/webview/renderSuggestion.test.ts`**

```ts
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
```

- [ ] **Step 2: 运行,确认失败**

Run: `npx vitest run src/webview/renderSuggestion.test.ts`
Expected: FAIL — `Failed to resolve import "./renderSuggestion"`.

- [ ] **Step 3: 实现 `src/webview/renderSuggestion.ts`**

```ts
import { escapeHtml } from "./render";
import type { Suggestion } from "../core/types";

export function renderSuggestion(s: Suggestion): string {
  const rewrites = s.rewrites
    .map((r) => {
      const text = escapeHtml(r.text);
      const basis = escapeHtml(r.basis);
      return `
      <div class="rw">
        <div class="rw-text">${text}</div>
        <div class="rw-basis">← ${basis}</div>
        <button class="copy-btn" data-copy="${text}">复制</button>
      </div>`;
    })
    .join("\n");
  const phrasings = s.phrasings
    .map((p) => `<li>${escapeHtml(p.text)} <span class="src">— ${escapeHtml(p.source)}</span></li>`)
    .join("\n");
  return `
    <div class="suggestion">
      <div class="sg-warn">⚠ 模型生成,请核验</div>
      <div class="sg-sec"><div class="sg-h">诊断</div><div class="sg-diag">${escapeHtml(s.diagnosis)}</div></div>
      <div class="sg-sec"><div class="sg-h">改写</div>${rewrites}</div>
      <div class="sg-sec"><div class="sg-h">可借用措辞</div><ul class="sg-ph">${phrasings}</ul></div>
    </div>`;
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `npx vitest run src/webview/renderSuggestion.test.ts`
Expected: PASS (4 passed)。

- [ ] **Step 5: Commit**

```bash
git add src/webview/renderSuggestion.ts src/webview/renderSuggestion.test.ts
git commit -m "feat(webview): add renderSuggestion (escaped HTML for the suggestion block)"
```

---

## Task 3: 面板脚本与样式(TDD via jsdom)

**Files:**
- Modify: `media/panel.js`
- Modify: `media/panel.css`(追加样式)
- Test: `src/webview/panel.dom.test.ts`(追加用例)

- [ ] **Step 1: 在 `src/webview/panel.dom.test.ts` 末尾追加用例**(放在文件最后一个 `describe` 之后)

```ts
describe("panel.js — suggestions", () => {
  it("shows the suggest button when results have hits and posts suggest on click", () => {
    const { postMessage, root } = loadPanel("");
    postToWebview({ type: "results", html: '<div class="hit">HIT</div>', count: 1 });
    const btn = root.querySelector("#suggest-btn");
    expect(btn, "suggest button rendered").toBeTruthy();
    click(btn!);
    expect(postMessage).toHaveBeenCalledWith({ type: "suggest" });
  });

  it("hides the suggest button when there are no hits", () => {
    const { root } = loadPanel("");
    postToWebview({ type: "results", html: '<div class="empty">none</div>', count: 0 });
    expect(root.querySelector("#suggest-btn")).toBeNull();
  });

  it("fills the suggest slot, leaving the hits intact", () => {
    const { root } = loadPanel("");
    postToWebview({ type: "results", html: '<div class="hit">HIT</div>', count: 1 });
    postToWebview({ type: "suggestions", html: '<div class="suggestion">SG</div>' });
    expect(root.querySelector("#suggest-slot")?.textContent).toContain("SG");
    expect(root.querySelector("#hits")?.textContent).toContain("HIT");
  });

  it("renders a suggestion error as text, never as HTML (XSS-safe)", () => {
    const { root } = loadPanel("");
    postToWebview({ type: "results", html: '<div class="hit">x</div>', count: 1 });
    postToWebview({ type: "suggestion-error", message: "<script>boom</script>" });
    expect(root.querySelector("#suggest-slot script")).toBeNull();
    expect(root.querySelector("#suggest-slot .error")?.textContent).toBe("<script>boom</script>");
  });
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `npx vitest run src/webview/panel.dom.test.ts`
Expected: FAIL — 新用例失败(现 `panel.js` 不渲染 `#suggest-btn`、不处理 `suggestions`/`suggestion-error` 消息;旧 5 个用例仍应通过)。

- [ ] **Step 3: 重写 `media/panel.js`**(完整替换文件内容)

```javascript
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");

  function slot() {
    return document.getElementById("suggest-slot");
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "loading") {
      root.innerHTML = '<div class="loading">检索中…</div>';
    } else if (msg.type === "results") {
      const bar =
        msg.count > 0
          ? '<div class="suggest-bar"><button id="suggest-btn">✍ 生成改写建议</button></div>'
          : "";
      root.innerHTML = bar + '<div id="suggest-slot"></div><div id="hits">' + msg.html + "</div>";
    } else if (msg.type === "error") {
      const d = document.createElement("div");
      d.className = "error";
      d.textContent = msg.message;
      root.replaceChildren(d);
    } else if (msg.type === "suggestion-loading") {
      const s = slot();
      if (s) s.innerHTML = '<div class="loading">生成建议中…</div>';
    } else if (msg.type === "suggestions") {
      const s = slot();
      if (s) s.innerHTML = msg.html;
    } else if (msg.type === "suggestion-error") {
      const s = slot();
      if (s) {
        const d = document.createElement("div");
        d.className = "error";
        d.textContent = msg.message;
        s.replaceChildren(d);
      }
    }
  });

  root.addEventListener("click", (e) => {
    const target = e.target;
    if (target.id === "suggest-btn") {
      const s = slot();
      if (s) s.innerHTML = '<div class="loading">生成建议中…</div>';
      vscode.postMessage({ type: "suggest" });
    } else if (target.classList.contains("copy-btn")) {
      vscode.postMessage({ type: "copy", text: target.getAttribute("data-copy") });
    } else if (target.classList.contains("jump-btn")) {
      vscode.postMessage({ type: "jump", key: target.getAttribute("data-key") });
    }
  });
})();
```

- [ ] **Step 4: 运行,确认通过**

Run: `npx vitest run src/webview/panel.dom.test.ts`
Expected: PASS(原 5 + 新 4 = 9 passed)。

- [ ] **Step 5: 在 `media/panel.css` 末尾追加样式**

```css
.suggest-bar { margin: 0 0 10px; }
#suggest-btn { background: var(--pl-accent); color: var(--pl-bg); border: none; border-radius: 4px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
#suggest-btn:hover { opacity: 0.9; }
.suggestion { border: 1px solid var(--pl-border); border-radius: 6px; padding: 10px; margin-bottom: 12px; }
.sg-warn { color: var(--vscode-editorWarning-foreground, #f9e2af); font-size: 11px; margin-bottom: 8px; }
.sg-sec { margin-bottom: 10px; }
.sg-h { font-weight: 600; font-size: 12px; color: var(--pl-muted); margin-bottom: 4px; }
.sg-diag { line-height: 1.6; }
.rw { border-left: 3px solid var(--pl-accent); padding: 0 0 0 10px; margin-bottom: 8px; }
.rw-text { line-height: 1.6; white-space: pre-wrap; }
.rw-basis { color: var(--pl-muted); font-size: 12px; margin: 2px 0 4px; }
.sg-ph { margin: 0; padding-left: 18px; line-height: 1.7; }
.sg-ph .src { color: var(--pl-muted); font-size: 12px; }
```

- [ ] **Step 6: Commit**

```bash
git add media/panel.js media/panel.css src/webview/panel.dom.test.ts
git commit -m "feat(webview): suggest button + suggestion-slot rendering in panel.js"
```

---

## Task 4: 配置与贡献点(glue)

**Files:**
- Modify: `src/core/config.ts`
- Modify: `package.json`(配置 + 命令)

- [ ] **Step 1: 在 `src/core/config.ts` 追加 `readSuggestConfig`**

在现有 import 行追加 `SuggestConfig`:
```ts
import type { ParlanceConfig, SuggestConfig } from "./types";
```
在文件末尾追加:
```ts
export function readSuggestConfig(): SuggestConfig {
  const c = vscode.workspace.getConfiguration("parlance");
  return {
    model: c.get<string>("suggestModel", "gemini-2.5-flash"),
    maxPassages: c.get<number>("suggestMaxPassages", 6),
    apiKey: process.env.GEMINI_API_KEY,
  };
}
```

- [ ] **Step 2: `package.json` — 加命令**(`contributes.commands` 数组追加一项)

```json
{ "command": "parlance.generateSuggestions", "title": "Parlance: 生成改写建议" }
```

- [ ] **Step 3: `package.json` — 加配置**(`contributes.configuration.properties` 追加两项)

```json
"parlance.suggestModel": {
  "type": "string",
  "default": "gemini-2.5-flash",
  "description": "生成改写建议的 Gemini 模型(可改 gemini-3.5-flash / gemini-2.5-pro 等)"
},
"parlance.suggestMaxPassages": {
  "type": "number",
  "default": 6,
  "description": "喂给模型的检索段落数上限"
}
```

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: exit 0。

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts package.json
git commit -m "feat(config): add suggestModel/suggestMaxPassages + generateSuggestions command"
```

---

## Task 5: PanelProvider 状态机 + extension 接线(glue)

**Files:**
- Modify: `src/providers/panelProvider.ts`(完整替换)
- Modify: `src/extension.ts`(完整替换)

- [ ] **Step 1: 完整替换 `src/providers/panelProvider.ts`**

```ts
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { renderHits } from "../webview/render";
import { renderSuggestion } from "../webview/renderSuggestion";
import type { PhraseHit, Suggestion } from "../core/types";

/**
 * Read-only snapshot of the panel's last state. Exposed purely for
 * integration tests (the webview DOM is not reachable from the test host);
 * production code only writes it and never reads it back.
 */
export interface PanelState {
  kind: "loading" | "results" | "error";
  count?: number;
  message?: string;
}

/** Read-only snapshot of the suggestion sub-panel state (for tests). */
export interface SuggestionState {
  kind: "loading" | "suggestions" | "error";
  count?: number;
  message?: string;
}

export class PanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "parlance.results";
  public lastState?: PanelState;
  public lastSuggestionState?: SuggestionState;
  private view?: vscode.WebviewView;
  private pending?: { type: string; [k: string]: unknown };
  private lastQuery?: { text: string; hits: PhraseHit[] };
  private suggestionHandler?: (text: string, hits: PhraseHit[]) => void | Promise<void>;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setSuggestionHandler(fn: (text: string, hits: PhraseHit[]) => void | Promise<void>): void {
    this.suggestionHandler = fn;
  }

  /** Invoke the wired suggestion handler with the last query (webview button or command). */
  requestSuggestions(): void {
    if (this.lastQuery) {
      void this.suggestionHandler?.(this.lastQuery.text, this.lastQuery.hits);
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.shell(view.webview);
    view.webview.onDidReceiveMessage((msg) => {
      if (msg.type === "copy") {
        void vscode.env.clipboard.writeText(msg.text);
        void vscode.window.showInformationMessage("已复制到剪贴板");
      } else if (msg.type === "jump") {
        void vscode.env.openExternal(vscode.Uri.parse(`zotero://select/library/items/${msg.key}`));
      } else if (msg.type === "suggest") {
        this.requestSuggestions();
      }
    });
    if (this.pending) {
      void view.webview.postMessage(this.pending);
      this.pending = undefined;
    }
  }

  showLoading(): void {
    this.lastState = { kind: "loading" };
    this.post({ type: "loading" });
  }

  showResults(text: string, hits: PhraseHit[]): void {
    this.lastQuery = { text, hits };
    this.lastSuggestionState = undefined;
    this.lastState = { kind: "results", count: hits.length };
    this.post({ type: "results", html: renderHits(hits), count: hits.length });
  }

  showError(message: string): void {
    this.lastState = { kind: "error", message };
    this.post({ type: "error", message });
  }

  showSuggestionLoading(): void {
    this.lastSuggestionState = { kind: "loading" };
    this.post({ type: "suggestion-loading" });
  }

  showSuggestions(s: Suggestion): void {
    this.lastSuggestionState = { kind: "suggestions", count: s.rewrites.length };
    this.post({ type: "suggestions", html: renderSuggestion(s) });
  }

  showSuggestionError(message: string): void {
    this.lastSuggestionState = { kind: "error", message };
    this.post({ type: "suggestion-error", message });
  }

  private post(message: { type: string; [k: string]: unknown }): void {
    if (this.view) {
      this.view.show?.(true);
      void this.view.webview.postMessage(message);
    } else {
      // View not resolved yet: stash and trigger resolution; resolveWebviewView flushes it.
      this.pending = message;
      void vscode.commands.executeCommand("parlance.results.focus");
    }
  }

  private shell(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "panel.css"));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "panel.js"));
    const nonce = randomUUID().replace(/-/g, "");
    return `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${cssUri}" rel="stylesheet" />
</head>
<body>
  <div id="root"><div class="empty">选中一段文字,运行「Parlance: 查找相近表达」。</div></div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}
```

> 关键改动:`showResults(text, hits)`(签名加 `text`,保留 `lastQuery`、重置 `lastSuggestionState`、`results` 消息带 `count`);`pending` 缓存的"View 未就绪先 stash"行为保持不变(suggestion 消息同样经 `post()`,未就绪时仍会 stash 最后一条)。

- [ ] **Step 2: 完整替换 `src/extension.ts`**

```ts
import * as vscode from "vscode";
import { PanelProvider } from "./providers/panelProvider";
import type { PanelState, SuggestionState } from "./providers/panelProvider";
import { readConfig, readSuggestConfig } from "./core/config";
import { findPhrases } from "./core/zsearchClient";
import { generateSuggestions, SuggestError } from "./core/suggestClient";

/** Public API returned by activate(), consumed by integration tests. */
export interface ParlanceApi {
  getLastState(): PanelState | undefined;
  getLastSuggestionState(): SuggestionState | undefined;
}

export function activate(context: vscode.ExtensionContext): ParlanceApi {
  const provider = new PanelProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PanelProvider.viewType, provider),
  );

  provider.setSuggestionHandler(async (text, hits) => {
    provider.showSuggestionLoading();
    try {
      const suggestion = await generateSuggestions(text, hits, readSuggestConfig());
      provider.showSuggestions(suggestion);
    } catch (e) {
      const message = e instanceof SuggestError ? e.message : String(e);
      provider.showSuggestionError(message);
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("parlance.findSimilarPhrasing", async () => {
      const editor = vscode.window.activeTextEditor;
      const selection = editor?.document.getText(editor.selection).trim();
      if (!selection) {
        void vscode.window.showWarningMessage("请先选中要检索的文本。");
        return;
      }
      provider.showLoading();
      try {
        const hits = await findPhrases(selection, readConfig());
        provider.showResults(selection, hits);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        provider.showError(message);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("parlance.generateSuggestions", () => {
      provider.requestSuggestions();
    }),
  );

  return {
    getLastState: () => provider.lastState,
    getLastSuggestionState: () => provider.lastSuggestionState,
  };
}

export function deactivate(): void {}
```

- [ ] **Step 3: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: typecheck exit 0;build 产出 `dist/extension.js`(因打包进 `@google/genai`,体积约 **1.5MB**,esbuild 给一条 size ⚠️ 提示,非 error)。

- [ ] **Step 4: 全量 vitest 回归**

Run: `npm test`
Expected: PASS — render 8 + zsearchClient 9 + panel.dom 9 + suggestClient 9 + renderSuggestion 4 = **39 passed**。

- [ ] **Step 5: Commit**

```bash
git add src/providers/panelProvider.ts src/extension.ts
git commit -m "feat: wire on-demand suggestion flow (provider state + command + handler)"
```

---

## Task 6: 集成测试 + 全量验证

**Files:**
- Modify: `src/test/suite/extension.test.ts`(追加用例)

- [ ] **Step 1: 在 `src/test/suite/extension.test.ts` 的「no API key required」`describe` 内追加一条**

```ts
  it("registers the generateSuggestions command", async () => {
    await getApi();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("parlance.generateSuggestions"),
      "parlance.generateSuggestions should be registered",
    );
  });
```

- [ ] **Step 2: 在文件末尾追加一个 golden-path-2 `describe`**

```ts
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
    } finally {
      await cfg.update("topK", undefined, vscode.ConfigurationTarget.Global);
    }
  });
});
```

> 注:命令 fire-and-forget,故轮询 `getLastSuggestionState()` 直到离开 `loading`(最多 90s)。集成测试跑在真实 Node 宿主,`Date.now()`/`setTimeout` 均可用。

- [ ] **Step 3: 运行集成测试**

Run: `npm run test:integration`
Expected: 「no API key」组现 5 条 + golden path 1 + suggestions golden path 1 = **7 passing**(有 key 时);若无 key,两条 golden path `this.skip()`,5 passing + 2 pending。

- [ ] **Step 4: 全量回归 + 诚实记录**

Run: `npm test && npm run typecheck && npm run build`
Expected: vitest 39 passed;typecheck exit 0;build OK(dist ≈1.5MB)。

- [ ] **Step 5: Commit**

```bash
git add src/test/suite/extension.test.ts
git commit -m "test: integration coverage for the suggestion command + golden path"
```

---

## Self-Review

**1. Spec coverage**(对 `2026-05-29-parlance-suggestions-design.md`):
- §1/§3 组合建议(诊断+改写+措辞)→ Task 1 `Suggestion` + Task 2 `renderSuggestion` ✓
- §4 按需触发 → Task 3 按钮 + Task 5 命令/handler ✓;Gemini 复用 key → Task 1 `defaultGenerator` + Task 4 `readSuggestConfig`(env)✓;前端直连 → Task 1/5 ✓
- §7 数据契约 `Suggestion` + JSON mode(`responseSchema`)→ Task 1 ✓
- §8 grounding(只喂句子+段落、不编造、basis/source、封顶/截断)→ Task 1 `SYSTEM_INSTRUCTION` + `buildPrompt`(`maxPassages`/`SNIPPET_CHAR_CAP`)✓
- §9 配置 `suggestModel`/`suggestMaxPassages` + key 仅 env → Task 4 ✓
- §10 错误分类(no-api-key/no-hits/network/bad-output)→ Task 1 + 测试 ✓;UI 错误 textContent 安全渲染 → Task 3 ✓
- §12 测试(suggestClient/renderSuggestion 单测、panel.dom、集成按需 + golden)→ Task 1/2/3/6 ✓
- §2 只建议不自动改正文 → 无 editor.edit/replace,仅复制 ✓

**2. Placeholder scan:** 无 TBD/TODO;每步含完整代码。Task 6 Step 2 的 `deadline` 占位行已在注记中明确删除并给出最终 `Date.now()` 轮询写法。✓

**3. Type consistency:** `Suggestion`/`SuggestConfig`/`GeminiGenerator`/`GeminiRequest`/`SuggestErrorKind`(types.ts)在 suggestClient、config、provider、extension、测试中名称与字段一致;`generateSuggestions`/`buildPrompt`/`SuggestError`/`defaultGenerator`/`SYSTEM_INSTRUCTION` 实现与测试一致;`PanelState`/`SuggestionState` 在 provider 定义、extension `ParlanceApi` 与集成测试引用一致;消息类型 `suggest`/`suggestion-loading`/`suggestions`/`suggestion-error` 与 `results.count` 在 panel.js、provider、dom 测试一致;命令 id `parlance.generateSuggestions` 在 package.json、extension、集成测试一致。✓

**Decisions:** 默认模型 `gemini-2.5-flash`(用户 key 已确认可用);only-suggest 不 auto-apply;6 段 / 800 字封顶。
