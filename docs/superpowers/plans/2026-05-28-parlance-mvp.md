# Parlance MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a VS Code extension that, on a text selection, retrieves similar passages from the user's Zotero full-text corpus (via zsearch) and shows them with source + attribution in a side panel.

**Architecture:** Two repos. **Phase 1** adds a chunk-level `phrases` command to `zsearch` (Python, repo `~/Projects/zotero-cli-agent`) that returns matched passages *with their original snippet text* — the existing `query` dedups by parent item and never returns chunk text. **Phase 2** builds the `parlance` extension (TypeScript, repo `~/Projects/parlance`), a thin front-end that spawns `zsearch phrases ... --json`, parses the result, and renders it in a Webview side panel. zsearch owns all embedding/vector-store work; Parlance owns selection → spawn → render.

**Tech Stack:** Python 3.11 + click + sqlite-vec (Phase 1, existing stack); TypeScript + esbuild + vitest + VS Code Extension API (Phase 2).

**Spec:** `~/Projects/parlance/docs/superpowers/specs/2026-05-28-parlance-design.md`

**Spec deviations (intentional, MVP):**
- `parlance.languageScope` (spec §8) is **deferred** — zsearch has no per-chunk language filter; cross-lingual "both" is the default behavior and needs no config. Revisit when zsearch stores per-chunk language.
- `parlance.minSimilarity` (spec §8) is **deferred** — the backend returns raw distance, not a normalized similarity; a threshold needs a stable score mapping first. MVP config is `zsearchPath` + `topK` only.

---

## Prerequisites

- Phase 1 works in the **existing** repo `~/Projects/zotero-cli-agent`. Before starting: `cd ~/Projects/zotero-cli-agent && git status` — confirm a clean tree (or stash) so Phase 1 commits are isolated. Ensure the venv is active: `source .venv/bin/activate` (the repo uses `uv`).
- Phase 1 unit tests need `sqlite-vec` and `pytest`, both already in the venv (`uv pip install -e ".[hf]"` if pytest is missing: `uv pip install pytest`).
- Phase 2 works in `~/Projects/parlance` (already git-init'd, `main` branch). Needs Node ≥ 18 and `npm`.
- The two phases are sequential: Phase 2's client depends on the Phase 1 JSON contract below.

## JSON contract (produced by Phase 1, consumed by Phase 2)

`zsearch phrases "<text>" --json` emits a JSON array; each element:

```json
{
  "key": "ABCD1234",
  "chunk_idx": 3,
  "distance": 0.21,
  "snippet": "the original passage text…",
  "title": "On Privacy",
  "creators": ["Solove, Daniel"],
  "date": "2006",
  "venue": "Harvard Law Review",
  "doi": "10.2307/..."
}
```

`distance` is sqlite-vec distance (lower = closer). `creators` is always an array (possibly empty). `title`/`date`/`venue`/`doi` may be `null`.

---

# Phase 1 — zsearch `phrases` command

Repo: `~/Projects/zotero-cli-agent`. All paths below are relative to that repo.

### Task 1: `query_chunks()` — chunk-level search with snippet retrieval

**Files:**
- Modify: `src/zotero_cli/search.py` (append after existing `query()`)
- Test: `tests/test_phrases.py` (create)

**Context for the engineer:** `search.py` already has `_parent_key(key)` (strips `#c{idx}` → parent key), `resolve_fulltext(parent_key, db_path)` (reads the item's `.md` full text, or `None`), and `chunk_text(text)` (splits into the same overlapping chunks used at index time — deterministic). The vector store `store.query(vec, top_k)` returns `list[(key, distance, metadata)]` ordered by distance ascending; chunk vectors have keys like `ABCD1234#c3` and metadata containing `chunk_idx` and `is_chunk: True`; metadata-only vectors have plain keys and no `chunk_idx`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_phrases.py`:

```python
"""Tests for chunk-level phrase search (query_chunks)."""
from __future__ import annotations

import pytest

from zotero_cli.search import query_chunks
from zotero_cli.vector_store import SQLiteVecStore, VectorStoreConfig


class FakeEmbedder:
    """Returns a vector closest to the first inserted chunk."""

    class _Cfg:
        dimensions = 4
        batch_size = 32

    cfg = _Cfg()

    def embed_query(self, query: str) -> list[float]:
        return [1.0, 0.0, 0.0, 0.0]

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [[1.0, 0.0, 0.0, 0.0] for _ in texts]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _fake_fulltext(parent_key, db_path=None):
    return f"FULLTEXT-{parent_key}"


def _fake_chunk(text, **kwargs):
    return [f"{text}-c0", f"{text}-c1", f"{text}-c2"]


@pytest.fixture
def store(tmp_path):
    cfg = VectorStoreConfig(db_path=tmp_path / "vec.sqlite", dim=4)
    with SQLiteVecStore(cfg) as s:
        s.upsert(
            keys=["ABCD#c0", "ABCD#c1", "ZZZZ"],
            vectors=[[1.0, 0, 0, 0], [0, 1.0, 0, 0], [0, 0, 1.0, 0]],
            metadatas=[
                {"chunk_idx": 0, "is_chunk": True, "title": "Doc A", "creators": ["Lee, K"], "date": "2024", "venue": "JX", "doi": None},
                {"chunk_idx": 1, "is_chunk": True, "title": "Doc A", "creators": ["Lee, K"], "date": "2024", "venue": "JX", "doi": None},
                {"title": "Doc Z (metadata only)", "creators": [], "date": "2020", "venue": None, "doi": None},
            ],
            date_modified=["2024-01-01", "2024-01-01", "2020-01-01"],
        )
        yield s


def test_query_chunks_returns_snippets_and_skips_metadata(store):
    results = query_chunks(
        "anything", store, FakeEmbedder(), top_k=10,
        fulltext_fn=_fake_fulltext, chunk_fn=_fake_chunk,
    )
    # Only the two chunk hits, never the metadata-only "ZZZZ" vector.
    assert len(results) == 2
    keys = {r["key"] for r in results}
    assert keys == {"ABCD"}
    first = results[0]
    assert first["chunk_idx"] in (0, 1)
    assert first["snippet"] == f"FULLTEXT-ABCD-c{first['chunk_idx']}"
    assert first["title"] == "Doc A"
    assert first["creators"] == ["Lee, K"]
    assert isinstance(first["distance"], float)


def test_query_chunks_respects_top_k(store):
    results = query_chunks(
        "anything", store, FakeEmbedder(), top_k=1,
        fulltext_fn=_fake_fulltext, chunk_fn=_fake_chunk,
    )
    assert len(results) == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/zotero-cli-agent && uv run pytest tests/test_phrases.py -v`
Expected: FAIL with `ImportError: cannot import name 'query_chunks' from 'zotero_cli.search'`

- [ ] **Step 3: Implement `query_chunks` + `_resolve_snippet`**

Append to `src/zotero_cli/search.py` (after the existing `query()` function):

```python
def _resolve_snippet(
    parent_key: str,
    chunk_idx: int,
    db_path: Path | None,
    cache: dict[str, list[str]],
    fulltext_fn=resolve_fulltext,
    chunk_fn=chunk_text,
) -> str | None:
    """Return the original text of chunk `chunk_idx` for `parent_key`.

    Re-derives chunks with the same deterministic ``chunk_text`` used at index
    time, caching per parent so repeated hits in one query read the .md once.
    Returns None if the full text is missing or the index is out of range.
    """
    if parent_key not in cache:
        text = fulltext_fn(parent_key, db_path)
        cache[parent_key] = chunk_fn(text) if text else []
    chunks = cache[parent_key]
    if 0 <= chunk_idx < len(chunks):
        return chunks[chunk_idx]
    return None


def query_chunks(
    text: str,
    store: SQLiteVecStore,
    embedder: EmbedderProtocol,
    *,
    top_k: int = 10,
    db_path: Path | None = None,
    candidate_pool: int = 50,
    fulltext_fn=resolve_fulltext,
    chunk_fn=chunk_text,
) -> list[dict]:
    """Chunk-level semantic search returning matched passages with snippet text.

    Unlike ``query``, this does NOT dedup by parent item and keeps chunk
    granularity. Only fulltext-chunk hits (key like ``KEY#c3``) are returned;
    metadata-only vectors are skipped. Each result carries the original snippet
    text resolved from the item's ``.md`` full text.
    """
    qv = embedder.embed_query(text)
    pool = max(top_k * 3, candidate_pool)
    raw = store.query(qv, top_k=pool)

    cache: dict[str, list[str]] = {}
    results: list[dict] = []
    for key, dist, meta in raw:
        if "#c" not in key:
            continue  # metadata-only vector, no chunk text
        chunk_idx = meta.get("chunk_idx")
        if chunk_idx is None:
            continue
        parent_key = _parent_key(key)
        snippet = _resolve_snippet(
            parent_key, chunk_idx, db_path, cache, fulltext_fn, chunk_fn
        )
        if not snippet:
            continue
        results.append(
            {
                "key": parent_key,
                "chunk_idx": chunk_idx,
                "distance": dist,
                "snippet": snippet,
                "title": meta.get("title"),
                "creators": meta.get("creators") or [],
                "date": meta.get("date"),
                "venue": meta.get("venue"),
                "doi": meta.get("doi"),
            }
        )
        if len(results) >= top_k:
            break
    return results
```

Also confirm the import line at the top of `search.py` already includes `EmbedderProtocol` (it imports `from .embed import EmbedderProtocol`) and `chunk_text, resolve_fulltext` (it imports `from .fulltext import chunk_text, resolve_fulltext`). Both already exist — no import changes needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Projects/zotero-cli-agent && uv run pytest tests/test_phrases.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/zotero-cli-agent
git add src/zotero_cli/search.py tests/test_phrases.py
git commit -m "feat(search): add query_chunks for chunk-level passage retrieval"
```

---

### Task 2: `phrases` CLI command

**Files:**
- Modify: `src/zotero_cli/cli.py`
- Test: `tests/test_phrases_cli.py` (create)

**Context:** The existing `query` command (cli.py:64-115) shows the pattern: build `SQLiteVecStore()` + `make_embedder(dimensions=store.cfg.dim)` in a `with`, call the search function, and emit `json.dumps(results, ensure_ascii=False, indent=2)` when `--json`. We mirror that for `phrases`, calling `query_chunks`. Helpers `_format_creators`, `_extract_year`, `_truncate` already exist in cli.py.

- [ ] **Step 1: Write the failing test**

Create `tests/test_phrases_cli.py`:

```python
"""CLI wiring test for `zsearch phrases` (no network, no real index)."""
from __future__ import annotations

import json

from click.testing import CliRunner

from zotero_cli import cli


class _FakeCM:
    """Context manager that yields an object with a .cfg.dim attribute."""

    class _Cfg:
        dim = 4

    cfg = _Cfg()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_phrases_json_output(monkeypatch):
    fake_hits = [
        {
            "key": "ABCD", "chunk_idx": 0, "distance": 0.1, "snippet": "你好世界",
            "title": "T", "creators": ["Lee, K"], "date": "2024", "venue": "JX", "doi": None,
        }
    ]
    monkeypatch.setattr(cli, "SQLiteVecStore", lambda *a, **k: _FakeCM())
    monkeypatch.setattr(cli, "make_embedder", lambda *a, **k: _FakeCM())
    monkeypatch.setattr(cli, "do_query_chunks", lambda *a, **k: fake_hits)

    result = CliRunner().invoke(cli.main, ["phrases", "测试", "--json"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == fake_hits
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/zotero-cli-agent && uv run pytest tests/test_phrases_cli.py -v`
Expected: FAIL — either `AttributeError: ... has no attribute 'do_query_chunks'` or a click error that the `phrases` command does not exist.

- [ ] **Step 3: Implement the `phrases` command**

In `src/zotero_cli/cli.py`, update the search import (line 18) to also import `query_chunks`:

```python
from .search import query as do_query, query_chunks as do_query_chunks, sync as do_sync
```

Then add this command immediately after the `query` command (after cli.py:115):

```python
@main.command()
@click.argument("text")
@click.option("-k", "--top-k", default=10, type=int, help="Number of passages")
@click.option("--json", "as_json", is_flag=True, help="Emit raw JSON")
def phrases(text: str, top_k: int, as_json: bool) -> None:
    """Find similar passages (chunk-level) with their source snippets."""
    with SQLiteVecStore() as store, make_embedder(dimensions=store.cfg.dim) as emb:
        results = do_query_chunks(text, store, emb, top_k=top_k)

    if as_json:
        click.echo(json.dumps(results, ensure_ascii=False, indent=2))
        return

    table = Table(title=f"Top-{top_k} passages for: {text}", show_lines=True)
    table.add_column("#", justify="right", style="dim")
    table.add_column("dist", justify="right", style="cyan")
    table.add_column("source", style="blue", no_wrap=False)
    table.add_column("passage", style="white", no_wrap=False)
    for i, r in enumerate(results, 1):
        src = (
            f"{_format_creators(r.get('creators') or [])} "
            f"({_extract_year(r.get('date'))}) — "
            f"{_truncate(r.get('title') or '<no-title>', 40)}"
        )
        table.add_row(str(i), f"{r['distance']:.3f}", src, _truncate(r["snippet"], 200))
    console.print(table)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Projects/zotero-cli-agent && uv run pytest tests/test_phrases_cli.py -v`
Expected: PASS (1 passed)

- [ ] **Step 5: Manual smoke against the real index**

Run: `cd ~/Projects/zotero-cli-agent && zsearch phrases "个人信息处理者的合规义务" -k 3 --json`
Expected: a JSON array of up to 3 objects, each with a non-empty `snippet` and a `title`/`creators`. (Requires the embedding API key in the environment; if you see an API-key error, `export GEMINI_API_KEY=...` first.) Eyeball that snippets are real passages and at least one may be from an English-language item (cross-lingual).

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/zotero-cli-agent
git add src/zotero_cli/cli.py tests/test_phrases_cli.py
git commit -m "feat(cli): add `phrases` command for chunk-level passage search"
```

---

# Phase 2 — parlance extension

Repo: `~/Projects/parlance`. All paths below are relative to that repo.

### Task 3: Scaffold the extension project

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `media/icon.svg`

- [ ] **Step 1: Create `.gitignore`**

```
node_modules/
dist/
coverage/
*.vsix
.vscode-test/
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "parlance",
  "displayName": "Parlance",
  "description": "Find how scholars phrased it — semantic phrasing search over your Zotero full-text via zsearch.",
  "version": "0.0.1",
  "publisher": "xwzhangSZU",
  "engines": { "vscode": "^1.90.0" },
  "categories": ["Other"],
  "main": "./dist/extension.js",
  "contributes": {
    "commands": [
      { "command": "parlance.findSimilarPhrasing", "title": "Parlance: 查找相近表达" }
    ],
    "menus": {
      "editor/context": [
        { "command": "parlance.findSimilarPhrasing", "when": "editorHasSelection", "group": "navigation@9" }
      ]
    },
    "viewsContainers": {
      "activitybar": [
        { "id": "parlance", "title": "Parlance", "icon": "media/icon.svg" }
      ]
    },
    "views": {
      "parlance": [
        { "id": "parlance.results", "type": "webview", "name": "相近表达" }
      ]
    },
    "configuration": {
      "title": "Parlance",
      "properties": {
        "parlance.zsearchPath": {
          "type": "string",
          "default": "zsearch",
          "description": "zsearch 可执行路径(若不在 PATH,填 venv 内绝对路径)"
        },
        "parlance.topK": {
          "type": "number",
          "default": 10,
          "description": "召回的相近表达条数"
        }
      }
    }
  },
  "scripts": {
    "build": "esbuild src/extension.ts --bundle --outfile=dist/extension.js --external:vscode --format=cjs --platform=node",
    "watch": "npm run build -- --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "vscode:prepublish": "npm run build"
  },
  "devDependencies": {
    "@types/node": "^20",
    "@types/vscode": "^1.90.0",
    "esbuild": "^0.21.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "moduleResolution": "node",
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Create a placeholder `media/icon.svg`**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
  <path d="M4 4h16v12H7l-3 3V4zm3 4h10v2H7V8zm0 4h7v2H7v-2z"/>
</svg>
```

- [ ] **Step 6: Install dependencies**

Run: `cd ~/Projects/parlance && npm install`
Expected: `node_modules/` created, no errors.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/parlance
git add .gitignore package.json package-lock.json tsconfig.json vitest.config.ts media/icon.svg
git commit -m "chore: scaffold parlance VS Code extension"
```

---

### Task 4: Types + zsearch client (TDD)

**Files:**
- Create: `src/core/types.ts`
- Create: `src/core/zsearchClient.ts`
- Test: `src/core/zsearchClient.test.ts`

- [ ] **Step 1: Create `src/core/types.ts`**

```typescript
export interface PhraseHit {
  key: string;
  chunk_idx: number;
  distance: number;
  snippet: string;
  title: string | null;
  creators: string[];
  date: string | null;
  venue: string | null;
  doi: string | null;
}

export interface ParlanceConfig {
  zsearchPath: string;
  topK: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type CommandRunner = (cmd: string, args: string[]) => Promise<CommandResult>;
```

- [ ] **Step 2: Write the failing test**

Create `src/core/zsearchClient.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/Projects/parlance && npx vitest run src/core/zsearchClient.test.ts`
Expected: FAIL — `Failed to resolve import "./zsearchClient"`.

- [ ] **Step 4: Implement `src/core/zsearchClient.ts`**

```typescript
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
    return new ZsearchClientError("not-installed", "未找到 zsearch,请先安装 zotero-cli-agent,或在设置 parlance.zsearchPath 填写绝对路径。");
  }
  if (s.includes("api_key") || s.includes("api key")) {
    return new ZsearchClientError("no-api-key", "zsearch 缺少嵌入 API key(如 GEMINI_API_KEY)。请在 VS Code 能读到的环境里设置后重试。");
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ~/Projects/parlance && npx vitest run src/core/zsearchClient.test.ts`
Expected: PASS (8 passed)

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/parlance
git add src/core/types.ts src/core/zsearchClient.ts src/core/zsearchClient.test.ts
git commit -m "feat(core): add zsearch client with error classification"
```

---

### Task 5: Webview render helpers (TDD)

**Files:**
- Create: `src/webview/render.ts`
- Test: `src/webview/render.test.ts`

**Context:** Pure functions that turn `PhraseHit[]` into an HTML fragment. No `vscode` or DOM imports, so they unit-test cleanly. The full HTML shell + CSS comes in Task 6.

- [ ] **Step 1: Write the failing test**

Create `src/webview/render.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { escapeHtml, formatSource, renderHits } from "./render";
import type { PhraseHit } from "../core/types";

const base: PhraseHit = {
  key: "ABCD", chunk_idx: 0, distance: 0.234, snippet: "原文段落",
  title: "论隐私", creators: ["Solove, D"], date: "2006-05", venue: "HLR", doi: null,
};

describe("escapeHtml", () => {
  it("escapes angle brackets and ampersands", () => {
    expect(escapeHtml('<a> & "b"')).toBe("&lt;a&gt; &amp; &quot;b&quot;");
  });
});

describe("formatSource", () => {
  it("extracts the year and joins a single author", () => {
    expect(formatSource(base)).toContain("Solove, D");
    expect(formatSource(base)).toContain("2006");
    expect(formatSource(base)).toContain("论隐私");
  });

  it("uses et al. for multiple authors", () => {
    expect(formatSource({ ...base, creators: ["A", "B", "C"] })).toContain("et al.");
  });

  it("falls back when title is null", () => {
    expect(formatSource({ ...base, title: null })).toContain("<无题>");
  });
});

describe("renderHits", () => {
  it("renders an empty-state message for no hits", () => {
    expect(renderHits([])).toContain("没有找到");
  });

  it("escapes snippet content to prevent injection", () => {
    const html = renderHits([{ ...base, snippet: "<script>x</script>" }]);
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders the distance and one block per hit", () => {
    const html = renderHits([base, { ...base, key: "EFGH" }]);
    expect(html).toContain("0.234");
    expect((html.match(/class="hit"/g) || []).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/parlance && npx vitest run src/webview/render.test.ts`
Expected: FAIL — `Failed to resolve import "./render"`.

- [ ] **Step 3: Implement `src/webview/render.ts`**

```typescript
import type { PhraseHit } from "../core/types";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatSource(hit: PhraseHit): string {
  const authors = hit.creators.length
    ? hit.creators[0] + (hit.creators.length > 1 ? " et al." : "")
    : "佚名";
  const yearMatch = hit.date ? hit.date.match(/\b(19|20)\d{2}\b/) : null;
  const year = yearMatch ? yearMatch[0] : "";
  const title = hit.title ?? "<无题>";
  const venue = hit.venue ? ` · ${hit.venue}` : "";
  return `${authors}${year ? ` (${year})` : ""} — ${title}${venue}`;
}

export function renderHits(hits: PhraseHit[]): string {
  if (hits.length === 0) {
    return `<div class="empty">没有找到相近表达。换个说法,或先运行 <code>zsearch sync</code>。</div>`;
  }
  return hits
    .map((h, i) => {
      const snippet = escapeHtml(h.snippet);
      const source = escapeHtml(formatSource(h));
      const copyPayload = escapeHtml(h.snippet);
      const key = escapeHtml(h.key);
      return `
    <div class="hit">
      <div class="hit-head">
        <span class="rank">${i + 1}</span>
        <span class="dist">距离 ${h.distance.toFixed(3)}</span>
      </div>
      <blockquote class="snippet">${snippet}</blockquote>
      <div class="source">${source}</div>
      <div class="actions">
        <button class="copy-btn" data-copy="${copyPayload}">复制</button>
        <button class="jump-btn" data-key="${key}">跳 Zotero</button>
      </div>
    </div>`;
    })
    .join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Projects/parlance && npx vitest run src/webview/render.test.ts`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/parlance
git add src/webview/render.ts src/webview/render.test.ts
git commit -m "feat(webview): add pure render helpers for phrase hits"
```

---

### Task 6: VS Code glue — config, panel provider, extension entry, webview assets

**Files:**
- Create: `src/core/config.ts`
- Create: `src/providers/panelProvider.ts`
- Create: `src/extension.ts`
- Create: `media/panel.css`
- Create: `media/panel.js`

**Context:** These touch the `vscode` runtime API and the Webview DOM, so they are validated by the manual F5 smoke test in Task 7, not vitest. The pure logic they call (`findPhrases`, `renderHits`) is already tested. Keep these files thin.

- [ ] **Step 1: Create `src/core/config.ts`**

```typescript
import * as vscode from "vscode";
import type { ParlanceConfig } from "./types";

export function readConfig(): ParlanceConfig {
  const c = vscode.workspace.getConfiguration("parlance");
  return {
    zsearchPath: c.get<string>("zsearchPath", "zsearch"),
    topK: c.get<number>("topK", 10),
  };
}
```

- [ ] **Step 2: Create `media/panel.css`** (Catppuccin Mocha via VS Code theme variables + fallback)

```css
:root {
  --pl-bg: var(--vscode-sideBar-background, #1e1e2e);
  --pl-fg: var(--vscode-foreground, #cdd6f4);
  --pl-muted: var(--vscode-descriptionForeground, #a6adc8);
  --pl-accent: var(--vscode-textLink-foreground, #89b4fa);
  --pl-border: var(--vscode-panel-border, #313244);
}
body { font-family: var(--vscode-font-family); color: var(--pl-fg); background: var(--pl-bg); padding: 8px; }
.empty { color: var(--pl-muted); padding: 16px 8px; line-height: 1.6; }
.hit { border: 1px solid var(--pl-border); border-radius: 6px; padding: 10px; margin-bottom: 10px; }
.hit-head { display: flex; justify-content: space-between; font-size: 11px; color: var(--pl-muted); margin-bottom: 6px; }
.rank { font-weight: 600; }
.snippet { margin: 0 0 8px; padding: 0 0 0 10px; border-left: 3px solid var(--pl-accent); white-space: pre-wrap; line-height: 1.6; max-height: 9.6em; overflow: auto; }
.source { color: var(--pl-muted); font-size: 12px; margin-bottom: 8px; }
.actions { display: flex; gap: 8px; }
button { background: transparent; color: var(--pl-accent); border: 1px solid var(--pl-border); border-radius: 4px; padding: 2px 10px; cursor: pointer; font-size: 12px; }
button:hover { background: var(--vscode-toolbar-hoverBackground, #313244); }
.loading { color: var(--pl-muted); padding: 16px 8px; }
.error { color: var(--vscode-errorForeground, #f38ba8); padding: 16px 8px; line-height: 1.6; }
```

- [ ] **Step 3: Create `media/panel.js`** (runs inside the webview)

```javascript
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "loading") {
      root.innerHTML = '<div class="loading">检索中…</div>';
    } else if (msg.type === "results") {
      root.innerHTML = msg.html;
    } else if (msg.type === "error") {
      root.innerHTML = '<div class="error">' + msg.message + "</div>";
    }
  });

  root.addEventListener("click", (e) => {
    const target = e.target;
    if (target.classList.contains("copy-btn")) {
      vscode.postMessage({ type: "copy", text: target.getAttribute("data-copy") });
    } else if (target.classList.contains("jump-btn")) {
      vscode.postMessage({ type: "jump", key: target.getAttribute("data-key") });
    }
  });
})();
```

- [ ] **Step 4: Create `src/providers/panelProvider.ts`**

```typescript
import * as vscode from "vscode";
import { renderHits } from "../webview/render";
import type { PhraseHit } from "../core/types";

export class PanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "parlance.results";
  private view?: vscode.WebviewView;

  constructor(private readonly extensionUri: vscode.Uri) {}

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
      }
    });
  }

  showLoading(): void {
    void this.reveal();
    this.view?.webview.postMessage({ type: "loading" });
  }

  showResults(hits: PhraseHit[]): void {
    void this.reveal();
    this.view?.webview.postMessage({ type: "results", html: renderHits(hits) });
  }

  showError(message: string): void {
    void this.reveal();
    this.view?.webview.postMessage({ type: "error", message });
  }

  private async reveal(): Promise<void> {
    if (!this.view) {
      await vscode.commands.executeCommand("parlance.results.focus");
    }
    this.view?.show?.(true);
  }

  private shell(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "panel.css"));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "panel.js"));
    return `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${cssUri}" rel="stylesheet" />
</head>
<body>
  <div id="root"><div class="empty">选中一段文字,运行「Parlance: 查找相近表达」。</div></div>
  <script src="${jsUri}"></script>
</body>
</html>`;
  }
}
```

- [ ] **Step 5: Create `src/extension.ts`**

```typescript
import * as vscode from "vscode";
import { PanelProvider } from "./providers/panelProvider";
import { readConfig } from "./core/config";
import { findPhrases, ZsearchClientError } from "./core/zsearchClient";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PanelProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PanelProvider.viewType, provider),
  );

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
        provider.showResults(hits);
      } catch (e) {
        const message = e instanceof ZsearchClientError ? e.message : String(e);
        provider.showError(message);
      }
    }),
  );
}

export function deactivate(): void {}
```

- [ ] **Step 6: Type-check**

Run: `cd ~/Projects/parlance && npm run typecheck`
Expected: no errors (exit 0).

- [ ] **Step 7: Build**

Run: `cd ~/Projects/parlance && npm run build`
Expected: `dist/extension.js` produced, no errors.

- [ ] **Step 8: Commit**

```bash
cd ~/Projects/parlance
git add src/core/config.ts src/providers/panelProvider.ts src/extension.ts media/panel.css media/panel.js
git commit -m "feat: wire command, panel provider, and webview UI"
```

---

### Task 7: Full-suite check + manual F5 smoke

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite + typecheck**

Run: `cd ~/Projects/parlance && npm test && npm run typecheck`
Expected: all vitest tests pass (zsearchClient 8 + render 6 = 14), typecheck clean.

- [ ] **Step 2: Launch the Extension Development Host**

In VS Code, open `~/Projects/parlance` and press **F5** (Run Extension). A second VS Code window opens with Parlance loaded.

> If there is no launch config, create `.vscode/launch.json` with one entry:
> ```json
> { "version": "0.2.0", "configurations": [ { "name": "Run Extension", "type": "extensionHost", "request": "launch", "args": ["--extensionDevelopmentPath=${workspaceFolder}"], "outFiles": ["${workspaceFolder}/dist/**/*.js"], "preLaunchTask": "" } ] }
> ```
> Run `npm run build` first so `dist/extension.js` exists.

- [ ] **Step 3: Golden-path smoke**

In the dev-host window: open any file, type and select a Chinese sentence (e.g. `个人信息处理者负有合规义务`), right-click → **Parlance: 查找相近表达** (or run it from the Command Palette). Expected: the Parlance side panel shows "检索中…" then a list of passages, each with a snippet, a 距离 value, and a source line (author · year · title). Confirm at least one result and that 复制 copies text and 跳 Zotero opens the item.

- [ ] **Step 4: Edge-case smoke**

  - Run the command with no selection → a warning toast "请先选中要检索的文本。", panel unchanged.
  - In settings, set `parlance.zsearchPath` to `zsearch-nope` → run → panel shows the not-installed error. Restore the setting afterward.

- [ ] **Step 5: Commit any launch config added**

```bash
cd ~/Projects/parlance
git add .vscode/launch.json
git commit -m "chore: add Run Extension launch config"
```

---

## Self-Review

**1. Spec coverage** (against `2026-05-28-parlance-design.md`):
- §2 zsearch `phrases` interface → Task 1 + Task 2 ✓ (JSON shape matches the contract block above)
- §3 extension module structure → Tasks 3–6 create `extension.ts`, `core/{zsearchClient,config,types}.ts`, `providers/panelProvider.ts`, `webview/render.ts` ✓ (spec listed `webview/panel.{html,ts,css}`; implemented as `media/panel.{css,js}` + `webview/render.ts` + the HTML shell inlined in `panelProvider.shell()` — functionally equivalent, noted)
- §4 data flow (select → spawn `zsearch phrases --json` → parse → panel → copy/jump) → Tasks 4, 6, 7 ✓
- §5 config → Task 3; **languageScope + minSimilarity deferred** (documented at top) ✓
- §6 error handling (not-installed / no-index / no-api-key / empty selection) → Task 4 `classifyError` + tests ✓
- §9 tests (zsearch phrases pytest; client + render vitest; manual smoke) → Tasks 1, 2, 4, 5, 7 ✓
- §11 gap: snippet via route A (lazy re-chunk) → Task 1 `_resolve_snippet` ✓; out-of-range chunk_idx guarded ✓

**2. Placeholder scan:** No TBD/TODO; every code step contains full content. ✓

**3. Type consistency:** `PhraseHit` fields (key, chunk_idx, distance, snippet, title, creators, date, venue, doi) are identical across the Phase 1 JSON contract, `types.ts`, the Python `query_chunks` dict, and `render.ts`. `ParlanceConfig` = `{ zsearchPath, topK }` in types.ts, config.ts, and zsearchClient args. `findPhrases` / `classifyError` / `ZsearchClientError` names match between implementation and tests. ✓

**Decisions for the implementer (from spec §13):** snippet route **A** is chosen (Task 1). The new capability is a dedicated **`phrases` subcommand** (Task 2), not a `query --chunks` flag.
