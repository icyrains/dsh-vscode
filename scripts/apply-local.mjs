// scripts/apply-local.mjs — 把「本地构建的桥接」安装进 DSH 运行时（可反复重放）
//
// 用途：本仓库被本地改过之后（例如在商店版基础上加了「本轮改动 Diff 在 VS Code 中打开」
// 与「相对路径按当前 DSH 会话工作区解析」），重放这一步即可让运行时用上本地构建产物。
//
// 为什么需要：桥接以 client 插件形式装进 $DSH_HOME/profiles（DSH 在**启动时**读取
// client.js 并据其内容计算 bundle rev），因此：
//   ① 文件替换后必须重启 DSH web 才会生效；
//   ② 商店版扩展升级会覆盖回随附的旧桥接 —— 重新跑本脚本即可恢复本地改动。
//
// 复用 src/bridge/installer.ts 的 installBridge：与扩展激活时走的是**同一套**逻辑
// （含多目标目录、cordis.patch.yml 幂等写入、版本/content 不一致强制重装、
// repeat-entry 自愈去重、issue #20 的他人目录白名单保护），因此不会出现
// 「手工拷贝与安装器行为不一致」的漂移。
//
// 用法：
//   node scripts/build.mjs          # 先构建（产出 out/bridge-client）
//   node scripts/apply-local.mjs    # 再安装进 DSH 运行时
//   node scripts/apply-local.mjs --uninstall   # 卸载（还原 cordis.patch.yml）
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 与扩展侧 createNodeFs 等价的 fs 子集（同步实现，语义对齐 installer.ts 的 InstallerFs） */
const fsAdapter = {
  exists: (p) => existsSync(p),
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, content) => writeFileSync(p, content, 'utf8'),
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  copyDir: (src, dest) => copyDirSync(src, dest),
  rmDir: (p) => rmSync(p, { recursive: true, force: true }),
  readdir: (p) => readdirSync(p),
};

/** 递归复制目录（覆盖目标），与扩展侧 createNodeFs().copyDir 行为一致 */
function copyDirSync(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else copyFileSync(s, d);
  }
}

/** 解析 $DSH_HOME（默认 ~/.dsh） */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  return fromEnv && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh');
}

/** npm 全局 node_modules（Windows 扩展宿主 ESM 可达位置）；找不到就不传该目标 */
function resolveNpmGlobalNodeModules() {
  const candidate = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules');
  return existsSync(candidate) ? candidate : undefined;
}

// 构建产物目录（包根含 package.json / lib）
const bridgeSourceDir = join(root, 'out', 'bridge-client');
if (!existsSync(join(bridgeSourceDir, 'lib', 'client.js'))) {
  console.error(`[apply-local] 未找到构建产物：${bridgeSourceDir}\n先运行： node scripts/build.mjs`);
  process.exit(1);
}

// 动态 import TS 源码不可行（Node 不能直接加载 .ts），因此用 esbuild 现场把 installer
// 打成一个可 import 的 CJS 入口——复用与扩展激活时**完全相同**的那份源码，
// 避免「手工拷贝 / 复制一份实现」与安装器行为漂移。
const dshHome = resolveDshHome();
const npmGlobalNodeModules = resolveNpmGlobalNodeModules();

console.log('[apply-local] DSH_HOME        =', dshHome);
console.log('[apply-local] bridgeSourceDir =', bridgeSourceDir);
console.log('[apply-local] npmGlobal       =', npmGlobalNodeModules ?? '(未找到，跳过该目标)');

// 用 esbuild 现场把 installer 打成一个可 require 的 CJS 入口（复用同一份源码，避免行为漂移）
const { build } = await import('esbuild');
const tmpEntry = join(root, 'out', '.apply-local-installer.cjs');
await build({
  entryPoints: [join(root, 'src', 'bridge', 'installer.ts')],
  outfile: tmpEntry,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'error',
  external: ['vscode'],
});

const { installBridge, uninstallBridge } = await import('file://' + tmpEntry.replace(/\\/g, '/'));

if (process.argv.includes('--uninstall')) {
  const res = uninstallBridge({ dshHome, bridgeSourceDir, fs: fsAdapter, npmGlobalNodeModules });
  console.log('[apply-local] 卸载结果：', JSON.stringify(res));
  rmSync(tmpEntry, { force: true });
  process.exit(0);
}

const result = installBridge({ dshHome, bridgeSourceDir, fs: fsAdapter, npmGlobalNodeModules });
console.log('[apply-local] 安装结果：', JSON.stringify(result));

// 校验所有目标目录都已刷新到本地构建版本
if (result.status === 'ok') {
  const want = JSON.parse(readFileSync(join(bridgeSourceDir, 'package.json'), 'utf8')).version;
  const wantClient = readFileSync(join(bridgeSourceDir, 'lib', 'client.js'));
  const targets = [
    join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-vscode-bridge'),
    join(dshHome, 'profiles', 'node_modules', 'dsh-vscode-bridge'),
    ...(npmGlobalNodeModules ? [join(npmGlobalNodeModules, 'dsh-vscode-bridge')] : []),
  ];
  let bad = 0;
  for (const t of targets) {
    const pj = join(t, 'package.json');
    if (!existsSync(pj)) {
      console.log(`  [skip] ${t} （不存在）`);
      continue;
    }
    const v = JSON.parse(readFileSync(pj, 'utf8')).version;
    const same = readFileSync(join(t, 'lib', 'client.js')).equals(wantClient);
    const ok = v === want && same;
    if (!ok) bad += 1;
    console.log(`  [${ok ? 'ok' : 'BAD'}] ${t}  version=${v}  client.js=${same ? '一致' : '不一致'}`);
  }
  if (bad > 0) {
    console.error('[apply-local] 有目标未刷新到本地构建版本，请检查权限后重试');
    process.exitCode = 1;
  } else {
    console.log(`[apply-local] 全部目标已刷新为本地构建 ${want}`);
    console.log('[apply-local] 下一步：刷新 VS Code 面板即可。');
    console.log('  · 浏览器端桥接由 @deepseek-ai/dsh-client-hmr 以 500ms 周期 stat 轮询 bundle，');
    console.log('    检测到变化会调用 clientModules.rebuilt() 重读字节并递增 rev，页面无需重启 DSH。');
    console.log('  · 仅当 DSH 侧插件树有结构性改动（cordis.patch.yml 增删条目）时才需要重启 DSH web。');
  }
}

rmSync(tmpEntry, { force: true });
