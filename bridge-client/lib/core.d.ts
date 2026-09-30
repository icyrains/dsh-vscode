// bridge-client/lib/core.d.ts — core.js 的类型声明（供 TS 侧 import 获得类型）
// 与 core.js 的运行时导出保持一致；纯逻辑无 DOM，可在 node 环境 import。

/** 外链协议白名单：仅 http/https 且非空返回 true */
export function isAllowedExternalUrl(url: string): boolean;

/** 构造"打开外链"消息 */
export function buildOpenExternalMessage(url: string): { kind: 'openExternal'; url: string };

/** 构造"打开文件"消息（cwd 为会话工作目录，可选） */
export function buildOpenFileMessage(path: string, cwd: string | undefined): { kind: 'openFile'; path: string; cwd?: string };

/**
 * DSH 页面里「文件入口」按钮的稳定选择器（issue #22）：
 * 覆盖 markdown 文件名（CSS Module 哈希类名）/ produced 芯片 / present 卡片，
 * 并排除 aria-haspopup 的宿主菜单按钮。
 */
export const FILE_ENTRY_SELECTOR: string;

/** 从被点击的文件入口按钮解析要转发的路径（title 优先；aria-label 仅作兜底）；无法判断返回 null */
export function resolveFileEntryPath(btn: unknown): string | null;

/** 构造"工作区同步回执"消息（bridgeAck，path 可选；version 为桥接包版本） */
export function buildSyncWorkspaceAck(ok: boolean, path?: string, version?: string): { kind: 'bridgeAck'; ok: boolean; path?: string; version?: string };

/** 构造"复制文本"消息（iframe 页面 → 父页面 → 扩展 → 系统剪贴板） */
export function buildCopyTextMessage(text: string, requestId: string): { kind: 'copyText'; text: string; requestId: string };

/** 构造"复制文本回执"消息（父页面 → iframe 页面） */
export function buildCopyTextAck(requestId: string, ok: boolean): { kind: 'copyTextAck'; requestId: string; ok: boolean };

/** 校验来自父页面的消息 token（握手防伪） */
export function isBridgeMessage(data: unknown, token: string): boolean;

/** 握手 token 字段名（父页面发来的消息里携带） */
export const HANDSHAKE_TOKEN_KEY: string;

/** 键盘事件关键字段（getShortcutCommand 的输入，兼容真实 KeyboardEvent 与测试桩） */
interface ShortcutEventLike {
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

/** 编辑命令枚举（getShortcutCommand 的返回） */
type EditCommand = 'copy' | 'paste' | 'cut' | 'selectAll' | 'undo' | 'redo';

/**
 * 从键盘事件判定"标准编辑快捷键"命令（VS Code 吞掉 iframe 内 Cmd+C/V/A 的修复）。
 * 命中返回对应编辑命令；未命中返回 null（调用方应放行原事件）。
 */
export function getShortcutCommand(e: ShortcutEventLike | null | undefined): EditCommand | null;

/** 判定元素是否为可编辑元素（textarea / 可输入 input / contenteditable） */
export function isEditableElement(el: unknown): boolean;

/** 计算在 [start, end) 选区插入 text 后的新值（越界/负值归一） */
export function computeInsertedValue(
  value: string | null | undefined,
  start: number,
  end: number,
  text: string,
): string;

/** 构造"读取剪贴板"消息（iframe 页面 → 父页面 → 扩展 → 系统剪贴板读取，粘贴兜底用） */
export function buildReadTextMessage(requestId: string): { kind: 'readText'; requestId: string };

/** 构造"读取剪贴板回执"消息（父页面 → iframe 页面）；成功带 text，失败省略 text */
export function buildReadTextAck(
  requestId: string,
  ok: boolean,
  text?: string,
): { kind: 'readTextAck'; requestId: string; ok: boolean; text?: string };
// —— v0.3.0 图片缓存降级消息（与 core.js 运行时导出保持一致） ——

/** 图片缓存文件扩展名白名单 */
export const IMAGE_CACHE_EXTENSIONS: readonly string[];

/**
 * 生成图片缓存文件名（不含目录）：dsh-imgcache-<ts>-<i><ext>。
 * 扩展名不在白名单返回 null。
 */
export function imageCacheFilename(timestamp: string | number, index: number, ext: string): string | null;

/** 构造「保存图片」上行消息 */
export function buildSaveImageRequest(
  requestId: string,
  name: string,
  dataB64: string,
  sessionCwd: string | undefined,
): { kind: 'saveImage'; requestId: string; name: string; dataB64: string; sessionCwd?: string };

/** 解析「保存图片」回执；requestId 不匹配或形状不合法返回 null */
export function parseSaveImageAck(
  data: unknown,
  expectedRequestId: string,
): { ok: boolean; path?: string } | null;

/** 构造「删除图片缓存」上行消息 */
export function buildDeleteImagesRequest(
  requestId: string,
  paths: string[],
): { kind: 'deleteImages'; requestId: string; paths: string[] };

/** 解析「删除图片缓存」回执；requestId 不匹配或形状不合法返回 null */
export function parseDeleteImagesAck(data: unknown, expectedRequestId: string): { ok: boolean } | null;

// —— v0.3.0 图片自由上传降级（与 core.js 运行时导出保持一致） ——

/** 判定一次 RPC 响应是否为「模型不支持图像输入」而被拒 */
export function detectModelReject(data: unknown): boolean;

/** 内容块数组是否含图片块 */
export function isPromptWithImages(content: unknown): boolean;

/** 提取内容块中的全部图片块（保持消息顺序=上传/发送顺序） */
export function imageBlocksOf(content: unknown): unknown[];

/** 把本条消息的图片块按顺序映射到已捕获缓存条目，返回有序子集（只引用本条消息的图片） */
export function matchCapturedImages(
  content: unknown,
  entries: { key?: string; name?: string; b64?: string; mime?: string }[],
): { key?: string; name?: string; b64?: string; mime?: string }[];

/** 提取内容块中的全部文本（按顺序拼接） */
export function extractPromptText(content: unknown): string;

/** 中文数字 1..10（超出用阿拉伯数字兜底） */
export function zhOrdinal(n: number): string;

/** 构造图片地址行：图片一/图片二…：<绝对路径>（n 为 1 起序号；缺省时为 '图片：<路径>' 简写） */
export function buildImagePointerLine(path: string, n?: number): string;

/** 构造纯文本内容块数组（原文本 + 图片指针行） */
export function buildTextOnlyContent(content: unknown, pointerLines?: string[]): { type: 'text'; text: string }[];


/** 文件指纹（去重键）；关键字段缺失返回 null */
export function imageCacheKey(fileLike: unknown): string | null;

/** 解包 RPC 请求体 → 业务 payload（兼容 {rpcId,payload} 与直传两种形态） */
export function unwrapRpcPayload(body: unknown): unknown;

/**
 * 端点方法名归一化：斜杠端点（DSH ≥0.1.2 的 session/prompt）与点分端点（≤0.1.1 的
 * session.prompt）统一为点分，便于两代共用同一套判断。非字符串返回空串。
 */
export function normalizeRpcMethod(method: unknown): string;

/**
 * 解包 RPC 请求体 → 业务请求对象（含 content/sessionId/mode 等）。
 * ≤0.1.1：payload 直挂业务字段；≥0.1.2：payload.args.<参数名>（prompt 为 request、
 * list 为 _request）。找不到业务对象时原样返回 payload/body。
 */
export function unwrapRpcRequest(body: unknown): unknown;

/** 以纯文本内容重构 RPC 请求（保留 type/method 与业务字段，仅换新 rpcId 与 content） */
export function buildTextResendRequest(
  originalBody: unknown,
  content: { type: 'text'; text: string }[],
): {
  type?: string;
  rpcId: string;
  method?: string;
  payload: Record<string, unknown>;
};

/** 从 fetch 的 input 提取 URL 字符串（string/URL(href)/Request(url)）；取不到返回 '' */
export function resolveFetchUrl(input: unknown): string;

// —— v0.4.3：在 VS Code 中打开「本轮文件改动」Diff（坐标解析 + turn-start 全文反推） ——

/** DSH「本轮改动摘要」端点（document-relative） */
export const CHANGES_SUMMARY_ROUTE: string;

/** DSH「单文件前后对比」端点（document-relative） */
export const CHANGES_DIFF_ROUTE: string;

/** 从 URL 解析 DSH 改动端点坐标；非本端点或参数不合法返回 null */
export function parseChangesQuery(
  url: string,
  base?: string,
): { route: 'diff'; sessionId: string; seq: number; index: number } | { route: 'summary'; sessionId: string; seq: number } | null;

/** 校验 `/api/changes.diff` 的 JSON 形状是否可转发（轻校验，权威校验在扩展宿主） */
export function isWorkspaceFileDiff(value: unknown): boolean;

/** 构造「在 VS Code 中打开 Diff」上行消息（只转发原始 hunks，turn-start 全文由宿主反推） */
export function buildOpenDiffMessage(req: {
  path: string;
  diff: unknown;
  cwd?: string;
  display?: string;
}): { kind: 'openDiff'; path: string; diff: unknown; cwd?: string; display?: string };

/** 「本轮文件改动」卡片容器选择器 */
export const CHANGED_FILES_CARD_SELECTOR: string;

/** review 标签页容器选择器 */
export const CHANGES_REVIEW_SELECTOR: string;

/** review 标签页「当前文件」选择按钮选择器（`data-review-file` = 相对路径） */
export const REVIEW_FILE_SELECTOR: string;

/** 右侧栏容器选择器（`data-sidebar-right-session` = 会话 id） */
export const SIDEBAR_RIGHT_SESSION_SELECTOR: string;

/** 会话根容器选择器（`data-conversation-session` = 会话 id） */
export const CONVERSATION_SESSION_SELECTOR: string;

/**
 * 「本轮」容器选择器（`data-turn-tail` = 该卡片所属轮次号）。
 * 卡片注入自 `conversation.chat.turnTail` 插槽，宿主把该轮 turn 写到这个属性上，
 * 与服务端 summary 的 `turn` 同源——是精确消歧轮次的唯一可靠依据。
 */
export const TURN_TAIL_SELECTOR: string;

/** 从卡片向上读出所属轮次号；读不到返回 null */
export function findTurn(el: unknown): number | null;

/** 按轮次号从候选里选唯一命中项；恰好一个才返回，0 个或多个返回 null（不猜） */
export function matchChangesTurn(
  candidates: Array<{ seq: number; summary: unknown }> | null | undefined,
  turn: number | null | undefined,
): { seq: number; summary: unknown } | null;

/**
 * 从元素向上找所属会话 id（聊天区 `data-conversation-session` /
 * 右侧栏 `data-sidebar-right-session`）；找不到返回 ''。
 * 注意：会话快照没有 current 字段，当前会话必须以 DOM 为准。
 */
export function findSessionId(el: unknown): string;

/** 从「本轮文件改动」卡片按钮解析该文件下标（aria-describedby 后缀；表头按 0） */
export function changedFileIndexOf(btn: unknown): number;

/** 构造 changes.diff 的 document-relative 取数 URL */
export function changesDiffUrl(sessionId: string, seq: number, index: number): string;

/** 从会话列表快照取某会话的工作目录（相对路径解析基准）；无则 undefined */
export function sessionCwdFrom(snapshot: unknown, sessionId: string): string | undefined;

/** 改动坐标缓存键（summary 与 diff 共用） */
export function changesKey(sessionId: string, seq: number): string;

/**
 * 有界 Map：写入超过上限时按插入顺序淘汰最旧条目。
 * 桥接的 summary/diff 缓存挂在长生命周期页面上，用它保证内存有界；
 * 重新写入已存在的键会把它移到队尾（近似 LRU），避免热点条目被误淘汰。
 */
export declare class BoundedMap<V = unknown> {
  /**
   * @param limit 条目上限（≤0 归一为 1）
   * @param sizeOf 可选：单条目大小估算；提供后同时按总大小淘汰（见 maxBytes）
   * @param maxBytes 总大小上限（仅在提供 sizeOf 时生效；≤0 视为不限）
   */
  constructor(limit: number, sizeOf?: (value: V) => number, maxBytes?: number);
  readonly limit: number;
  readonly size: number;
  /** 当前总大小（未提供 sizeOf 时恒为 0） */
  readonly totalBytes: number;
  get(key: string): V | undefined;
  set(key: string, value: V): this;
  has(key: string): boolean;
  entries(): IterableIterator<[string, V]>;
}

/** JSON 载荷的字节估算（给 diff 缓存做字节上限；量级对即可） */
export function jsonByteSize(value: unknown): number;

/** 「展开/收起全部」控件选择器（卡片内，必须排除出文件行语义） */
export const CHANGES_TOGGLE_SELECTOR: string;

/** 判断元素是否为展开/收起控件等非文件行元素 */
export function isChangesToggle(el: unknown): boolean;

/** 判断 absolute 是否以 relative 结尾（按路径段，忽略分隔符风格） */
export function pathTailMatches(absolute: string, relative: string): boolean;

/**
 * 在同会话的多个改动轮次里，用卡片里的绝对路径对齐出「同一轮」。
 * 全部对齐才算命中；无法确定返回 null。
 */
export function matchChangesSeq(
  candidates: unknown,
  cardPaths: string[],
): { seq: number; summary: unknown } | null;

/** 从改动摘要里取第 index 个文件的 `{ path, display }`；取不到返回 null */
export function changedFileAt(
  summary: unknown,
  index: number,
): { path: string; display: string } | null;

/**
 * 把 RPC 响应打包为携带指定 rpcId 的新 Response（降级重发响应交回 DSH 时统一请求-响应身份）；非 JSON/无 rpcId 时原样返回
 */
export function rewriteRpcId(response: unknown, rpcId: string): Promise<Response>;

// —— v0.5.0：VS Code 右键「引用到 DSH」（插入原生引用芯片到当前会话输入框） ——

/** 单次引用插入的批量上限 */
export const MAX_REFERENCE_BATCH: number;

/** 扩展侧传给页面的一个引用条目（`path` 为绝对路径，`directory` 表示文件夹） */
export interface InsertReferenceEntry {
  path: string;
  directory?: boolean;
}

/**
 * 「引用到 DSH」的机读结果。
 * `ok=false` 时 `reason` 为机读原因（no-context/no-session/no-reference/no-composer/
 * insert-failed/insert-refused/page-timeout/bridge-unavailable/not-ready），由扩展翻成用户文案。
 */
export type InsertReferenceResult =
  | { ok: true; inserted: number }
  | { ok: false; reason: string };

/** 把绝对路径相对化到会话工作目录（逐行复刻 DSH 的 relativizeToCwd） */
export function relativizeToCwd(text: string, cwd: string | undefined | null): string;

/** 按 DSH 的 file 规则生成 `@path` mention；路径无法安全表示时返回 undefined */
export function formatFileMention(path: string): string | undefined;

/** 取路径最后一段（支持 `/` 与 `\`；目录尾斜杠先剥除） */
export function pathBasename(path: string): string;

/** 校验并规范化扩展侧传来的引用条目（丢弃非法项，反斜杠转正斜杠，截断到上限） */
export function normalizeReferenceEntries(
  entries: unknown,
): { absPath: string; directory: boolean }[];

/** 把规范化条目转成 DSH 原生引用插入载荷（addFiles 的第一参数） */
export function buildReferenceInsertions(
  entries: { absPath: string; directory: boolean }[],
  cwd: string | undefined,
): {
  source: 'reference';
  ref: string;
  label: string;
  appearance: 'file' | 'folder';
  clipboardText: string;
}[];

/** 构造「插入引用」下行请求（扩展宿主 → webview 顶层脚本，type 词汇） */
export function buildInsertReferenceMessage(
  requestId: string,
  entries: unknown,
): { type: 'bridgeInsertReference'; requestId: string; entries: unknown };

/** 构造「插入引用」回执（iframe 页面 → 父页面 → 扩展宿主） */
export function buildInsertReferenceAck(
  requestId: string,
  ok: boolean,
  reason?: string,
  inserted?: number,
): { kind: 'insertReferenceAck'; requestId: string; ok: boolean; reason?: string; inserted?: number };

/** 解析并校验「插入引用」下行消息；形状不合法返回 null */
export function parseInsertReferenceMessage(
  data: unknown,
): { requestId: string; entries: { absPath: string; directory: boolean }[] } | null;

/**
 * 从 uiWorkspace selection（`dsh.sessions.current`）与 DOM 兜底里定出目标会话 id；
 * 都拿不到返回空串。
 */
export function resolveTargetSessionId(selection: unknown, domSessionId: string): string;

