import { escapeHtml } from "./render";
import type { Suggestion } from "../core/types";

/** Map a model id to a human provider label for the badge. */
export function providerLabel(model: string | undefined): string {
  if (!model) return "";
  if (/^qwen/i.test(model)) return "Qwen";
  if (/^gemini/i.test(model)) return "Gemini";
  return model;
}

export function renderSuggestion(s: Suggestion): string {
  const provider = providerLabel(s.model);
  const badge = provider
    ? ` <span class="sg-model">· 由 ${escapeHtml(provider)} 生成${s.model ? `(${escapeHtml(s.model)})` : ""}</span>`
    : "";
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
      <div class="sg-warn">⚠ 模型生成,请核验${badge}</div>
      <div class="sg-sec"><div class="sg-h">诊断</div><div class="sg-diag">${escapeHtml(s.diagnosis)}</div></div>
      <div class="sg-sec"><div class="sg-h">改写</div>${rewrites}</div>
      <div class="sg-sec"><div class="sg-h">可借用措辞</div><ul class="sg-ph">${phrasings}</ul></div>
    </div>`;
}
