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

const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

/** Transient = worth retrying: 429/5xx, Gemini UNAVAILABLE/RESOURCE_EXHAUSTED, or fetch/DNS errors. */
export function isTransientGeminiError(e: unknown): boolean {
  const status = (e as { status?: unknown }).status;
  if (typeof status === "number" && TRANSIENT_STATUS.has(status)) {
    return true;
  }
  const m = String((e as { message?: unknown }).message ?? "").toUpperCase();
  return (
    m.includes("UNAVAILABLE") ||
    m.includes("RESOURCE_EXHAUSTED") ||
    m.includes("ECONNRESET") ||
    m.includes("ETIMEDOUT") ||
    m.includes("ENOTFOUND") ||
    m.includes("FETCH FAILED")
  );
}

export interface RetryOptions {
  attempts: number;
  isTransient: (e: unknown) => boolean;
  delayMs: (attempt: number) => number;
  sleep: (ms: number) => Promise<void>;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < opts.attempts && opts.isTransient(e)) {
        await opts.sleep(opts.delayMs(attempt));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const defaultGenerator: GeminiGenerator = async (req: GeminiRequest): Promise<string> => {
  const ai = new GoogleGenAI({ apiKey: req.apiKey });
  return withRetry(
    async () => {
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
    },
    { attempts: 3, isTransient: isTransientGeminiError, delayMs: (a) => 700 * 2 ** (a - 1), sleep: realSleep },
  );
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

function classifyGenError(e: unknown): SuggestError {
  if (e instanceof SuggestError) {
    return e;
  }
  const status = (e as { status?: unknown }).status;
  const msg = String((e as { message?: unknown }).message ?? "");
  const up = msg.toUpperCase();
  if (status === 401 || status === 403 || up.includes("API KEY") || up.includes("API_KEY") || up.includes("PERMISSION")) {
    return new SuggestError("no-api-key", "Gemini 拒绝了 API key(无效或无权限),请检查 GEMINI_API_KEY。");
  }
  if (isTransientGeminiError(e)) {
    return new SuggestError("network", "Gemini 暂时繁忙或不可用(已重试),请稍后再试。");
  }
  return new SuggestError("network", `调用 Gemini 失败:${msg.slice(0, 200) || "未知错误"},请重试。`);
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
  } catch (e) {
    throw classifyGenError(e);
  }
  return parseSuggestion(raw);
}
