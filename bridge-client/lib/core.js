// bridge-client/lib/core.js — 桥接纯逻辑（无 DOM、无 window，可在 node 环境单测）
// 说明：本文件是唯一实现与单测目标；生产环境在构建时（scripts/build.mjs）把它
// 内联进 client.js 工厂，保证"生产运行的逻辑 = 单测验证的逻辑"同一份源码。

// 外链协议白名单：只允许 http/https，杜绝 javascript:/file: 等危险协议
export function isAllowedExternalUrl(url) {
  // 非字符串或空串一律拒绝
  if (typeof url !== 'string' || url.trim() === '') return false;
  try {
    // 用 URL 解析取协议；无效 URL 会抛错，落入 catch 返回 false
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// 构造"打开外链"消息（父页面 → 扩展 → 系统浏览器）
export function buildOpenExternalMessage(url) {
  return { kind: 'openExternal', url };
}

// 构造"打开文件"消息（cwd 为会话工作目录，可选；无 cwd 时省略该字段）
export function buildOpenFileMessage(path, cwd) {
  return cwd === undefined ? { kind: 'openFile', path } : { kind: 'openFile', path, cwd };
}

/**
 * DSH 页面里「文件入口」按钮的稳定选择器（issue #22）。
 *
 * 背景与实证（DSH 0.1.5-rc.2 产物）：
 * - 文件名内联渲染成 `button`，其 class 是 CSS Module 哈希名（实测 `fileMention_kcgor_304`），
 *   因此原先的 `classList.contains('fileMention')` 恒为 false，转发完全失效；
 * - 「本轮文件改动」芯片：`[data-produced-files-row] button[title]`（title 为相对路径）；
 * - present 交付卡片：`[data-presented-file] button[title]`（title 为工作区绝对路径）；
 * - 同卡片上的「更多」菜单按钮带 `aria-haspopup="menu"`，必须排除，避免劫持宿主的原生打开菜单。
 */
export const FILE_ENTRY_SELECTOR = [
  'button[class*="fileMention"]',
  '[data-produced-files-row] button[title]',
  '[data-presented-file] button[title]',
].join(', ');

/** 需要排除的文件入口候选：宿主原生菜单触发器（如 present 卡片的「更多」按钮） */
const FILE_ENTRY_EXCLUDE_SELECTOR = '[aria-haspopup]';

/**
 * 从按钮的标签文案里抽取被引号包裹的路径。
 * 实测 DSH 的 aria-label 形如「打开 docs/progress.md」「在侧边栏预览 `a/b.md`」——
 * 路径一定带反引号或引号包裹，按「引号内的内容」提取即可，无需依赖本地化前缀。
 */
function pathInLabel(label) {
  if (typeof label !== 'string') return null;
  const m = label.match(/[`"'\u2018\u2019\u201c\u201d]([^`"'\u2018\u2019\u201c\u201d]+)[`"'\u2018\u2019\u201c\u201d]/);
  return m === null ? '' : m[1];
}

/**
 * 从被点击的「文件入口」按钮解析出要转发的路径（纯函数，便于单测）。
 *
 * 取值优先级（issue #22 实测的属性语义）：
 *   1. `title` 才是路径（produced 芯片是相对路径，present 卡片是工作区绝对路径）；
 *   2. `aria-label` 是本地化动作文案（「打开 …」「预览 …」「queued a.ts」），
 *      仅当 title 为空时才作兜底，且必须先抽出引号包裹的路径片段；
 *      抽不出带引号的路径时——若整串文案看起来仍像路径（无空格、无换行）才采用，
 *      否则判为不可用（宁可漏转，也不把「打开 docs/a.md」整串当路径下发）。
 *
 * @param btn 形如按钮的元素（只要求 getAttribute / matches / closest）
 * @returns 路径字符串；无法判断时返回 null
 */
export function resolveFileEntryPath(btn) {
  if (btn === null || btn === undefined || typeof btn.getAttribute !== 'function') return null;
  // 宿主原生菜单触发器（aria-haspopup）不是"打开文件"，交给宿主处理
  if (typeof btn.matches === 'function' && btn.matches(FILE_ENTRY_EXCLUDE_SELECTOR)) return null;

  const title = (btn.getAttribute('title') ?? '').trim();
  if (title !== '') return title;

  const label = (btn.getAttribute('aria-label') ?? '').trim();
  if (label === '') {
    // 最后兜底：纯文本内容（DSH 早期版本的文件名按钮没有 title/aria-label）
    const text = typeof btn.textContent === 'string' ? btn.textContent.trim() : '';
    return text === '' ? null : text;
  }

  const quoted = pathInLabel(label);
  if (quoted !== null) return quoted === '' ? null : quoted;

  // 无引号：仅当整串仍像单个路径时才采用（排除「queued a.ts, b.ts」这类多文件摘要）
  if (label.includes('\n') || /\s/.test(label) || label.includes(' ')) return null;
  return label;
}

// 构造"工作区同步回执"消息（bridgeAck，path 可选；version 为桥接包版本，供扩展侧日志识别代码版本）
export function buildSyncWorkspaceAck(ok, path, version) {
  const base = path === undefined ? { kind: 'bridgeAck', ok } : { kind: 'bridgeAck', ok, path };
  return version === undefined ? base : { ...base, version };
}

// 构造"复制文本"消息（iframe 页面 → 父页面 → 扩展 → 系统剪贴板）
export function buildCopyTextMessage(text, requestId) {
  return { kind: 'copyText', text, requestId };
}

// 构造"复制文本回执"消息（父页面 → iframe 页面，用于 resolve/reject writeText 的 Promise）
export function buildCopyTextAck(requestId, ok) {
  return { kind: 'copyTextAck', requestId, ok };
}

// 校验来自父页面的消息 token（握手防伪）：必须是对象且携带匹配的非空 token
export function isBridgeMessage(data, token) {
  return (
    data !== null &&
    typeof data === 'object' &&
    typeof data.token === 'string' &&
    data.token === token &&
    data.token !== ''
  );
}

// 握手 token 字段名（父页面发来的消息里携带）
export const HANDSHAKE_TOKEN_KEY = 'token';

/**
 * 从键盘事件判定"标准编辑快捷键"命令。
 *
 * 背景：VS Code 在 macOS 上会调用 setIgnoreMenuShortcuts(true) 并只在顶层 webview
 * 转发快捷键，导致嵌套 iframe（本桥接所在的 DSH 页面）里的 Cmd+C / Cmd+V / Cmd+A 等
 * 被吞掉（microsoft/vscode#129178 / #180234，官方至今未修复）。但 iframe 内的 JS 仍能
 * 收到 keydown 事件，因此这里把"按键 → 编辑命令"的判定抽成纯函数，
 * 由 client.js 捕获后自行模拟对应行为。
 *
 * @param {{ key?: string, metaKey?: boolean, ctrlKey?: boolean, shiftKey?: boolean }} e
 *   键盘事件的关键字段（兼容真实 KeyboardEvent 与测试桩，多余字段忽略）
 * @returns {null | 'copy' | 'paste' | 'cut' | 'selectAll' | 'undo' | 'redo'}
 *   命中的编辑命令；未命中返回 null（调用方应放行原事件）
 */
export function getShortcutCommand(e) {
  if (!e || typeof e !== 'object') return null;
  // 主修饰键：mac 用 meta（⌘），Windows/Linux 用 ctrl，两者都识别以兼容两种平台
  const hasMod = e.ctrlKey === true || e.metaKey === true;
  // Windows 上 Shift+Insert 是经典的粘贴组合，一并支持
  if (!hasMod) {
    return e.shiftKey === true && e.key === 'Insert' ? 'paste' : null;
  }
  // 键名统一小写以兼容 'c' 与 'C'（Shift+字母时 key 为大写）
  const k = typeof e.key === 'string' ? e.key.toLowerCase() : '';
  switch (k) {
    case 'c':
      return 'copy';
    case 'v':
      return 'paste';
    case 'x':
      return 'cut';
    case 'a':
      return 'selectAll';
    case 'z':
      // Cmd+Shift+Z 是重做（mac 惯例；Windows 上 Ctrl+Y 也能重做，暂不额外处理）
      return e.shiftKey === true ? 'redo' : 'undo';
    default:
      return null;
  }
}

/**
 * 判定一个元素是否为"可编辑元素"（可接收粘贴/剪切/打字的目标）。
 *
 * @param {object|null} el DOM 元素
 * @returns {boolean} true 表示 textarea / 可输入 input / contenteditable
 */
export function isEditableElement(el) {
  if (!el || typeof el !== 'object' || !('tagName' in el)) return false;
  const tag = typeof el.tagName === 'string' ? el.tagName.toLowerCase() : '';
  if (tag === 'textarea') return true;
  if (tag === 'input') {
    // 真实 DOM 的 input.type 属性默认为 'text'，但为兼容测试桩与旧浏览器，
    // 空字符串 type 一律按 text 处理
    const type = typeof el.type === 'string' && el.type !== '' ? el.type.toLowerCase() : 'text';
    // 仅把能接收键盘文本输入的 type 视为可编辑（checkbox/button/range 等排除）
    return ['text', 'search', 'url', 'tel', 'password', 'number', 'email'].includes(type);
  }
  return el.isContentEditable === true;
}

/**
 * 计算在字符串的 [start, end) 区间插入 text 后的新值（纯函数，供可编辑元素兜底写入）。
 *
 * @param {string|undefined|null} value 原值（textarea.value 等）
 * @param {number} start 选区起点（selectionStart）
 * @param {number} end 选区终点（selectionEnd）
 * @param {string} text 待插入文本
 * @returns {string} 插入后的完整新值
 */
export function computeInsertedValue(value, start, end, text) {
  const v = typeof value === 'string' ? value : String(value ?? '');
  // 越界/负值/顺序异常都归一到合法区间，避免 slice 结果错乱
  const s = Math.max(0, Math.min(Number.isFinite(start) ? start : v.length, v.length));
  const e = Math.max(s, Math.min(Number.isFinite(end) ? end : v.length, v.length));
  return v.slice(0, s) + text + v.slice(e);
}

// 构造"读取剪贴板"消息（iframe 页面 → 父页面 → 扩展 → 系统剪贴板读取，供粘贴兜底）
export function buildReadTextMessage(requestId) {
  return { kind: 'readText', requestId };
}

// 构造"读取剪贴板回执"消息（父页面 → iframe 页面，resolve/reject readText 的 Promise）
// ok=true 且 text 非空才视为成功；空文本/失败一律回执 ok=false（无可粘贴内容）
export function buildReadTextAck(requestId, ok, text) {
  return ok === true && typeof text === 'string' && text !== ''
    ? { kind: 'readTextAck', requestId, ok: true, text }
    : { kind: 'readTextAck', requestId, ok: false };
}
// —— v0.3.0 图片缓存降级：saveImage / deleteImages 消息与缓存文件名 ——
// 图片缓存文件的扩展名白名单（仅这些结尾才允许由扩展宿主落盘/删除，防任意文件写入/删除）
export const IMAGE_CACHE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

/**
 * 生成图片缓存文件名（不含目录，目录由扩展侧拼接）：dsh-imgcache-<ts>-<i><ext>。
 * 扩展名不在白名单（或缺少点号）时返回 null（调用方不得落盘）。
 */
export function imageCacheFilename(timestamp, index, ext) {
  if (typeof ext !== 'string' || !IMAGE_CACHE_EXTENSIONS.includes(ext.toLowerCase())) return null;
  const t = typeof timestamp === 'string' && timestamp !== '' ? timestamp : String(Date.now());
  const i = Number.isFinite(index) ? index : 0;
  return 'dsh-imgcache-' + t + '-' + i + ext.toLowerCase();
}

// 构造「保存图片」上行消息（iframe 页面 → 父页面 → 扩展宿主落盘）
export function buildSaveImageRequest(requestId, name, dataB64, sessionCwd) {
  return { kind: 'saveImage', requestId, name, dataB64, sessionCwd };
}

/**
 * 解析「保存图片」回执：仅接受与期望 requestId 一致的 saveImageAck。
 * 返回 { ok, path? }；形状不合法或 requestId 不匹配返回 null。
 */
export function parseSaveImageAck(data, expectedRequestId) {
  if (
    data && typeof data === 'object' && data.kind === 'saveImageAck' &&
    data.requestId === expectedRequestId && typeof data.ok === 'boolean'
  ) {
    return typeof data.path === 'string' ? { ok: data.ok, path: data.path } : { ok: data.ok };
  }
  return null;
}

// 构造「删除图片缓存」上行消息（iframe 页面 → 父页面 → 扩展宿主删除）
export function buildDeleteImagesRequest(requestId, paths) {
  return { kind: 'deleteImages', requestId, paths: Array.isArray(paths) ? paths : [] };
}

/**
 * 解析「删除图片缓存」回执：仅接受与期望 requestId 一致的 deleteImagesAck。
 */
export function parseDeleteImagesAck(data, expectedRequestId) {
  if (
    data && typeof data === 'object' && data.kind === 'deleteImagesAck' &&
    data.requestId === expectedRequestId && typeof data.ok === 'boolean'
  ) {
    return { ok: data.ok };
  }
  return null;
}

// —— v0.3.0 图片自由上传降级：模型拒绝判定 / 内容重构 / 指纹 / 指针行 ——
/** 「模型不支持图像输入」的拒绝码集合：≤0.1.1 与 ≥0.1.2 两代线格式都认 */
const MODEL_REJECT_CODES = new Set(['attachment-error', 'session/attachment-invalid', 'subagent/attachment-invalid']);

/**
 * 判定一次 prompt RPC 响应是否为「模型不支持图像输入」而被拒。
 * 兼容三种形状：wire 包 ({ result:{ ok:false, error } })、flat ({ ok:false, error })、
 * 裸错误 ({ code, details })，便于单测与线上解析复用。
 * 拒绝码两代都认：≤0.1.1 的 attachment-error 与 ≥0.1.2 的 session/attachment-invalid
 * （服务端 dsh-api-session-controller 抛 RemoteError('session/attachment-invalid', …,
 * { reason:'MODEL_DOES_NOT_SUPPORT_IMAGES' })）；reason 必须精确匹配，避免把图片超限
 * 等其它附件错误误判成模型不支持。
 */
export function detectModelReject(data) {
  if (!data || typeof data !== 'object') return false;
  const result = data.result && typeof data.result === 'object' ? data.result : data;
  const error = result.error && typeof result.error === 'object'
    ? result.error
    : data.error && typeof data.error === 'object'
      ? data.error
      : data;
  if (!MODEL_REJECT_CODES.has(error.code)) return false;
  return !!(error.details && typeof error.details === 'object' && error.details.reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES');
}

/** 内容块数组是否含图片块（v0.3.0 判定是否需要走降级） */
export function isPromptWithImages(content) {
  return Array.isArray(content) && content.some((b) => b && typeof b === 'object' && b.type === 'image');
}

/** 提取内容块中的全部图片块（保持消息内的出现顺序，即用户上传/发送顺序） */
export function imageBlocksOf(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && typeof b === 'object' && b.type === 'image');
}

/**
 * 把「本条消息的图片块」按顺序映射到已捕获缓存，返回有序子集。
 * 只引用本条消息实际包含的图片，不再重复引用全部历史缓存（修复"一直重复引用
 * 根目录临时图片"）。
 * 匹配优先级：① **base64 数据精确相同**（DSH ≥0.1.2 的图片块自带 data，最可靠——
 * 避免同会话重复上传同名文件时命中陈旧条目、把旧图字节落盘发给模型）；② 文件名
 * 相同（≤0.1.1 的图片块可能只带 name）；③ 按序取首个未占用（尽力而为兜底）。
 * entries 为 { key?, name?, b64?, mime? } 数组。
 */
export function matchCapturedImages(content, entries) {
  const blocks = imageBlocksOf(content);
  const remaining = Array.isArray(entries) ? [...entries] : [];
  const used = [];
  for (const block of blocks) {
    let hit = null;
    const name = typeof block.name === 'string' && block.name !== '' ? block.name : '';
    const data = typeof block.data === 'string' ? block.data.trim() : '';
    if (data) hit = remaining.find((e) => e && typeof e.b64 === 'string' && e.b64.trim() === data) || null;
    if (!hit && name) hit = remaining.find((e) => e && e.name === name) || null;
    if (!hit) hit = remaining[0] || null; // 兜底：按序取第一个未占用
    if (hit) {
      used.push(hit);
      remaining.splice(remaining.indexOf(hit), 1);
    }
  }
  return used;
}

/** 提取内容块中的全部文本（按顺序拼接，空行分隔） */
export function extractPromptText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** 中文数字 1..10（超出用阿拉伯数字兜底），用于图片按上传/发送顺序标注：图片一、图片二… */
export function zhOrdinal(n) {
  const ZH = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const i = Math.floor(Number(n));
  return i >= 1 && i <= 10 ? ZH[i - 1] : String(i);
}

/**
 * 构造图片地址行：图片已落盘到 path，把 path 作为「地址」随消息发给模型，
 * 由模型自行判断/选择图像识别工具查看。n 为 1 起序号（图片一、图片二…），
 * 使多图按上传/发送顺序被明确标注；不传序号时保持'图片：<路径>'简写。
 */
export function buildImagePointerLine(path, n) {
  return n === undefined || n === null ? '图片：' + path : '图片' + zhOrdinal(n) + '：' + path;
}

/**
 * 构造纯文本内容块数组：原文本 + 图片指针行。
 * 无图片指针时保持原文本不变（形状不变），有指针时拼接到文本之后。
 */
export function buildTextOnlyContent(content, pointerLines) {
  const text = extractPromptText(content);
  const pointers = (Array.isArray(pointerLines) ? pointerLines : []).filter((l) => typeof l === 'string' && l !== '');
  const joined = pointers.length === 0 ? text : text === '' ? pointers.join('\n') : text + '\n\n' + pointers.join('\n');
  return [{ type: 'text', text: joined }];
}


/**
 * 文件指纹（去重键）：name:size:lastModified；关键字段缺失返回 null。
 * 用于附件捕获时对同一文件去重，避免重复落盘。
 */
export function imageCacheKey(fileLike) {
  if (!fileLike || typeof fileLike !== 'object') return null;
  const name = typeof fileLike.name === 'string' ? fileLike.name : '';
  const size = typeof fileLike.size === 'number' ? fileLike.size : 0;
  const lm = typeof fileLike.lastModified === 'number' ? fileLike.lastModified : 0;
  return name === '' ? null : name + ':' + size + ':' + lm;
}

/**
 * 解包 RPC 请求体 → 业务 payload。
 * DSH 的 fetch 请求体是 { rpcId, payload }（RpcRequest），content 等业务字段在 payload 下；
 * 兼容「直传 payload」的测试形态。v0.3.0 图片降级的拦截/重发都要经它对齐线格式。
 */
export function unwrapRpcPayload(body) {
  if (body && typeof body === 'object' && body.payload && typeof body.payload === 'object') return body.payload;
  return body;
}

/**
 * 端点方法名归一化：DSH ≥0.1.2 把点分端点换成斜杠端点（session.prompt → session/prompt），
 * 统一转成点分形式做比较，两代线格式共用同一套判断。
 */
export function normalizeRpcMethod(method) {
  return typeof method === 'string' ? method.replace(/\//g, '.') : '';
}

/**
 * 解包 RPC 请求体 → 业务请求对象（含 content/sessionId/mode 等真正业务字段）。
 * - ≤0.1.1：payload 直挂业务字段（{ rpcId, method:'session.prompt', payload:{ sessionId, content } }）；
 * - ≥0.1.2：payload.args.<参数名>（{ type:'client-request', rpcId, method:'session/prompt',
 *   payload:{ args:{ request:{ requestId, sessionId, mode, content } } } }，参数名按控制器 TS 形参
 *   命名——prompt 是 request、list 是 _request），故取 args 下第一个对象值。
 * 两代都要支持：图片降级的「识别含图 prompt / 取 sessionId / 重写 content」都依赖它。
 */
export function unwrapRpcRequest(body) {
  const payload = unwrapRpcPayload(body);
  if (payload && typeof payload === 'object' && payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args)) {
    const args = payload.args;
    if (args.request && typeof args.request === 'object') return args.request;       // prompt / create / …
    if (args._request && typeof args._request === 'object') return args._request;    // list / search 等
    const first = Object.values(args).find((v) => v && typeof v === 'object' && !Array.isArray(v));
    return first === undefined ? args : first;
  }
  return payload;
}

/**
 * 以纯文本内容重构 RPC 请求：保留 DSH 线格式的 type/method（client-request/session.prompt 或
 * 0.1.2 的 client-request/session/prompt，否则服务器会以 bad-request 拒绝重发），换新 rpcId
 * （与已拒请求不撞车），业务对象保留原 sessionId/mode/requestId/clientTimeZone 等字段并把
 * content 替换为纯文本内容——0.1.2 的 content 位于 payload.args.<参数名> 内，须原位写回。
 * 返回新对象，绝不就地修改原请求体（DSH 可能仍持有引用）。
 */
export function buildTextResendRequest(originalBody, content) {
  const src = originalBody && typeof originalBody === 'object' ? originalBody : {};
  const payload = unwrapRpcPayload(src);
  let nextPayload;
  if (payload && typeof payload === 'object' && payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args)) {
    // 0.1.2：找到 args 下真正承载 content 的那个参数对象（prompt 为 request）并原位替换
    const args = { ...payload.args };
    const key = Object.keys(args).find((k) => {
      const v = args[k];
      return v && typeof v === 'object' && !Array.isArray(v) && 'content' in v;
    });
    if (key !== undefined) {
      args[key] = { ...args[key], content };
      nextPayload = { ...payload, args };
    }
  }
  if (nextPayload === undefined) nextPayload = { ...(payload && typeof payload === 'object' ? payload : {}), content };
  return {
    ...(typeof src.type === 'string' ? { type: src.type } : {}),
    rpcId: 'vsc-fb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    ...(typeof src.method === 'string' ? { method: src.method } : {}),
    payload: nextPayload,
  };
}

/**
 * 从 fetch 的 input 提取 URL 字符串（兼容 string / URL 实例(href) / Request 实例(url) 三种形态）。
 * 取不到返回 ''，调用方据此放弃重发，避免向非法地址发起无意义请求。
 * 背景：DSH 的 postJson 传入的是 new URL(...) 实例（只有 .href，没有 .url），
 * 若按 Request 的 .url 抽取会得到空串导致重发静默失败。
 */
export function resolveFetchUrl(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    if (typeof input.href === 'string' && input.href !== '') return input.href; // URL 实例
    if (typeof input.url === 'string' && input.url !== '') return input.url;   // Request 实例
  }
  return '';
}

// —— v0.4.3：把「本轮文件改动」的 Diff 在 VS Code 中打开（坐标解析 + turn-start 全文反推） ——
// 背景：DSH 的 review 视图只在网页内渲染，用户无法在 VS Code 里看同一处改动。
// 关键约束（源码实证，dsh-client-ui-deliverables / dsh-workspace-changes）：
//  · `/api/changes.diff` 只返回 hunks，**不给完整的前后文件文本**，且刻意隐藏 cwd 与快照树 id；
//  · 卡片行按钮的 DOM 里没有 seq（它只活在 React 闭包），因此坐标要靠调用方另行解析。
// 但 unified diff 的语义是精确的：hunk 之外的行两侧逐字节相同。于是可以
// 「以磁盘当前内容为 turn-end 侧 + hunks 反向还原 turn-start 全文」，做到逐字节精确。

/** DSH「本轮改动摘要」端点（document-relative：相对当前文档，无前导斜杠） */
export const CHANGES_SUMMARY_ROUTE = 'api/changes.summary';

/** DSH「单文件前后对比」端点（document-relative） */
export const CHANGES_DIFF_ROUTE = 'api/changes.diff';

/**
 * 从 URL 解析 DSH 改动端点的坐标。
 * 用于旁路观察 DSH 自己发出的 `changes.summary` / `changes.diff` 请求——
 * 这是 review 标签页里唯一能稳定拿到 `seq` 的途径（DOM 不含 seq）。
 *
 * @param url 请求 URL（绝对或相对均可）
 * @param base 相对 URL 的解析基准（浏览器传 document.baseURI）
 * @returns `{ route, sessionId, seq, index? }`；非本端点或缺少必需参数时返回 null
 */
export function parseChangesQuery(url, base) {
  if (typeof url !== 'string' || url === '') return null;
  let parsed;
  try {
    parsed = new URL(url, typeof base === 'string' && base !== '' ? base : undefined);
  } catch {
    return null;
  }
  // 容忍前导斜杠与任意部署前缀：只看路径末尾的端点名
  const path = parsed.pathname.replace(/\/+$/, '');
  const route = path.endsWith('/' + CHANGES_DIFF_ROUTE) || path === CHANGES_DIFF_ROUTE
    ? 'diff'
    : path.endsWith('/' + CHANGES_SUMMARY_ROUTE) || path === CHANGES_SUMMARY_ROUTE
      ? 'summary'
      : '';
  if (route === '') return null;
  const sessionId = parsed.searchParams.get('sessionId') ?? '';
  const seqRaw = parsed.searchParams.get('seq') ?? '';
  if (sessionId === '' || seqRaw === '') return null;
  const seq = Number(seqRaw);
  if (!Number.isInteger(seq) || seq < 0) return null;
  if (route === 'summary') return { route, sessionId, seq };
  const indexRaw = parsed.searchParams.get('index') ?? '';
  const index = Number(indexRaw);
  if (!Number.isInteger(index) || index < 0) return null;
  return { route, sessionId, seq, index };
}

/**
 * 校验 `/api/changes.diff` 的 JSON 形状是否可直接转发给扩展宿主。
 * 这里只做「够用即转」的轻校验（拒绝明显不合规的载荷），权威校验在扩展宿主侧。
 * @param value 页面从 `/api/changes.diff` 读到的 JSON
 * @returns 是否可转发
 */
export function isWorkspaceFileDiff(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.kind !== 'text') return false;
  if (typeof value.path !== 'string' || value.path === '') return false;
  return Array.isArray(value.hunks);
}

/**
 * 构造「在 VS Code 中打开 Diff」上行消息。
 * 只转发 DSH 服务端的原始 diff 载荷（hunks）；turn-start 全文由扩展宿主
 * 读磁盘 current 内容后反推（见 src/bridge/host.ts 的 reconstructBefore），
 * 保证「还原算法」只有一份实现且有单测覆盖。
 *
 * @param req.path 改动文件路径（相对会话 cwd，或工作区外绝对路径）
 * @param req.cwd 会话工作目录（相对路径解析基准）
 * @param req.diff `/api/changes.diff` 的原始 JSON
 * @param req.display 展示路径（diff 标题用）
 */
export function buildOpenDiffMessage(req) {
  const msg = { kind: 'openDiff', path: req.path, diff: req.diff };
  if (typeof req.cwd === 'string' && req.cwd !== '') msg.cwd = req.cwd;
  if (typeof req.display === 'string' && req.display !== '') msg.display = req.display;
  return msg;
}

/**
 * 「本轮文件改动」卡片容器选择器（DSH 的稳定 data 属性，非 CSS Module 哈希类名）。
 * 卡片内的按钮既可能是单文件表头，也可能是多文件的行。
 */
export const CHANGED_FILES_CARD_SELECTOR = '[data-changed-files]';

/** review 标签页容器选择器（右侧栏的改动对比视图） */
export const CHANGES_REVIEW_SELECTOR = '[data-changes-review]';

/** review 标签页里「当前文件」选择按钮（其 `data-review-file` 即相对路径） */
export const REVIEW_FILE_SELECTOR = '[data-review-file]';

/** 右侧栏容器：其 `data-sidebar-right-session` 给出该栏所属会话 id */
export const SIDEBAR_RIGHT_SESSION_SELECTOR = '[data-sidebar-right-session]';

/** 会话根容器：其 `data-conversation-session` 给出当前会话 id（用于解析相对路径基准） */
export const CONVERSATION_SESSION_SELECTOR = '[data-conversation-session]';

/**
 * 「本轮」容器选择器：其 `data-turn-tail=<turn>` 给出该卡片所属的**轮次号**。
 *
 * 这是把「改动卡片」精确对到「某一轮 summary」的**唯一可靠**依据：
 * 卡片由 deliverables 插件注入 `conversation.chat.turnTail` 插槽
 * （实证 `dsh-client-ui-deliverables/lib/client.js` 的 `ctx.slots.inject("conversation.chat.turnTail", …)`），
 * 而该插槽的宿主 `TurnTailNodeView` 会把 `data.turn` 写到外层 div 上
 * （实证 `dsh-client-ui-chat/lib/client.js`：`"data-turn-tail": data.turn`，
 *  传给插槽的上下文也是同一个 `turn`）。
 * 服务端 summary 的 `turn` 字段来自同一个 turn 编号
 * （`workspace-changes`：`session.append('workspace/changes', { turn: state.turn })`）。
 *
 * 为什么不能只靠文件路径对齐：同一文件在多轮里都被改时，各轮的文件指纹完全相同，
 * 按「路径全对齐 + 取最新 seq」必然把旧卡片解析到最新一轮，从而显示别的轮次的 diff。
 */
export const TURN_TAIL_SELECTOR = '[data-turn-tail]';

/**
 * 从卡片向上读出它所属的轮次号。
 * @param el 卡片内的任意元素（只要求 closest / getAttribute）
 * @returns 轮次号；读不到返回 null
 */
export function findTurn(el) {
  if (el === null || el === undefined || typeof el.closest !== 'function') return null;
  let host;
  try {
    host = el.closest(TURN_TAIL_SELECTOR);
  } catch {
    return null;
  }
  if (!host || typeof host.getAttribute !== 'function') return null;
  const raw = host.getAttribute('data-turn-tail');
  if (typeof raw !== 'string' || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * 按轮次号从候选里选出唯一命中项。
 * @param candidates `[{ seq, summary }]`（summary 带 `turn`）
 * @param turn 卡片所属轮次号（来自 {@link findTurn}）
 * @returns 恰好命中一个时返回它；0 个或多个返回 null
 */
export function matchChangesTurn(candidates, turn) {
  if (!Array.isArray(candidates) || !Number.isFinite(turn)) return null;
  let hit = null;
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const summary = c.summary;
    const t = summary && typeof summary === 'object' ? summary.turn : undefined;
    if (!Number.isFinite(t) || t !== turn) continue;
    if (hit !== null) return null; // 同一轮出现多个候选：不猜
    hit = { seq: c.seq, summary };
  }
  return hit;
}

/**
 * 从元素向上找出它所属的会话 id。
 * 实证（DSH 0.2.0-rc.1）：聊天区根节点带 `data-conversation-session=<sessionId>`；
 * 右侧栏容器带 `data-sidebar-right-session=<sessionId>`。二者都是稳定 data 属性，
 * 不依赖 CSS Module 哈希类名——因此比按类名匹配健壮得多。
 *
 * 注意：DSH 的会话列表快照（`sessions.list.getSnapshot()`）**没有** current 字段
 * （实证 `SessionListState = { ids, byId, phase, projectionsBySession }`），
 * 所以「当前会话」必须以 DOM 为准，不能用快照猜。
 *
 * @param el 起始元素（只要求 closest / getAttribute）
 * @returns 会话 id；找不到返回 ''
 */
export function findSessionId(el) {
  if (el === null || el === undefined || typeof el.closest !== 'function') return '';
  const conv = el.closest(CONVERSATION_SESSION_SELECTOR);
  if (conv && typeof conv.getAttribute === 'function') {
    const v = conv.getAttribute('data-conversation-session');
    if (typeof v === 'string' && v !== '') return v;
  }
  const side = el.closest(SIDEBAR_RIGHT_SESSION_SELECTOR);
  if (side && typeof side.getAttribute === 'function') {
    const v = side.getAttribute('data-sidebar-right-session');
    if (typeof v === 'string' && v !== '') return v;
  }
  return '';
}

/**
 * 从「本轮文件改动」卡片里的按钮解析该文件的 index。
 * 实证：行按钮带 `aria-describedby="<useId>-<index>"`，单文件表头只带 `<useId>`
 * （对应 index 0）。这是唯一直达 DOM 的坐标，且不受类名哈希影响。
 *
 * @param btn 卡片内的按钮元素
 * @returns files 数组下标（解析不出时按 0，与 DSH 表头语义一致）
 */
export function changedFileIndexOf(btn) {
  if (btn === null || btn === undefined || typeof btn.getAttribute !== 'function') return 0;
  const described = btn.getAttribute('aria-describedby');
  if (typeof described !== 'string' || described === '') return 0;
  const m = /-(\d+)$/.exec(described);
  if (m === null) return 0;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * 构造 `changes.diff` 的 document-relative 取数 URL（与 DSH 客户端一致）。
 * @param sessionId 会话 id
 * @param seq `workspace/changes` 事件序号
 * @param index files 数组下标
 */
export function changesDiffUrl(sessionId, seq, index) {
  return (
    CHANGES_DIFF_ROUTE +
    '?' +
    new URLSearchParams({ sessionId, seq: String(seq), index: String(index) }).toString()
  );
}

/**
 * 从会话列表快照里取某会话的工作目录（相对路径解析基准）。
 * @param snapshot `sessions.list.getSnapshot()` 的返回值（形状不合法时返回 undefined）
 * @param sessionId 目标会话 id
 * @returns 工作目录绝对路径；无则 undefined
 */
export function sessionCwdFrom(snapshot, sessionId) {
  if (!snapshot || typeof snapshot !== 'object') return undefined;
  if (typeof sessionId !== 'string' || sessionId === '') return undefined;
  const byId = snapshot.byId;
  if (!byId || typeof byId !== 'object') return undefined;
  const row = byId[sessionId];
  if (!row || typeof row !== 'object') return undefined;
  const cwd = row.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
}

/**
 * 有界 Map：超过上限时按插入顺序淘汰最旧的条目。
 * 为什么需要：桥接的 summary/diff 缓存挂在长生命周期页面上（面板一开就是几小时），
 * 若无限增长会随会话轮次持续吃内存。用一个很小的上限即可覆盖用户实际会点的窗口，
 * 又保证内存有界。
 *
 * 注意先删后插：`Map` 迭代按插入序，删除再设可使被重新访问的键移到队尾
 * （semantics 接近 LRU，避免「最热的那轮改动」被误淘汰）。
 */
export class BoundedMap {
  /**
   * @param limit 条目上限（≤0 视为 1）
   * @param sizeOf 可选：单条目「大小」估算函数；给了就同时按总大小淘汰。
   *   为什么需要：单条 diff 可以是「两侧各 ≤2 MiB」量级（DSH 默认 maxFileBytes=2 MiB），
   *   只按条数限（如 500 条）最坏会占住约 2 GiB 堆。面板一开就是几小时，必须同时按字节兜住。
   * @param maxBytes 总大小上限（仅在提供 sizeOf 时生效；≤0 视为不限）
   */
  constructor(limit, sizeOf, maxBytes) {
    this.limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1;
    this.sizeOf = typeof sizeOf === 'function' ? sizeOf : null;
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 0;
    this.map = new Map();
    this.bytes = 0;
  }

  /** 单条目大小（未提供 sizeOf 时为 0） */
  measure(value) {
    if (this.sizeOf === null) return 0;
    const n = this.sizeOf(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  get(key) {
    return this.map.get(key);
  }

  set(key, value) {
    // 先删再插 → 命中过的键排到队尾，淘汰时优先舍弃最久未写过的
    const existing = this.map.get(key);
    if (existing !== undefined || this.map.has(key)) {
      this.bytes -= this.measure(existing);
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.bytes += this.measure(value);
    this.evict();
    return this;
  }

  /** 按条数与总字节双上限淘汰最旧条目（至少保留 1 条，避免刚放进去就被清掉） */
  evict() {
    while (
      this.map.size > this.limit ||
      (this.maxBytes > 0 && this.bytes > this.maxBytes && this.map.size > 1)
    ) {
      const oldest = this.map.keys().next();
      if (oldest.done === true) break;
      this.bytes -= this.measure(this.map.get(oldest.value));
      this.map.delete(oldest.value);
    }
    if (this.bytes < 0) this.bytes = 0;
  }

  has(key) {
    return this.map.has(key);
  }

  get size() {
    return this.map.size;
  }

  /** 当前总大小（未提供 sizeOf 时恒为 0） */
  get totalBytes() {
    return this.bytes;
  }

  /** 按插入顺序枚举（与 Map 一致），供「取某会话最新一轮」之类的遍历使用 */
  entries() {
    return this.map.entries();
  }
}

/** JSON 载荷的字节估算：用来给 diff 缓存做字节上限（不需要精确，量级对即可） */
export function jsonByteSize(value) {
  try {
    const s = JSON.stringify(value);
    return typeof s === 'string' ? s.length : 0;
  } catch {
    return 0;
  }
}

/** 改动坐标的缓存键（summary 与 diff 都用它） */
export function changesKey(sessionId, seq) {
  return sessionId + '|' + String(seq);
}

/**
 * 「本轮文件改动」卡片里的「展开/收起全部」按钮选择器。
 * 实证：该 disclosure 控件带 `aria-expanded`，而文件行/表头按钮都不带。
 * 必须排除它——否则点「展开全部 5 个文件」会被误当成点击第一个文件。
 */
export const CHANGES_TOGGLE_SELECTOR = '[aria-expanded]';

/**
 * 判断某元素是否应被排除出「文件行」语义。
 * @param el 候选按钮
 * @returns true 表示是展开/收起控件等非文件行元素
 */
export function isChangesToggle(el) {
  if (el === null || el === undefined || typeof el.matches !== 'function') return false;
  try {
    return el.matches(CHANGES_TOGGLE_SELECTOR);
  } catch {
    return false;
  }
}

/** 把路径分隔符统一成 '/'，便于跨平台做尾部比较 */
function normalizeSlashes(s) {
  return s.replace(/[\\/]+/g, '/');
}

/**
 * `absolute` 是否以 `relative` 结尾（**按完整路径段**，不区分分隔符风格）。
 * 用于把卡片里读到的「绝对路径」与摘要里的「相对路径」对上号，
 * 避免在浏览器侧做完整的路径拼接（不需要 node:path）。
 *
 * 必须按段比较：朴素的 endsWith 会让 `/ws/src/ab.ts` 命中相对路径 `b.ts`，
 * 从而把不同文件误判为同一个、进而对齐到错误的改动轮次。
 */
export function pathTailMatches(absolute, relative) {
  if (typeof absolute !== 'string' || typeof relative !== 'string') return false;
  if (absolute === '' || relative === '') return false;
  const a = normalizeSlashes(absolute);
  const r = normalizeSlashes(relative);
  if (a === r) return true;
  // 绝对形式的 relative（以 / 开头或带盘符）直接比较，不再补前导斜杠
  if (r.startsWith('/') || /^[a-zA-Z]:\//.test(r)) return a === r;
  return a.endsWith('/' + r);
}

/**
 * 在同会话的多个改动轮次（summary 候选）里，找出与「当前卡片」是同一轮的那个。
 *
 * 为什么需要：一个会话可以有多轮改动，卡片也就会有多个。若一律取最新一轮，
 * 在向上滚动点击旧卡片时会取到错误的 diff。
 * 做法：卡片各行经 aria-describedby → 隐藏 span 能读到该文件的**绝对路径**；
 * 摘要里该文件是**相对会话 cwd 的路径**。用「尾段匹配」逐项对齐打分，
 * 只有全部对齐（score === 卡片文件数）才认这一轮，否则返回 null 由调用方兜底。
 *
 * @param candidates `[{ seq, summary }]` 同会话的全部候选
 * @param cardPaths 当前卡片按 index 顺序的绝对路径
 * @returns 命中的候选（含 score）；无法确定时 null
 */
export function matchChangesSeq(candidates, cardPaths) {
  if (!Array.isArray(candidates) || !Array.isArray(cardPaths) || cardPaths.length === 0) return null;
  let best = null;
  let ambiguous = false;
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const summary = c.summary;
    const files = summary && typeof summary === 'object' ? summary.files : undefined;
    if (!Array.isArray(files) || files.length < cardPaths.length) continue;
    let score = 0;
    for (let i = 0; i < cardPaths.length; i += 1) {
      const rel = files[i] && typeof files[i] === 'object' ? files[i].path : undefined;
      if (typeof rel === 'string' && pathTailMatches(cardPaths[i], rel)) score += 1;
    }
    // 全部对齐才算命中
    if (score !== cardPaths.length) continue;
    if (best === null) {
      best = { seq: c.seq, summary };
      continue;
    }
    // 多个候选取同样对齐：**绝不能**按「取最新 seq」决定——同一文件在多轮里都被改时
    // 各轮指纹完全相同，取最新会把旧卡片显示成最新一轮的 diff（张冠李戴）。
    // 这里改为判为「无法确定」，由调用方优先用轮次号消歧、否则拒绝（退回原生行为）。
    ambiguous = true;
  }
  return ambiguous ? null : best;
}

/**
 * 从「本轮改动摘要」JSON 里取出第 index 个文件的路径信息。
 * 摘要来自 `/api/changes.summary`（`ChangesSummary = {turn, files, total, added, deleted}`，
 * 其中 `files[].path` 相对会话 cwd，`display` 为展示用路径）。
 * 用服务端摘要而非 DOM 文案取路径，可完全避开 CSS Module 哈希类名与本地化文案。
 *
 * @param summary 摘要 JSON
 * @param index files 数组下标
 * @returns `{ path, display }`；取不到返回 null
 */
export function changedFileAt(summary, index) {
  if (!summary || typeof summary !== 'object') return null;
  const files = summary.files;
  if (!Array.isArray(files)) return null;
  const f = files[index];
  if (!f || typeof f !== 'object') return null;
  if (typeof f.path !== 'string' || f.path === '') return null;
  return { path: f.path, display: typeof f.display === 'string' ? f.display : f.path };
}

/**
 * 把 RPC 响应重新打包为「携带指定 rpcId」的新 Response。
 * 图片降级重发会使用新 rpcId（避免与服务端已处理请求撞车），而重发响应需要以
 * 「原请求的 rpcId」交回给 DSH 调用方，保持请求-响应关联一致。响应体不是可解析
 * 的 JSON（或没有 rpcId 字段）时原样返回，不做改写（不向 DSH 造假形状）。
 */
export async function rewriteRpcId(response, rpcId) {
  if (!response || typeof response.clone !== 'function' || typeof response.json !== 'function') return response;
  let json;
  try {
    json = await response.clone().json();
  } catch {
    return response;
  }
  if (!json || typeof json !== 'object' || typeof json.rpcId !== 'string') return response;
  return new Response(JSON.stringify({ ...json, rpcId }), {
    status: response.status,
    statusText: response.statusText,
    headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
  });
}

// ——————————————————————————————————————————————————————————————
// v0.5.0：VS Code 右键「引用到 DSH」
//
// 目标：把 VS Code 里选中的文件插入当前 DSH 会话的输入框，形式与 DSH 自身
// 「把文件拖进输入框」完全一致——一个原子引用芯片（Lexical ReferenceChipNode），
// 而非纯文本。用户无需再手打 @ 路径。
//
// 关键设计：扩展侧只传「绝对路径 + 是否目录」，**不**传相对路径。
// 因为相对路径的基准必须是「该 DSH 会话的工作目录」（见 v0.4.3 的同类修复），
// 而不是 VS Code 的工作区根：两者在多根工作区/远程场景下会不一致。
// 页面侧才有会话 cwd（sessions 服务），所以相对化在页面内完成，
// 并直接复用 DSH 自己的相对化与 mention 规则（见下），保证产物与原生拖拽逐字节一致。
// ——————————————————————————————————————————————————————————————

/** 单次引用插入的批量上限（防止误选上千文件时把输入框塞爆） */
export const MAX_REFERENCE_BATCH = 50;

/**
 * 把绝对路径相对化到会话工作目录——复刻 DSH 的 `relativizeToCwd` 语义。
 *
 * 为什么要复刻：DSH 原生拖拽走的正是这个函数，只有语义一致，右键插入的芯片才与
 * 拖拽产生的芯片指向同一路径。
 *
 * 与 DSH 的一处**有意差异**（且已测）：这里比较前把两侧分隔符统一为 `/`。
 * DSH 只做裸 startsWith 比较，从不归一化，因此它对「cwd 为反斜杠、路径为正斜杠」的
 * 混合输入会静默放弃相对化，退回绝对路径。这在 DSH 内部不会出问题（它自己的拖拽
 * 两端同风格），但本桥接的输入天然混合：`cwd` 来自 DSH 会话（Windows 上可能是
 * `C:\ws`），绝对路径来自 VS Code（`uri.fsPath`，Windows 上同为反斜杠）。
 * 不归一化就会在 Windows 上产出 `@C:/ws/a.ts` 这种绝对引用，与原生拖拽的 `@a.ts`
 * 不一致。归一化对 DSH 自身能产生的输入不改变任何结果，只是让本桥接的输入也正确。
 * 输出一律 `/` 分隔（DSH 的路径词汇与 mention 约定）。
 *
 * 保持 DSH 的另一项语义：路径恰好等于 cwd 时**照原样返回**（不返回空串），
 * 于是「右键工作区根目录」会得到 `@<绝对路径>/` 这一有效引用，而不是静默无操作。
 *
 * @param text 绝对路径
 * @param cwd 会话工作目录（可为 undefined/空，表示未知）
 * @returns cwd 之下的相对路径；不在 cwd 之下时返回归一化后的路径
 */
export function relativizeToCwd(text, cwd) {
  if (typeof text !== 'string') return '';
  const normalized = text.replace(/\\/g, '/');
  if (cwd === undefined || cwd === null || cwd === '') return normalized;
  const root = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '');
  if (root === '') return normalized;
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  return normalized;
}

/**
 * 把路径转成 `@path` mention——复刻 DSH 的 `formatFileMention`（kind='file' 分支）。
 *
 * DSH 对目录的拖拽插入走的是「路径先补尾斜杠、再按 file 规则加引号」，
 * 因此含空格的目录得到闭合引号 `@"dir/"`（而不是补全菜单里那种故意不闭合的 `@"dir/`）。
 * 本函数接收的 path 已由调用方补好尾斜杠。
 *
 * @param path 相对或绝对路径（`/` 分隔，目录已带尾斜杠）
 * @returns mention 文本；路径含控制字符或 `"`（编辑器语法无法安全表示）时返回 undefined
 */
export function formatFileMention(path) {
  if (typeof path !== 'string' || path === '') return undefined;
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined;
  if (!/\s/u.test(path)) return `@${path}`;
  return `@"${path}"`;
}

/** 取路径最后一段（`/` 或 `\` 分隔均支持；目录尾斜杠先剥掉） */
export function pathBasename(path) {
  if (typeof path !== 'string') return '';
  const trimmed = path.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * 校验并规范化扩展侧传来的引用条目。
 *
 * 只接受 `{ path, directory? }` 形状：path 必须是非空字符串，directory 为真值表示目录。
 * 反斜杠统一转 `/`（DSH 的路径词汇一律正斜杠）。非法条目直接丢弃而不是抛错——
 * 一个坏条目不该让整批引用失败。
 *
 * @param entries 来自扩展侧（未完全可信）的数组
 * @returns 规范化后的 `{ absPath, directory }` 数组
 */
export function normalizeReferenceEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const entry of entries) {
    if (out.length >= MAX_REFERENCE_BATCH) break;
    if (entry === null || typeof entry !== 'object') continue;
    const raw = entry.path;
    if (typeof raw !== 'string') continue;
    const absPath = raw.trim().replace(/\\/g, '/');
    if (absPath === '') continue;
    out.push({ absPath, directory: entry.directory === true });
  }
  return out;
}

/**
 * 把规范化条目转成 DSH 原生的引用插入载荷（`conversation.input.shell().addFiles` 的第一参数）。
 *
 * 字段与 DSH `ui-conversation` 的拖拽代码逐项对齐：
 *   source='reference'、ref=mention、label=文件名（目录带尾斜杠）、
 *   appearance='folder'|'file'、clipboardText=mention。
 * 顺序即数组顺序（芯片按用户选择顺序插入）。
 *
 * @param entries `normalizeReferenceEntries` 的输出
 * @param cwd 当前 DSH 会话的工作目录
 * @returns 原生插入载荷数组；mention 无法表示（含控制字符等）的条目被跳过
 */
export function buildReferenceInsertions(entries, cwd) {
  const refs = [];
  for (const { absPath, directory } of entries) {
    const relative = relativizeToCwd(absPath, cwd);
    if (relative === '') continue; // 恰好等于 cwd：不是一个可引用的文件
    const withSlash = directory ? `${relative.replace(/\/+$/, '')}/` : relative;
    const mention = formatFileMention(withSlash);
    if (mention === undefined) continue;
    const name = pathBasename(withSlash);
    const label = directory ? `${name === '' ? withSlash : name}/` : name === '' ? withSlash : name;
    refs.push({
      source: 'reference',
      ref: mention,
      label,
      appearance: directory ? 'folder' : 'file',
      clipboardText: mention,
    });
  }
  return refs;
}

/**
 * 构造「插入引用」下行请求（扩展宿主 → webview 顶层脚本）。
 *
 * 注意两个方向的形状不同、都有意如此：
 *   - 扩展 → 顶层脚本：`{ type:'bridgeInsertReference', … }`（与本扩展其它下行消息同一套 type 词汇）
 *   - 顶层脚本 → iframe：`{ kind:'insertReference', … }`（桥接内部 kind 词汇，由顶层脚本构造）
 * 两段都按各自既有约定走，避免为了"统一"去改动既有的消息路由。
 */
export function buildInsertReferenceMessage(requestId, entries) {
  return { type: 'bridgeInsertReference', requestId, entries };
}

/**
 * 构造「插入引用」回执（iframe 页面 → 父页面 → 扩展宿主）。
 *
 * ok=true 表示芯片已真的插入输入框；否则带 reason 供扩展侧提示用户
 * （扩展侧把它翻成可读文案，页面侧只报机读原因）。
 *
 * @param requestId 与请求一致的关联 id
 * @param ok 是否插入成功
 * @param reason 失败原因（ok=true 时省略）
 * @param inserted 实际插入的芯片数量（ok=true 时给出，便于日志对账）
 */
export function buildInsertReferenceAck(requestId, ok, reason, inserted) {
  const base = { kind: 'insertReferenceAck', requestId, ok: ok === true };
  if (base.ok) return typeof inserted === 'number' ? { ...base, inserted } : base;
  return typeof reason === 'string' && reason !== '' ? { ...base, reason } : base;
}

/**
 * 解析并校验「插入引用」下行消息。
 *
 * @param data 父页面投递的消息体
 * @returns `{ requestId, entries }`；形状不合法（缺 requestId / 无可插入条目）时返回 null
 */
export function parseInsertReferenceMessage(data) {
  if (data === null || typeof data !== 'object') return null;
  if (data.kind !== 'insertReference') return null;
  if (typeof data.requestId !== 'string' || data.requestId === '') return null;
  const entries = normalizeReferenceEntries(data.entries);
  if (entries.length === 0) return null;
  return { requestId: data.requestId, entries };
}

/**
 * 从会话列表快照里取出「当前应插入到哪个会话」。
 *
 * 优先用 uiWorkspace 的 selection（持久化在 `dsh.sessions.current`，是主视图真正的驱动源），
 * 仅当它不可用/指向已消失的会话时，才退回 DOM 可见的 `[data-conversation-session]`。
 * 这样桥接既不需要硬依赖 uiWorkspace 服务，也不会在服务缺失时彻底失效。
 *
 * @param selection uiWorkspace.selection.getSnapshot() 的值（可能为 undefined）
 * @param domSessionId DOM 兜底扫描得到的会话 id（可能为空串）
 * @returns 会话 id；都拿不到时返回空串
 */
export function resolveTargetSessionId(selection, domSessionId) {
  if (selection !== null && typeof selection === 'object') {
    const id = selection.sessionId;
    if (typeof id === 'string' && id !== '') return id;
  }
  return typeof domSessionId === 'string' ? domSessionId : '';
}

