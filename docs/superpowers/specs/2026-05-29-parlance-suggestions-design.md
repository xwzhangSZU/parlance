# Parlance 迭代 2 — grounded 改写建议(Design Spec)

- **状态:** 已通过 brainstorming 评审,待用户复核 → writing-plans
- **日期:** 2026-05-29
- **扩展 id:** `parlance`
- **类型:** VS Code 扩展前端增量(不改 zsearch 后端)
- **前序:** 见 `2026-05-28-parlance-design.md`(MVP:检索+展示)

---

## 1. 目标与一句话定义

检索出相近段落后,面板顶部出现「✍ 生成改写建议」按钮;点击 → Parlance 把**用户选中的句子 + 已检索到的段落**交给 Gemini → 返回**诊断 + 2–3 条带出处的改写 + 可借用措辞**,渲染在段落上方,并明确标注「⚠ 模型生成,请核验」。

核心价值:把 Parlance 从"这个意思学者怎么写的"(检索)推进到"那我这句具体该怎么改"(grounded 建议),且建议**只基于检索到的真实段落**,不引入未核验材料。

## 2. 与原 spec 的关系(范围演进)

原 spec §3「非目标」明确写道:"自动改写、续写、风格迁移……Parlance 只'检索+展示',不改用户文字"。本迭代**有意识地修订**这一边界:

- Parlance 现在也产出**改写建议**,但仍坚持 **only-suggest、不自动改用户正文**(只复制,用户手动粘贴)——保留"不替用户落笔"的克制。
- 建议严格 grounded 在检索段落上,延续"可核验、不编造"的原则。
- 原 spec §3 将在落地后补一行交叉引用本文件,记录此次演进。

## 3. 用户故事与成功标准

- 作为中文/英文学术写作者,我选中一句草稿、检索到若干相近段落后,点一个按钮,几秒内看到:这句话哪里笼统/不精确(诊断)、2–3 个**基于上方段落**的改写(每个标明依据哪条出处)、以及可直接借用的措辞/搭配(带出处)。我自己判断后手动采用。
- **成功标准(本迭代):**
  1. 有检索结果时出现「生成改写建议」按钮;点击 → 显示"生成中…" → 显示建议块或友好错误态,不崩溃。
  2. 建议含三段:诊断、改写(每条带 basis/出处)、可借用措辞(带出处)。
  3. 喂给模型的内容**仅限**用户句子 + 已检索段落;模型被指令不得编造法条号/出处/事实。
  4. 建议块明确标注"模型生成,请核验";每条改写显出处供对照。
  5. 无 `GEMINI_API_KEY` 时检索仍可用,仅建议功能给出友好提示。

## 4. 范围

### 本迭代(做)
- 触发:**按需**(面板按钮),不自动。
- 模型:**Gemini**,复用现有 `GEMINI_API_KEY`(与 embedding 同 provider)。
- 架构:**前端直连**——`parlance` 复用已检索 `PhraseHit[]`,调 Gemini 生成。
- 输出:**组合**(诊断 + 带出处改写 + 可借用措辞),结构化 JSON。
- 渲染:段落上方的建议块 + ⚠ banner;改写条目可一键复制(复用现有 copy 机制)。

### 非目标(本迭代明确不做)
- **自动替换/落笔到编辑器**(只复制,用户手动粘贴;auto-apply 留后续)。
- 多轮对话/追问、风格迁移大改。
- 切换 provider(只 Gemini)、自动触发(只按需)。
- 把生成逻辑下沉到 zsearch 后端(本迭代留在前端)。

### 后续迭代(记录,不做)
- 「应用此改写」一键替换选区(需谨慎,跨"改用户文字"红线)。
- 可配置 auto-suggest;provider 可切换(Claude/Gemini)。
- 把 prompt/生成逻辑下沉为 `zsearch suggest`(若要被其他客户端复用)。

## 5. 架构:前端直连 Gemini

```
selection ──(已有)──> zsearchClient.findPhrases ──> PhraseHit[]
                                                      │  (保留 lastQuery={text,hits})
   面板「✍ 生成改写建议」按钮 ──postMessage(suggest)──┘
                          │
                          v
   suggestClient.generateSuggestions(text, hits, cfg, gen) ──> Gemini(JSON mode) ──> Suggestion
                          │
                          v
   renderSuggestion(Suggestion) ──> 面板 #suggest-slot
```

定位:**检索仍由 zsearch 负责,生成是前端 Parlance 的新职责**;模型只收到已检索/已展示的段落,grounding 天然可核验。

## 6. 模块结构(守 200–400 行小文件、注入式可测,与现有一致)

**新增:**
- `src/core/suggestClient.ts`(~150)— `generateSuggestions(text, hits, cfg, gen?)`:构造 grounded prompt、调 Gemini、校验/解析 JSON、错误归类。**transport 注入**:`gen: GeminiGenerator`(默认 `defaultGenerator` 用 `@google/genai`),单测传假实现、不联网——与 `zsearchClient` 的 `CommandRunner` 同套路。
- `src/webview/renderSuggestion.ts`(~80)— 纯函数 `renderSuggestion(s: Suggestion): string`,输出已转义 HTML(同 `render.ts`,可单测)。

**修改:**
- `src/core/types.ts` — 增 `Suggestion`、`SuggestConfig`、`GeminiGenerator`、`SuggestErrorKind`。
- `src/core/config.ts` — 增 `readSuggestConfig()`(读 model/maxPassages;apiKey 从 `process.env.GEMINI_API_KEY`)。
- `src/providers/panelProvider.ts` — 保留 `lastQuery`;`showSuggestionLoading/showSuggestions/showSuggestionError`;`suggest` 消息;`lastSuggestionState`(测试可观测)。
- `src/extension.ts` — 接线:把 suggest handler 注入 provider(handler 调 `generateSuggestions` 并回 post)。
- `media/panel.js` — 「生成改写建议」按钮 → `postMessage({type:"suggest"})`;处理 `suggestion-*` 消息 → 只更新 `#suggest-slot`(不动 hits)。
- `media/panel.css` — 建议块/banner/按钮样式。
- `package.json` — `contributes.configuration` 增 `parlance.suggestModel`、`parlance.suggestMaxPassages`。

## 7. 数据契约(Suggestion)

```ts
interface Suggestion {
  diagnosis: string;                              // 1–2 句:这句话的问题
  rewrites: { text: string; basis: string }[];    // 2–3 条;basis=依据哪段/出处
  phrasings: { text: string; source: string }[];  // 可借用措辞 + 出处
}
```

- Gemini 用 **JSON mode**(`responseMimeType:"application/json"` + `responseSchema` 镜像上结构)强制结构化输出。
- `suggestClient` 解析后做最小校验:三字段存在、`rewrites`/`phrasings` 为数组、元素含必需键;不合则归类 `bad-output`,提示重试(不渲染半成品)。

## 8. Grounding 与 prompt 策略(关键)

**喂给模型的输入(仅此):**
- 用户选中的句子。
- top-N 检索段落(N=`suggestMaxPassages`,默认 6),每段:`[i] 出处(作者·年份·标题) + snippet`,snippet 截断到 ~800 字控成本。

**系统/指令(中文)硬约束:**
- 只能基于"所给段落 + 用户句子"作答;**不得发明**法条号、出处、作者、年份、事实或所给段落中没有的内容。
- 每条改写须在 `basis` 注明依据的段落编号/出处;`phrasings` 的 `source` 同理。
- 若所给段落不足以支撑某改写,**诚实说明**(写进 diagnosis),而非编造。
- 中文输出;严格 JSON(配合 JSON mode)。

**UI 配合:** 建议块顶部固定 ⚠「模型生成,请核验」;每条改写/措辞显出处,用户可对照上方真实段落核验。

## 9. 配置(`contributes.configuration` 增量)

| 键 | 默认 | 说明 |
|---|---|---|
| `parlance.suggestModel` | (Gemini flash 档,确切 id 在 writing-plans 联网核实) | 生成模型;需更细腻可改 pro 档 |
| `parlance.suggestMaxPassages` | `6` | 喂给模型的段落数上限 |

**Key:** 只从 `process.env.GEMINI_API_KEY` 读(与 zsearch 同机制),**不写进 settings.json**(守密钥规则)。代价:从 GUI(Dock/Finder)启动的 VS Code 可能读不到该变量——见 §11 风险。

## 10. 错误处理(仿 `ZsearchClientError`,`SuggestError` 分类)

`SuggestErrorKind = "no-api-key" | "network" | "bad-output" | "no-hits" | "unknown"`

- 无 key:建议区提示"缺 `GEMINI_API_KEY`,检索不受影响;请在能读到该变量的环境启动 VS Code"。
- 网络/超时:设超时,提示重试。
- 非 JSON / 校验失败:`bad-output`,提示重试(不渲染半成品)。
- 无 hits:按钮禁用 / 提示先检索。
- 其他:surfacing 原始错误摘要(经 textContent 安全渲染,延续现有 XSS 处理)。

## 11. 已知 gap / 风险(诚实标注)

- **模型输出质量测不了:** "是否真 grounded / 中文是否地道 / 改写是否更好"是主观,自动化测试只保证*结构、grounding 管道(模型只收到检索段落)、不崩、JSON 合法*;质量靠用户眼看。
- **env key 可达性:** 前端调 Gemini 需扩展宿主进程能读到 `GEMINI_API_KEY`;GUI 启动的 VS Code 可能没有(与现有 zsearch spawn 同样的既有约束,非本迭代新增)。文档需说明:从已 `source ~/.env` 的终端启动 `code`,或用 launchd 环境。
- **成本/延迟:** 每次点按钮 = 一次 Gemini 调用 + 几秒。已用按需触发 + 段落封顶/截断缓解。
- **段落 overlap:** 检索段落本就可能相邻重复(原 spec §11),喂给模型前沿用展示侧的去重。

## 12. 测试策略

- **单测(vitest):**
  - `suggestClient`:注入假 `gen`,测 prompt 构造(含句子 + N 段 + grounding 指令)、JSON 解析/校验、错误分支(no-api-key/network/bad-output/no-hits)、段落封顶 + 截断。
  - `renderSuggestion`:纯 HTML 转义、三段结构、⚠ banner、改写条带 `.copy-btn`。
  - `panel.dom`(扩展):「生成建议」按钮 → `postMessage({type:"suggest"})`;`suggestion-*` 消息 → 只更新 `#suggest-slot`。
- **集成(@vscode/test-cli):**
  - 按需 suggest 路径走通;`lastSuggestionState` 反映 loading→suggestions/error(扩展现有可观测钩子)。
  - golden path(有 key 时,否则 `this.skip()`):真实 Gemini 返回合法 `Suggestion`,三段非空。
- 延续现有 vitest 22(render 8 + zsearchClient 9 + panel.dom 5)+ 集成 5 全绿,新增不破旧。

## 13. 开放问题(留给 writing-plans / 实现)

1. `@google/genai` 确切包名/版本与 JSON-mode API 形态(联网核实,API 会演进)。
2. `suggestModel` 默认确切 id(flash 档具体型号)。
3. `lastSuggestionState` 与现有 `lastState` 合并还是并列(实现时定,以测试可断言为准)。
4. 建议块放段落"上方固定"还是"可折叠";改写「复制」复用现有 `.copy-btn` 委托即可。
