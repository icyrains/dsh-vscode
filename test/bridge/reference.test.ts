// test/bridge/reference.test.ts — v0.5.0「引用到 DSH」纯逻辑单测
//
// 覆盖三件事：
//   ① 相对化必须与 DSH 的 relativizeToCwd 逐字一致（否则芯片指向别的文件）；
//   ② mention/插入载荷必须与 DSH 原生拖拽的字段逐项一致（图标、剪贴板文本、模型可见形式）；
//   ③ 协议入口的形状校验足够严（坏消息一律丢弃，不半信任）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  relativizeToCwd,
  formatFileMention,
  pathBasename,
  normalizeReferenceEntries,
  buildReferenceInsertions,
  buildInsertReferenceMessage,
  buildInsertReferenceAck,
  parseInsertReferenceMessage,
  resolveTargetSessionId,
  MAX_REFERENCE_BATCH,
} from '../../bridge-client/lib/core.js';

// ——— ① 相对化：与 DSH relativizeToCwd 等价 ———

test('relativizeToCwd 与 DSH 参考实现逐例一致（仅分隔符风格归一）', () => {
  // 参考实现逐行抄自 DSH；本实现与它的**唯一**差异是输出/比较一律归一为 `/`
  // （见下一个测试说明为何这是 Windows 上的必要修正）。因此比较前把参考输出也归一。
  function dshRelativizeToCwd(text: string, cwd: string): string {
    const root = cwd.replace(/[/\\]+$/, '');
    if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`)) return text.slice(root.length + 1);
    return text;
  }
  const cases: Array<[string, string]> = [
    ['/ws/src/a.ts', '/ws'],
    ['/ws/src/a.ts', '/ws/'],
    ['/ws/src/a.ts', '/ws//'],
    ['/ws/a.ts', '/ws'],
    ['C:\\ws\\src\\a.ts', 'C:\\ws'],
    ['C:/ws/src/a.ts', 'C:/ws'],
    ['/other/a.ts', '/ws'],
    ['/wsx/a.ts', '/ws'],
  ];
  for (const [text, cwd] of cases) {
    assert.equal(
      relativizeToCwd(text, cwd),
      dshRelativizeToCwd(text, cwd).replace(/\\/g, '/'),
      `${text} @ ${cwd}`,
    );
  }
});

test('relativizeToCwd 归一化分隔符（对 DSH 的既有语义是超集，且是 Windows 上的必要修正）', () => {
  // DSH 自身只做裸比较、从不归一化；本桥接的 cwd 来自 DSH 会话、路径来自 VS Code，
  // 两端分隔符风格在 Windows 上可能不同——不归一化就会退回绝对引用，与原生拖拽不一致。
  assert.equal(relativizeToCwd('C:/ws/a.ts', 'C:\\ws'), 'a.ts');
  assert.equal(relativizeToCwd('C:\\ws\\a.ts', 'C:/ws'), 'a.ts');
  assert.equal(relativizeToCwd('C:\\ws\\sub\\a.ts', 'C:\\ws'), 'sub/a.ts');
  // 输出一律 / 分隔（DSH 的路径词汇）
  assert.equal(relativizeToCwd('C:\\ws\\sub\\a.ts', 'C:\\ws').includes('\\'), false);
});

test('relativizeToCwd 不做前缀误匹配：/wsx 不属于 /ws', () => {
  // 踩坑预防：朴素 startsWith(cwd) 会让 /wsx/a.ts 变成 x/a.ts（指向不存在的文件）
  assert.equal(relativizeToCwd('/wsx/a.ts', '/ws'), '/wsx/a.ts');
  assert.equal(relativizeToCwd('C:\\wsx\\a.ts', 'C:\\ws'), 'C:/wsx/a.ts');
});

test('relativizeToCwd 在 cwd 未知时原样返回（仅归一化分隔符）', () => {
  assert.equal(relativizeToCwd('/ws/a.ts', undefined), '/ws/a.ts');
  assert.equal(relativizeToCwd('/ws/a.ts', ''), '/ws/a.ts');
  assert.equal(relativizeToCwd('/ws/a.ts', null), '/ws/a.ts');
  assert.equal(relativizeToCwd('C:\\ws\\a.ts', undefined), 'C:/ws/a.ts');
});

test('relativizeToCwd 路径恰好等于 cwd 时保留（与 DSH 一致；右键工作区根仍是有意义引用）', () => {
  assert.equal(relativizeToCwd('/ws', '/ws'), '/ws');
  assert.equal(relativizeToCwd('C:\\ws', 'C:\\ws'), 'C:/ws');
});

// ——— mention 生成 ———
test('formatFileMention 无空格用裸 @，有空格用闭合引号', () => {
  assert.equal(formatFileMention('src/a.ts'), '@src/a.ts');
  assert.equal(formatFileMention('my dir/a.ts'), '@"my dir/a.ts"');
});

test('formatFileMention 目录（已带尾斜杠）含空格时引号闭合且斜杠在引号内', () => {
  // DSH 拖拽目录时是「先补尾斜杠、再加引号」，产物为 @"my dir/"（引号闭合）
  assert.equal(formatFileMention('my dir/'), '@"my dir/"');
});

test('formatFileMention 拒绝编辑器语法无法表示的路径', () => {
  // 引号本身与 C0/C1 控制字符无法用 @"..." 语法表示——必须拒绝而不是产出坏 token
  assert.equal(formatFileMention('a"b.ts'), undefined);
  assert.equal(formatFileMention('a\u0001b.ts'), undefined);
  assert.equal(formatFileMention('a\u007fb.ts'), undefined);
  assert.equal(formatFileMention(''), undefined);
});

// ——— pathBasename ———
test('pathBasename 支持两种分隔符并剥除目录尾斜杠', () => {
  assert.equal(pathBasename('src/a.ts'), 'a.ts');
  assert.equal(pathBasename('src\\a.ts'), 'a.ts');
  assert.equal(pathBasename('src/dir/'), 'dir');
  assert.equal(pathBasename('a.ts'), 'a.ts');
  assert.equal(pathBasename(''), '');
});

// ——— ② 插入载荷：字段与 DSH 原生拖拽一致 ———
test('buildReferenceInsertions 产出 DSH 原生引用载荷的完整字段', () => {
  const refs = buildReferenceInsertions([{ absPath: '/ws/src/a.ts', directory: false }], '/ws');
  assert.deepEqual(refs, [
    {
      source: 'reference',
      ref: '@src/a.ts',
      label: 'a.ts',
      appearance: 'file',
      clipboardText: '@src/a.ts',
    },
  ]);
});

test('buildReferenceInsertions 目录：appearance=folder、label 带尾斜杠、ref 带尾斜杠', () => {
  const refs = buildReferenceInsertions([{ absPath: '/ws/src/dir', directory: true }], '/ws');
  assert.deepEqual(refs, [
    {
      source: 'reference',
      ref: '@src/dir/',
      label: 'dir/',
      appearance: 'folder',
      clipboardText: '@src/dir/',
    },
  ]);
});

test('buildReferenceInsertions 含空格目录的 label 不带引号（引号只出现在 ref）', () => {
  const refs = buildReferenceInsertions([{ absPath: '/ws/my dir', directory: true }], '/ws');
  assert.equal(refs[0].ref, '@"my dir/"');
  assert.equal(refs[0].label, 'my dir/'); // 展示用 label 不带引号
  assert.equal(refs[0].appearance, 'folder');
});

test('buildReferenceInsertions 在 cwd 未知时回退绝对路径（不丢引用）', () => {
  const refs = buildReferenceInsertions([{ absPath: '/ws/src/a.ts', directory: false }], undefined);
  assert.equal(refs[0].ref, '@/ws/src/a.ts');
  assert.equal(refs[0].label, 'a.ts');
});

test('buildReferenceInsertions 跳过无法表示的路径，但不影响同批其它条目', () => {
  const refs = buildReferenceInsertions(
    [
      { absPath: '/ws/ok.ts', directory: false },
      { absPath: '/ws/bad"name.ts', directory: false },
      { absPath: '/ws/also-ok.ts', directory: false },
    ],
    '/ws',
  );
  assert.deepEqual(refs.map((r) => r.ref), ['@ok.ts', '@also-ok.ts']);
});

test('buildReferenceInsertions 路径恰好等于 cwd 时保留为有效引用（与 DSH 语义一致）', () => {
  // 右键工作区根目录应是「引用整个目录」，不是静默无操作
  assert.deepEqual(buildReferenceInsertions([{ absPath: '/ws', directory: true }], '/ws'), [
    {
      source: 'reference',
      ref: '@/ws/',
      label: 'ws/',
      appearance: 'folder',
      clipboardText: '@/ws/',
    },
  ]);
});

test('buildReferenceInsertions 保持用户选择顺序', () => {
  const refs = buildReferenceInsertions(
    [
      { absPath: '/ws/b.ts', directory: false },
      { absPath: '/ws/a.ts', directory: false },
      { absPath: '/ws/c.ts', directory: false },
    ],
    '/ws',
  );
  assert.deepEqual(refs.map((r) => r.ref), ['@b.ts', '@a.ts', '@c.ts']);
});

// ——— ③ 协议形状校验 ———
test('normalizeReferenceEntries 反斜杠转正斜杠、丢非法项', () => {
  const out = normalizeReferenceEntries([
    { path: 'C:\\ws\\a.ts' },
    { path: '' },
    { path: '   ' },
    null,
    'not-an-object',
    { path: 42 },
    { path: 'C:/ws/b.ts', directory: true },
  ]);
  assert.deepEqual(out, [
    { absPath: 'C:/ws/a.ts', directory: false },
    { absPath: 'C:/ws/b.ts', directory: true },
  ]);
});

test('normalizeReferenceEntries 非数组输入返回空数组', () => {
  assert.deepEqual(normalizeReferenceEntries(undefined), []);
  assert.deepEqual(normalizeReferenceEntries(null), []);
  assert.deepEqual(normalizeReferenceEntries('x'), []);
});

test('normalizeReferenceEntries 截断到批量上限（防止误选上千文件塞爆输入框）', () => {
  const many = Array.from({ length: MAX_REFERENCE_BATCH + 25 }, (_, i) => ({ path: `/ws/f${i}.ts` }));
  assert.equal(normalizeReferenceEntries(many).length, MAX_REFERENCE_BATCH);
});

test('parseInsertReferenceMessage 只接受合法形状', () => {
  assert.deepEqual(parseInsertReferenceMessage({ kind: 'insertReference', requestId: 'r1', entries: [{ path: '/ws/a.ts' }] }), {
    requestId: 'r1',
    entries: [{ absPath: '/ws/a.ts', directory: false }],
  });
  // 缺 requestId / 空 requestId / 空 entries / 其它 kind 一律拒绝
  assert.equal(parseInsertReferenceMessage({ kind: 'insertReference', entries: [{ path: '/ws/a.ts' }] }), null);
  assert.equal(parseInsertReferenceMessage({ kind: 'insertReference', requestId: '', entries: [{ path: '/ws/a.ts' }] }), null);
  assert.equal(parseInsertReferenceMessage({ kind: 'insertReference', requestId: 'r1', entries: [] }), null);
  assert.equal(parseInsertReferenceMessage({ kind: 'insertReference', requestId: 'r1', entries: [{ path: '' }] }), null);
  assert.equal(parseInsertReferenceMessage({ kind: 'other', requestId: 'r1', entries: [{ path: '/ws/a.ts' }] }), null);
  assert.equal(parseInsertReferenceMessage(null), null);
  assert.equal(parseInsertReferenceMessage('x'), null);
});

test('buildInsertReferenceMessage 用 webview 的 type 词汇（区别于 iframe 的 kind 词汇）', () => {
  const msg = buildInsertReferenceMessage('r1', [{ path: '/ws/a.ts' }]);
  assert.equal(msg.type, 'bridgeInsertReference');
  assert.equal(msg.requestId, 'r1');
  assert.deepEqual(msg.entries, [{ path: '/ws/a.ts' }]);
});

test('buildInsertReferenceAck 成功带 inserted、失败带 reason', () => {
  assert.deepEqual(buildInsertReferenceAck('r1', true, undefined, 3), {
    kind: 'insertReferenceAck',
    requestId: 'r1',
    ok: true,
    inserted: 3,
  });
  assert.deepEqual(buildInsertReferenceAck('r1', false, 'no-session'), {
    kind: 'insertReferenceAck',
    requestId: 'r1',
    ok: false,
    reason: 'no-session',
  });
  // 成功时不得混入 reason（避免扩展开出误导性提示）
  const ok = buildInsertReferenceAck('r1', true, 'ignored', 1);
  assert.equal('reason' in ok, false);
});

// ——— 目标会话定址 ———
test('resolveTargetSessionId 优先用 uiWorkspace selection', () => {
  assert.equal(resolveTargetSessionId({ sessionId: 's-abc' }, 's-dom'), 's-abc');
});

test('resolveTargetSessionId 在 selection 不可用时退回 DOM', () => {
  assert.equal(resolveTargetSessionId(undefined, 's-dom'), 's-dom');
  assert.equal(resolveTargetSessionId(null, 's-dom'), 's-dom');
  assert.equal(resolveTargetSessionId({}, 's-dom'), 's-dom');
  assert.equal(resolveTargetSessionId({ sessionId: '' }, 's-dom'), 's-dom');
  assert.equal(resolveTargetSessionId({ sessionId: 42 }, 's-dom'), 's-dom');
});

test('resolveTargetSessionId 两者都无返回空串（调用方据此报 no-session）', () => {
  assert.equal(resolveTargetSessionId(undefined, ''), '');
  assert.equal(resolveTargetSessionId({}, ''), '');
});
