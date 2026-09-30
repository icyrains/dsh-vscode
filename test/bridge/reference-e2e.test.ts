// test/bridge/reference-e2e.test.ts — v0.5.0「引用到 DSH」端到端测试（在真实构建产物上运行）
//
// 为什么必须有这一层：纯逻辑单测只能证明「载荷算得对」，证明不了「它真的进了 DSH 输入框」。
// 这里把内联后的 client.js 工厂放进 node:vm 沙箱执行，模拟扩展宿主投递下行消息，然后断言
// 桥接确实调用了 DSH 的 **原生** 入口 conversation.input.shell(id).addFiles(refs, [])——
// 也就是 DSH 自己「拖文件进输入框」走的同一个方法。
//
// 覆盖的用户口径：
//   ① 右键引用 → 输入框出现引用（addFiles 被调用，载荷字段与原生拖拽一致）；
//   ② 相对路径按**会话 cwd** 解析（不是 VS Code 工作区根）；
//   ③ 定不到会话 / 没有输入框 / 输入框拒绝 → 回执 ok=false 且带机读原因（绝不假装成功）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildBridgeClient } from '../../scripts/bridge-build.mjs';

/** 一次 addFiles 调用的记录 */
interface AddFilesCall {
  sessionId: string;
  references: { source: string; ref: string; label: string; appearance: string; clipboardText: string }[];
  attachmentIds: unknown;
}

/**
 * 在最小浏览器沙箱里加载桥接工厂。
 * @param opts.sessionCwd 会话工作目录（sessions.list 快照里的 cwd）
 * @param opts.selection uiWorkspace.selection 快照（当前会话）
 * @param opts.dotfilesDir 只用于断言「错误地按 VS Code 工作区根解析」不会发生
 * @param opts.omitComposer 为 true 时不提供 conversation 服务（模拟输入框不存在）
 * @param opts.addFilesResult addFiles 的返回值（默认 true）
 */
function loadBridge(opts: {
  sessionCwd?: string;
  selection?: unknown;
  omitComposer?: boolean;
  addFilesResult?: boolean;
}) {
  const outDir = join(
    tmpdir(),
    'dsh-bridge-ref-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  );
  // buildBridgeClient 会 console.log 一行；并行测试下会污染 TAP 流，静默它
  const origLog = console.log;
  console.log = () => {};
  let built: string;
  try {
    built = buildBridgeClient({
      coreSource: join(process.cwd(), 'bridge-client', 'lib', 'core.js'),
      clientTemplate: join(process.cwd(), 'bridge-client', 'lib', 'client.js'),
      outDir,
    });
  } finally {
    console.log = origLog;
  }
  const code = readFileSync(built, 'utf8');

  const windowListeners = new Map<string, Set<(...a: any[]) => void>>();
  const docListeners = new Map<string, Set<(...a: any[]) => void>>();
  const parentMessages: any[] = [];
  const addFilesCalls: AddFilesCall[] = [];
  let loadedPlugin: any = null;

  const emitWin = (type: string, data: unknown) => {
    for (const fn of windowListeners.get(type) ?? []) fn({ data });
  };

  const parent = {
    postMessage(msg: any) {
      parentMessages.push(msg);
    },
  };

  const fakeWindow: Record<string, any> = {
    __ModuleLoader__: { load(cfg: any) { loadedPlugin = cfg; } },
    fetch: async () => new Response('{}', { status: 200 }),
    __dshVscodeBridgeReady: false,
    addEventListener(type: string, fn: (...a: any[]) => void) {
      (windowListeners.get(type) ?? (windowListeners.set(type, new Set()).get(type)!)).add(fn);
    },
    removeEventListener(type: string, fn: (...a: any[]) => void) {
      windowListeners.get(type)?.delete(fn);
    },
    getSelection() { return null; },
    innerWidth: 1280,
    innerHeight: 800,
  };
  const fakeDocument: Record<string, any> = {
    addEventListener(type: string, fn: (...a: any[]) => void) {
      (docListeners.get(type) ?? (docListeners.set(type, new Set()).get(type)!)).add(fn);
    },
    activeElement: null,
    baseURI: 'http://127.0.0.1:3080/',
    execCommand() { return false; },
    createElement() { return { textContent: '', style: {}, append() {}, setAttribute() {}, addEventListener() {} }; },
    head: { append() {} },
    body: { append() {} },
    // DOM 兜底：本测试一律用 uiWorkspace selection 定址，故这里返回 null
    querySelector() { return null; },
  };

  const sandbox: Record<string, any> = {
    window: fakeWindow,
    document: fakeDocument,
    navigator: { clipboard: {} },
    parent,
    btoa: (globalThis as any).btoa?.bind(globalThis),
    atob: (globalThis as any).atob?.bind(globalThis),
    Response: globalThis.Response,
    fetch: globalThis.fetch,
    setTimeout,
    clearTimeout,
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    CSS: { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') },
    Event: class { type: string; constructor(type: string) { this.type = type; } },
    HTMLTextAreaElement: { prototype: {} },
    HTMLInputElement: { prototype: {} },
    console: { log() {}, warn() {}, error() {} },
  };
  const ctx = createContext(sandbox);
  runInContext(code, ctx);

  assert.ok(loadedPlugin, '工厂应被 load 捕获');

  return {
    outDir,
    parentMessages,
    addFilesCalls,
    emitWin,
    /** 执行工厂（绑定监听、返回 module.exports），但**不**调用 cordis apply */
    boot() {
      return loadedPlugin.factory(() => { throw new Error('unexpected require'); });
    },
    /**
     * 执行工厂并把一个桩 cordis ctx 交给桥接的 exports.apply。
     * 桩 ctx 的 get() 只暴露本场景需要的服务。
     */
    apply() {
      const exportsObj = this.boot();
      assert.ok(typeof exportsObj.apply === 'function', '桥接应导出 cordis apply');
      exportsObj.apply({
        get(name: string) {
          if (name === 'uiWorkspace') {
            return { selection: { getSnapshot: () => opts.selection ?? {} } };
          }
          if (name === 'sessions') {
            return {
              list: {
                getSnapshot: () => ({
                  ids: ['s-target'],
                  byId: { 's-target': { id: 's-target', cwd: opts.sessionCwd } },
                }),
              },
            };
          }
          if (name === 'conversation') {
            if (opts.omitComposer === true) return undefined;
            return {
              input: {
                shell(sessionId: string) {
                  return {
                    addFiles(references: AddFilesCall['references'], attachmentIds: unknown) {
                      addFilesCalls.push({ sessionId, references, attachmentIds });
                      return opts.addFilesResult !== false;
                    },
                  };
                },
              },
            };
          }
          return undefined;
        },
      });
      return exportsObj;
    },
  };
}

/** 取最后一条 insertReferenceAck 回执 */
function lastAck(b: { parentMessages: any[] }) {
  const acks = b.parentMessages.filter((m) => m?.kind === 'insertReferenceAck');
  return acks[acks.length - 1];
}

/**
 * 把沙箱（另一个 realm）里造出的对象转成本 realm 的普通对象。
 *
 * 必须这么做的原因：vm 沙箱有自己的 Object/Array 原型，node 的 deepStrictEqual 会
 * 因「原型不同」判不等——即使结构完全一样。直接用 JSON 往返即可（载荷本就是纯数据）。
 * 注意：这不是在放宽断言，结构差异依然会被抓到。
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test('E2E：下行 insertReference → 调用 DSH 原生 addFiles，且载荷与原生拖拽一致', () => {
  const b = loadBridge({ sessionCwd: '/ws/session-a', selection: { sessionId: 's-target' } });
  const outDir = b.outDir;
  try {
    b.apply();
    b.emitWin('message', {
      kind: 'insertReference',
      requestId: 'req-1',
      entries: [{ path: '/ws/session-a/src/a.ts' }],
    });

    // ① 真的调用了 DSH 原生入口
    assert.equal(b.addFilesCalls.length, 1, '应恰好调用一次 addFiles');
    const call = b.addFilesCalls[0];
    assert.equal(call.sessionId, 's-target', '应插入到 UI 当前选中的会话');
    assert.deepEqual(plain(call.attachmentIds), [], '引用插入不涉及图片附件，应传空数组');

    // ② 载荷字段与 DSH 原生拖拽逐项一致
    assert.deepEqual(plain(call.references), [
      {
        source: 'reference',
        ref: '@src/a.ts',
        label: 'a.ts',
        appearance: 'file',
        clipboardText: '@src/a.ts',
      },
    ]);

    // ③ 回执成功且带条数
    const ack = lastAck(b);
    assert.equal(ack.ok, true);
    assert.equal(ack.requestId, 'req-1');
    assert.equal(ack.inserted, 1);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('E2E：相对路径按会话 cwd 解析，而不是 VS Code 工作区根', () => {
  // 会话 cwd = /ws/session-a；文件在它的 src/ 下 → 引用应为 @src/a.ts。
  // 若错误地按别的基准（如 VS Code 工作区根 /ws）解析，就会得到 @session-a/src/a.ts。
  const b = loadBridge({ sessionCwd: '/ws/session-a', selection: { sessionId: 's-target' } });
  const outDir = b.outDir;
  try {
    b.apply();
    b.emitWin('message', {
      kind: 'insertReference',
      requestId: 'req-2',
      entries: [{ path: '/ws/session-a/src/deep/b.ts' }],
    });
    assert.equal(b.addFilesCalls[0].references[0].ref, '@src/deep/b.ts');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('E2E：目录引用 → appearance=folder、label 与 ref 带尾斜杠', () => {
  const b = loadBridge({ sessionCwd: '/ws/session-a', selection: { sessionId: 's-target' } });
  const outDir = b.outDir;
  try {
    b.apply();
    b.emitWin('message', {
      kind: 'insertReference',
      requestId: 'req-3',
      entries: [{ path: '/ws/session-a/src/components', directory: true }],
    });
    assert.deepEqual(plain(b.addFilesCalls[0].references[0]), {
      source: 'reference',
      ref: '@src/components/',
      label: 'components/',
      appearance: 'folder',
      clipboardText: '@src/components/',
    });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('E2E：多选批量按选择顺序插入，回执条数等于实际插入数', () => {
  const b = loadBridge({ sessionCwd: '/ws/session-a', selection: { sessionId: 's-target' } });
  const outDir = b.outDir;
  try {
    b.apply();
    b.emitWin('message', {
      kind: 'insertReference',
      requestId: 'req-4',
      entries: [{ path: '/ws/session-a/b.ts' }, { path: '/ws/session-a/a.ts' }, { path: '/ws/session-a/dir', directory: true }],
    });
    assert.deepEqual(plain(b.addFilesCalls[0].references.map((r) => r.ref)), ['@b.ts', '@a.ts', '@dir/']);
    assert.equal(lastAck(b).inserted, 3);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('E2E：定不到会话 → 回执 ok=false reason=no-session（且不碰输入框）', () => {
  // selection 与 DOM 都拿不到会话
  const b = loadBridge({ sessionCwd: '/ws/session-a', selection: {} });
  const outDir = b.outDir;
  try {
    b.apply();
    b.emitWin('message', { kind: 'insertReference', requestId: 'req-5', entries: [{ path: '/ws/session-a/a.ts' }] });
    const ack = lastAck(b);
    assert.equal(ack.ok, false);
    assert.equal(ack.reason, 'no-session');
    assert.equal(b.addFilesCalls.length, 0, '定不到会话时不得调用 addFiles');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('E2E：输入框不可用（无 conversation 服务）→ reason=no-composer', () => {
  const b = loadBridge({ sessionCwd: '/ws/session-a', selection: { sessionId: 's-target' }, omitComposer: true });
  const outDir = b.outDir;
  try {
    b.apply();
    b.emitWin('message', { kind: 'insertReference', requestId: 'req-6', entries: [{ path: '/ws/session-a/a.ts' }] });
    const ack = lastAck(b);
    assert.equal(ack.ok, false);
    assert.equal(ack.reason, 'no-composer');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('E2E：addFiles 拒绝（例如正在发送）→ reason=insert-refused，不假装成功', () => {
  const b = loadBridge({ sessionCwd: '/ws/session-a', selection: { sessionId: 's-target' }, addFilesResult: false });
  const outDir = b.outDir;
  try {
    b.apply();
    b.emitWin('message', { kind: 'insertReference', requestId: 'req-7', entries: [{ path: '/ws/session-a/a.ts' }] });
    const ack = lastAck(b);
    assert.equal(ack.ok, false);
    assert.equal(ack.reason, 'insert-refused');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('E2E：工厂已加载但 cordis 未 apply（上下文缺失）→ reason=no-context', () => {
  const b = loadBridge({ sessionCwd: '/ws/session-a', selection: { sessionId: 's-target' } });
  const outDir = b.outDir;
  try {
    // 执行工厂（监听已绑定，页面收得到消息），但故意**不**调 apply()：
    // 模拟 cordis 尚未注入上下文 / apply 因故未运行。此时 clientCtx 仍为 undefined。
    b.boot();
    b.emitWin('message', { kind: 'insertReference', requestId: 'req-8', entries: [{ path: '/ws/session-a/a.ts' }] });
    const ack = lastAck(b);
    assert.ok(ack, '应仍有回执（不能让命令悬挂）');
    assert.equal(ack.ok, false);
    assert.equal(ack.reason, 'no-context');
    assert.equal(b.addFilesCalls.length, 0);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('E2E：坏形状消息（缺 requestId / 空 entries）被完全忽略（无回执、无副作用）', () => {
  const b = loadBridge({ sessionCwd: '/ws/session-a', selection: { sessionId: 's-target' } });
  const outDir = b.outDir;
  try {
    b.apply();
    b.emitWin('message', { kind: 'insertReference', entries: [{ path: '/ws/session-a/a.ts' }] });
    b.emitWin('message', { kind: 'insertReference', requestId: 'x', entries: [] });
    assert.equal(lastAck(b), undefined, '坏消息不应产生任何回执');
    assert.equal(b.addFilesCalls.length, 0);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('E2E：钉住「不经过剪贴板/键盘模拟」——只走 addFiles 一条路', () => {
  // 这是本功能的核心设计断言：引用以原子芯片形式插入，而非往输入框塞纯文本。
  // 若将来有人改成 execCommand/粘贴实现，本测试会因为 addFiles 不再被调用而失败。
  const b = loadBridge({ sessionCwd: '/ws/session-a', selection: { sessionId: 's-target' } });
  const outDir = b.outDir;
  try {
    b.apply();
    b.emitWin('message', { kind: 'insertReference', requestId: 'req-9', entries: [{ path: '/ws/session-a/a.ts' }] });
    assert.equal(b.addFilesCalls.length, 1, '必须走 DSH 原生 addFiles（芯片语义）');
    // 载荷必须带 source/ref/label/appearance/clipboardText 五件套——缺任一项都不是合法芯片
    const ref = b.addFilesCalls[0].references[0];
    for (const key of ['source', 'ref', 'label', 'appearance', 'clipboardText']) {
      assert.ok(key in ref, `引用载荷缺少 ${key}`);
    }
    assert.equal(ref.source, 'reference', 'source 必须是 reference（决定芯片图标与路由）');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
