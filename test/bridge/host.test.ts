// test/bridge/host.test.ts — 桥接消息处理与路径解析单测
// 覆盖：resolveBridgePath 的绝对/相对/危险协议分支；handleBridgeMessage 的外链白名单
// 转发、危险协议拒绝、文件跳转路径解析、打开失败与路径无法解析的用户提示。
// 生产侧接 vscode API，这里注入假实现验证纯逻辑（showWarning 一并注入以断言提示文案）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  resolveBridgePath,
  handleBridgeMessage,
  saveImageToCwd,
  deleteImageFiles,
  cleanupAllImageCaches,
  cleanupStaleImageCaches,
  createImageRegistry,
  isFileDiff,
  splitComparableLines,
  reconstructBefore,
  afterSideMatchesHunks,
  type FileDiff,
} from '../../src/bridge/host';

test('resolveBridgePath 处理绝对/相对/危险协议', () => {
  // 绝对路径直接采用（忽略 cwd 与工作区根）
  assert.deepEqual(resolveBridgePath('/a/b.ts', undefined, '/proj'), { kind: 'abs', path: '/a/b.ts' });
  // 相对路径优先按会话 cwd 解析（工作区根不同也不影响）
  assert.deepEqual(resolveBridgePath('src/main.ts', '/proj', '/other'), { kind: 'abs', path: '/proj/src/main.ts' });
  // 会话 cwd 缺失时回退工作区根
  assert.deepEqual(resolveBridgePath('src/main.ts', undefined, '/proj'), { kind: 'abs', path: '/proj/src/main.ts' });
  // 无任何基准的相对路径：无法解析
  assert.deepEqual(resolveBridgePath('..\\evil.ts', undefined, undefined), { kind: 'invalid' });
  // 协议串（URL）：一律拒绝
  assert.deepEqual(resolveBridgePath('https://x.com/a', undefined, '/proj'), { kind: 'invalid' });
});

test('handleBridgeMessage 转发 openExternal 到外部浏览器', async () => {
  // 记录被转发的 URL，验证 http/https 外链原样透传
  const calls: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenExternal', url: 'https://a.b' }, {
    openExternal: async (u) => { calls.push(u); return true; },
    openTextDocument: async () => {},
    showWarning: () => {},
  });
  assert.deepEqual(calls, ['https://a.b']);
});

test('handleBridgeMessage 拒绝危险协议的 openExternal', async () => {
  // javascript: 协议不允许走 openExternal（纵深防御，即使桥接侧已过滤）
  let called = false;
  await handleBridgeMessage({ type: 'bridgeOpenExternal', url: 'javascript:alert(1)' }, {
    openExternal: async () => { called = true; return true; },
    openTextDocument: async () => {},
    showWarning: () => {},
  });
  assert.equal(called, false);
});

test('handleBridgeMessage openExternal 抛错时提示用户', async () => {
  // 假 openExternal 抛错 → 应调用 showWarning（文案含 URL 与错误摘要），且不抛未处理异常
  const warnings: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenExternal', url: 'https://a.b/c' }, {
    openExternal: async () => { throw new Error('no default browser'); },
    openTextDocument: async () => {},
    showWarning: (m) => { warnings.push(m); },
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('https://a.b/c'), `提示应含链接，实际：${warnings[0]}`);
  assert.ok(warnings[0].includes('no default browser'), `提示应含错误摘要，实际：${warnings[0]}`);
});

test('handleBridgeMessage openFile 调用打开文档', async () => {
  // 相对路径 + cwd → 解析为绝对路径后交给 openTextDocument
  const opened: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: 'src/main.ts', cwd: '/proj' }, {
    openExternal: async () => true,
    openTextDocument: async (p) => { opened.push(p); },
    showWarning: () => {},
    workspaceRoot: '/proj',
  });
  assert.deepEqual(opened, ['/proj/src/main.ts']);
});

test('handleBridgeMessage openFile 打开失败时提示用户', async () => {
  // 假 openTextDocument 抛错 → 应调用 showWarning，文案含解析后的路径与错误摘要，且不抛未处理异常
  const warnings: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: 'missing.ts', cwd: '/proj' }, {
    openExternal: async () => true,
    openTextDocument: async () => { throw new Error('ENOENT: no such file'); },
    showWarning: (m) => { warnings.push(m); },
    workspaceRoot: '/proj',
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('/proj/missing.ts'), `提示应含路径，实际：${warnings[0]}`);
  assert.ok(warnings[0].includes('ENOENT'), `提示应含错误摘要，实际：${warnings[0]}`);
});

test('handleBridgeMessage openFile 路径无法解析时提示用户', async () => {
  // 危险协议（无基准可解析）→ invalid 分支应调用 showWarning（替代原 vscode 硬编码告警）
  const warnings: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: 'https://x.com/a' }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    showWarning: (m) => { warnings.push(m); },
    workspaceRoot: '/proj',
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('https://x.com/a'), `提示应含原始路径，实际：${warnings[0]}`);
});
// —— v0.3.0 图片缓存落盘/删除（路径安全） ——
test('saveImageToCwd：合法写入并登记，返回绝对路径', async () => {
  const written: string[] = [];
  const reg = createImageRegistry();
  const ok = await saveImageToCwd(
    { writeFile: async (p: string, _b: string) => { written.push(p); }, rmFile: async () => {} },
    { cwd: '/ws', name: 'dsh-imgcache-a-0.png', dataB64: 'AAAA' },
    reg,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.path, '/ws/dsh-imgcache-a-0.png');
  assert.equal(written.length, 1);
  assert.ok(reg.has('/ws/dsh-imgcache-a-0.png'), '落盘后登记进注册表');
});

test('saveImageToCwd：无 cwd/相对 cwd/穿越文件名/非法扩展名/空数据一律拒绝且不写入', async () => {
  const written: string[] = [];
  const deps = { writeFile: async (p: string) => { written.push(p); }, rmFile: async () => {} };
  assert.equal((await saveImageToCwd(deps, { cwd: undefined, name: 'dsh-imgcache-a-0.png', dataB64: 'x' })).ok, false);
  assert.equal((await saveImageToCwd(deps, { cwd: 'rel/ws', name: 'dsh-imgcache-a-0.png', dataB64: 'x' })).ok, false);
  assert.equal((await saveImageToCwd(deps, { cwd: '/ws', name: '../dsh-imgcache-a-0.png', dataB64: 'x' })).ok, false);
  assert.equal((await saveImageToCwd(deps, { cwd: '/ws', name: 'dsh-imgcache-a-0.exe', dataB64: 'x' })).ok, false);
  assert.equal((await saveImageToCwd(deps, { cwd: '/ws', name: 'dsh-imgcache-a-0.png', dataB64: '' })).ok, false);
  assert.equal(written.length, 0, '任何拒绝都不落盘');
});

test('cleanupAllImageCaches：全量删除注册表内所有缓存路径并清空', async () => {
  const reg = createImageRegistry();
  reg.add('/ws/dsh-imgcache-a-0.png');
  reg.add('/ws/dsh-imgcache-a-1.jpg');
  const deleted: string[] = [];
  const deps = { writeFile: async () => {}, rmFile: async (p: string) => { deleted.push(p); } };
  await cleanupAllImageCaches(deps, reg);
  assert.deepEqual(deleted.sort(), ['/ws/dsh-imgcache-a-0.png', '/ws/dsh-imgcache-a-1.jpg']);
  assert.equal(reg.all().length, 0, '清理后注册表应清空');
});

test('cleanupStaleImageCaches：按目录扫描只删 dsh-imgcache-* 白名单孤儿，不依赖注册表', async () => {
  const removed: string[] = [];
  // 目录里既有我们的临时图，也有用户自己的文件；只删 dsh-imgcache-* 白名单
  const n = await cleanupStaleImageCaches(
    async () => ['dsh-imgcache-1710000000-0.png', 'dsh-imgcache-1710000000-1.jpg', 'README.md', 'photo.png', 'dsh-imgcache-1710000000-2.exe'],
    async (p: string) => { removed.push(p); },
    ['/ws/root', 'not-absolute', ''],
  );
  assert.equal(n, 2);
  assert.deepEqual(removed.sort(), ['/ws/root/dsh-imgcache-1710000000-0.png', '/ws/root/dsh-imgcache-1710000000-1.jpg']);
  // 目录不可读（readDir 抛错）→ 跳过，不影响删除计数
  const n2 = await cleanupStaleImageCaches(async () => { throw new Error('ENOENT'); }, async () => {}, ['/missing']);
  assert.equal(n2, 0);
});

test('deleteImageFiles：只删除注册表中的缓存文件，任意路径被忽略', async () => {
  const reg = createImageRegistry();
  reg.add('/ws/dsh-imgcache-a-0.png');
  const deleted: string[] = [];
  const deps = { writeFile: async () => {}, rmFile: async (p: string) => { deleted.push(p); } };
  await deleteImageFiles(deps, { paths: ['/ws/dsh-imgcache-a-0.png', '/ws/user.txt', '/etc/passwd'] }, reg);
  assert.deepEqual(deleted, ['/ws/dsh-imgcache-a-0.png'], '只删注册过的缓存文件');
  assert.ok(!reg.has('/ws/dsh-imgcache-a-0.png'), '删除后移出注册表');
});

test('handleBridgeMessage bridgeSaveImage：无 sessionCwd 时回退到 workspaceRoot', async () => {
  const acks: unknown[] = [];
  await handleBridgeMessage({ type: 'bridgeSaveImage', requestId: 's9', name: 'dsh-imgcache-a-0.png', dataB64: 'AAAA' }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    showWarning: () => {},
    workspaceRoot: '/root',
    writeFile: async () => {},
    rmFile: async () => {},
    reply: async (m: unknown) => { acks.push(m); },
  });
  assert.equal(acks.length, 1);
  assert.equal((acks[0] as { type: string; ok: boolean; path: string }).path, '/root/dsh-imgcache-a-0.png');
});

test('handleBridgeMessage 处理 bridgeSaveImage：回执 saveImageAck（ok+path）', async () => {
  const acks: unknown[] = [];
  await handleBridgeMessage({ type: 'bridgeSaveImage', requestId: 's1', name: 'dsh-imgcache-a-0.png', dataB64: 'AAAA', sessionCwd: '/ws' }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    showWarning: () => {},
    writeFile: async () => {},
    rmFile: async () => {},
    reply: async (m: unknown) => { acks.push(m); },
  });
  assert.equal(acks.length, 1);
  const a = acks[0] as { type: string; ok: boolean; path: string };
  assert.equal(a.type, 'bridgeSaveImageAck');
  assert.equal(a.ok, true);
  assert.equal(a.path, '/ws/dsh-imgcache-a-0.png');
});

test('handleBridgeMessage 处理 bridgeDeleteImages：回执 deleteImagesAck', async () => {
  const acks: unknown[] = [];
  await handleBridgeMessage({ type: 'bridgeDeleteImages', requestId: 'd1', paths: [] }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    showWarning: () => {},
    writeFile: async () => {},
    rmFile: async () => {},
    reply: async (m: unknown) => { acks.push(m); },
  });
  assert.equal(acks.length, 1);
  assert.equal((acks[0] as { type: string }).type, 'bridgeDeleteImagesAck');
  assert.equal((acks[0] as { ok: boolean }).ok, true);
});

// —— v0.4.3：「本轮文件改动」Diff 在 VS Code 中打开 ——

/**
 * 平台感知的工作区根：Windows 上必须是「带盘符的绝对路径」，否则 node:path
 * 的 resolve/join 会补上当前盘符，断言会因环境而非逻辑失败（本仓库既有
 * 39 个用例即因硬编码 POSIX 路径在 Windows 上失败）。
 */
const WS = process.platform === 'win32' ? 'C:\\ws' : '/ws';

/** 直接构造一个 text 对比（hunks 手写，便于精确断言算法边界） */
function textDiff(hunks: FileDiff['hunks'], over: Partial<FileDiff> = {}): FileDiff {
  return { kind: 'text', path: 'a.ts', before: true, after: true, hunks, ...over };
}

test('isFileDiff 校验 text 对比（binary/oversized 无 hunks，必须拒绝）', () => {
  assert.equal(isFileDiff(textDiff([])), true);
  assert.equal(isFileDiff(textDiff([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [' a'] }])), true);
  // 非 text 分支：没有 hunks，无法还原旧侧
  assert.equal(isFileDiff({ kind: 'binary', path: 'a.png' }), false);
  assert.equal(isFileDiff({ kind: 'oversized', path: 'a.ts' }), false);
  // 缺字段 / 类型不对
  assert.equal(isFileDiff({ kind: 'text', path: 'a.ts', hunks: [] }), false); // 缺 before/after
  assert.equal(isFileDiff({ kind: 'text', path: '', before: true, after: true, hunks: [] }), false);
  assert.equal(isFileDiff({ kind: 'text', path: 'a.ts', before: true, after: true, hunks: {} }), false);
  assert.equal(isFileDiff({ kind: 'text', path: 'a.ts', before: true, after: true, hunks: [{ oldStart: 1 }] }), false);
  // hunk 行必须是带前缀的非空字符串（空行在 wire 上是单个前缀字符）
  assert.equal(isFileDiff({ kind: 'text', path: 'a.ts', before: true, after: true, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines: [''] }] }), false);
  assert.equal(isFileDiff(null), false);
  assert.equal(isFileDiff('x'), false);
  assert.equal(isFileDiff([]), false);
});

test('isFileDiff 拒绝含 `\\ No newline at end of file` 元信息行的 hunks（防静默错误还原）', () => {
  // unified diff 可能出现以 '\' 开头的元信息行。它不是内容行；若被放进 lines，
  // reconstructBefore 会把它当上下文行 → 安静地给出**错误**的旧侧内容。
  // DSH 的 compareText 会先对两侧 terminated()，实际不会产生该行；
  // 这里断言我们宁可拒绝（退回「直接打开文件」），也不展示一份错误的 Diff。
  const hunksOf = (lines: string[]) => ({
    kind: 'text',
    path: 'a.ts',
    before: true,
    after: true,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }],
  });
  assert.equal(
    isFileDiff(hunksOf(['-x', '\\ No newline at end of file', '+y'])),
    false,
    '含元信息行必须被拒绝',
  );
  // 对照：去掉元信息行后是合法的
  assert.equal(isFileDiff(hunksOf(['-x', '+y'])), true);

  // 三种合法前缀都接受（单字符前缀行 = 内容为空的行）
  for (const ok of [[' a'], ['-a'], ['+a'], [' '], ['-'], ['+']]) {
    assert.equal(isFileDiff(hunksOf(ok)), true, `前缀 ${JSON.stringify(ok)} 应被接受`);
  }
  // 其它前缀 / 缺前缀一律拒绝
  for (const bad of [['a'], ['?a'], ['#a'], ['\\']]) {
    assert.equal(isFileDiff(hunksOf(bad)), false, `前缀 ${JSON.stringify(bad)} 应被拒绝`);
  }
});

test('splitComparableLines 与 DSH 比对面语义一致（空文本零行、末尾换行不算额外行）', () => {
  assert.deepEqual(splitComparableLines(''), []);
  assert.deepEqual(splitComparableLines(undefined), []);
  assert.deepEqual(splitComparableLines(null), []);
  assert.deepEqual(splitComparableLines('a'), ['a']);
  assert.deepEqual(splitComparableLines('a\n'), ['a']);
  assert.deepEqual(splitComparableLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitComparableLines('a\nb'), ['a', 'b']);
  // 连续换行 = 空行，确实是一个内容行
  assert.deepEqual(splitComparableLines('a\n\nb\n'), ['a', '', 'b']);
});

test('reconstructBefore 精确还原旧侧（常规改写 / 多 hunk / 上下文搬运）', () => {
  // 改写第 2 行：hunk 覆盖 b(上下文) c→X d(上下文)
  const d = textDiff([
    { oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [' a', '-c', '+X', ' d', ' e'] },
  ]);
  const after = 'a\nX\nd\ne\n';
  assert.equal(reconstructBefore(after, d), 'a\nc\nd\ne\n');

  // 两个 hunk：hunk 之间的未变更区段必须原样搬运（游标不能丢）
  const two = textDiff([
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B'] },
    { oldStart: 6, oldLines: 3, newStart: 6, newLines: 3, lines: ['-f', '+F', ' g'] },
  ]);
  const afterTwo = 'a\nB\nc\nd\ne\nF\ng\n';
  assert.equal(reconstructBefore(afterTwo, two), 'a\nb\nc\nd\ne\nf\ng\n');
});

test('reconstructBefore 处理新增 / 删除 / 清空文件', () => {
  // 新增文件（before=false）→ 旧侧为空
  const added = textDiff([{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+x', '+y'] }], { before: false });
  assert.equal(reconstructBefore('x\ny\n', added), '');

  // 删除文件：单个全 '-' 的 hunk，游标不动，旧侧即全文
  const removed = textDiff([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ['-x', '-y'] }], { after: false });
  assert.equal(reconstructBefore('', removed), 'x\ny\n');

  // 清空已有文件
  const emptied = textDiff([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ['-a', '-b'] }]);
  assert.equal(reconstructBefore('', emptied), 'a\nb\n');

  // 无 hunks（两侧相同）→ 旧侧等于新侧
  assert.equal(reconstructBefore('same\n', textDiff([])), 'same\n');
  assert.equal(reconstructBefore('', textDiff([])), '');
});

test('reconstructBefore 对 coarse（整文件替换）与 CRLF 同样精确', () => {
  // coarse：DSH 超时降级为「全删 + 全增」的单个 hunk
  const coarse = textDiff([
    { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-old1', '-old2', '+new1', '+new2'] },
  ]);
  assert.equal(reconstructBefore('new1\nnew2\n', coarse), 'old1\nold2\n');

  // CRLF 逐字节保留（行内容含 \r，不能被规整掉）
  const crlf = textDiff([
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a\r', '-b\r', '+B\r', ' c\r'] },
  ]);
  assert.equal(reconstructBefore('a\r\nB\r\nc\r\n', crlf), 'a\r\nb\r\nc\r\n');
});

test('handleBridgeMessage openDiff：还原旧侧并存入内存文档，开原生 diff（不落任何文件）', async () => {
  const opened: { before: string; after: string; title: string }[] = [];
  const put: { text: string; baseName: string }[] = [];
  const warnings: string[] = [];
  const cwd = WS;

  await handleBridgeMessage({
    type: 'bridgeOpenDiff',
    path: 'src/a.ts',
    display: 'src/a.ts',
    cwd,
    diff: textDiff([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-old', '+new', ' tail'] }]),
  }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    showWarning: (m) => { warnings.push(m); },
    readFileText: async () => 'new\ntail\n', // 磁盘当前内容 = turn-end 侧
    // 生产实现会返回 vscode.Uri 的字符串形式；这里用可辨识的假 URI
    putBeforeDoc: (text, baseName) => {
      put.push({ text, baseName });
      return `dsh-diff-before:/b${put.length}/${baseName}`;
    },
    openDiff: async (before, after, title) => { opened.push({ before, after, title }); },
  });

  assert.deepEqual(warnings, [], '不应产生任何用户可见警告');
  // 旧侧内容由 hunks 精确还原，且带上目标文件名（用于保留语法高亮）
  assert.deepEqual(put, [{ text: 'old\ntail\n', baseName: 'a.ts' }]);
  // 打开的是「内存旧侧 ↔ 真实文件」，标题用 display
  assert.equal(opened.length, 1);
  assert.equal(opened[0]?.before, 'dsh-diff-before:/b1/a.ts');
  assert.equal(opened[0]?.after, join(cwd, 'src', 'a.ts'));
  assert.equal(opened[0]?.title, 'src/a.ts');
});

test('handleBridgeMessage openDiff：磁盘文件已删除时旧侧仍能还原（after=false 场景）', async () => {
  const written: string[] = [];
  let opened = 0;
  await handleBridgeMessage({
    type: 'bridgeOpenDiff',
    path: 'gone.ts',
    cwd: WS,
    diff: textDiff([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 0, lines: ['-only'] }], { after: false }),
  }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    showWarning: () => {},
    // 读磁盘失败（文件已删除）必须被吞掉并视为空，而不是让整个 Diff 失败
    readFileText: async () => { throw new Error('ENOENT'); },
    putBeforeDoc: (t: string) => { written.push(t); return 'dsh-diff-before:/b1/gone.ts'; },
    openDiff: async () => { opened += 1; },
  });
  assert.deepEqual(written, ['only\n']);
  assert.equal(opened, 1);
});

test('handleBridgeMessage openDiff：binary/oversized 退回直接打开文件（而非报错或静默）', async () => {
  const openedFiles: string[] = [];
  const warnings: string[] = [];
  await handleBridgeMessage({
    type: 'bridgeOpenDiff',
    path: 'img.png',
    cwd: WS,
    diff: { kind: 'binary', path: 'img.png' }, // 无 hunks
  }, {
    openExternal: async () => true,
    openTextDocument: async (p) => { openedFiles.push(p); },
    showWarning: (m) => { warnings.push(m); },
    openDiff: async () => { throw new Error('不应走到 diff'); },
  });
  assert.deepEqual(openedFiles, [join(WS, 'img.png')]);
  assert.deepEqual(warnings, []);
});

test('handleBridgeMessage openDiff：依赖缺失/路径无法解析时给出可见提示，不静默', async () => {
  const warnings: string[] = [];
  const deps = {
    openExternal: async () => true,
    openTextDocument: async () => {},
    showWarning: (m: string) => { warnings.push(m); },
  };
  // 缺 readFileText/putBeforeDoc/openDiff（理论不可达，但要可见）
  await handleBridgeMessage({
    type: 'bridgeOpenDiff',
    path: 'a.ts',
    cwd: WS,
    diff: textDiff([]),
  }, deps);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /桥接依赖未就绪/);

  // 危险协议路径：拒绝并提示
  const w2: string[] = [];
  await handleBridgeMessage({
    type: 'bridgeOpenDiff',
    path: 'https://evil.com/x',
    diff: textDiff([]),
  }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    showWarning: (m) => { w2.push(m); },
    readFileText: async () => '',
    putBeforeDoc: () => 'dsh-diff-before:/b1/a.ts',
    openDiff: async () => {},
  });
  assert.equal(w2.length, 1);
  assert.match(w2[0]!, /无法解析路径/);
});

// —— v0.4.3 review 加固：磁盘不再是 turn-end 时绝不展示错误的 Diff ——

test('afterSideMatchesHunks：磁盘与 hunks 自洽才通过（含 CRLF 不敏感）', () => {
  const d = textDiff([
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] },
  ]);
  // 完全对应
  assert.equal(afterSideMatchesHunks(['a', 'B', 'c'], d), true);
  // 磁盘是 CRLF：不应因为行尾风格被判为「已改动」
  assert.equal(afterSideMatchesHunks(['a\r', 'B\r', 'c\r'], d), true);
  // 内容被改 → 拒绝
  assert.equal(afterSideMatchesHunks(['a', 'X', 'c'], d), false);
  // 位置被改（顶部插入一行）→ 拒绝
  assert.equal(afterSideMatchesHunks(['INSERTED', 'a', 'B', 'c'], d), false);
  // 磁盘比 hunk 期望的短 → 拒绝
  assert.equal(afterSideMatchesHunks(['a', 'B'], d), false);

  // 多 hunk：各自按 newStart 锚定
  const multi = textDiff([
    { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+X'] },
    { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, lines: [' y', '-z', '+Z'] },
  ]);
  assert.equal(afterSideMatchesHunks(['X', 'b', 'c', 'd', 'y', 'Z'], multi), true);
  assert.equal(afterSideMatchesHunks(['X', 'b', 'c', 'd', 'WRONG', 'Z'], multi), false);
});

test('handleBridgeMessage openDiff：磁盘已被再次修改 → 拒绝并提示，绝不展示错误 Diff', async () => {
  const warnings: string[] = [];
  const opened: string[] = [];
  const openedFiles: string[] = [];
  await handleBridgeMessage({
    type: 'bridgeOpenDiff',
    path: 'src/a.ts',
    cwd: WS,
    // 该轮把 b 改成 B；磁盘现在却多了一行（该轮之后又被改过）
    diff: textDiff([{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] }]),
  }, {
    openExternal: async () => true,
    openTextDocument: async (p) => { openedFiles.push(p); },
    showWarning: (m) => { warnings.push(m); },
    // 磁盘内容与 hunks 不符（顶部多了一行）
    readFileText: async () => 'INSERTED\na\nB\nc\n',
    putBeforeDoc: () => { throw new Error('不应走到还原'); },
    openDiff: async () => { opened.push('diff'); },
  });
  assert.deepEqual(opened, [], '不得打开 diff');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /已被再次修改/);
  // 仍帮用户打开真实文件（不给假 Diff，但也不让点击无响应）
  assert.deepEqual(openedFiles, [join(WS, 'src', 'a.ts')]);
});

test('handleBridgeMessage openDiff：文件读不到（非 after=false）→ 提示而非静默截断左栏', async () => {
  const warnings: string[] = [];
  const openedFiles: string[] = [];
  await handleBridgeMessage({
    type: 'bridgeOpenDiff',
    path: 'src/gone.ts',
    cwd: WS,
    diff: textDiff([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' a', '-b', '+B'] }]),
  }, {
    openExternal: async () => true,
    openTextDocument: async (p) => { openedFiles.push(p); },
    showWarning: (m) => { warnings.push(m); },
    readFileText: async () => { throw new Error('ENOENT'); },
    putBeforeDoc: () => { throw new Error('不应走到还原'); },
    openDiff: async () => { throw new Error('不得打开 diff'); },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /已无法读取/);
  assert.deepEqual(openedFiles, [join(WS, 'src', 'gone.ts')]);
});

test('handleBridgeMessage openDiff：after=false（该轮删除了文件）不读盘也成立', async () => {
  const opened: string[] = [];
  const put: string[] = [];
  const warnings: string[] = [];
  await handleBridgeMessage({
    type: 'bridgeOpenDiff',
    path: 'gone.ts',
    cwd: WS,
    // 该轮把文件删除：旧侧有内容，新侧不存在
    diff: textDiff([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ['-only', '-lines'] }], { after: false }),
  }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    showWarning: (m) => { warnings.push(m); },
    // after=false 时**不应**依赖磁盘内容（后来可能又被重建）
    readFileText: async () => { throw new Error('不应读盘'); },
    putBeforeDoc: (text) => { put.push(text); return 'dsh-diff-before:/b1/gone.ts'; },
    openDiff: async () => { opened.push('diff'); },
  });
  assert.deepEqual(warnings, []);
  assert.deepEqual(put, ['only\nlines\n']);
  assert.equal(opened.length, 1);
});

test('reconstructBefore：左栏行尾/末尾换行对齐磁盘形态（避免纯风格造成的假差异）', () => {
  const d = textDiff([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-old', '+new', ' tail'] }]);
  // 磁盘 LF + 有末尾换行
  assert.equal(reconstructBefore('new\ntail\n', d), 'old\ntail\n');
  // 磁盘 CRLF：左栏也应是 CRLF，且不出现重复的 '\r'
  assert.equal(reconstructBefore('new\r\ntail\r\n', d), 'old\r\ntail\r\n');
  // 磁盘无末尾换行：左栏也不补末尾换行（否则会出现「凭空多一行」的假改动）
  assert.equal(reconstructBefore('new\ntail', d), 'old\ntail');
  assert.equal(reconstructBefore('new\r\ntail', d), 'old\r\ntail');
});

