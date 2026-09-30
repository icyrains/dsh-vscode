// src/bridge/installer.ts — DSH 桥接包的探测与幂等安装/卸载
// 职责：把 bridge-client 包安装进用户 profile 目录（$DSH_HOME/profiles/web），
// 并通过 cordis.patch.yml 的 insert: 条目把它注册为 DSH 的官方 client 插件。
// 安全边界：只写用户目录（$DSH_HOME/profiles/web），绝不触碰 DSH 安装目录。
//
// 关键约束（来自 Task 0 spike 实测，见 task-0-report.md）：
// 1. cordis.patch.yml 顶层是流式空数组 `[]` 时，不能在其后直接追加块序列条目，
//    否则整个文件 YAML 解析失败（fail-loud）。必须把顶层改写为块序列形式。
// 2. 新增条目必须用 `insert:` 包裹；裸 `- id:` 条目是「按 id 覆盖既有行」的 patch，
//    目标行不存在时只会告警并跳过，不会真正新增条目。
// 3. 卸载时按 begin/end 标记精确删除条目段；若删除后仅剩空白，还原为 `[]`。
import { join, dirname, win32 } from 'node:path';
import * as nodeFs from 'node:fs';

/** 桥接条目在 cordis.patch.yml 中的包裹标记（卸载时按标记精确删除） */
export const BRIDGE_BEGIN_MARK = '# dsh-vscode-bridge: begin';
export const BRIDGE_END_MARK = '# dsh-vscode-bridge: end';
/** 空数组改写分支的元数据标记：begin 标记行携带它，卸载时据此字节级还原「注释头 + []」 */
export const BRIDGE_WAS_EMPTY_ARRAY_FLAG = 'was-empty-array';
/** 空数组改写分支专用 begin 标记（= base begin 标记 + was-empty-array 元数据） */
export const BRIDGE_BEGIN_MARK_WAS_EMPTY = `${BRIDGE_BEGIN_MARK} ${BRIDGE_WAS_EMPTY_ARRAY_FLAG}`;

/** 桥接包在 profile node_modules 下的目录名（无 scope） */
export const BRIDGE_PACKAGE_NAME = 'dsh-vscode-bridge';

/** 注入的 fs 子集：生产用 Node fs 封装（createNodeFs），测试用内存实现 */
export interface InstallerFs {
  exists(p: string): boolean;
  readFile(p: string): string;
  writeFile(p: string, content: string): void;
  mkdir(p: string): void;
  copyDir(src: string, dest: string): void;
  rmDir(p: string): void;
  readdir(p: string): string[];
}

/** 安装结果状态：ok 成功；pending-restart 预留（服务重启后生效）；degraded 降级 */
export type BridgeInstallStatus = 'ok' | 'pending-restart' | 'degraded';

/** 安装结果 */
export interface BridgeInstallResult {
  status: BridgeInstallStatus;
  reason?: string;   // degraded 时的原因（英文短句，日志用）
  profileDir?: string;
  bridgeDir?: string; // 安装目标目录（保持兼容：语义为 primary 路径 profiles/web/node_modules/dsh-vscode-bridge；secondary 见 bridgeTargetDirs）
}

/** 安装参数 */
export interface BridgeInstallOptions {
  dshHome: string;            // $DSH_HOME 或 ~/.dsh
  bridgeSourceDir: string;    // 插件随附 bridge-client 目录绝对路径
  fs: InstallerFs;            // 注入的 fs 子集
  /** npm 全局 node_modules 目录绝对路径（Windows 扩展宿主 ESM 解析可达位置，可选） */
  npmGlobalNodeModules?: string;
}

/**
 * 定位 web profile 目录：dshHome/profiles/web。
 * 不存在时返回 null（调用方据此判定为 degraded）。
 */
export function detectProfileDir(dshHome: string, fs: InstallerFs): string | null {
  const dir = join(dshHome, 'profiles', 'web');
  return fs.exists(dir) ? dir : null;
}

/**
 * 桥接包的全部安装目标目录。
 *
 * 背景（Windows 实测，见 bridge-locations-fix-report.md）：
 * - primary：profiles/web/node_modules/dsh-vscode-bridge（WSL 模块解析锚点）；
 * - secondary：profiles/node_modules/dsh-vscode-bridge（Windows profile 插件解析 fallback 真实目录）；
 * - npm 全局位置（可选）：Windows 下 VS Code 扩展宿主 spawn 的 dsh 进程对 profile 插件的 ESM
 *   解析与普通命令行进程不同，profiles 双位置仍可能解析不到桥接包；而 npm 全局 node_modules
 *   （AppData\Roaming\npm\node_modules）是确定可达的位置，因此额外安装到此处。
 * 两类平台各解析其可及位置，因此需同时安装到全部位置。
 *
 * 顺序固定：[primary, secondary, ...(npmGlobalNodeModules ? [join(npmGlobalNodeModules, NAME)] : [])]
 *
 * @param profileDir            web profile 目录绝对路径
 * @param npmGlobalNodeModules  npm 全局 node_modules 目录绝对路径（可选，缺省仅双位置）
 */
export function bridgeTargetDirs(profileDir: string, npmGlobalNodeModules?: string): string[] {
  const dirs = [
    join(profileDir, 'node_modules', BRIDGE_PACKAGE_NAME),
    join(profileDir, '..', 'node_modules', BRIDGE_PACKAGE_NAME),
  ];
  if (npmGlobalNodeModules) {
    dirs.push(join(npmGlobalNodeModules, BRIDGE_PACKAGE_NAME));
  }
  return dirs;
}

/**
 * 从「dsh 包内文件路径」向上寻找第一个 `node_modules` 目录（issue #20）。
 *
 * 场景：`dsh.executablePath` 指向 `…\app.asar.unpacked\node_modules\@deepseek-ai\dsh\lib\bin.js`
 * 这类包内入口时，`dirname` 得到的是包内目录而非 node_modules 根；逐级上溯才能拿到真正的根。
 * 全程用 path.win32，避免在非 Windows 上单测这条 Windows 逻辑时被平台路径规则干扰。
 *
 * @returns node_modules 根目录；路径中不含 node_modules 段时返回 undefined（调用方放弃该目标）
 */
export function npmNodeModulesRootFrom(p: string): string | undefined {
  let dir = win32.dirname(p);
  for (let i = 0; i < 12; i += 1) {
    if (win32.basename(dir).toLowerCase() === 'node_modules') return dir;
    const parent = win32.dirname(dir);
    if (parent === dir) break; // 到盘符根仍未找到
    dir = parent;
  }
  return undefined;
}

/**
 * 判断该安装目标是否应当跳过：其**父目录是"命令垫片目录"**（issue #20）。
 *
 * 关键点（真实文件系统 + 真机验证得出，且踩过一次回归）：
 * 危险不是"父目录里有别人的东西"，而是"**往一个被别的程序独占的命令目录里新增条目**"。
 * 受害目录 `%APPDATA%\DSH Desktop\host-commands\desktop\bin` 被 DSH Desktop 以硬断言独占
 * （只允许它自己的 `dsh.cmd`）：多出任何条目（含我们新建的 `dsh-vscode-bridge/`）都会让
 * 桌面下次启动硬失败。
 *
 * 判据刻意收窄为「父目录里存在批处理垫片（`*.cmd`）」——这正是"命令目录"的特征：
 * - `…/desktop/bin` 里有 `dsh.cmd` → 跳过 ✅（issue #20 的场景）
 * - `…/node_modules`（npm 全局或 DSH profiles 下的依赖目录）里有成百上千个包，
 *   但不会有 `dsh.cmd` → **放行**，否则桥接无法被刷新（曾因"父目录有他人条目就跳过"
 *   导致 `profiles/node_modules` 的桥接停留在旧版本）。
 *
 * @param parentDir 目标目录的父目录（如 `…/node_modules` 或 `…/desktop/bin`）
 */
export function shouldSkipForeignTarget(
  parentDir: string,
  fs: Pick<InstallerFs, 'exists' | 'readdir'>,
): boolean {
  if (!fs.exists(parentDir)) return false; // 父目录不存在：由本扩展创建，安全
  try {
    // 只认"命令垫片目录"：含 *.cmd 即视为被别的程序独占的命令目录
    return fs.readdir(parentDir).some((name) => name.toLowerCase().endsWith('.cmd'));
  } catch {
    // 读不到目录内容（权限/IO）时保守跳过：宁可少装一处，也不冒写坏他人目录的风险
    return true;
  }
}

/**
 * 判定 cordis.patch.yml 的顶层是否为「流式空数组 []」。
 *
 * 规则：去掉注释行与空行后：
 * - 剩余有效行为空，且原文 trim 后为空 → 空文件，视为空数组；
 * - 剩余有效行只有一行且为 `[]` → 顶层空数组（含「注释 + []」的默认模板）；
 * - 其余（含只有注释、或已有块序列条目）→ 不是空数组。
 *
 * 注意「只有注释」必须走追加分支而非改写分支：注释可能是用户自己的内容
 * （见 uninstall 用例 `# 用户自己的内容`），改写会覆盖它。
 */
function isTopLevelEmptyArray(content: string): boolean {
  const meaningful = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  if (meaningful.length === 0) {
    // 无任何有效行：只有「真正空文件」才视为空数组；只有注释视为用户内容
    return content.trim() === '';
  }
  return meaningful.length === 1 && meaningful[0] === '[]';
}

/**
 * 提取「顶层空数组」文件中 `[]` 这一行之前的注释头（含全部注释行与空行），原样保留。
 * 仅在 isTopLevelEmptyArray 判定为真时调用；逐行定位顶层 `[]` 所在行，
 * 返回其之前的原始子串（不 trim、不改写），供卸载时字节级还原。
 */
function findEmptyArrayHead(content: string): string {
  let pos = 0;
  for (const line of content.split('\n')) {
    if (line.trim() === '[]') {
      // 找到顶层 [] 行：其之前的内容（注释头 + 空行）即 head
      return content.slice(0, pos);
    }
    pos += line.length + 1; // +1 为换行符
  }
  return ''; // 防御分支：调用前已用 isTopLevelEmptyArray 判定，不会走到这里
}

/**
 * 幂等安装桥接包（全部目标目录：primary + secondary + 可选 npm 全局位置）：
 * - profile 缺失 → degraded；
 * - 条目已存在 → 可用性验证（每处均可读 package.json），全部完好则 ok，
 *   任一处坏包（权限/损坏/缺失）则强制重装该处，重装失败则回滚条目为 degraded；
 * - 首次安装 → 写条目 + 复制目录到全部目标位置，
 *   任一处 copyDir 失败则清理已复制的 → 还原 patch → degraded；
 * - 顶层空数组 → 整文件改写为块序列（含 insert: 条目）；
 * - 已有用户内容 → 去尾随空白后追加 insert: 条目。
 */
export function installBridge(opts: BridgeInstallOptions): BridgeInstallResult {
  const profileDir = detectProfileDir(opts.dshHome, opts.fs);
  if (profileDir === null) {
    return { status: 'degraded', reason: 'web profile not found' };
  }
  const patchPath = join(profileDir, 'cordis.patch.yml');
  const allTargets = bridgeTargetDirs(profileDir, opts.npmGlobalNodeModules);
  // 写入前的白名单校验（issue #20）：按**父目录**判定——父目录里已有非本扩展产物就跳过该目标。
  // 典型受害目录是 DSH Desktop 的私有命令目录（只允许它自己的 dsh.cmd）：哪怕目标子目录
  // 还不存在，只要往那里新建 `dsh-vscode-bridge/`，桌面下次启动就会硬失败。
  const targets = allTargets.filter((t) => !shouldSkipForeignTarget(dirname(t), opts.fs));
  // primary 路径保持兼容语义（BridgeInstallResult.bridgeDir）
  const bridgeDir = targets[0] ?? allTargets[0];

  // 读取现有 patch（不存在视为空，避免真实环境首次运行时 readFile 抛错）
  const existing = opts.fs.exists(patchPath) ? opts.fs.readFile(patchPath) : '';

  // 判定「已安装」必须**两种形态都认**：带标记块 + 早期版本残留的无标记裸 insert。
  // 只查 BRIDGE_BEGIN_MARK 的旧写法会让无标记文件走下面的「首次安装」分支，
  // 于是每次激活都再追加一条 → 条目无限累积（真实故障：文件里堆了 4 条，
  // 而 DSH 对同 id 多条 insert 是静默追加，界面上完全看不出问题）。
  if (countBridgeEntries(existing) > 0) {
    // 已存在条目：先归一为恰好一条（自愈重复副本 + 给无标记块补标记），
    // 再做"全部目标目录都必须可用"的判定（能读到含 `"name"` 的 package.json，
    // 且版本与插件随附版本一致——版本不一致说明是升级前的旧包，需强制重装刷新）。
    // 仅 exists 会漏掉「目录在但 package.json 不可读」的坏包（chmod 000 事故），
    // 且 Windows 场景某目标缺失但其余完好时也需自愈补回。
    const deduped = dedupeBridgeEntries(existing);
    if (deduped !== existing) {
      opts.fs.writeFile(patchPath, deduped);
    }
    const wantVersion = bridgeVersion(opts.bridgeSourceDir, opts.fs);
    const unusable = targets.filter((t) => !isBridgeUsable(t, opts.fs, wantVersion, opts.bridgeSourceDir));
    if (unusable.length === 0) {
      return { status: 'ok', profileDir, bridgeDir };
    }
    // 有目标不可用：逐一强制重装（删掉坏目录后重新复制）。
    try {
      for (const t of unusable) {
        opts.fs.rmDir(t);
        copyBridgeDir(opts, t);
      }
      return { status: 'ok', profileDir, bridgeDir };
    } catch (e) {
      // 删除或复制失败（权限锁死等）：回滚 patch 条目，避免「有条目但包不可用」导致 DSH 启动失败。
      // 回滚后 DSH 至少能干净启动，用户可手工修权限后再重试安装。
      uninstallBridge(opts);
      return { status: 'degraded', reason: `reinstall failed: ${errMsg(e)}`, profileDir, bridgeDir };
    }
  }

  // 首次安装：写条目前保存原文，供 copyDir 失败时回滚，绝不残留「有条目但包不可用」。
  const originalPatch = existing;
  writePatchEntry(opts.fs, patchPath, existing);
  // 写入后硬校验：**恰好一条**。DSH 对同 id 多条 insert 是静默追加（不查重、不告警），
  // 所以「只写一条」必须由我们保证。若这里不成立，宁可回滚成 degraded 也不留下坏配置——
  // 让问题在日志里可见，而不是变成用户侧难以察觉的重复挂载。
  if (countBridgeEntries(opts.fs.readFile(patchPath)) !== 1) {
    opts.fs.writeFile(patchPath, originalPatch);
    return { status: 'degraded', reason: 'patch entry count is not exactly 1 after write', profileDir, bridgeDir };
  }
  let failedTarget = '';
  try {
    // 全部目标位置复制：每处都成功才算安装成功。
    for (const t of targets) {
      failedTarget = t;
      copyBridgeDir(opts, t);
    }
  } catch (e) {
    // 任一处复制失败：尽力清理已复制的目录 + 还原 patch 原文，返回 degraded。
    // 清理为尽力而为（rmDir 可能同样抛错），核心是还原 patch 绝不残留「有条目但包不可用」。
    for (const t of targets) {
      try { opts.fs.rmDir(t); } catch { /* 忽略清理失败 */ }
    }
    opts.fs.writeFile(patchPath, originalPatch);
    // failedTarget 即失败时正在复制的目标路径，写入 reason 便于日志定位。
    return { status: 'degraded', reason: `copy failed at ${failedTarget}: ${errMsg(e)}`, profileDir, bridgeDir };
  }
  return { status: 'ok', profileDir, bridgeDir };
}

/**
 * 统计 patch 里「桥接条目」的份数（含无标记的旧版残留）。
 *
 * 存在意义：**同一 id 多条 insert 会被 DSH 静默叠加**——`dsh-app-boot` 的
 * `applyEntryPatches` 对 insert 走的是 `data.push(...insert)`，纯追加、不查重、不告警
 * （实测 `dsh --dump-config --profile web` 会把 4 条全部列进最终 loader 树）。
 * 因此「只写一条」是必须由我们保证的不变量，需要一个可验证的计数函数。
 *
 * @returns 桥接条目块的数量
 */
export function countBridgeEntries(patch: string): number {
  return findBridgeBlocks(patch.split('\n')).length;
}

/** 一个桥接条目块的行范围（0-based，含首尾行）与是否带 begin/end 标记 */
interface BridgeBlock {
  start: number;
  end: number;
  marked: boolean;
}

/** 是否为 begin 标记行（含 `was-empty-array` 元数据变体） */
function isBeginMark(line: string): boolean {
  return line.trim().startsWith(BRIDGE_BEGIN_MARK);
}

/** 是否为 end 标记行 */
function isEndMark(line: string): boolean {
  return line.trim().startsWith(BRIDGE_END_MARK);
}

/** 顶层 `- insert:` 行 */
function isInsertLine(line: string): boolean {
  return /^- insert:\s*$/.test(line);
}

/** insert 列表里的一个 `- id: xxx` 行 */
function idOf(line: string): string | null {
  const m = /^\s+-\s*id:\s*(\S+)\s*$/.exec(line);
  return m === null ? null : m[1];
}

/**
 * 定位 patch 里的全部桥接条目块，分两种形态：
 *
 * 1. **带标记块**：`# dsh-vscode-bridge: begin` … `# dsh-vscode-bridge: end`（当前版本写法）；
 * 2. **无标记块**：顶层 `- insert:` 且其条目列表**全部**是 `id: dsh-vscode-bridge`
 *    ——早期版本残留的形态（只写裸 insert，没有标记）。
 *
 * 形态 2 必须被识别：早期版本写的条目对「只匹配 begin..end」的旧实现完全不可见，
 * 于是自愈永远不生效（真实故障：文件里累积了 4 条，界面只表现为「能用」，无从察觉）。
 *
 * 保守性：begin 有配对 end 才算块（标记不完整则整段忽略，绝不猜着删用户内容）；
 * insert 列表里若混有其它 id，则**不整段删除**（那不是纯桥接条目），只跳过。
 */
function findBridgeBlocks(lines: string[]): BridgeBlock[] {
  const blocks: BridgeBlock[] = [];
  const covered = new Array<boolean>(lines.length).fill(false);

  // ① 带标记块
  for (let i = 0; i < lines.length; i += 1) {
    if (covered[i] || !isBeginMark(lines[i])) continue;
    let j = i;
    while (j < lines.length && !isEndMark(lines[j])) {
      // 撞到下一个 begin 说明标记没配对：放弃该段（保守，不删）
      if (j > i && isBeginMark(lines[j])) break;
      j += 1;
    }
    if (j >= lines.length || !isEndMark(lines[j])) continue;
    for (let k = i; k <= j; k += 1) covered[k] = true;
    blocks.push({ start: i, end: j, marked: true });
    i = j;
  }

  // ② 无标记的裸 insert 块（跳过已归属标记块的行）
  for (let i = 0; i < lines.length; i += 1) {
    if (covered[i] || !isInsertLine(lines[i])) continue;
    let j = i;
    while (j + 1 < lines.length && /^\s+\S/.test(lines[j + 1])) j += 1;
    const body = lines.slice(i + 1, j + 1);
    const ids = body.map(idOf).filter((id): id is string => id !== null);
    // 必须命中桥接，且列表里没有别的 id（否则不是纯桥接条目，整段删除风险高）
    if (ids.length === 0 || ids.some((id) => id !== BRIDGE_PACKAGE_NAME)) continue;
    blocks.push({ start: i, end: j, marked: false });
    for (let k = i; k <= j; k += 1) covered[k] = true;
    i = j;
  }

  return blocks;
}

/**
 * 把 patch 里的桥接条目**归一为恰好一条**（幂等自愈）。
 *
 * 为什么需要：DSH 对同 id 的多条 insert 是**静默追加**而非覆盖
 * （`dsh-app-boot` 的 `applyEntryPatches` → `data.push(...insert)`），
 * 多条并存会让插件被重复挂载，且 `dsh --dump-config` 之前的任何环节都不报错。
 *
 * 处理两种来源：带标记块的重复、以及早期版本残留的**无标记**裸 insert。
 * 保留优先级：带标记块 > 无标记块（卸载依赖标记，故优先留带标记的）；
 * 若只剩一个无标记块，就地补上标记，使其可被正常卸载。
 *
 * 不动用户内容：非桥接条目、以及混有其它 id 的 insert 一律原样保留。
 * 空行清理只针对被删条目**自身带来的**那一行分隔，不做全局折叠
 * （全局折叠会误改用户 YAML 块标量里的空行）。
 *
 * @returns 归一后的 patch 文本；本来就恰好一条（且带标记）时原样返回
 */
export function dedupeBridgeEntries(patch: string): string {
  const lines = patch.split('\n');
  const blocks = findBridgeBlocks(lines);
  if (blocks.length === 0) return patch;
  if (blocks.length === 1 && blocks[0].marked) return patch;

  // 保留带标记的那一个；没有带标记的则保留第一个并补标记
  const keepIdx = Math.max(0, blocks.findIndex((b) => b.marked));
  const kept = blocks[keepIdx];

  const drop = new Set<number>();
  blocks.forEach((b, idx) => {
    if (idx === keepIdx) return;
    for (let k = b.start; k <= b.end; k += 1) drop.add(k);
    // 追加条目时我们会在其前留一空行作分隔；删除该块时一并收掉这一行
    if (b.start > 0 && lines[b.start - 1].trim() === '') drop.add(b.start - 1);
  });

  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (drop.has(i)) continue;
    if (i === kept.start && !kept.marked) out.push(BRIDGE_BEGIN_MARK);
    out.push(lines[i]);
    if (i === kept.end && !kept.marked) out.push(BRIDGE_END_MARK);
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** 提取 Error 的 message（未知抛出物兜底为字符串化） */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 卸载：删除桥接条目（两种形态都删：带标记块 + 早期版本残留的无标记裸 insert）
 * + 删除桥接目录。其余内容原样保留。
 *
 * 为什么必须认无标记块：早期版本写下的裸 insert 没有标记，只按标记删会**删不掉**，
 * 于是「卸载后 DSH 里桥接仍在跑」——比装不上更难排查（用户已以为卸载完成）。
 */
export function uninstallBridge(opts: BridgeInstallOptions): void {
  const profileDir = detectProfileDir(opts.dshHome, opts.fs);
  if (profileDir === null) return;
  const patchPath = join(profileDir, 'cordis.patch.yml');
  if (!opts.fs.exists(patchPath)) return;
  const patch = opts.fs.readFile(patchPath);

  // 空数组改写分支的还原元数据：只扫带标记段内部，避免误判用户内容里的同名文本
  const begin = patch.indexOf(BRIDGE_BEGIN_MARK);
  const end = patch.indexOf(BRIDGE_END_MARK);
  const wasEmptyArray =
    begin !== -1 && end !== -1 && patch.slice(begin, Math.max(begin, end)).includes(BRIDGE_WAS_EMPTY_ARRAY_FLAG);

  const lines = patch.split('\n');
  const blocks = findBridgeBlocks(lines);
  if (blocks.length > 0) {
    // 按**字符偏移**单趟拼接删除（而不是「过滤行后重新 join」）。
    // 两个都必须注意的点（各自都踩过一次）：
    //  1) 不能顺手删掉块**前面的空行**：空数组改写分支写入的是 `head + entry + '\n'`，
    //     而 head 可能以空行结尾（`# 注释\n\n` + 条目）；连它一起删会把
    //     `# 注释\n\n[]` 还原成 `# 注释\n[]`，丢掉原始空行（实测被独立验证抓出）。
    //  2) `findBridgeBlocks` 返回的顺序**不是**位置序（先收标记块、再收无标记块），
    //     所以不能按数组下标「从后往前」删——那样可能先删靠前的块，使后面块的偏移失效
    //     （实测：混合形态卸载后漏删一条）。这里显式按 start 升序、单趟拼接，与顺序无关。
    const lineStart: number[] = [];
    let pos = 0;
    for (const line of lines) {
      lineStart.push(pos);
      pos += line.length + 1; // +1 为换行符
    }
    let restored = '';
    let cursor = 0;
    for (const b of [...blocks].sort((x, y) => x.start - y.start)) {
      restored += patch.slice(cursor, lineStart[b.start]);
      // 连同块最后一行之后的换行一起删（安装时就是我们补上的）
      cursor = Math.min(lineStart[b.end] + lines[b.end].length + 1, patch.length);
    }
    restored += patch.slice(cursor);
    if (wasEmptyArray) {
      // 空数组改写分支：restored 即安装前的注释头（原样，含空行），补回 [] 实现字节级还原
      opts.fs.writeFile(patchPath, `${restored}[]\n`);
    } else {
      // 追加分支：安装时引入过 `\n\n` 分隔，归一化尾随空白后补单个换行
      const normalized = restored.trimEnd();
      opts.fs.writeFile(patchPath, normalized === '' ? '[]\n' : `${normalized}\n`);
    }
  }
  const targets = bridgeTargetDirs(profileDir, opts.npmGlobalNodeModules);
  // 全部目标目录删除均为尽力而为：权限锁死等场景下 rmDir 可能抛错，
  // 卸载的核心是回滚 patch 条目（保证 DSH 可干净启动），目录删除失败不应中断卸载。
  for (const dir of targets) {
    if (opts.fs.exists(dir)) {
      try {
        opts.fs.rmDir(dir);
      } catch {
        // 忽略：目录残留不影响 DSH 启动，用户可后续手工清理
      }
    }
  }
}

/**
 * 生产侧 Node fs 适配：把 node:fs 同步 API 封装为 InstallerFs 子集。
 * copyDir 用 fs.cpSync(src, dest, { recursive: true }) 递归复制。
 * 供 Task 7 装配时注入到 installBridge/uninstallBridge。
 */
export function createNodeFs(): InstallerFs {
  return {
    exists: (p) => nodeFs.existsSync(p),
    readFile: (p) => nodeFs.readFileSync(p, 'utf8'),
    writeFile: (p, content) => nodeFs.writeFileSync(p, content, 'utf8'),
    mkdir: (p) => nodeFs.mkdirSync(p, { recursive: true }),
    copyDir: (src, dest) => nodeFs.cpSync(src, dest, { recursive: true }),
    rmDir: (p) => nodeFs.rmSync(p, { recursive: true, force: true }),
    readdir: (p) => nodeFs.readdirSync(p),
  };
}

/**
 * 写入 cordis.patch.yml 的桥接条目（含 begin/end 标记）。
 * 顶层空数组 → 保留 [] 之前的注释头，改写为块序列；已有内容 → 追加。
 */
function writePatchEntry(fs: InstallerFs, patchPath: string, existing: string): void {
  if (isTopLevelEmptyArray(existing)) {
    // 顶层空数组（[] / 空文件 / 注释+[] 的默认模板）：
    // 1) 提取 [] 之前的注释头 head（原样保留全部注释行与空行）；
    // 2) 写入 head + 块序列条目，begin 标记携带 was-empty-array 元数据，
    //    供卸载时字节级还原为「head + []\n」。
    // 直接改写为块序列，避免在 [] 之后追加块序列导致 YAML 解析失败（fail-loud）。
    const head = findEmptyArrayHead(existing);
    const entry = buildPatchEntry(BRIDGE_BEGIN_MARK_WAS_EMPTY);
    fs.writeFile(patchPath, `${head}${entry}\n`);
  } else {
    // 已有用户内容：去尾随空白后追加，中间留一空行，绝不覆盖用户内容；
    // begin 标记不带 was-empty-array 元数据（安装行为与修复前一致）。
    const entry = buildPatchEntry(BRIDGE_BEGIN_MARK);
    fs.writeFile(patchPath, `${existing.trimEnd()}\n\n${entry}\n`);
  }
}

/**
 * 组装桥接条目段：begin 标记行 + insert: 包裹 + end 标记行（顶层块序列，可合法存在）。
 * beginMark 由调用方决定——空数组改写分支用带 was-empty-array 元数据的变体，
 * 用户内容追加分支用普通 BRIDGE_BEGIN_MARK。
 */
function buildPatchEntry(beginMark: string): string {
  return [
    beginMark,
    '- insert:',
    `    - id: ${BRIDGE_PACKAGE_NAME}`,
    `      name: ${BRIDGE_PACKAGE_NAME}`,
    BRIDGE_END_MARK,
  ].join('\n');
}

/**
 * 可用性验证：桥接目录完好与否，取决于能否读到含 `"name"` 字段的 package.json、
 * version 与随附版本一致（版本已知时），且【随附 client.js 与已装 client.js 字节一致】。
 * 版本比对的意义：版本不一致视为「旧版残留」→ 强制重装刷新。
 * 内容比对的意义：桥接版本与插件版本已统一（一同随包发布），版本号不再随每次代码修复递增，
 * 若仅比版本，会出现「版本号相同但代码不同 → 安装器跳过重装」——升级插件后用户仍跑旧桥接代码
 * （生产实测：商店 v0.3.0 用户残留旧 0.3.0 桥接，图片上传仍报旧弹窗）。故必须再按内容判定。
 * 读取抛错（权限不可读/chmod 000）或内容不含 `"name"` 均视为坏包 → 需要强制重装。
 *
 * @param wantVersion 插件随附桥接包版本号；空串表示源包版本未知（退回只看 `"name"`）
 * @param sourceDir 插件随附桥接目录（提供时做 client.js 内容比对；源不可读时退回版本判定）
 */
function isBridgeUsable(bridgeDir: string, fs: InstallerFs, wantVersion: string, sourceDir?: string): boolean {
  const pkgPath = join(bridgeDir, 'package.json');
  try {
    const raw = fs.readFile(pkgPath);
    if (!raw.includes('"name"')) return false;
    if (wantVersion !== '') {
      try {
        if (JSON.parse(raw).version !== wantVersion) return false;
      } catch {
        return false;
      }
    }
    if (sourceDir) {
      let wantClient: string;
      try {
        wantClient = fs.readFile(join(sourceDir, 'lib', 'client.js'));
      } catch {
        return true; // 随附源不可读：退回版本判定，避免误重装
      }
      try {
        return fs.readFile(join(bridgeDir, 'lib', 'client.js')) === wantClient;
      } catch {
        return false; // 已装 client.js 不可读 → 坏包/旧结构 → 重装
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取插件随附桥接包的版本号（bridgeSourceDir/package.json 的 version 字段）。
 * 读取或解析失败时返回空串（调用方据此退回「只看 name」的旧可用性判定，避免误重装）。
 */
function bridgeVersion(bridgeSourceDir: string, fs: InstallerFs): string {
  try {
    const pkg = JSON.parse(fs.readFile(join(bridgeSourceDir, 'package.json')));
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
}

/**
 * 复制桥接目录：目标目录的父级（node_modules，primary/secondary）或 npm 全局目录缺失则先创建，
 * 再递归复制 source → bridgeDir。
 * 生产侧 copyDir 用 fs.cpSync recursive，会同时创建目标目录与其父级。
 * 复制可能抛错（磁盘满/权限），由调用方负责回滚 patch。
 *
 * @param bridgeDir 目标目录绝对路径（父级由 dirname 推导后确保存在）
 */
function copyBridgeDir(opts: BridgeInstallOptions, bridgeDir: string): void {
  const parentDir = dirname(bridgeDir);
  if (!opts.fs.exists(parentDir)) opts.fs.mkdir(parentDir);
  opts.fs.copyDir(opts.bridgeSourceDir, bridgeDir);
}
