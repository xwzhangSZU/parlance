# Parlance — 设计规格(Design Spec)

- **状态:** 已通过 brainstorming 评审,待 writing-plans
- **日期:** 2026-05-28
- **扩展 id:** `parlance`
- **类型:** VS Code 扩展 + `zotero-cli-agent`(zsearch)小增强

---

## 1. 目标与一句话定义

选中正在写的一句话 → Parlance 在用户自己的 Zotero 文献**全文**里检索"学者们表达相近意思的段落",在 VS Code 侧边栏列出**原文段落 + 相似度 + 出处**,供用户借鉴措辞、核验出处。

核心价值:回答"这个意思,别的中英文文献作者是怎么写的?",并给出可核验的依据和出处。

## 2. 用户故事与成功标准

- 作为中文/英文学术写作者,我选中一句草稿,触发命令,几秒内在侧栏看到 5–10 条来自我 Zotero 库的相近表达原文,每条标注作者·年份·标题·相似度,可一键复制或跳回 Zotero 条目。
- **成功标准(MVP):**
  1. 选中文本 → 命令触发 → 侧栏面板显示结果或友好空态/错误态,不崩溃。
  2. 结果含**段落原文**(非仅文献元数据)、相似度、出处四要素。
  3. 中英文跨语言检索可用(选中中文也能召回英文文献的相近表达,反之亦然)。
  4. 出处可点击跳转回 Zotero。

## 3. 范围

### MVP(首版)
- 输入:**仅选中的编辑器文本**。
- 检索:复用 zsearch 句子/段落级语义检索(chunk 级)。
- 输出:**侧边栏 Webview 面板**(Activity Bar 视图),展示原文段落 + 相似度 + 出处 + 复制 + 跳 Zotero。
- 主题:Catppuccin Mocha,WebView 用原生 CSS 变量 + fallback。

### 非目标(MVP 明确不做)
- 截图 / OCR / 多模态输入。
- 自动改写、续写、风格迁移(那是 scholar-writing-assistant 的范畴,Parlance 只"检索+展示",不改用户文字)。
- 自建嵌入/向量库(一律复用 zsearch)。
- 精确 PDF 页码标注。

### 后续迭代(记录,不在 MVP)
- 截图 OCR / 多模态输入。
- 上下文增强(自动带光标周围段落做语义分析)。
- 段落内**句级高亮**:在召回的段落里定位与 query 语义最近的那一句。
- 页码映射(需 ZoteroLLM 侧在 .md 写入 page-anchor)。

## 4. 架构:两个交付物

1. **`parlance`**(新建,`~/Projects/parlance/`)— VS Code 扩展前端(TypeScript)。
2. **`zotero-cli-agent` 的小增强** — 给 zsearch 增加 chunk 级输出能力。

定位为"**复用 + 小增强 zsearch**",不重复实现检索/嵌入/向量库。

## 5. zsearch 增强规格(扩展依赖,需先落地)

新增子命令 `zsearch phrases "<text>" --json -k N`(或等价 `query --chunks`),区别于现有 `query`:

- embed query → `store.query` 取候选池;
- **不按 parent item 去重**(现有 `query` 在 `search.py:169` 用 `_parent_key` 去重,会丢掉同一文献的多个相近段落,也丢掉 chunk 粒度);
- 仅保留 `is_chunk=True` 的命中(chunk key 形如 `KEY#c{idx}`);
- 每条结果回填:
  ```json
  {
    "key": "<parent item key>",
    "chunk_idx": 3,
    "distance": 0.21,
    "snippet": "<该 chunk 的原文段落>",
    "title": "...", "creators": ["..."], "date": "2024",
    "venue": "...", "doi": "..."
  }
  ```
- **snippet 取回:** 向量库未持久化 chunk 原文(`items` 表仅 `key/metadata_json/date_modified`),故需重新取回。两种实现路线,writing-plans 阶段定夺:
  - **路线 A(MVP 倾向):** 查询时 lazy 调用现成 `resolve_fulltext()` + `chunk_text()` 重切,按 `chunk_idx` 取第 idx 段。不改 schema;依赖 `chunk_text()` 的**确定性**(同输入同切分)保证 idx 稳定映射。代价:每次查询读 top-K 个 .md 并切分。
  - **路线 B(更稳健):** `sync` 时把 chunk 文本写入 `items` 新列 `chunk_text`。query 快、不依赖 .md 仍在原位;代价:改 schema + 重建 226M 索引。
- 不改动现有 `query` / `sync` 的对外行为(纯增量)。

## 6. 扩展模块结构(TypeScript,守 200–400 行小文件原则)

```
parlance/
├── package.json              # 命令、配置、贡献点(Activity Bar 视图容器)
├── src/
│   ├── extension.ts          # 激活入口:注册命令 + WebviewView provider (~80)
│   ├── core/
│   │   ├── zsearchClient.ts  # spawn zsearch、解析 JSON、错误归类 (~150)
│   │   ├── config.ts         # 读 workspace 配置 (~60)
│   │   └── types.ts          # PhraseHit / 配置类型,frozen 风格 (~60)
│   ├── providers/
│   │   └── panelProvider.ts  # WebviewView:加载/结果/空/错 状态机 + 消息桥 (~180)
│   └── webview/
│       ├── panel.html        # 面板骨架
│       ├── panel.ts          # 面板逻辑:渲染 hits、复制、跳转消息 (~150)
│       └── panel.css         # Catppuccin Mocha + 原生 CSS 变量 (~120)
└── test/                     # 见 §9
```

## 7. 数据流

1. 用户选中文本 → 触发命令 `parlance.findSimilarPhrasing`(编辑器右键菜单 / 快捷键 / 命令面板)。
2. `extension.ts` 取 selection;空选区 → 提示并返回。
3. `zsearchClient` `spawn` `zsearch phrases "<sel>" --json -k <topK>`(语言范围/阈值按配置)。
4. 解析 stdout JSON → `PhraseHit[]`;非零退出码 → 按 stderr 归类错误。
5. `panelProvider` 把 hits post 给 webview。
6. 面板渲染每条:**原文段落**(query 关键词字面高亮、过长折叠)· 相似度(distance→可读分值)· 出处(作者·年份·标题·期刊)· `[复制]` `[跳 Zotero]`。
7. "跳 Zotero" → `zsearch open <key>` 或 `zotero://select/items/<key>`。

## 8. 配置(`contributes.configuration`)

| 键 | 默认 | 说明 |
|---|---|---|
| `parlance.zsearchPath` | `zsearch` | 可执行路径,支持 venv 绝对路径 |
| `parlance.topK` | `10` | 召回条数 |
| `parlance.languageScope` | `both` | `both`/`zh`/`en`,默认跨语言 |
| `parlance.minSimilarity` | (空) | 可选相似度过滤阈值 |

## 9. 错误处理(只在边界)

- zsearch 未安装 / 不在 PATH:面板显示安装指引(指向 zotero-cli-agent),不崩。
- 向量库空 / 未 sync:提示先 `zsearch sync`。
- 嵌入联网超时(gemini):设超时 + 可取消,提示重试。
- 无结果:友好空态文案。
- 空选区:状态栏/通知提示先选文本。

## 10. 前置依赖(已验证)

- **zsearch 全文 chunk 索引已就绪**(验证于 2026-05-28):`~/.local/share/zotero-cli/vectors.sqlite` 226M,总 16690 行,其中 **15163 个 chunk**(~91%)。全文语料充足。
- 依赖 ZoteroLLM 持续把新 PDF 转 `.md` 并挂到 Zotero,保持全文覆盖。
- 嵌入沿用 zsearch 的 gemini 现状(联网 + API key + 成本),Parlance 不引入新嵌入后端。

## 11. 已知 gap / 风险(诚实标注)

- **chunk 是段落级**(~2000 CJK 字 / 4000 字符,overlap 300,每文献≤20 段),非单句 → MVP 折叠展示,句级高亮留后续。
- **无精确页码**(仅 `chunk_idx`)→ 出处用 作者·年份·标题,不标页码。
- snippet 取回路线 A 依赖 `chunk_text()` 确定性;若 zsearch 升级切分逻辑需同步,否则 idx 漂移(路线 B 可规避)。
- 段落 overlap 会让相邻 chunk 文本部分重复 → 面板需按 `key+chunk_idx` 去重展示。

## 12. 测试策略

- **zsearch 增强(pytest):** `phrases` 输出含 `snippet`、不按 parent 去重、`chunk_idx` 正确映射回原文段落;空库 / 无 .md 文献的降级行为。
- **扩展(TS):** mock `child_process` 测 `zsearchClient` 的 JSON 解析与各错误分支(未安装/超时/非零退出/空结果);`panelProvider` 状态机;面板渲染快照。
- **集成:** 对真实 zsearch 做手动 smoke(选一段中文 → 看是否召回中英文相近段落 + 出处正确)。

## 13. 开放问题(留给 writing-plans / 实现)

1. snippet 取回选路线 A 还是 B(MVP 倾向 A)。
2. `phrases` 做成 zsearch 新子命令还是 `query --chunks` flag。
3. distance → 用户可读相似度分值的映射方式。
4. 命令触发点优先级(右键菜单 vs 快捷键默认绑定)。
