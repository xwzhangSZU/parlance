# Parlance

**Find how scholars phrased it** — semantic phrasing search over your own Zotero full-text, with on-demand, grounded rewrite suggestions.

Select a sentence in your draft → Parlance retrieves passages from your Zotero full-text corpus (via [`zsearch`](https://github.com/) from zotero-cli-agent) where other authors expressed a similar idea, and lists them with source + attribution in a side panel. On demand, it can also generate **grounded rewrite suggestions** — a short diagnosis, 2–3 rewrites (each citing the passage it draws on), and reusable phrasings — using Gemini. Suggestions are clearly marked as model output and the extension **never edits your text**.

## Requirements

This is a thin front-end over a local setup; it is most useful if you already run:

- **`zsearch`** (from zotero-cli-agent) on your `PATH`, or set `parlance.zsearchPath` to its absolute path.
- A **populated vector index** over your Zotero full-text (`zsearch sync`).
- **`GEMINI_API_KEY`** available in the VS Code process environment — used for retrieval embeddings and, optionally, for rewrite suggestions. (Launch VS Code from a shell where this variable is set.)
- *(Optional)* **`DASHSCOPE_API_KEY`** — if set, rewrite suggestions automatically fall back to Qwen (Alibaba DashScope) whenever Gemini is unavailable (e.g. 503 high-demand).

## Usage

1. Select a sentence in any editor.
2. Run **Parlance: 查找相近表达** (right-click → context menu, or the Command Palette).
3. The Parlance side panel shows similar passages, each with distance and source (author · year · title), plus Copy and Jump-to-Zotero buttons.
4. Click **✍ 生成改写建议** (or run **Parlance: 生成改写建议**) for grounded rewrite suggestions based on those passages.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `parlance.zsearchPath` | `zsearch` | Path to the `zsearch` executable |
| `parlance.topK` | `10` | Number of passages to retrieve |
| `parlance.suggestModel` | `gemini-3.5-flash` | Primary Gemini model for suggestions |
| `parlance.suggestMaxPassages` | `6` | Max retrieved passages fed to the model |
| `parlance.fallbackModel` | `qwen-plus` | Qwen model (DashScope) used when Gemini fails; needs `DASHSCOPE_API_KEY` |
| `parlance.fallbackBaseUrl` | DashScope endpoint | OpenAI-compatible base URL for the Qwen fallback |

## Privacy & grounding

Rewrite suggestions are generated **only** from the passages already retrieved from your own library; the model is instructed not to invent sources, statute numbers, authors, or facts. Transient model errors (e.g. 503) are retried with backoff, and if Gemini stays unavailable the request automatically falls back to Qwen (when `DASHSCOPE_API_KEY` is set). The suggestion panel labels which model produced it (Gemini or the Qwen fallback). Your draft text is never modified by the extension — suggestions are copy-only.

## License

MIT
