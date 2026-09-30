// src/bridge/host.ts — 桥接消息处理：外链打开 / 文件跳转
// 职责：把 webview 顶层转发来的桥接消息（bridgeOpenExternal / bridgeOpenFile）落地为
// VS Code 动作（打开外部浏览器 / 打开文本文档），并做协议白名单与路径解析的纵深防御。
// 依赖注入设计：生产侧接 vscode API（openExternal / showTextDocument），测试侧注入假实现，
// 保证纯逻辑可被 node:test 直接验证。
import { isAbsolute, resolve, join, basename } from 'node:path';
import type { PanelMessage } from '../panel/html';

/** 图片缓存文件名白名单正则：前缀（与 core.js 的 imageCacheFilename 一致）+ 时间戳/序号 + 白名单扩展名 */
const IMAGE_CACHE_NAME_RE = /^dsh-imgcache-[A-Za-z0-9._:-]+-\d+\.(png|jpe?g|gif|webp)$/i;

/**
 * 已落盘图片注册表：仅允许删除「本扩展写过的」缓存文件。
 * 这是纵深防御——即使页面被攻破/伪造 deleteImages 消息的任意路径，也无法删除工作区外的文件。
 * 默认使用模块级共享注册表（主/次面板共享）；测试可注入独立注册表。
 */
export interface ImageRegistry {
  has(p: string): boolean;
  add(p: string): void;
  delete(p: string): void;
  /** 当前登记的全部路径（供全量清理迭代；返回副本，不暴露内部 Set） */
  all(): string[];
}
export function createImageRegistry(): ImageRegistry {
  const set = new Set<string>();
  return {
    has: (p) => set.has(p),
    add: (p) => set.add(p),
    delete: (p) => set.delete(p),
    all: () => [...set],
  };
}
const sharedImageRegistry = createImageRegistry();

/** 图片文件写入依赖（生产接 node:fs/promises 的 writeFile/unlink） */
export interface ImageFileDeps {
  writeFile(path: string, dataB64: string): Thenable<void>;
  rmFile(path: string): Thenable<void>;
}

/**
 * 安全落盘图片缓存：仅接受绝对 cwd + 白名单文件名（无路径穿越），写入 join(cwd, name)。
 * 成功返回 { ok: true, path } 并登记到注册表；失败返回原因（不抛异常，由调用方回 ack）。
 */
export async function saveImageToCwd(
  deps: ImageFileDeps,
  req: { cwd?: string; name: string; dataB64: string },
  registry: ImageRegistry = sharedImageRegistry,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (typeof req.cwd !== 'string' || req.cwd === '' || !isAbsolute(req.cwd)) {
    return { ok: false, error: 'invalid cwd' };
  }
  // 文件名必须是普通名称（无路径分隔符/穿越）、符合白名单
  if (typeof req.name !== 'string' || basename(req.name) !== req.name || !IMAGE_CACHE_NAME_RE.test(req.name)) {
    return { ok: false, error: 'invalid filename' };
  }
  const target = join(req.cwd, req.name);
  // 防御：产物必须是 cwd 内的精确拼接（join 结果）
  if (target !== resolve(req.cwd, req.name)) {
    return { ok: false, error: 'path mismatch' };
  }
  if (typeof req.dataB64 !== 'string' || req.dataB64 === '') {
    return { ok: false, error: 'empty data' };
  }
  try {
    await deps.writeFile(target, req.dataB64);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  registry.add(target);
  return { ok: true, path: target };
}

/**
 * 删除图片缓存：只删除注册表中「本扩展曾写过的」路径，其余一律忽略。
 * 单个文件删除失败不中断其余；返回 { ok: true }（尽力而为，不因个别失败而整体报错）。
 */
export async function deleteImageFiles(
  deps: ImageFileDeps,
  req: { paths: string[] },
  registry: ImageRegistry = sharedImageRegistry,
): Promise<{ ok: boolean; error?: string }> {
  const list = Array.isArray(req.paths) ? req.paths : [];
  for (const p of list) {
    if (typeof p !== 'string' || !registry.has(p)) continue;
    try {
      await deps.rmFile(p);
    } catch {
      // 删除失败（文件已被移走/权限）尽力而为，不中断其余
    } finally {
      registry.delete(p);
    }
  }
  return { ok: true };
}

/**
 * 全量清理图片缓存（扩展停用/服务停止时的兜底）：删除注册表中所有已写路径并清空注册表。
 * 补充 pagehide 清理之外的生命周期缺口（关闭 VS Code/停用扩展时页面不一定会触发 pagehide）。
 */
export async function cleanupAllImageCaches(
  deps: ImageFileDeps,
  registry: ImageRegistry = sharedImageRegistry,
): Promise<void> {
  for (const p of registry.all()) {
    try {
      await deps.rmFile(p);
    } catch {
      // 忽略个别删除失败
    }
    registry.delete(p);
  }
}

/**
 * 扫描并清理「工作区根目录』中残留的图片降级临时文件（孤儿清理，不依赖注册表）。
 * 背景：dsh-imgcache-* 由扩展按白名单命名落盘到工作区根；若 VS Code/扩展重启，
 * 内存注册表（sharedImageRegistry）丢失，旧文件会成为「无人追踪的孤儿」——
 * cleanupAllImageCaches/deleteImageFiles 都按注册表删除，找不到它们。故在扩展激活
 * 与手动清理命令时按目录扫描，只删除符合 IMAGE_CACHE_NAME_RE（本扩展专属命名空间）的文件。
 * @param readDir 列出目录条目（生产接 node:fs/promises.readdir）
 * @param rmFile 删除文件（生产接 node:fs/promises.unlink）
 * @param roots 要扫描的工作区根目录；缺失/非绝对路径跳过
 * @returns 删除的文件数
 */
export async function cleanupStaleImageCaches(
  readDir: (dir: string) => Promise<string[]>,
  rmFile: (path: string) => Promise<void>,
  roots: string[],
): Promise<number> {
  let removed = 0;
  for (const root of roots) {
    if (typeof root !== 'string' || root === '' || !isAbsolute(root)) continue;
    let names: string[];
    try {
      names = await readDir(root);
    } catch {
      continue; // 目录不可读（不存在/权限）跳过
    }
    for (const n of names) {
      if (typeof n === 'string' && IMAGE_CACHE_NAME_RE.test(n)) {
        try {
          await rmFile(join(root, n));
          removed += 1;
        } catch {
          // 单个删除失败（文件已被移走/权限）尽力而为
        }
      }
    }
  }
  return removed;
}

// —— v0.4.3：「本轮文件改动」Diff 在 VS Code 中打开（turn-start 全文反推） ——
// 背景与实证（DSH 0.2.0-rc.1，dsh-client-ui-deliverables / dsh-workspace-changes）：
//  · `/api/changes.diff` 只返回 hunks，**不给完整的前后文件文本**，并刻意隐藏 cwd 与快照树 id
//    （`ChangesSummary = Pick<WorkspaceChangesSummary, 'turn'|'files'|'total'|'added'|'deleted'>`）；
//  · 但 unified diff 的语义是精确的：hunk 之外的行两侧逐字节相同。
// 因此以「磁盘当前内容」为 turn-end 侧、用 hunks 反向还原 turn-start 全文即可逐字节精确，
// 无需任何新接口。还原语义已与 DSH 真实的 compareText（structuredPatch，context=3）交叉验证。

/** DSH 比较面的上下文行数（dsh-workspace-changes 的 CONTEXT_LINES） */
export const CONTEXT_LINES = 3;

/** 一个 hunk（WorkspaceDiffHunk 的形状子集） */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** hunk 行体，每行以 '+' / '-' / ' ' 前缀 */
  lines: string[];
}

/** `/api/changes.diff` 的 text 分支（WorkspaceFileDiff 的形状子集） */
export interface FileDiff {
  kind: 'text';
  path: string;
  display?: string;
  /** turn 起始时该文件是否存在 */
  before: boolean;
  /** turn 结束时该文件是否存在 */
  after: boolean;
  hunks: DiffHunk[];
  /** 行比较超时降级为「整文件替换」 */
  coarse?: boolean;
}

/**
 * 校验 `/api/changes.diff` 的 JSON 是否为可直接处理的 text 对比。
 * binary / oversized 分支没有 hunks，无法还原旧侧，故一并拒绝。
 * @param value 页面转发的 diff 载荷
 * @returns 是否为可用的 text 对比
 */
export function isFileDiff(value: unknown): value is FileDiff {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  if (d.kind !== 'text') return false;
  if (typeof d.path !== 'string' || d.path === '') return false;
  if (typeof d.before !== 'boolean' || typeof d.after !== 'boolean') return false;
  if (!Array.isArray(d.hunks)) return false;
  return d.hunks.every((h) => {
    if (typeof h !== 'object' || h === null || Array.isArray(h)) return false;
    const k = h as Record<string, unknown>;
    return (
      Number.isInteger(k.oldStart) && Number.isInteger(k.oldLines) &&
      Number.isInteger(k.newStart) && Number.isInteger(k.newLines) &&
      Array.isArray(k.lines) &&
      // 每行必须带 '+'/'-'/' ' 前缀（空行在 wire 上是单字符前缀行）。
      // 严格限定这三种前缀是**正确性要求**，不是风格问题：unified diff 还可能出现
      // `\ No newline at end of file` 这类以 '\' 开头的元信息行，若放进来会被
      // reconstructBefore 当成上下文行、污染还原结果（静默给出错误内容）。
      // DSH 的 compareText 会对两侧先做 terminated()，所以实际不会产生该标记行；
      // 这里仍然拒绝，是为了在 DSH 改变行为时**明确降级**（退回直接打开文件），
      // 而不是安静地展示一份错误的 Diff。
      (k.lines as unknown[]).every(
        (l) => typeof l === 'string' && l.length > 0 && (l.charAt(0) === '+' || l.charAt(0) === '-' || l.charAt(0) === ' '),
      )
    );
  });
}

/**
 * 按 DSH 比对面语义拆分文本行，与 dsh-workspace-changes 的
 * `lines(terminated(text))` 完全一致：空文本零行、末尾换行不算额外行。
 * @param text 文本（undefined/null 视为空）
 * @returns 内容行数组
 */
export function splitComparableLines(text: string | undefined | null): string[] {
  const t = typeof text === 'string' ? text : '';
  if (t === '') return [];
  return (t.endsWith('\n') ? t.slice(0, -1) : t).split('\n');
}

/**
 * 由「turn-end 全文」+ hunks 反推「turn-start 全文」——逐字节精确。
 *
 * 算法：hunk 之外的行两侧相同（unified diff 的定义），因此以 turn-end 全文为骨架，
 * 按每个 hunk 的 `newStart` 定位、按其行体重建旧侧：
 *   · `' '` 上下文行 → 两侧都有，写入旧侧并推进新侧游标；
 *   · `'-'` 删除行   → 仅旧侧，写入旧侧（不动新侧游标）；
 *   · `'+'` 新增行   → 仅新侧，跳过（仅推进新侧游标）。
 * coarse（整文件替换的单 hunk）与新增/删除整个文件都由此自动成立：
 *   · 新增文件（before=false）→ 旧侧为空串；
 *   · 删除文件 → 单个全 `-` 的 hunk，游标不动，旧侧即全文。
 *
 * **显示层面的一致性**：DSH 在比较前会把两侧 `terminated()` 并把快照行规整为 `\n`，
 * 所以「行尾是 `\n` 还是 `\r\n`」和「是否以换行结尾」这两个信息**不在 payload 上**。
 * 结果是左栏（内存旧侧）若固定用 `\n` + 末尾补换行，就会与右栏（真实磁盘文件）
 * 在 CRLF 文件、或无末尾换行的文件上产生**虚假差异**。因此这里把这两个属性
 * 对齐到**右栏的实际形态**（see {@link splitComparableLines} 的调用方传入的 afterText）：
 *   · 行分隔符沿用 afterText 实际使用的（`\r\n` 或 `\n`）；
 *   · 是否以换行结尾沿用 afterText。
 * 这样两侧只在**真实内容差异**上不同，不会因为行尾风格而满屏飘红。
 *
 * @param afterText turn-end 全文（磁盘当前内容）；文件不存在时传空串
 * @param diff 校验过的 text 对比
 * @returns 还原出的 turn-start 全文
 */
export function reconstructBefore(afterText: string | undefined, diff: FileDiff): string {
  // turn 起始时文件不存在：旧侧就是空
  if (diff.before === false) return '';
  const raw = typeof afterText === 'string' ? afterText : '';
  const afterLines = splitComparableLines(raw);
  const beforeLines: string[] = [];
  let cursor = 0; // 新侧（afterLines）0-based 游标
  for (const hunk of diff.hunks) {
    const newStart = hunk.newStart - 1;
    // hunk 之前的未变更区段：两侧逐字节相同，直接搬运
    while (cursor < newStart && cursor < afterLines.length) {
      beforeLines.push(afterLines[cursor] as string);
      cursor += 1;
    }
    for (const line of hunk.lines) {
      const sign = line.charAt(0);
      const body = line.slice(1);
      if (sign === '+') {
        cursor += 1; // 仅存在于新侧
      } else if (sign === '-') {
        beforeLines.push(body); // 仅存在于旧侧
      } else {
        beforeLines.push(body);
        cursor += 1; // 上下文行：两侧都有
      }
    }
  }
  // hunk 之后的未变更区段
  while (cursor < afterLines.length) {
    beforeLines.push(afterLines[cursor] as string);
    cursor += 1;
  }
  if (beforeLines.length === 0) return '';
  // EOL 一致性：hunk 行体（来自 git 快照）与磁盘行体可能行尾风格不同，
  // 直接混用会让左栏出现「同时有两种行尾」的假差异。统一规整到**右栏（磁盘）**的风格：
  //   ① 去掉每行尾部可能残留的 '\r'（`splitComparableLines` 对 CRLF 会把 '\r' 留在行体内）；
  //   ② 若磁盘是 CRLF，再统一补回 '\r'。
  // 这样两侧只在**真实内容**上不同，不会因为行尾风格而满屏飘红。
  const isCrlf = raw.includes('\r\n');
  const normalized = beforeLines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const body = normalized.join(isCrlf ? '\r\n' : '\n');
  // 末尾换行：该位不在 payload 上（DSH 比较前会 terminated() 抹掉），
  // 只能沿用右栏形态，以免出现「凭空多/少一个末尾换行」的假改动。
  const trailing = raw === '' ? true : raw.endsWith('\n');
  return body + (trailing ? (isCrlf ? '\r\n' : '\n') : '');
}


/** 桥接消息处理依赖（生产接 vscode API，测试注入假实现） */
export interface BridgeMessageDeps {
  /** 打开外部链接（生产接 vscode.env.openExternal，返回是否成功） */
  openExternal(url: string): Thenable<boolean>;
  /** 打开文本文档（生产接 vscode.window.showTextDocument） */
  openTextDocument(path: string): Thenable<void>;
  /** 弹用户可见提示（生产接 vscode.window.showWarningMessage，测试注入假实现以断言） */
  showWarning(msg: string): void;
  /** 工作区根目录（相对路径解析的兜底基准，生产由扩展入口注入） */
  workspaceRoot?: string;
  /** 写入图片缓存文件（生产接 node:fs/promises，产物 base64）——v0.3.0 图片降级用 */
  writeFile?: (path: string, dataB64: string) => Thenable<void>;
  /** 删除图片缓存文件（生产接 node:fs/promises）——v0.3.0 会话结束清理用 */
  rmFile?: (path: string) => Thenable<void>;
  /** 回执消息投递（生产接 webview.postMessage）——v0.3.0 saveImage/deleteImages 回执 */
  reply?: (msg: PanelMessage) => Thenable<void>;
  /** 读取文件文本（生产接 node:fs/promises.readFile utf8）——v0.4.3 Diff 的 turn-end 侧 */
  readFileText?: (path: string) => Thenable<string>;
  /**
   * 以 VS Code 原生 diff 编辑器打开「旧 ↔ 新」两个文档（生产接 vscode.commands.executeCommand('vscode.diff', …)）。
   * 旧侧是**内存内文档**（自定义 scheme），不落任何临时文件——避免污染 Perforce/SVN 工作副本。
   */
  openDiff?: (beforeUri: string, afterPath: string, title: string) => Thenable<void>;
  /**
   * 把旧侧全文存进内存并返回其 URI 字面量（生产由 src/bridge/diff-doc.ts 提供）。
   * 用 `vscode.Uri.toString()` 的字符串形式跨层传递，host 层因此不需要依赖 vscode 类型。
   */
  putBeforeDoc?: (text: string, baseName: string) => string;
}

/**
 * 提取错误摘要：优先取 Error.message，其余类型做保守的字符串化，兜底空串。
 * 用于把打开失败原因并入用户提示，避免把内部错误对象原样展示。
 */
function errSummary(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err === null || err === undefined) return '';
  return String(err);
}

/**
 * 解析文件路径：绝对路径直接采用；相对路径依次按 会话 cwd → 工作区根 作为基准解析。
 * 安全规则：形似 URL 的协议串（如 https://、javascript:）一律拒绝，
 * 但 Windows 盘符（C:\ 或 C:/）不是协议，需要放行。
 */
export function resolveBridgePath(raw: string, sessionCwd: string | undefined, workspaceRoot: string | undefined):
  { kind: 'abs'; path: string } | { kind: 'invalid' } {
  // 路径形似 URL 一律拒绝（协议串）；Windows 盘符不属于协议，予以放行
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) {
    return { kind: 'invalid' };
  }
  // 绝对路径直接采用（跨平台：Windows 盘符与 POSIX / 开头都算绝对）
  if (isAbsolute(raw)) return { kind: 'abs', path: raw };
  // 相对路径：优先用会话 cwd，缺失时退回工作区根；两者都无则无法解析
  const base = sessionCwd ?? workspaceRoot;
  if (base === undefined) return { kind: 'invalid' };
  return { kind: 'abs', path: resolve(base, raw) };
}

/**
 * 校验「磁盘当前内容」是否真等于该轮改动结束时的内容（turn-end）。
 *
 * **为什么必须有这一步**（否则会安静地展示错误的 Diff）：
 * DSH 的 hunks 是在**两个 git 快照树**之间算出来的
 * （实证 `dsh-workspace-changes/lib/types/recorder.js` 的 `readSide` → `case 'snapshot'` → `treeBlob`），
 * 而这里只能读到**当前磁盘**内容。只要该轮之后文件又被改过
 * （下一轮再次编辑、手动改、格式化、`git checkout`、外部工具），
 * 磁盘就不再是 turn-end，用它反推出的 turn-start 会**同样合理但完全错误**。
 *
 * 判据（不需要新接口）：unified diff 的 `' '` 上下文行与 `'+'` 新增行
 * 在 turn-end 侧逐字节存在，且它们在 hunk 内的先后顺序是确定的。
 * 因此按 `newStart` 把各 hunk 锚回磁盘行，逐行比对这几行的**内容与位置**；
 * 全部相符才认为磁盘仍是 turn-end。
 *
 * 已知边界：hunk 只带「变更区 ± 3 行上下文」，所以本校验只能证明
 * **hunk 覆盖到的那些行**没变，更远处的改动察觉不到——这是端点载荷的固有限制
 * （`/api/changes.diff` 不给完整前后文本，也没有内容哈希）。
 * 宁可覆盖可判定的部分并在不可判定时拒绝，也不要因为「做不到完美」而完全不校验。
 *
 * @param afterLines 磁盘当前内容的行（按 DSH 比对面语义切分）
 * @param diff 校验过的 text 对比
 * @returns 磁盘内容与 hunks 自洽时 true
 */
export function afterSideMatchesHunks(afterLines: string[], diff: FileDiff): boolean {
  if (!Array.isArray(afterLines)) return false;
  // 行尾风格不参与比较：快照侧（hunk 行体）由 git 规整为 LF，
  // 而磁盘可能是 CRLF（`core.autocrlf=true` 的本机就是这样），
  // 若按字节比较，所有 CRLF 文件都会被判为「已被再次修改」而无法查看 Diff。
  const strip = (s: string) => (s.endsWith('\r') ? s.slice(0, -1) : s);
  for (const hunk of diff.hunks) {
    const start = hunk.newStart - 1;
    if (!Number.isInteger(start) || start < 0) return false;
    // 新侧行（' ' 上下文 / '+' 新增）必须按顺序、逐内容落在磁盘上
    let cursor = start;
    for (const line of hunk.lines) {
      const sign = line.charAt(0);
      if (sign !== ' ' && sign !== '+') continue; // '-' 只属于旧侧，不在磁盘上
      if (cursor >= afterLines.length) return false; // 磁盘比 hunk 期望的短
      if (strip(afterLines[cursor] as string) !== strip(line.slice(1))) return false; // 内容或位置不符
      cursor += 1;
    }
  }
  return true;
}

/**
 * 处理 `bridgeOpenDiff`：把 DSH 的「turn-start ↔ turn-end」对比放进 VS Code 原生 diff 视图。
 *
 * 步骤：解析目标文件绝对路径 → 读磁盘当前内容 → **校验磁盘确实仍是该轮的 turn-end**
 * → 用 hunks 反推 turn-start 全文 → 旧侧存入**内存文档**（自定义 scheme）
 * → `vscode.diff(内存旧侧, 真实文件, 标题)`。
 * 全程不落任何临时文件（避免污染 Perforce/SVN 工作副本，也避免「用后即删」导致 diff 视图退化）。
 * 任何一步失败都给出用户可见提示，绝不静默。
 *
 * **为什么必须校验 turn-end**：DSH 的 hunks 是在**两个 git 快照树**之间算出来的
 * （`dsh-workspace-changes` 的 `readSide` → `case 'snapshot'` → `treeBlob`），
 * 而这里只能读**当前磁盘**。只要该轮之后文件又被改过，磁盘就不再是 turn-end，
 * 用它反推的 turn-start 会「看起来合理但完全错误」。宁可提示并退回打开文件，
 * 也不要展示一份可信的假 diff。
 */
async function handleOpenDiff(
  msg: Extract<PanelMessage, { type: 'bridgeOpenDiff' }>,
  deps: BridgeMessageDeps,
): Promise<void> {
  const diff = msg.diff;
  if (!isFileDiff(diff)) {
    // binary / oversized 分支没有 hunks：退回「直接打开该文件」，仍比什么都不做强
    const fallback = resolveBridgePath(msg.path, msg.cwd, deps.workspaceRoot);
    if (fallback.kind === 'abs') {
      try {
        await deps.openTextDocument(fallback.path);
      } catch (err) {
        deps.showWarning(`无法打开文件：${fallback.path}（${errSummary(err)}）`);
      }
    } else {
      deps.showWarning(`无法解析路径：${msg.path}`);
    }
    return;
  }

  const r = resolveBridgePath(msg.path, msg.cwd, deps.workspaceRoot);
  if (r.kind !== 'abs') {
    deps.showWarning(`无法解析路径：${msg.path}`);
    return;
  }

  const readFileText = deps.readFileText;
  const putBeforeDoc = deps.putBeforeDoc;
  const openDiff = deps.openDiff;
  if (readFileText === undefined || putBeforeDoc === undefined || openDiff === undefined) {
    // 依赖缺失（理论不可达，生产侧必定注入）：不要静默，给出明确原因
    deps.showWarning('无法在 VS Code 中显示 Diff：桥接依赖未就绪');
    return;
  }

  try {
    let afterText: string;
    if (diff.after === false) {
      // 该轮结束时文件本就不存在 → turn-end 就是空串（由 payload 权威给出，
      // 与磁盘现状无关；不去读盘，避免「后来又被重建」污染骨架）。
      afterText = '';
    } else {
      // 必须区分「读失败」与「内容为空」：旧实现把读失败当空串，
      // 会在文件被删除/改名后**静默截断**左栏（只留 hunk 行体）。
      try {
        afterText = await readFileText(r.path);
      } catch (err) {
        await openDiffFallback(deps, r.path, `文件已无法读取（${errSummary(err)}）`);
        return;
      }
      // 磁盘必须仍是该轮的 turn-end（hunk 的上下文行/新增行要能逐行对上），
      // 否则反推出的 turn-start 会「看起来合理但完全错误」。
      if (!afterSideMatchesHunks(splitComparableLines(afterText), diff)) {
        await openDiffFallback(deps, r.path, '该轮之后文件已被再次修改，无法重建当时的对比');
        return;
      }
    }

    const beforeText = reconstructBefore(afterText, diff);
    const beforeUri = putBeforeDoc(beforeText, basename(r.path));
    // 标题：优先用 DSH 的展示路径，否则用文件名
    const title = typeof msg.display === 'string' && msg.display !== '' ? msg.display : basename(r.path);
    await openDiff(beforeUri, r.path, title);
  } catch (err) {
    deps.showWarning(`无法显示 Diff：${r.path}（${errSummary(err)}）`);
  }
}

/**
 * Diff 无法可靠重建时的统一退路：直接打开该文件，并说明原因（绝不静默、绝不给假 Diff）。
 * @param deps 桥接依赖
 * @param path 目标文件绝对路径
 * @param reason 面向用户的原因（会拼进提示）
 */
async function openDiffFallback(
  deps: BridgeMessageDeps,
  path: string,
  reason: string,
): Promise<void> {
  deps.showWarning(`${reason}，已改为直接打开文件：${path}`);
  try {
    await deps.openTextDocument(path);
  } catch {
    // 文件可能也已不存在：提示已经给出，这里不再重复打扰
  }
}

/**
 * 处理桥接消息：外链打开走协议白名单，文件跳转走路径解析，Diff 走容器还原。
 */
export async function handleBridgeMessage(msg: PanelMessage, deps: BridgeMessageDeps): Promise<void> {
  if (msg.type === 'bridgeOpenExternal') {
    // 协议白名单：仅 http/https（与桥接侧白名单双重校验，纵深防御）
    if (/^https?:\/\//i.test(msg.url)) {
      try {
        await deps.openExternal(msg.url);
      } catch (err) {
        // 打开外链可能失败（如无默认浏览器），捕获后给用户可见反馈而非未处理拒绝
        deps.showWarning(`无法打开链接：${msg.url}（${errSummary(err)}）`);
      }
    }
    return;
  }
  if (msg.type === 'bridgeOpenFile') {
    const r = resolveBridgePath(msg.path, msg.cwd, deps.workspaceRoot);
    if (r.kind === 'abs') {
      try {
        // 打开文档可能因文件不存在/无权限等失败，捕获后给用户可见反馈而非未处理拒绝
        await deps.openTextDocument(r.path);
      } catch (err) {
        // 文案内联固定提示（本模块纯逻辑，直接断言，与 Task 7 的 i18n 无关）
        deps.showWarning(`无法打开文件：${r.path}（${errSummary(err)}）`);
      }
    } else {
      // 路径无法解析（危险协议或缺少基准目录）：仅弹提示，不打断面板与桥接流程
      deps.showWarning(`无法解析路径：${msg.path}`);
    }
    return;
  }
  if (msg.type === 'bridgeOpenDiff') {
    await handleOpenDiff(msg, deps);
    return;
  }
  if (msg.type === 'bridgeSaveImage') {
    // 图片缓存落盘：白名单校验 + 路径安全由 saveImageToCwd 保证；回执 success/路径给 iframe
    // cwd 兜底：客户端通常不传会话 cwd（DSH 无轻量接口可取），回退到工作区根目录（=dsh 会话 cwd 的常用值）
    const r = await saveImageToCwd(
      { writeFile: deps.writeFile ?? (async () => {}), rmFile: deps.rmFile ?? (async () => {}) },
      { cwd: msg.sessionCwd ?? deps.workspaceRoot, name: msg.name, dataB64: msg.dataB64 },
    );
    await deps.reply?.({
      type: 'bridgeSaveImageAck',
      requestId: msg.requestId,
      ok: r.ok,
      ...(r.path === undefined ? {} : { path: r.path }),
    });
    return;
  }
  if (msg.type === 'bridgeDeleteImages') {
    // 会话结束清理：只删除注册表中的本扩展缓存文件
    const r = await deleteImageFiles(
      { writeFile: deps.writeFile ?? (async () => {}), rmFile: deps.rmFile ?? (async () => {}) },
      { paths: msg.paths },
    );
    await deps.reply?.({ type: 'bridgeDeleteImagesAck', requestId: msg.requestId, ok: r.ok });
    return;
  }
}