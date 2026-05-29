# 下一会话任务简报:自动化 Parlance 扩展端到端验证(免人工 F5)

> 读完本文件即可独立执行,无需上一会话的上下文。

## TL;DR(你的任务)
为 Parlance VS Code 扩展建立**命令行可跑的集成测试**(`@vscode/test-electron` / `@vscode/test-cli`),自动验证扩展在真实 VS Code 实例里能:激活、注册命令与视图、正确处理空选区与坏配置的错误路径,并在嵌入 API key 可用时跑通真实"选中→检索→出结果"的 golden path。**目标:让用户尽量不必亲自按 F5。** 完成后走 `superpowers:finishing-a-development-branch`。

## 项目背景(self-contained)
Parlance 是一个 VS Code 扩展:用户在编辑器选中一句话 → 扩展 `spawn` `zsearch phrases "<text>" --json -k N` → 解析返回的 JSON(相近段落 + 出处)→ 在侧栏 Webview 面板展示(snippet + 距离 + 作者·年份·标题 + 复制/跳 Zotero 按钮)。
- 扩展仓库:`/Users/xianweizhang/Projects/parlance`(TypeScript + esbuild + vitest)
- 后端:`zsearch`(在 `/Users/xianweizhang/Projects/zotero-cli-agent`,Python CLI,对本地 Zotero 库做语义检索;本扩展依赖它的 `phrases` 子命令)
- 设计 spec:`parlance/docs/superpowers/specs/2026-05-28-parlance-design.md`
- 实现 plan:`parlance/docs/superpowers/plans/2026-05-28-parlance-mvp.md`(其 Task 7 是 smoke,务必读)

## 已完成(勿重复造)
MVP 代码已全部实现并通过 per-task 双复审,两仓库都在 `main`(用户已授权直接在 main 工作):
- **Phase 1**(zotero-cli-agent,commits `c9ecf1d`→`c03a02b`):`search.py` 的 `query_chunks` + `cli.py` 的 `phrases` 命令。**已用真实库 live smoke 通过**。
- **Phase 2**(parlance,commits `9bce36f`→`20c4668`):`src/core/{types,config,zsearchClient}.ts`、`src/webview/render.ts`、`src/providers/panelProvider.ts`、`src/extension.ts`、`media/{panel.css,panel.js,icon.svg}`、`.vscode/launch.json`。
- 验证现状:**vitest 23 单测全绿**(zsearchClient 9 + render 8 + Python 6=23,其中 Python 在 Phase 1 仓库)、`npm run typecheck` clean、`npm run build` 产出 `dist/extension.js`。
- **唯一未做:扩展宿主层的端到端 smoke**(plan Task 7 的 F5 部分)。

关键契约(已 final-review 确认四层一致):
`PhraseHit = { key:string, chunk_idx:number, distance:number, snippet:string, title:string|null, creators:string[], date:string|null, venue:string|null, doi:string|null }`。
命令 id `parlance.findSimilarPhrasing`;view id `parlance.results`;config `parlance.zsearchPath`(默认 `zsearch`)、`parlance.topK`(默认 10)。

## 怎么做(推荐路线)

### 0. 先核实环境(决定能否跑真实 golden path)
- key:`grep -o 'GEMINI_API_KEY' ~/.env 2>/dev/null | head -1`。扩展 spawn zsearch 时继承 `process.env`,所以集成测试启动前需让该进程能读到 key(例如测试 launcher 里 `source ~/.env` 后再跑,或注入 env)。
- 库:`sqlite3 ~/.local/share/zotero-cli/vectors.sqlite "SELECT count(*) FROM items WHERE key LIKE '%#c%'"`(上一会话验证过有约 15000 个 chunk)。
- zsearch 可执行:`which zsearch || ls ~/Projects/zotero-cli-agent/.venv/bin/zsearch`。若不在 PATH,集成测试里把 `parlance.zsearchPath` 指向 venv 内绝对路径。

### 1. 加集成测试栈
devDeps:`@vscode/test-cli` + `@vscode/test-electron` + `mocha` + `@types/mocha`。加 `.vscode-test.mjs` 配置 + `package.json` script `"test:integration": "vscode-test"`。它会自动下载一份 VS Code 并在其中运行 mocha 测试。**核对最新 API**(可联网查 @vscode/test-cli 文档,API 会演进)。

### 2. 关键坑——vitest 与集成测试的 glob 冲突(务必处理)
vitest 当前 `include: ["src/**/*.test.ts"]`,而集成测试要 `import * as vscode from "vscode"`(只有在扩展宿主里才有该模块)。若集成测试也命名 `*.test.ts` 放在 src/ 下,**vitest 会抓到它并因 import vscode 失败**。
解决:集成测试放 `src/test/suite/*.test.ts`,并在 `vitest.config.ts` 加 `exclude: ["src/test/**"]`;集成测试需先用 `tsc` 编译到独立目录(如 `out-test/`)再由 vscode-test 运行(它跑的是 JS,不是 vitest 的 esbuild 即时编译)。把 `out-test/` 加进 `.gitignore`。

### 3. 测试场景(按是否需要 key 分层)
- **不需 key(必做,一定能自动化):**
  - 扩展能 `activate` 不抛。
  - `vscode.commands.getCommands(true)` 含 `parlance.findSimilarPhrasing`。
  - 空选区时执行命令不抛(warning toast 难断言,验证不崩即可)。
  - 把 config `parlance.zsearchPath` 设成不存在的值后执行命令 → 走 error 路径不崩,且面板进入 error 状态(用下面的状态钩子断言)。
- **需 key(条件做;无 key 或库则 `this.skip()` 并打印原因):**
  - 创建含中文句子的文档、设 selection、执行命令,`await` 一小段后断言 findPhrases 真实返回 ≥1 条、provider 进入 results 状态、无异常。

### 4. 让"面板状态"可断言(webview DOM 在集成测试里拿不到)
给 `PanelProvider` 加一个最小、不影响生产行为的可观察点,如:
`public lastState?: { kind: "loading" | "results" | "error"; count?: number; message?: string };`
在 `post()`(或 show* 方法)里更新它。集成测试通过它断言命令执行后的状态。这是为可测性做的**小**改动,可接受;有更干净的方案(如 EventEmitter)也行。改完保持 vitest/typecheck/build 全绿。

### 5. 跑起来
`npm run test:integration`。mac 本地有显示,通常无需 xvfb;若报显示相关错误,研究 @vscode/test-electron 的 headless 选项。

## 边界与诚实交付
- 纯视觉(配色、按钮长相)集成测试断不了——但 HTML 由 `render.ts` 生成且已单测,`panel.js` 只是消息 switch + 按钮 postMessage(简单)。可接受不自动化这层;若你判断有必要,可用 jsdom 给 `panel.js` 的消息处理做轻量单测(需把它写成可测形式,谨慎权衡)。
- 复制/跳 Zotero 按钮(webview→扩展消息)在集成测试里难触发;`openExternal`/`clipboard` 可在"需 key"测试里间接覆盖,或作为唯一人工确认项(若如此,给出最小步骤)。
- 结束时**如实报告**:哪些场景已自动跑通、哪些 skip(为什么)、是否还剩任何必须人工的一步(力求为零,或仅"瞄一眼面板")。

## 约束
- 两仓库都在 `main`,用户已授权直接工作。
- 遵循 TDD 风格;改动尽量小,不为测试大改生产代码(给 PanelProvider 加只读状态钩子这种小改可以)。
- **只有用户明确要求才 commit / push**;做完先报告,问是否提交。
- 涉及联网(下载 VS Code、调用嵌入 API)和 key,注意并如实说明。

## 完成后
所有自动化验证通过后,用 `superpowers:finishing-a-development-branch` 收尾(两仓库在 main:确认状态、是否合并/推远端等,交用户定)。若 smoke 暴露 bug,用 `superpowers:systematic-debugging`。

## 关键路径速查
- 扩展:`/Users/xianweizhang/Projects/parlance`
  - `src/extension.ts` — activate + 命令 `parlance.findSimilarPhrasing`(取 selection → findPhrases → provider.show*)
  - `src/providers/panelProvider.ts` — WebviewView 面板 + 消息(`copy`/`jump` ← webview;`loading`/`results`/`error` → webview);有 pending 队列;CSP nonce
  - `src/core/zsearchClient.ts` — `findPhrases(text,cfg,run?)` spawn + 解析;`classifyError`(kinds:not-installed/no-api-key/no-index/empty-selection/unknown)
  - `src/webview/render.ts` — `renderHits` 生成已转义的 HTML
  - `src/core/config.ts` — `readConfig()`
- 后端:`/Users/xianweizhang/Projects/zotero-cli-agent` — `zsearch phrases "<text>" --json -k N`
- spec / plan:见"项目背景"
