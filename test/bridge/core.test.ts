// test/bridge/core.test.ts — 桥接纯逻辑单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedExternalUrl,
  buildOpenExternalMessage,
  buildOpenFileMessage,
  buildSyncWorkspaceAck,
  buildCopyTextMessage,
  buildCopyTextAck,
  isBridgeMessage,
  HANDSHAKE_TOKEN_KEY,
  getShortcutCommand,
  isEditableElement,
  computeInsertedValue,
  buildReadTextMessage,
  buildReadTextAck,
  FILE_ENTRY_SELECTOR,
  resolveFileEntryPath,
  parseChangesQuery,
  isWorkspaceFileDiff,
  buildOpenDiffMessage,
  findSessionId,
  changedFileIndexOf,
  changesDiffUrl,
  sessionCwdFrom,
  changesKey,
  changedFileAt,
  CHANGES_DIFF_ROUTE,
  CHANGES_SUMMARY_ROUTE,
  isChangesToggle,
  pathTailMatches,
  matchChangesSeq,
  BoundedMap,
  jsonByteSize,
  findTurn,
  matchChangesTurn,
  TURN_TAIL_SELECTOR,
} from '../../bridge-client/lib/core.js';

/** 构造最小按钮替身（只实现 resolveFileEntryPath 需要的接口） */
function fakeBtn(attrs: { title?: string; 'aria-label'?: string; text?: string; haspopup?: boolean }) {
  return {
    getAttribute: (name: string) => {
      if (name === 'title') return attrs.title ?? null;
      if (name === 'aria-label') return attrs['aria-label'] ?? null;
      return null;
    },
    textContent: attrs.text ?? '',
    matches: (sel: string) => (sel === '[aria-haspopup]' ? attrs.haspopup === true : false),
  };
}

// ——— issue #22：文件入口解析（原先 classList.contains('fileMention') 恒不命中） ———
test('FILE_ENTRY_SELECTOR 覆盖三类文件入口', () => {
  // markdown 文件名（CSS Module 哈希类名，必须用 class*= 而非精确类名）
  assert.ok(FILE_ENTRY_SELECTOR.includes('button[class*="fileMention"]'));
  // produced 芯片 / present 卡片预览面：稳定 data 属性 + title
  assert.ok(FILE_ENTRY_SELECTOR.includes('[data-produced-files-row] button[title]'));
  assert.ok(FILE_ENTRY_SELECTOR.includes('[data-presented-file] button[title]'));
});

test('resolveFileEntryPath：title 优先（title 才是路径，aria-label 是动作文案）', () => {
  // produced 芯片：title 是相对路径，aria-label 是「打开 <路径>」的本地化文案
  assert.equal(
    resolveFileEntryPath(fakeBtn({ title: 'docs/progress.md', 'aria-label': '打开 docs/progress.md' })),
    'docs/progress.md',
  );
  // present 卡片：title 已是工作区绝对路径
  assert.equal(
    resolveFileEntryPath(fakeBtn({ title: '/home/u/proj/src/a.ts', 'aria-label': '在侧边栏预览 src/a.ts' })),
    '/home/u/proj/src/a.ts',
  );
  // Windows 盘符绝对路径原样透传（协议判定由扩展侧 resolveBridgePath 负责）
  assert.equal(resolveFileEntryPath(fakeBtn({ title: 'C:\\work\\a.ts' })), 'C:\\work\\a.ts');
});

test('resolveFileEntryPath：title 为空时从 aria-label 抽取引号包裹的路径', () => {
  assert.equal(resolveFileEntryPath(fakeBtn({ 'aria-label': '打开 `docs/progress.md`' })), 'docs/progress.md');
  assert.equal(resolveFileEntryPath(fakeBtn({ 'aria-label': '在侧边栏预览 "src/a.ts"' })), 'src/a.ts');
  assert.equal(resolveFileEntryPath(fakeBtn({ 'aria-label': 'Open \u201cREADME.md\u201d' })), 'README.md');
});

test('resolveFileEntryPath：aria-label 无引号路径时判为不可用（不把整串文案当路径）', () => {
  // 旧实现会把「打开 docs/progress.md」整串下发，扩展侧解析不到文件
  assert.equal(resolveFileEntryPath(fakeBtn({ 'aria-label': '打开 docs/progress.md' })), null);
  assert.equal(resolveFileEntryPath(fakeBtn({ 'aria-label': 'queued a.ts, b.ts' })), null);
  assert.equal(resolveFileEntryPath(fakeBtn({ 'aria-label': '在侧边栏打开' })), null);
});

test('resolveFileEntryPath：排除 aria-haspopup 的宿主菜单触发按钮', () => {
  assert.equal(resolveFileEntryPath(fakeBtn({ title: 'docs/a.md', haspopup: true })), null);
});

test('resolveFileEntryPath：无 title/aria-label 时退回纯文本文件名', () => {
  assert.equal(resolveFileEntryPath(fakeBtn({ text: 'src/main.ts' })), 'src/main.ts');
  assert.equal(resolveFileEntryPath(fakeBtn({ text: '   ' })), null);
  assert.equal(resolveFileEntryPath(fakeBtn({})), null);
});

test('resolveFileEntryPath：非法输入不抛错', () => {
  assert.equal(resolveFileEntryPath(null as unknown as never), null);
  assert.equal(resolveFileEntryPath(undefined as unknown as never), null);
  assert.equal(resolveFileEntryPath({} as unknown as never), null);
});

test('isAllowedExternalUrl 仅放行 http/https', () => {
  assert.equal(isAllowedExternalUrl('https://example.com/a'), true);
  assert.equal(isAllowedExternalUrl('http://127.0.0.1:3080/x'), true);
  assert.equal(isAllowedExternalUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedExternalUrl('file:///etc/passwd'), false);
  assert.equal(isAllowedExternalUrl(''), false);
});

test('buildOpenExternalMessage 构造消息', () => {
  assert.deepEqual(buildOpenExternalMessage('https://a.b/c'), { kind: 'openExternal', url: 'https://a.b/c' });
});

test('buildOpenFileMessage 携带可选 cwd', () => {
  assert.deepEqual(buildOpenFileMessage('src/main.ts', '/proj'), { kind: 'openFile', path: 'src/main.ts', cwd: '/proj' });
  assert.deepEqual(buildOpenFileMessage('/abs/a.ts', undefined), { kind: 'openFile', path: '/abs/a.ts' });
});

test('buildSyncWorkspaceAck 构造回执', () => {
  assert.deepEqual(buildSyncWorkspaceAck(true), { kind: 'bridgeAck', ok: true });
  assert.deepEqual(buildSyncWorkspaceAck(false, '/proj'), { kind: 'bridgeAck', ok: false, path: '/proj' });
});

test('buildCopyTextMessage / buildCopyTextAck 构造剪贴板桥接消息', () => {
  assert.deepEqual(buildCopyTextMessage('hello', 'req-1'), { kind: 'copyText', text: 'hello', requestId: 'req-1' });
  assert.deepEqual(buildCopyTextAck('req-1', true), { kind: 'copyTextAck', requestId: 'req-1', ok: true });
  assert.deepEqual(buildCopyTextAck('req-2', false), { kind: 'copyTextAck', requestId: 'req-2', ok: false });
});

test('isBridgeMessage 校验 token', () => {
  assert.equal(isBridgeMessage({ token: 't1' }, 't1'), true);
  assert.equal(isBridgeMessage({ token: 't2' }, 't1'), false);
  assert.equal(isBridgeMessage(null, 't1'), false);
});

test('常量取值正确', () => {
  assert.equal(HANDSHAKE_TOKEN_KEY, 'token');
});

// —— 标准编辑快捷键仿真（VS Code 吞掉 iframe 内 Cmd+C/V/A/X/Z 的修复） ——

test('getShortcutCommand 识别 mac/win 标准编辑快捷键', () => {
  // mac: metaKey
  assert.equal(getShortcutCommand({ key: 'c', metaKey: true }), 'copy');
  assert.equal(getShortcutCommand({ key: 'v', metaKey: true }), 'paste');
  assert.equal(getShortcutCommand({ key: 'x', metaKey: true }), 'cut');
  assert.equal(getShortcutCommand({ key: 'a', metaKey: true }), 'selectAll');
  assert.equal(getShortcutCommand({ key: 'z', metaKey: true }), 'undo');
  assert.equal(getShortcutCommand({ key: 'z', metaKey: true, shiftKey: true }), 'redo');
  // win/linux: ctrlKey
  assert.equal(getShortcutCommand({ key: 'C', ctrlKey: true }), 'copy');
  assert.equal(getShortcutCommand({ key: 'V', ctrlKey: true }), 'paste');
  // Shift+Insert（Windows 粘贴惯例）
  assert.equal(getShortcutCommand({ key: 'Insert', shiftKey: true }), 'paste');
  // 大小写不敏感
  assert.equal(getShortcutCommand({ key: 'C', metaKey: true }), 'copy');
  // 未命中：无修饰键、非编辑键、非法输入
  assert.equal(getShortcutCommand({ key: 'c' }), null);
  assert.equal(getShortcutCommand({ key: 'Enter', metaKey: true }), null);
  assert.equal(getShortcutCommand({ key: 'k', ctrlKey: true }), null);
  assert.equal(getShortcutCommand(null), null);
  assert.equal(getShortcutCommand(undefined), null);
  assert.equal(getShortcutCommand({}), null);
});

test('isEditableElement 只认可接收文本编辑的元素', () => {
  // textarea / text input / contenteditable 为可编辑
  assert.equal(isEditableElement({ tagName: 'TEXTAREA' }), true);
  assert.equal(isEditableElement({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isEditableElement({ tagName: 'INPUT', type: '' }), true); // type 缺省即 text
  assert.equal(isEditableElement({ tagName: 'DIV', isContentEditable: true }), true);
  // 非文本输入型 input 不可编辑
  assert.equal(isEditableElement({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isEditableElement({ tagName: 'INPUT', type: 'button' }), false);
  // 普通元素 / 空值 / 非对象
  assert.equal(isEditableElement({ tagName: 'DIV' }), false);
  assert.equal(isEditableElement(null), false);
  assert.equal(isEditableElement(undefined), false);
  assert.equal(isEditableElement('textarea'), false);
});

test('computeInsertedValue 在选区插入文本', () => {
  // 正常插入（前不着后不着）
  assert.equal(computeInsertedValue('hello world', 6, 11, 'VS Code'), 'hello VS Code');
  // 全选替换
  assert.equal(computeInsertedValue('hello', 0, 5, 'hi'), 'hi');
  // 空选区 = 光标处插入
  assert.equal(computeInsertedValue('ab', 1, 1, 'X'), 'aXb');
  // 选区顺序/越界归一
  assert.equal(computeInsertedValue('abc', 5, 2, 'X'), 'abcX');
  assert.equal(computeInsertedValue('abc', -1, 2, 'X'), 'Xc');
  // 非字符串值兜底
  assert.equal(computeInsertedValue(undefined, 0, 0, 'x'), 'x');
  assert.equal(computeInsertedValue(null, 0, 0, 'x'), 'x');
});

test('buildReadTextMessage / buildReadTextAck 构造剪贴板读取消息', () => {
  assert.deepEqual(buildReadTextMessage('req-1'), { kind: 'readText', requestId: 'req-1' });
  assert.deepEqual(buildReadTextAck('req-1', true, 'abc'), { kind: 'readTextAck', requestId: 'req-1', ok: true, text: 'abc' });
  // 读取失败：不带 text 字段
  assert.deepEqual(buildReadTextAck('req-2', false), { kind: 'readTextAck', requestId: 'req-2', ok: false });
  assert.deepEqual(buildReadTextAck('req-3', true, ''), { kind: 'readTextAck', requestId: 'req-3', ok: false });
});

// —— v0.4.3：在 VS Code 中打开「本轮文件改动」Diff ——

test('parseChangesQuery 解析 summary / diff 坐标（这条链路是拿到 seq 的唯一途径）', () => {
  const base = 'http://127.0.0.1:3080/';
  // diff：三个参数俱全
  assert.deepEqual(parseChangesQuery('api/changes.diff?sessionId=s1&seq=12&index=3', base), {
    route: 'diff',
    sessionId: 's1',
    seq: 12,
    index: 3,
  });
  // summary：无 index
  assert.deepEqual(parseChangesQuery('api/changes.summary?sessionId=s1&seq=12', base), {
    route: 'summary',
    sessionId: 's1',
    seq: 12,
  });
  // 绝对 URL、前导斜杠、带部署前缀都应识别
  assert.deepEqual(parseChangesQuery('http://127.0.0.1:3080/api/changes.summary?sessionId=s2&seq=1', base), {
    route: 'summary',
    sessionId: 's2',
    seq: 1,
  });
  assert.deepEqual(parseChangesQuery('/api/changes.summary?sessionId=s3&seq=2', base), {
    route: 'summary',
    sessionId: 's3',
    seq: 2,
  });
  // 非本端点 / 缺参数 / 非法数字一律 null（观测器据此静默跳过）
  assert.equal(parseChangesQuery('api/changes.summary', base), null);
  assert.equal(parseChangesQuery('api/changes.summary?sessionId=s1', base), null);
  assert.equal(parseChangesQuery('api/changes.summary?sessionId=&seq=1', base), null);
  assert.equal(parseChangesQuery('api/changes.summary?sessionId=s1&seq=abc', base), null);
  assert.equal(parseChangesQuery('api/changes.diff?sessionId=s1&seq=1&index=-1', base), null);
  assert.equal(parseChangesQuery('api/other?sessionId=s1&seq=1', base), null);
  assert.equal(parseChangesQuery('', base), null);
});

test('changesDiffUrl 与 DSH 客户端构造的取数 URL 形状一致', () => {
  const url = changesDiffUrl('sess-1', 7, 2);
  assert.ok(url.startsWith(CHANGES_DIFF_ROUTE + '?'), `应以 ${CHANGES_DIFF_ROUTE}? 开头，实际 ${url}`);
  const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  assert.equal(params.get('sessionId'), 'sess-1');
  assert.equal(params.get('seq'), '7');
  assert.equal(params.get('index'), '2');
  // 端点必须是 document-relative（无前导斜杠）——DSH 的 Web client 按下此约定取数
  assert.ok(!CHANGES_DIFF_ROUTE.startsWith('/'));
  assert.ok(!CHANGES_SUMMARY_ROUTE.startsWith('/'));
});

test('isWorkspaceFileDiff 只接受 text 分支（binary/oversized 无 hunks 无法还原）', () => {
  const ok = { kind: 'text', path: 'a.ts', hunks: [] };
  assert.equal(isWorkspaceFileDiff(ok), true);
  assert.equal(isWorkspaceFileDiff({ kind: 'binary', path: 'a.png' }), false);
  assert.equal(isWorkspaceFileDiff({ kind: 'oversized', path: 'big.ts' }), false);
  assert.equal(isWorkspaceFileDiff({ kind: 'text', path: '', hunks: [] }), false);
  assert.equal(isWorkspaceFileDiff({ kind: 'text', path: 'a.ts', hunks: 'no' }), false);
  assert.equal(isWorkspaceFileDiff(null), false);
  assert.equal(isWorkspaceFileDiff([]), false);
  assert.equal(isWorkspaceFileDiff('text'), false);
});

test('buildOpenDiffMessage 只带非空可选字段（cwd/display 不污染消息形状）', () => {
  const diff = { kind: 'text', path: 'a.ts', hunks: [] };
  assert.deepEqual(buildOpenDiffMessage({ path: 'a.ts', diff }), {
    kind: 'openDiff',
    path: 'a.ts',
    diff,
  });
  assert.deepEqual(buildOpenDiffMessage({ path: 'a.ts', diff, cwd: '/ws', display: 'src/a.ts' }), {
    kind: 'openDiff',
    path: 'a.ts',
    diff,
    cwd: '/ws',
    display: 'src/a.ts',
  });
  // 空串视同缺省（避免扩展侧把 '' 当基准目录解析出错误路径）
  const m = buildOpenDiffMessage({ path: 'a.ts', diff, cwd: '', display: '' });
  assert.equal('cwd' in m, false);
  assert.equal('display' in m, false);
});

test('findSessionId 从会话容器取 id（快照没有 current 字段，只能以 DOM 为准）', () => {
  const el = (attrs: Record<string, string | undefined>) => ({
    closest: (sel: string) => {
      if (sel === '[data-conversation-session]' && attrs.conv !== undefined) return { getAttribute: () => attrs.conv };
      if (sel === '[data-sidebar-right-session]' && attrs.side !== undefined) return { getAttribute: () => attrs.side };
      return null;
    },
  });
  assert.equal(findSessionId(el({ conv: 's-1' })), 's-1');
  // 聊天区优先于右侧栏（同一元素可能同时在两者内，聊天区更贴近用户意图）
  assert.equal(findSessionId(el({ conv: 's-1', side: 's-2' })), 's-1');
  // 仅右侧栏（review 标签页场景）：也能取到
  assert.equal(findSessionId(el({ side: 's-3' })), 's-3');
  // 空串 / 缺失 / 非元素一律 ''
  assert.equal(findSessionId(el({ conv: '' })), '');
  assert.equal(findSessionId(el({})), '');
  assert.equal(findSessionId(null), '');
  assert.equal(findSessionId({}), '');
});

test('changedFileIndexOf 从 aria-describedby 后缀解析下标（表头按 0）', () => {
  const btn = (described: string | null | undefined) => ({ getAttribute: () => described ?? null });
  assert.equal(changedFileIndexOf(btn(':r5:-3')), 3);
  assert.equal(changedFileIndexOf(btn(':r5:-0')), 0);
  // 单文件表头：只有 useId，没有下标后缀 → 0（与 DSH 表头语义一致）
  assert.equal(changedFileIndexOf(btn(':r5:')), 0);
  assert.equal(changedFileIndexOf(btn(null)), 0);
  assert.equal(changedFileIndexOf(btn('')), 0);
  assert.equal(changedFileIndexOf({}), 0);
  assert.equal(changedFileIndexOf(null), 0);
});

test('sessionCwdFrom 取「当前 DSH 会话工作区」；形状缺失一律 undefined（不抛）', () => {
  const snap = { ids: ['a'], byId: { a: { id: 'a', cwd: 'G:\\projA' }, b: { id: 'b' } } };
  assert.equal(sessionCwdFrom(snap, 'a'), 'G:\\projA');
  // 切到 B 会话就是 B 的工作区——这正是「相对路径按会话解析」的核心诉求
  assert.equal(sessionCwdFrom({ byId: { b: { cwd: 'G:\\projB' } } }, 'b'), 'G:\\projB');
  // 无 cwd / 未知会话 / 空 cwd / 形状不合法
  assert.equal(sessionCwdFrom(snap, 'b'), undefined);
  assert.equal(sessionCwdFrom(snap, 'zzz'), undefined);
  assert.equal(sessionCwdFrom({ byId: { a: { cwd: '' } } }, 'a'), undefined);
  assert.equal(sessionCwdFrom(undefined, 'a'), undefined);
  assert.equal(sessionCwdFrom(null, 'a'), undefined);
  assert.equal(sessionCwdFrom({}, 'a'), undefined);
  assert.equal(sessionCwdFrom({ byId: { a: { cwd: 1 } } }, 'a'), undefined);
  assert.equal(sessionCwdFrom(snap, ''), undefined);
});

test('changesKey / changedFileAt：坐标键与摘要取文件（数据源是服务端 JSON，不碰 DOM 文案）', () => {
  assert.equal(changesKey('s1', 3), 's1|3');
  const summary = {
    turn: 2,
    files: [
      { path: 'src/a.ts', display: 'src/a.ts', added: 1, deleted: 0 },
      { path: '../out/b.txt', display: '../out/b.txt', added: 0, deleted: 2 },
      { path: 'c.md' }, // 缺 display：回退用 path
    ],
  };
  assert.deepEqual(changedFileAt(summary, 0), { path: 'src/a.ts', display: 'src/a.ts' });
  // 工作区外的 ../ 路径原样保留（扩展侧会相对会话 cwd 解析）
  assert.deepEqual(changedFileAt(summary, 1), { path: '../out/b.txt', display: '../out/b.txt' });
  assert.deepEqual(changedFileAt(summary, 2), { path: 'c.md', display: 'c.md' });
  // 越界 / 缺字段 / 形状不合法一律 null
  assert.equal(changedFileAt(summary, 9), null);
  assert.equal(changedFileAt({ files: [{ display: 'x' }] }, 0), null);
  assert.equal(changedFileAt({ files: 'no' }, 0), null);
  assert.equal(changedFileAt(null, 0), null);
});

test('isChangesToggle 排除「展开/收起全部」控件（否则点展开会误弹第一个文件的 diff）', () => {
  const el = (expanded: string | null) => ({
    matches: (sel: string) => (sel === '[aria-expanded]' ? expanded !== null : false),
  });
  // disclosure 控件带 aria-expanded → 必须排除
  assert.equal(isChangesToggle(el('true')), true);
  assert.equal(isChangesToggle(el('false')), true);
  // 文件行/表头按钮不带 aria-expanded → 视为文件行
  assert.equal(isChangesToggle(el(null)), false);
  assert.equal(isChangesToggle({}), false);
  assert.equal(isChangesToggle(null), false);
  // matches 抛错也要安全
  assert.equal(isChangesToggle({ matches: () => { throw new Error('x'); } }), false);
});

test('pathTailMatches 按路径段做尾匹配（跨分隔符风格）', () => {
  assert.equal(pathTailMatches('G:\\projA\\src\\a.ts', 'src/a.ts'), true);
  assert.equal(pathTailMatches('/ws/src/a.ts', 'src\\a.ts'), true);
  assert.equal(pathTailMatches('/ws/src/a.ts', 'a.ts'), true);
  // 只是后缀字符相同但不是一个路径段：不算匹配（避免 b.ts 命中 ab.ts）
  assert.equal(pathTailMatches('/ws/src/ab.ts', 'b.ts'), false);
  assert.equal(pathTailMatches('/ws/src/a.ts', 'other/a.ts'), false);
  assert.equal(pathTailMatches('', 'a.ts'), false);
  assert.equal(pathTailMatches('/ws/a.ts', ''), false);
  assert.equal(pathTailMatches(undefined as unknown as string, 'a'), false);
});

test('matchChangesSeq 用卡片绝对路径对齐出同一轮（多轮改动不张冠李戴）', () => {
  const round1 = { turn: 1, files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] };
  const round2 = { turn: 2, files: [{ path: 'src/x.ts' }, { path: 'src/y.ts' }, { path: 'src/z.ts' }] };
  const candidates = [{ seq: 10, summary: round1 }, { seq: 20, summary: round2 }];
  const ws = (n: string) => `/ws/${n}`;

  // 点旧卡片（第 1 轮）→ 必须命中 seq 10，而不是最新一轮 20
  assert.deepEqual(matchChangesSeq(candidates, [ws('src/a.ts'), ws('src/b.ts')]), { seq: 10, summary: round1 });
  // 点新卡片（第 2 轮）→ 命中 20
  assert.deepEqual(
    matchChangesSeq(candidates, [ws('src/x.ts'), ws('src/y.ts'), ws('src/z.ts')]),
    { seq: 20, summary: round2 },
  );
  // 只有部分对齐 → 判为无法确定（返回 null，由调用方退回最新一轮）
  assert.equal(matchChangesSeq(candidates, [ws('src/a.ts'), ws('nope.ts')]), null);
  // 候选里文件数少于卡片行数 → 跳过
  assert.equal(matchChangesSeq([{ seq: 1, summary: { files: [{ path: 'src/a.ts' }] } }], [ws('src/a.ts'), ws('src/b.ts')]), null);
  // 空输入 / 形状不合法
  assert.equal(matchChangesSeq([], [ws('a.ts')]), null);
  assert.equal(matchChangesSeq(candidates, []), null);
  assert.equal(matchChangesSeq(null, [ws('a.ts')]), null);
  assert.equal(matchChangesSeq([{ seq: 1, summary: null }], [ws('a.ts')]), null);
});

test('BoundedMap：超过上限淘汰最旧，命中过的键不被优先淘汰（面板长开内存有界）', () => {
  const m = new BoundedMap(3);
  m.set('a', 1);
  m.set('b', 2);
  m.set('c', 3);
  assert.equal(m.size, 3);
  // 写第 4 个 → 最旧的 'a' 被淘汰
  m.set('d', 4);
  assert.equal(m.size, 3);
  assert.equal(m.has('a'), false, '最旧的应被淘汰');
  assert.equal(m.get('d'), 4);

  // 命中后重写 'b' → 它应排到队尾，接下来的淘汰目标是 'c' 而非 'b'
  m.set('b', 22);
  m.set('e', 5);
  assert.equal(m.get('b'), 22, '最近写过的键不应被淘汰');
  assert.equal(m.has('c'), false, '此时应淘汰 c');

  // 覆盖已有键不增长条目数
  const before = m.size;
  m.set('d', 44);
  assert.equal(m.size, before);
  assert.equal(m.get('d'), 44);

  // limit ≤ 0 归一为 1（不出现无界）
  const tiny = new BoundedMap(0);
  tiny.set('x', 1);
  tiny.set('y', 2);
  assert.equal(tiny.size, 1);
  assert.equal(tiny.get('y'), 2);

  // entries() 可用（client.js 用它与 Map 同形遍历）
  const keys = [...new BoundedMap(2).set('k', 1).entries()].map(([k]) => k);
  assert.deepEqual(keys, ['k']);
});

test('BoundedMap：提供 sizeOf/maxBytes 时按总字节淘汰（防单条 diff 撑爆堆）', () => {
  // 每条 10 字符；总上限 25 → 最多留 2 条（第 3 条进来时淘汰最旧）
  const m = new BoundedMap(1000, (s: string) => s.length, 25);
  m.set('a', 'aaaaaaaaaa');
  m.set('b', 'bbbbbbbbbb');
  assert.equal(m.totalBytes, 20);
  m.set('c', 'cccccccccc');
  assert.ok(m.totalBytes <= 25, `总字节应被限制，实际 ${m.totalBytes}`);
  assert.equal(m.has('a'), false, '最旧的应因字节超限被淘汰');
  assert.equal(m.has('c'), true);

  // 覆盖同键：字节账要正确回滚（不能越攒越多）
  const m2 = new BoundedMap(10, (s: string) => s.length, 100);
  m2.set('k', 'x'.repeat(30));
  assert.equal(m2.totalBytes, 30);
  m2.set('k', 'y'.repeat(10));
  assert.equal(m2.totalBytes, 10, '覆盖后应只计新值');

  // 即便超限也至少保留 1 条（否则刚放进去就被清掉，等于永远不命中）
  const m3 = new BoundedMap(10, (s: string) => s.length, 1);
  m3.set('big', 'z'.repeat(100));
  assert.equal(m3.size, 1);
  assert.equal(m3.get('big'), 'z'.repeat(100));

  // 未提供 sizeOf 时不统计字节
  const m4 = new BoundedMap(3);
  m4.set('a', 'anything');
  assert.equal(m4.totalBytes, 0);
});

test('jsonByteSize：正常/循环引用都不抛（缓存记账不能因数据形状炸掉）', () => {
  assert.ok(jsonByteSize({ a: 1 }) > 0);
  assert.equal(jsonByteSize(undefined), 0);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(jsonByteSize(cyclic), 0, '循环引用应安全返回 0 而不是抛错');
});

/** 构造带 data-turn-tail 的卡片替身 */
function fakeTurnCard(turn: string | null) {
  const host = {
    getAttribute: (n: string) => (n === 'data-turn-tail' ? turn : null),
  };
  return {
    closest: (sel: string) => (sel === TURN_TAIL_SELECTOR ? host : null),
  };
}

test('findTurn：从卡片读出所属轮次号（读不到/非法值一律 null）', () => {
  assert.equal(findTurn(fakeTurnCard('3')), 3);
  assert.equal(findTurn(fakeTurnCard('0')), 0);
  assert.equal(findTurn(fakeTurnCard(null)), null);
  assert.equal(findTurn(fakeTurnCard('')), null);
  assert.equal(findTurn(fakeTurnCard('abc')), null);
  assert.equal(findTurn(null), null);
  assert.equal(findTurn({}), null); // 没有 closest
});

test('matchChangesTurn：按轮次号精确命中；0 个或多个都判为无法确定', () => {
  const a = { seq: 10, summary: { turn: 1, files: [] } };
  const b = { seq: 20, summary: { turn: 2, files: [] } };
  const c = { seq: 30, summary: { turn: 3, files: [] } };
  assert.deepEqual(matchChangesTurn([a, b, c], 2), b);
  assert.equal(matchChangesTurn([a, b, c], 9), null, '没有该轮 → null');
  // 同一轮出现多个候选（异常数据）→ 不猜
  assert.equal(matchChangesTurn([a, { seq: 99, summary: { turn: 1 } }], 1), null);
  assert.equal(matchChangesTurn([a], null), null);
  assert.equal(matchChangesTurn(null, 1), null);
  // 候选缺 turn 字段 → 不匹配
  assert.equal(matchChangesTurn([{ seq: 1, summary: { files: [] } }], 1), null);
});

test('matchChangesSeq：多候选同样对齐时判为歧义（不再「取最新 seq」而张冠李戴）', () => {
  // 同一文件在 3 轮里都被改 → 三条指纹完全相同
  const same = (seq: number, turn: number) => ({ seq, summary: { turn, files: [{ path: 'src/a.ts' }] } });
  const candidates = [same(10, 1), same(20, 2), same(30, 3)];
  // 关键：以前会返回 seq=30（最新），让「第 1 轮卡片」显示第 3 轮的 diff
  assert.equal(matchChangesSeq(candidates, ['/ws/src/a.ts']), null, '歧义时必须返回 null，由轮次号消歧');
  // 只有一条对齐时仍能命中
  assert.deepEqual(matchChangesSeq([candidates[0]!], ['/ws/src/a.ts']), {
    seq: 10,
    summary: candidates[0]!.summary,
  });
});
