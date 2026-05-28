import { execFile } from "node:child_process";
import type { CommandResult, CommandRunner, ParlanceConfig, PhraseHit } from "./types";

export class ZsearchClientError extends Error {
  constructor(public kind: string, message: string) {
    super(message);
    this.name = "ZsearchClientError";
  }
}

export const defaultRunner: CommandRunner = (cmd, args) =>
  new Promise<CommandResult>((resolve) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ stdout: "", stderr: "ENOENT", code: 127 });
        return;
      }
      const errno = err as (NodeJS.ErrnoException & { code?: number }) | null;
      const code = errno && typeof errno.code === "number" ? errno.code : err ? 1 : 0;
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
    });
  });

export function classifyError(stderr: string): ZsearchClientError {
  const s = stderr.toLowerCase();
  if (s.includes("enoent") || s.includes("command not found") || s.includes("no such file")) {
    return new ZsearchClientError(
      "not-installed",
      "未找到 zsearch,请先安装 zotero-cli-agent,或在设置 parlance.zsearchPath 填写绝对路径。",
    );
  }
  if (s.includes("api_key") || s.includes("api key")) {
    return new ZsearchClientError(
      "no-api-key",
      "zsearch 缺少嵌入 API key(如 GEMINI_API_KEY)。请在 VS Code 能读到的环境里设置后重试。",
    );
  }
  if (s.includes("no such table") || s.includes("vectors.sqlite") || s.includes("index is empty")) {
    return new ZsearchClientError("no-index", "向量库为空或未建,请先运行 `zsearch sync`。");
  }
  return new ZsearchClientError("unknown", stderr.trim() || "zsearch 执行失败。");
}

export async function findPhrases(
  text: string,
  cfg: ParlanceConfig,
  run: CommandRunner = defaultRunner,
): Promise<PhraseHit[]> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new ZsearchClientError("empty-selection", "请先选中要检索的文本。");
  }
  const args = ["phrases", trimmed, "--json", "-k", String(cfg.topK)];
  const result = await run(cfg.zsearchPath, args);
  if (result.code !== 0) {
    throw classifyError(result.stderr);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new ZsearchClientError("unknown", "zsearch 返回的不是有效 JSON。");
  }
  if (!Array.isArray(parsed)) {
    throw new ZsearchClientError("unknown", "zsearch 返回的不是 JSON 数组。");
  }
  return parsed as PhraseHit[];
}
