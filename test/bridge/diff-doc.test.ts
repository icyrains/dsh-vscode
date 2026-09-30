// test/bridge/diff-doc.test.ts — Diff 旧侧「内存文档」仓库单测
//
// 为什么值得单测：这套机制的存在理由就是**不落临时文件**（用户工作区多为
// Perforce/SVN 工作副本，落文件会污染变更列表）。因此这里重点验证：
//   ① 存入/取回内容一致，且带扩展名（保留语法高亮）；
//   ② 双上限淘汰（条数与总字节）不会无界增长，且不会误删唯一条目；
//   ③ 未知 URI / 形态异常一律返回空串而不抛（绝不让点击链路炸掉）。
//
// vscode 模块在测试环境由 test/vscode-stub.ts 顶替（见 scripts/build.mjs 的 alias）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiffDocStore, DIFF_BEFORE_SCHEME, basenameOf, beforeDocLabel } from '../../src/bridge/diff-doc';

test('DiffDocStore：存入后可按 URI 取回同一内容（旧侧全文不落盘）', () => {
  const store = new DiffDocStore();
  try {
    const uri = store.put('hello\nworld\n', 'a.ts');
    assert.equal(uri.scheme, DIFF_BEFORE_SCHEME);
    // 取回内容必须逐字节相同（diff 的左侧就是靠它渲染的）
    assert.equal(store.provideTextDocumentContent(uri), 'hello\nworld\n');
    assert.equal(store.size, 1);
  } finally {
    store.dispose();
  }
});

test('DiffDocStore：URI 保留文件名（供 VS Code 推断语言模式 → 语法高亮）', () => {
  const store = new DiffDocStore();
  try {
    const uri = store.put('x\n', 'a.ts');
    assert.ok(String(uri.path).endsWith('a.ts'), `path 应保留文件名，实际 ${uri.path}`);
    // 无文件名时给一个兜底名，避免出现空 path 段
    const uri2 = store.put('y\n', '');
    assert.ok(String(uri2.path).endsWith('before'), `空文件名应兜底，实际 ${uri2.path}`);
    // 两次存入必须是**不同** URI（否则后一次会覆盖前一次的内容）
    assert.notEqual(uri.toString(), uri2.toString());
  } finally {
    store.dispose();
  }
});

test('DiffDocStore：多份内容互不干扰（同一文件的多轮改动可同时打开）', () => {
  const store = new DiffDocStore();
  try {
    const a = store.put('v1\n', 'a.ts');
    const b = store.put('v2\n', 'a.ts');
    assert.equal(store.provideTextDocumentContent(a), 'v1\n');
    assert.equal(store.provideTextDocumentContent(b), 'v2\n');
  } finally {
    store.dispose();
  }
});

test('DiffDocStore：条数超上限后淘汰最旧条目（内存不无界增长）', () => {
  const store = new DiffDocStore();
  try {
    const uris = [];
    // 上限 200：灌 250 条，最旧的应被淘汰
    for (let i = 0; i < 250; i += 1) uris.push(store.put(`content-${i}\n`, 'a.ts'));
    assert.ok(store.size <= 200, `条目数应被限制在 200 以内，实际 ${store.size}`);
    // 最早的已被淘汰 → 空串（而不是抛错）
    assert.equal(store.provideTextDocumentContent(uris[0]!), '');
    // 最新的仍在
    assert.equal(store.provideTextDocumentContent(uris[249]!), 'content-249\n');
  } finally {
    store.dispose();
  }
});

test('DiffDocStore：未知/异常 URI 一律返回空串而不抛（点击链路必须稳）', () => {
  const store = new DiffDocStore();
  try {
    assert.equal(store.provideTextDocumentContent({ scheme: DIFF_BEFORE_SCHEME, path: '/nope/x.ts' } as never), '');
    assert.equal(store.provideTextDocumentContent({ scheme: DIFF_BEFORE_SCHEME, path: '/' } as never), '');
    assert.equal(store.provideTextDocumentContent({ scheme: DIFF_BEFORE_SCHEME, path: '' } as never), '');
    // dispose 之后取回也是空串（不抛）
    store.dispose();
    assert.equal(store.provideTextDocumentContent({ scheme: DIFF_BEFORE_SCHEME, path: '/b1/a.ts' } as never), '');
  } finally {
    store.dispose();
  }
});

test('basenameOf：跨平台取文件名（不依赖 node:path 的平台规则）', () => {
  assert.equal(basenameOf('G:\\proj\\src\\a.ts'), 'a.ts');
  assert.equal(basenameOf('/ws/src/a.ts'), 'a.ts');
  assert.equal(basenameOf('a.ts'), 'a.ts');
  assert.equal(basenameOf('/ws/src/'), '');
  assert.equal(basenameOf(''), '');
});

test('beforeDocLabel：给出「改动前」语义的展示名（用户能看出左侧是快照）', () => {
  assert.equal(beforeDocLabel('a.ts'), 'a.ts（本轮改动前）');
  assert.equal(beforeDocLabel(''), '改动前');
});
