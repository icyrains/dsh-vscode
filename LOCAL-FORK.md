# 本地分支说明（dsh-vscode-local）

本目录是 [`Fengze233/dsh-vscode`](https://github.com/Fengze233/dsh-vscode) 的本地克隆，
在商店版 **0.4.3** 的基础上做了三处改动，并以 **0.5.0** 本地构建、本地安装。

> 上游仓库：https://github.com/Fengze233/dsh-vscode
> 本分支推送目标：https://github.com/icyrains/dsh-vscode（`origin` 已指向此 fork；与上游同源，`main` 同基线）
> 克隆位置：`G:\DSH\dsh-vscode-local`
> 本分支基线：`v0.4.2`（commit `75abca4`；0.4.3 的改动也在本分支内，未单独打 tag）

---

## 一、为什么要有这个本地分支

商店版有两处不满足需求（0.5.0 另新增第三项能力）：

1. **面板里点「本轮文件改动」无法在 VS Code 中看 Diff**——DSH 的改动对比只在网页里渲染。
2. **相对路径按 VS Code 工作区根解析，而不是按当前 DSH 会话的工作区**——0.4.2 移除了工作区同步后，
   桥接不再发送 `cwd`（源码注释写着「会话 cwd 不再维护」），于是 DSH 会话的工作目录与
   VS Code 工作区不同时（或在多个工作区之间切换会话时）会解析到错误位置。
3. **（0.5.0 新增）没有「右键把文件引用给 DSH」的入口**——只能自己手打 `@` 路径。

上游改动周期不可控，因此改为**本地改、本地构建、本地安装**。

---

## 二、改了什么

### 改动 1：本轮文件改动 Diff 可在 VS Code 中查看

在对话里的「本轮文件改动」卡片上点击任一文件行 → 用 `vscode.diff` 打开
「该轮起始内容 ↔ 磁盘当前内容」，标题取 DSH 的展示路径并标注「本轮改动前」。

**技术难点与解法**（都不是「顺手就能加」的，记录在这里以免日后重做时重新踩）：

- **旧侧全文从哪来**：`/api/changes.diff` 只返回 hunks，**不给完整的前后文件文本**，
  且刻意隐藏 cwd 与快照树 id
  （`ChangesSummary = Pick<WorkspaceChangesSummary, 'turn'|'files'|'total'|'added'|'deleted'>`）。
  但 unified diff 的语义是精确的——**hunk 之外的行两侧逐字节相同**。因此以磁盘当前内容为
  turn-end 侧、按 hunk 反向还原 turn-start 全文，做到**逐字节精确**，不需要任何新接口。
  还原算法已与 DSH 真实的 `compareText`（`structuredPatch`，`context: 3`）交叉验证
  （随机化属性测试 6000 组、0 失败；见 `probe-results/`）。
- **坐标从哪来**：`seq` 只存在于 React 闭包（`changes.seq`），**DOM 里完全没有**，
  单靠 DOM 无法构造该端点参数。故桥接**旁路观察 DSH 自己发出的**
  `changes.summary` / `changes.diff` 请求（本插件本就 patch 了 `window.fetch` 做图片降级），
  从服务端 JSON 取权威坐标与 hunks；点行按钮时若 diff 尚未被 DSH 拉取，则按坐标**现取**。
  该路径不依赖任何 CSS Module 哈希类名，也不需要解析本地化文案。
- **「磁盘就是 turn-end」必须被校验，不能假设**（这是最容易出**静默错误**的地方）：
  DSH 的 hunks 由**两个 git 快照树**算出
  （`dsh-workspace-changes/lib/types/recorder.js` 的 `readSide` → `case 'snapshot'` → `treeBlob`），
  而扩展只能读**当前磁盘**。该轮之后文件只要再被改过（下一轮编辑、手动改、格式化、
  `git checkout`、外部工具），磁盘就不再是 turn-end，反推出的旧侧会**看起来合理但完全错误**。
  因此按 hunk 的 `newStart` 把上下文行/新增行逐行锚回磁盘做一致性校验
  （`afterSideMatchesHunks`）；不符就**提示原因并改为直接打开文件**，绝不展示假 Diff。
  边界：hunk 只覆盖「变更区 ± 3 行」，更远处的改动察觉不到——这是端点载荷的固有限制
  （`/api/changes.diff` 不给完整文本、也没有内容哈希）。
- **歧义时宁可不动**：同一文件在多轮里都被改过时，各轮的「文件路径指纹」完全相同，
  按「取最新」必然把旧卡片显示成最新一轮。现改用 `data-turn-tail`（卡片所在轮次，
  与 summary 的 `turn` 同源）精确消歧；仍无法确定时保留 DSH 原生行为。

### 改动 2：相对路径按「当前 DSH 会话工作区」解析

点击相对路径时，从 DOM 取当前会话 id（`[data-conversation-session]` /
`[data-sidebar-right-session]`），经 cordis 的 `sessions` 服务惰性查该会话的 `cwd` 并随消息下发；
扩展侧 `resolveBridgePath` 本就优先用 `sessionCwd`。于是 A 工作区的会话解析到 A、B 会话解析到 B，
**切换即时生效**（每次点击实时读取，不缓存）。

- **刻意不声明 `dsh.client.inject: ['sessions']`**：硬依赖一旦不满足会让整个桥接
  （含外链跳转、剪贴板、图片降级）都无法挂载。改为 `apply(ctx)` 存下上下文、点击时惰性解析，
  服务不可用时只是退回工作区根，其余能力完全不受影响。
- **当前会话必须以 DOM 为准**：DSH 的会话列表快照**没有** `current` 字段
  （实证 `SessionListState = { ids, byId, phase, projectionsBySession }`），不能用快照猜。

### 改动 3（0.5.0 新增）：右键把文件「引用到 DSH」

在资源管理器 / 编辑器标签页 / 编辑器正文三处右键 → 选中的文件或文件夹变成当前 DSH 会话
输入框里的一个 `@` **引用芯片**，随后可直接打字发送。支持多选批量。菜单命令为
`DSH: Reference to DSH`（`dsh.referenceToDsh`），可同时在命令面板直接调用。

**为什么不做成「插入纯文本 `@路径`」**：DSH 的 `@` 引用是 Lexical 的**原子节点**
（`ReferenceChipNode`），不是普通文本——它有图标、参与撤销栈、粘贴与发送语义。
自己往输入框塞文本会得到一个「看起来像但没有芯片语义」的字符串。而 DSH 自身就暴露了正规入口：

```js
ctx.get("conversation").input.shell(sessionId).addFiles(references, attachmentIds)
```

这正是 DSH「把文件拖进输入框」走的**同一个方法**
（`ui-conversation` 的 `addFiles` → `draftEditor.insertFileReferences` → `$replaceDetectSpanWithNodes`）。
调用它得到的芯片与原生拖拽逐字节一致。字段也逐项对齐原生拖拽代码：
`source='reference'`、`ref=@path`、`label=文件名`、`appearance='file'|'folder'`、`clipboardText=ref`。

- **相对路径按「会话 cwd」相对化，不是 VS Code 工作区根**：扩展只传**绝对路径**，
  页面侧用会话 `cwd` 做相对化（复刻 DSH 的 `relativizeToCwd` 与 `formatFileMention` 规则）。
  多根工作区/远程场景下两者不一致，按 VS Code 根解析会指错文件。
  这是改动 2 的同一条原则在「写入方向」上的应用。
- **当前会话如何确定**：优先 `uiWorkspace.selection`（持久化于 `dsh.sessions.current`，
  是主视图真正的驱动源），仅当它不可用/指向已消失会话时才退回 DOM 的
  `[data-conversation-session]`。既不硬依赖 `uiWorkspace`，也不会在服务缺失时彻底失效。
- **一处与 DSH 的有意差异**：本桥接的 `relativizeToCwd` 在比较前把两侧分隔符统一为 `/`。
  DSH 只做裸 `startsWith`、从不归一化；它自己的拖拽两端同风格所以没问题，但本桥接的
  `cwd` 来自 DSH（Windows 上可能是 `C:\ws`）、路径来自 VS Code，**不归一化就会在 Windows 上
  退化成正斜杠绝对引用**，与原生拖拽的 `@a.ts` 不一致。已由单测钉住。
- **失败绝不静默**：定不到会话、输入框未就绪、正在发送而拒绝插入、面板未打开、页面超时……
  每个分支都有机读原因 + 用户可读文案两层，并写进扩展日志。页面回执按 `requestId` 配对，
  每条请求都有超时，命令不会悬挂。
- **菜单位次必须用 `navigation@-1`，不能用自定义组名**（初版用了 `dsh@1`，用户反馈"太靠后"）。
  这不是审美偏好，而是 VS Code 排序规则的硬约束——`MenuInfo.compareMenuItems`
  （`src/vs/platform/actions/common/menuService.ts`）规定：空 group 排最后 →
  **`navigation` 组硬编码排最前**（专门分支，不走字典序）→ 其余按字典序 → 组内按 order。
  而 `group@<order>` 的 `@` 后缀会被剥离（`menusExtensionPoint.ts` 用 `lastIndexOf('@')`）。
  所以「排最前」= 组名 `navigation` + order 为负。
  实测（复刻官方算法、读本机真实扩展数据，见 `G:\DSH\menu-order-probe`）：
  三处右键菜单都从第 16/28/4 位变为**第 1 位**，且都排在同为 `navigation` 组、order 0 的
  Codix「Add File to Codix」**之前**。该契约已由 `test/package.test.ts` 的专门测试固化。

> 注意：插入逻辑跑在 **DSH 页面内的桥接 bundle** 里，属扩展侧改动 →
> **必须 `Developer: Reload Window` 后生效**（与改动 2 同理）。
> 菜单项的 group 改动同理：VS Code 在窗口加载时读取扩展清单，也需重载窗口。

---

## 三、怎么构建与安装

```bash
cd G:\DSH\dsh-vscode-local

# ① 安装依赖（本机沙箱下需要，见「已知环境问题」）
npm install --ignore-scripts --cache ./.npm-cache
npm install @esbuild/win32-x64@0.25.12 --no-save --ignore-scripts --cache ./.npm-cache

# ② 类型检查 + 测试
npm run typecheck
node scripts/build.mjs --test && node --test "out/test/**/*.test.js"

# ③ 构建并打包
node scripts/build.mjs
npx vsce package -o dsh-vscode-0.5.0.vsix --allow-missing-repository

# ④ 安装扩展
& "C:\Program Files\Microsoft VS Code\bin\code.cmd" `
    --install-extension .\dsh-vscode-0.5.0.vsix --force

# ⑤ 把本地桥接装进 DSH 运行时（复用安装器逻辑，幂等可重放）
node scripts/apply-local.mjs

# ⑥ 刷新 VS Code 面板（关掉重开即可；无需重启 DSH 服务）
```

> ⚠️ **顺序不能省**：`node scripts/build.mjs --test` 只产出 `out/test/**` 与桥接产物，
> **不产出 `out/extension.js`**。若跳过 ③ 直接打包，`vsce` 会报
> `Extension entrypoint(s) missing ... extension/out/extension.js`。
> 打包前务必先跑一次不带 `--test` 的 `node scripts/build.mjs`。

> **关于「要不要重启 DSH」**：改**桥接**（`bridge-client/lib/client.js`）不需要重启——
> DSH 的 `@deepseek-ai/dsh-client-hmr` 每 500ms stat 轮询各 bundle，检测到变化即调用
> `clientModules.rebuilt()` 重读字节并递增 rev，页面会自动换到新代码（实测：面板里
> `client.js executed` 的行号随构建变化，说明服务端已换新）。
> 只有**结构性改动**（`cordis.patch.yml` 里增删插件条目、装载新的包）才需要重启 DSH web。
> 改**扩展侧**（`src/**`）则需要重载 VS Code 窗口（`Developer: Reload Window`）。

`scripts/apply-local.mjs` 复用 `src/bridge/installer.ts` 的 `installBridge`
——与扩展激活时走的是**同一套**逻辑（多目标目录、`cordis.patch.yml` 幂等写入、
版本/内容不一致强制重装、重复条目自愈去重、issue #20 的他人目录白名单保护），
因此不会出现「手工拷贝」与安装器行为漂移。加 `--uninstall` 可还原。

它会把桥接同时刷新到三个位置（缺一不可，见 installer.ts 注释）：

| 位置 | 作用 |
|---|---|
| `~/.dsh/profiles/web/node_modules/dsh-vscode-bridge` | primary（WSL 模块解析锚点） |
| `~/.dsh/profiles/node_modules/dsh-vscode-bridge` | secondary（Windows profile 插件解析 fallback） |
| `%APPDATA%/npm/node_modules/dsh-vscode-bridge` | npm 全局（扩展宿主 spawn 的 dsh 的 ESM 解析可达位置） |

> **注意**：`cordis.patch.yml` 里的 `# dsh-vscode-bridge: begin/end` 标记块是安装器的
> 权威写入点；历史原因文件里可能还遗留若干**无标记**的 `- insert: dsh-vscode-bridge` 条目。
> 若插件树因此崩溃（issue #19），先删掉那些无标记条目，再重跑 `apply-local.mjs`。

---

## 四、升级商店版之后怎么恢复

商店版升级会覆盖扩展目录，从而丢掉本地改动。恢复步骤：

```bash
cd G:\DSH\dsh-vscode-local
git fetch origin && git log --oneline origin/main -3   # 看上游是否有新提交
node scripts/build.mjs                                  # 重新构建
npx vsce package -o dsh-vscode-0.5.0.vsix --allow-missing-repository
& "C:\Program Files\Microsoft VS Code\bin\code.cmd" --install-extension .\dsh-vscode-0.5.0.vsix --force
node scripts/apply-local.mjs
```

若期间还执行过 `git pull` 合上游代码，重点回看这三处是否被上游覆盖：

- `bridge-client/lib/core.js` —— 新增 `parseChangesQuery` / `isWorkspaceFileDiff` /
  `buildOpenDiffMessage` / `findSessionId` / `changedFileIndexOf` / `changesDiffUrl` /
  `sessionCwdFrom` / `changedFileAt` / `isChangesToggle` / `BoundedMap` /
  `pathTailMatches` / `matchChangesSeq`，以及 `CHANGED_FILES_CARD_SELECTOR` 等常量
- `bridge-client/lib/client.js` —— `interceptChangesFetch` / `tryOpenChangesDiff` /
  `fetchAndPostDiff` / `currentSessionCwd` / `pickChangesFor`，以及 `exports.apply(ctx)`
- `src/bridge/host.ts` —— `isFileDiff` / `splitComparableLines` / `reconstructBefore` /
  `handleOpenDiff`、`bridgeOpenDiff` 分支与对应 deps（`readFileText` / `putBeforeDoc` / `openDiff`）
- `src/bridge/diff-doc.ts`（**新增文件**）—— `DiffDocStore` / `registerDiffDocProvider` /
  `DIFF_BEFORE_SCHEME` / `basenameOf` / `beforeDocLabel`，以及 `src/extension.ts` 里的注册调用

---

## 五、验证方式

**自动化**（无需人工）：`test/bridge/interceptor.test.ts` 用 `node:vm` 建了一个最小浏览器沙箱，
直接加载**构建产物** `out/bridge-client/lib/client.js`，用 DOM 桩模拟点击，断言：

- 点改动卡片行按钮 → 发布 `openDiff`，且转发的是服务端权威 hunks；
- 点「展开/收起全部」控件 → **不**发布 `openDiff`（排除误触）；
- 点普通文件入口 → 发布 `openFile` 且**携带当前会话 cwd**。

**人工**（面板里）：

1. 让 DSH 改一个文件（或打开一个已有改动的会话）。
2. 面板里点「本轮文件改动」卡片上的文件行 → 应在 VS Code 中打开原生 diff。
3. 面板里点正文/工具行里的相对路径 → 应打开**当前 DSH 会话工作区**下的文件。
4. DevTools 控制台应能看到：
   - `[dsh-vscode-bridge] client.js executed`
   - `[dsh-vscode-bridge] handshake ok, v0.5.0, imageFallback=...`
   - 点改动行时：`[dsh-vscode-bridge] open diff in VS Code → <path>`

---

## 六、已知环境问题（本机 Windows）

1. **`npm install` 在沙箱内会 EPERM**：npm 的默认缓存在工作区外。用
   `--cache ./.npm-cache` 把缓存放到仓库内即可（`.gitignore` 已忽略该目录）。
2. **`--ignore-scripts` 会跳过 esbuild 的平台二进制安装**，导致 `spawn EPERM` /
   `Cannot find module @esbuild/win32-x64`。补一条
   `npm install @esbuild/win32-x64@0.25.12 --no-save --ignore-scripts` 即可。
3. **本仓库部分用例硬编码 POSIX 路径**（如 `/proj/src/main.ts`、`/home/u/.dsh`），
   在 Windows 上必然失败；另有依赖 PATH 上有 `dsh` 的真实链路用例会因 `dsh` 不可用而失败。
   本机实测基线为 **39 条失败**（改动前后一致，与本次改动无关）。CI 在 Ubuntu 上跑，这些用例是绿的。
4. **git 直连 GitHub 报 `schannel: SEC_E_NO_CREDENTIALS`**：本机 TLS 走 schannel 失败，
   而 Python 的 TLS 正常。克隆/拉取时加 `-c http.sslBackend=openssl` 即可
   （本仓库已 `git config http.sslBackend openssl` 固化）。

---

## 七、能否删除

这个目录是上述两处改动的**唯一源码副本**（商店版没有这些改动），
删掉之前请确认改动已另存或已回流上游。删除命令：

```powershell
Remove-Item -Recurse -Force G:\DSH\dsh-vscode-local
```

（注意：删除目录**不会**卸载已装的扩展与已写入 DSH 运行时的桥接；如需一并还原，
先跑 `node scripts/apply-local.mjs --uninstall`，再在 VS Code 里卸载 `Fengze233.dsh-vscode-panel`。）
