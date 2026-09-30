// test/bridge/interceptor.test.ts — 图片降级拦截器集成测试（在真实构建产物上运行）
// 目的：直接把「内联后的 client.js」工厂放进一个最小浏览器沙箱（node:vm）执行，
// 模拟握手 + 附件捕获 + 被拒响应，验证 v0.3.0 图片降级的新行为（用户验收口径）：
//   ① 非视觉模型被拒 → 保存图片、改为「原文+图片地址」重发、用重发成功响应顶替被拒响应
//      （DSH 不再显示"不支持图像输入"报错），且不向上发任何 imageFallback 通知；
//   ② 视觉模型（成功响应）→ 原样透传，完全不动；
//   ③ 被拒但无落盘（未打开工作区）→ 回退原生被拒响应，绝不吞错误。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildBridgeClient } from '../../scripts/bridge-build.mjs';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const REJECT_BODY = {
  rpcId: 'orig-1',
  result: {
    ok: false,
    error: {
      code: 'attachment-error',
      message: 'Model "x" does not support image input.',
      details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
    },
  },
};
const ACCEPT_BODY = { rpcId: 'orig-1', result: { ok: true, value: { accepted: true } } };

/** 构造并加载桥接工厂，返回可调用的沙箱句柄 */
function loadBridge(opts: { fetch: (input: unknown, init: any) => Promise<Response> }) {
  const outDir = join(tmpdir(), 'dsh-bridge-it-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  // 静默构建（buildBridgeClient 会 console.log 一行，避免污染 node --test 的 TAP 流——
  // 与其它测试并行时可能导致 runner 反序列化失败（Unable to deserialize cloned data））
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

  // —— 最小浏览器沙箱 ——
  const windowListeners: Map<string, Set<(...a: any[]) => void>> = new Map();
  const docListeners: Map<string, Set<(...a: any[]) => void>> = new Map();
  const parentMessages: any[] = [];
  let loadedPlugin: any = null;

  const emitWin = (type: string, data: unknown) => {
    for (const fn of windowListeners.get(type) ?? []) fn({ data });
  };
  const emitDoc = (type: string, ev: unknown) => {
    for (const fn of docListeners.get(type) ?? []) fn(ev);
  };

  // 父页面（扩展宿主）桩：落盘 saveImage 即回执 saveImageAck（模拟扩展写盘后回路径）。
  const parent = {
    postMessage(msg: any, _o?: string) {
      parentMessages.push(msg);
      if (msg?.kind === 'saveImage') {
        emitWin('message', { kind: 'saveImageAck', requestId: msg.requestId, ok: true, path: '/ws/' + msg.name });
      } else if (msg?.kind === 'deleteImages') {
        emitWin('message', { kind: 'deleteImagesAck', requestId: msg.requestId, ok: true });
      }
    },
  };

  const fakeWindow: Record<string, any> = {
    __ModuleLoader__: { load(cfg: any) { loadedPlugin = cfg; } },
    fetch: opts.fetch,
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
    // 测试默认把「模型看完即删」的 TTL 设为 30ms：批次自动快速删除，避免测试结束时残留定时器
    __dshBridgeImageTtlMs: 30,
  };
  const fakeDocument: Record<string, any> = {
    addEventListener(type: string, fn: (...a: any[]) => void) {
      (docListeners.get(type) ?? (docListeners.set(type, new Set()).get(type)!)).add(fn);
    },
    activeElement: null,
    // 改动 Diff 的取数 URL 按 document.baseURI 解析（与真实页面一致：服务地址 + '/'）
    baseURI: 'http://127.0.0.1:3080/',
    // undo/redo 返回 false：模拟「React 受控输入框原生撤销栈为空」，强制走桥接手动手栈
    execCommand(cmd: string) { return cmd !== 'undo' && cmd !== 'redo'; },
    createElement() { return { textContent: '', style: {}, append() {}, setAttribute() {}, addEventListener() {} }; },
    head: { append() {} },
    body: { append() {} },
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
    // —— v0.4.3 改动 Diff 链路需要的 Web API（vm 新 context 只带 ECMAScript 内置） ——
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    CSS: { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') },
    // —— 撤销/重做测试用 DOM 桩 ——
    Event: class { type: string; bubbles: boolean; constructor(type: string, opts?: { bubbles?: boolean }) { this.type = type; this.bubbles = !!(opts && opts.bubbles); } },
    HTMLTextAreaElement: {
      prototype: (() => {
        const proto: any = {};
        Object.defineProperty(proto, 'value', { get() { return this._v; }, set(v: string) { this._v = v; } });
        return proto;
      })(),
    },
    HTMLInputElement: {
      prototype: (() => {
        const proto: any = {};
        Object.defineProperty(proto, 'value', { get() { return this._v; }, set(v: string) { this._v = v; } });
        return proto;
      })(),
    },
    // 沙箱内 console：桥接的降级诊断行照常转发到 node console（调试可见），但
    // 用简单对象包裹，避免跨 realm console 对象参与 runner 的结果序列化
    console: {
      log: (...a: unknown[]) => console.log(...a),
      warn: (...a: unknown[]) => console.warn(...a),
      error: (...a: unknown[]) => console.error(...a),
    },
  };
  const ctx = createContext(sandbox);
  runInContext(code, ctx);

  assert.ok(loadedPlugin, '工厂应被 load 捕获');
  assert.equal(loadedPlugin.id, 'dsh-vscode-bridge');
  assert.ok(typeof loadedPlugin.factory === 'function');

  return {
    outDir,
    window: fakeWindow,
    document: fakeDocument,
    windowListeners,
    docListeners,
    parentMessages,
    emitWin,
    emitDoc,
    /** 执行 factory 并返回 module.exports（应用实例） */
    apply() {
      const req = (id: string) => { throw new Error('unexpected require: ' + id); };
      return loadedPlugin.factory(req);
    },
  };
}

test('被拒（非视觉模型）→ 保存图片、图片改为地址重发、返回成功响应且无通知', async () => {
  const calls: { input: unknown; init: any }[] = [];
  let servedOriginal = false;
  const fakeRealFetch = async (input: unknown, init: any) => {
    calls.push({ input, init });
    if (!servedOriginal) {
      servedOriginal = true;
      return jsonResponse(REJECT_BODY); // 第 1 次：原始含图请求 → 被拒
    }
    return jsonResponse(ACCEPT_BODY);   // 第 2 次：降级重发 → 成功
  };

  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply(); // 执行工厂：完成所有监听绑定与 fetch 接管

    // 握手：携带 imageFallback=true 激活降级
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    assert.equal(b.parentMessages.length, 1, '握手应回执 bridgeAck');
    assert.equal(b.parentMessages[0].kind, 'bridgeAck');

    // 捕获一张图片（模拟对话框选择文件）
    const file = {
      name: 'photo.png',
      size: 3,
      lastModified: 42,
      type: 'image/png',
      arrayBuffer: async () => new Uint8Array([1, 2, 3]),
    };
    b.emitDoc('change', { target: { files: [file] } });
    await new Promise((r) => setTimeout(r, 10)); // 等 btoa 微任务完成

    // 模拟 DSH 发送含图 prompt（父页面桩会自动回执 saveImageAck）
    const promptBody = JSON.stringify({
      type: 'client-request',
      rpcId: 'orig-1',
      method: 'session.prompt',
      payload: {
        sessionId: 's1',
        mode: 'queue',
        content: [{ type: 'text', text: '这是什么？' }, { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'a.png' }],
      },
    });
    const out = await b.window.fetch('http://127.0.0.1:3080/api/prompt', { method: 'POST', body: promptBody, headers: { 'content-type': 'application/json' } });

    // ① 返回给 DSH 的是「成功」响应（顶替被拒），且 rpcId 回写为原请求
    const json = await out.json();
    assert.equal(json.rpcId, 'orig-1', '交回响应的 rpcId 应为原请求');
    assert.equal(json.result.ok, true, '交回响应应为成功（不再报"不支持图像输入"）');
    assert.equal(json.result.value.accepted, true);
    assert.equal(out.status, 200);

    // ② DSH 侧应发起两次真实 fetch：原始（含图）+ 降级重发（纯文本图片地址）
    assert.equal(calls.length, 2, '应恰好一次原始 + 一次重发');
    const originalBody = JSON.parse(calls[0].init.body);
    const resendBody = JSON.parse(calls[1].init.body);
    // 原始请求不被篡改（仍是原 rpcId + 图片块）
    assert.equal(originalBody.type, 'client-request');
    assert.equal(originalBody.method, 'session.prompt');
    assert.equal(originalBody.rpcId, 'orig-1');
    assert.ok(originalBody.payload.content.some((x: any) => x.type === 'image'));
    // 重发：保留线格式 type/method（否则服务器 bad-request 拒绝）、新 rpcId、保留 sessionId/mode、内容为「原文 + 图片：路径」且不再含图片块
    assert.equal(resendBody.type, 'client-request', '重发必须保留 type=client-request');
    assert.equal(resendBody.method, 'session.prompt', '重发必须保留 method=session.prompt');
    assert.match(resendBody.rpcId, /^vsc-fb-/);
    assert.equal(resendBody.payload.sessionId, 's1');
    assert.equal(resendBody.payload.mode, 'queue');
    assert.ok(Array.isArray(resendBody.payload.content) && resendBody.payload.content.length === 1);
    assert.equal(resendBody.payload.content[0].type, 'text');
    assert.ok(resendBody.payload.content[0].text.includes('这是什么？'), '应保留用户原文');
    assert.match(resendBody.payload.content[0].text, /图片一：\S+dsh-imgcache-\S+\.png/, '应以「图片一：<绝对路径>」形式随消息发出');

    // ③ 请求过 saveImage 落盘（带图像数据，父桩回执了路径）
    const saveReqs = b.parentMessages.filter((m) => m.kind === 'saveImage');
    assert.equal(saveReqs.length, 1);
    assert.ok(typeof saveReqs[0].dataB64 === 'string' && saveReqs[0].dataB64.length > 0);
    assert.match(saveReqs[0].name, /^dsh-imgcache-/);

    // ④ 绝不向上发 imageFallback 通知（全程无感）
    assert.ok(!b.parentMessages.some((m) => m.kind === 'imageFallback'), '不应发送 imageFallback 通知');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('视觉模型（成功响应）→ 原样透传，不重发、不落盘、不通知', async () => {
  const calls: { input: unknown; init: any }[] = [];
  const fakeRealFetch = async (input: unknown, init: any) => {
    calls.push({ input, init });
    return jsonResponse(ACCEPT_BODY); // 模型支持图像 → 成功
  };
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    const promptBody = JSON.stringify({
      type: 'client-request', rpcId: 'orig-9', method: 'session.prompt',
      payload: { sessionId: 's2', content: [{ type: 'image' }, { type: 'text', text: '看图' }] },
    });
    const out = await b.window.fetch('/api/prompt', { method: 'POST', body: promptBody });
    const json = await out.json();
    assert.equal(json.result.ok, true);
    assert.equal(calls.length, 1, '成功路径不应触发重发');
    assert.ok(!b.parentMessages.some((m) => m.kind === 'saveImage'), '成功路径不应落盘');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('被拒但无图片缓存（未打开工作区）→ 回退原生被拒响应，不吞错误', async () => {
  const fakeRealFetch = async (_input: unknown, _init: any) => jsonResponse(REJECT_BODY);
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    // 未捕获任何图片（imageCache 为空）直接发含图请求
    const promptBody = JSON.stringify({
      type: 'client-request', rpcId: 'orig-3', method: 'session.prompt',
      payload: { sessionId: 's3', content: [{ type: 'image' }] },
    });
    const out = await b.window.fetch('/api/prompt', { method: 'POST', body: promptBody });
    const json = await out.json();
    // 保持原生：返回的是被拒响应（用户在 DSH 里能看到原始报错，不静默吞掉）
    assert.equal(json.result.ok, false);
    assert.equal(json.result.error.code, 'attachment-error');
    assert.ok(!b.parentMessages.some((m) => m.kind === 'saveImage'), '无缓存不应落盘');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('多条历史缓存时只降级本条消息的图片：按序标注 图片一/图片二、用后消费，不再重复引用', async () => {
  const calls: { input: unknown; init: any }[] = [];
  // 模拟服务端：含图请求被拒（非视觉模型），纯文本重发成功
  const fakeRealFetch = async (input: unknown, init: any) => {
    calls.push({ input, init });
    let body: any = {};
    try { body = JSON.parse(init.body || '{}'); } catch {}
    const content = body.payload && body.payload.content;
    const hasImage = Array.isArray(content) && content.some((c: any) => c && c.type === 'image');
    return jsonResponse(hasImage ? REJECT_BODY : ACCEPT_BODY);
  };
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    // 捕获 3 张（A/B/C）
    const mkFile = (name: string) => ({ name, size: name.length, lastModified: 1, type: 'image/png', arrayBuffer: async () => new Uint8Array([1, 2, 3]) });
    b.emitDoc('change', { target: { files: [mkFile('A.png'), mkFile('B.png'), mkFile('C.png')] } });
    await new Promise((r) => setTimeout(r, 20));

    // 第 1 次发送：本条消息只含 A、B 两张
    const body1 = JSON.stringify({
      type: 'client-request', rpcId: 'm1', method: 'session.prompt',
      payload: { sessionId: 's1', mode: 'queue',
        content: [{ type: 'text', text: '看看' }, { type: 'image', name: 'A.png', data: 'x' }, { type: 'image', name: 'B.png', data: 'y' }] },
    });
    const out1 = await b.window.fetch('/api/prompt', { method: 'POST', body: body1 });
    assert.equal((await out1.json()).result.ok, true);
    // 恰好 2 次 fetch：原始(含图) + 重发(纯文本)
    assert.equal(calls.length, 2);
    const text1 = JSON.parse(calls[1].init.body).payload.content[0].text;
    assert.match(text1, /图片一：\S*dsh-imgcache-[^\n]*\.png/m, '应按序标为图片一');
    assert.match(text1, /图片二：\S*dsh-imgcache-[^\n]*\.png/m, '应按序标为图片二');
    assert.ok(!/图片[三四五]/m.test(text1), '不应引用本条消息外的图片');
    const saves1 = b.parentMessages.filter((m) => m.kind === 'saveImage');
    assert.equal(saves1.length, 2, '只应落盘本条消息的 2 张');

    // 第 2 次发送：只含 C —— A/B 已被消费，不应再被重复引用
    const body2 = JSON.stringify({
      type: 'client-request', rpcId: 'm2', method: 'session.prompt',
      payload: { sessionId: 's1', mode: 'queue',
        content: [{ type: 'text', text: '再发' }, { type: 'image', name: 'C.png', data: 'z' }] },
    });
    const out2 = await b.window.fetch('/api/prompt', { method: 'POST', body: body2 });
    assert.equal((await out2.json()).result.ok, true);
    assert.equal(calls.length, 4);
    const text2 = JSON.parse(calls[3].init.body).payload.content[0].text;
    assert.match(text2, /图片一：\S*dsh-imgcache-[^\n]*\.png/m, 'C 应标为图片一');
    assert.ok(!/图片二/m.test(text2), 'C 只有一张，不应出现第二行');
    // 不重复引用第 1 次落盘的 A/B 文件
    for (const s of saves1) {
      assert.ok(!text2.includes(s.name), '不得重复引用上一轮已消费的临时文件 ' + s.name);
    }
    assert.equal(b.parentMessages.filter((m) => m.kind === 'saveImage').length, 3, '本轮新增只落盘 1 张');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('会话新建/切换时删除上一对话已落盘的临时图片（对话终止清理）', async () => {
  const calls: { input: unknown; init: any }[] = [];
  // 含图请求被拒（触发降级落盘），纯文本/其它成功
  const fakeRealFetch = async (input: unknown, init: any) => {
    calls.push({ input, init });
    let body: any = {};
    try { body = JSON.parse(init.body || '{}'); } catch {}
    const content = body.payload && body.payload.content;
    const hasImage = Array.isArray(content) && content.some((c: any) => c && c.type === 'image');
    return jsonResponse(hasImage ? REJECT_BODY : ACCEPT_BODY);
  };
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    // TTL 放大（须在工厂执行前设置，工厂在 apply 时读取该覆盖值），
    // 避免测试期间定时器自动删除干扰「会话新建触发删除」的计数断言
    b.window.__dshBridgeImageTtlMs = 60000;
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    // 会话 s1：发一张图 → 被拒 → 落盘 1 张到工作区
    const mkFile = (name: string) => ({ name, size: 3, lastModified: 7, type: 'image/png', arrayBuffer: async () => new Uint8Array([1, 2, 3]) });
    b.emitDoc('change', { target: { files: [mkFile('s1.png')] } });
    await new Promise((r) => setTimeout(r, 20));
    const bodyP = JSON.stringify({
      type: 'client-request', rpcId: 'p1', method: 'session.prompt',
      payload: { sessionId: 's1', content: [{ type: 'text', text: 'hi' }, { type: 'image', name: 's1.png', data: 'x' }] },
    });
    const out1 = await b.window.fetch('/api/prompt', { method: 'POST', body: bodyP });
    assert.equal((await out1.json()).result.ok, true);
    const saves = b.parentMessages.filter((m) => m.kind === 'saveImage');
    assert.equal(saves.length, 1);
    const savedPath = '/ws/' + saves[0].name;

    // 新建会话 → 应删除上一对话（s1）已落盘的临时图片
    const createBody = JSON.stringify({
      type: 'client-request', rpcId: 'c1', method: 'session.create', payload: { workspaceId: 'w' },
    });
    await b.window.fetch('/api/session.create', { method: 'POST', body: createBody });
    const dels = b.parentMessages.filter((m) => m.kind === 'deleteImages');
    assert.equal(dels.length, 1, '会话新建时应发起一次删除清理');
    assert.ok(Array.isArray(dels[0].paths) && dels[0].paths.includes(savedPath), '应删除上一对话落盘的临时图片 ' + savedPath);
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('模型看完即删：下一条消息只删除更早批次（保留最新批）；TTL 到期自动删除', async () => {
  const calls: { input: unknown; init: any }[] = [];
  const fakeRealFetch = async (input: unknown, init: any) => {
    calls.push({ input, init });
    let body: any = {};
    try { body = JSON.parse(init.body || '{}'); } catch {}
    // 两代线格式都要能识别含图请求（≤0.1.1 payload.content / ≥0.1.2 payload.args.request.content）
    const content = body?.payload?.args?.request?.content ?? body?.payload?.content;
    const hasImage = Array.isArray(content) && content.some((c: any) => c && c.type === 'image');
    return jsonResponse(hasImage ? REJECT_BODY : ACCEPT_BODY);
  };
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    // 本用例把 TTL 放大到 300ms（须在工厂执行前设置），既验证 TTL 自动删，又避免与断言竞态
    b.window.__dshBridgeImageTtlMs = 300;
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    const mkFile = (name: string, size: number) => ({ name, size, lastModified: 7, type: 'image/png', arrayBuffer: async () => new Uint8Array(size) });
    const sendImage = async (rpcId: string, name: string, data: string) => {
      const body = JSON.stringify({
        type: 'client-request', rpcId, method: 'session.prompt',
        payload: { sessionId: 's9', content: [{ type: 'image', name, data }] },
      });
      const out = await b.window.fetch('/api/prompt', { method: 'POST', body });
      assert.equal((await out.json()).result.ok, true);
      const saves = b.parentMessages.filter((m) => m.kind === 'saveImage');
      return '/ws/' + saves[saves.length - 1].name;
    };
    // 批 1
    b.emitDoc('change', { target: { files: [mkFile('m1.png', 3)] } });
    await new Promise((r) => setTimeout(r, 20));
    const p1 = await sendImage('q1', 'm1.png', 'x');
    // 批 2
    b.emitDoc('change', { target: { files: [mkFile('m2.png', 4)] } });
    await new Promise((r) => setTimeout(r, 20));
    const p2 = await sendImage('q2', 'm2.png', 'y');
    // 消息 3（纯文本）→ 删除更早批次（批 1），保留最新批（批 2）：
    // DSH ≥0.1.2 的 queue 模式允许模型仍在跑时继续发消息，最新批可能仍在被读取
    const body3 = JSON.stringify({
      type: 'client-request', rpcId: 'q3', method: 'session.prompt',
      payload: { sessionId: 's9', content: [{ type: 'text', text: '继续' }] },
    });
    await b.window.fetch('/api/prompt', { method: 'POST', body: body3 });
    const dels = b.parentMessages.filter((m) => m.kind === 'deleteImages');
    assert.ok(dels.some((d) => d.paths.includes(p1)), '更早批次应被删除 ' + p1);
    assert.ok(!dels.some((d) => d.paths.includes(p2)), '最新批必须保留（可能仍在被模型读取）' + p2);
    // TTL（300ms）到期 → 最新批自动删除
    await new Promise((r) => setTimeout(r, 700));
    assert.ok(
      b.parentMessages.some((m) => m.kind === 'deleteImages' && m.paths.includes(p2)),
      'TTL 到期应自动删除最新批 ' + p2,
    );
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('DSH ≥0.1.2 线格式全链路：payload.args.request.content + session/attachment-invalid 拒绝码 → 落盘并重发（新格式）', async () => {
  const calls: { input: unknown; init: any }[] = [];
  const MODERN_REJECT = {
    type: 'server-response',
    rpcId: 'orig-1',
    result: {
      ok: false,
      error: {
        code: 'session/attachment-invalid',
        message: 'Model "x" does not support image input.',
        details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
      },
    },
  };
  const fakeRealFetch = async (input: unknown, init: any) => {
    calls.push({ input, init });
    let body: any = {};
    try { body = JSON.parse(init.body || '{}'); } catch {}
    const content = body?.payload?.args?.request?.content;
    const hasImage = Array.isArray(content) && content.some((c: any) => c && c.type === 'image');
    return jsonResponse(hasImage ? MODERN_REJECT : { type: 'server-response', rpcId: 'x', result: { ok: true, value: { accepted: true } } });
  };
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    const imgB64 = Buffer.from([9, 8, 7]).toString('base64');
    b.emitDoc('change', {
      target: { files: [{ name: 'modern.png', size: 3, lastModified: 11, type: 'image/png', arrayBuffer: async () => new Uint8Array([9, 8, 7]) }] },
    });
    await new Promise((r) => setTimeout(r, 20));
    // 0.1.2 请求：斜杠端点 + payload.args.request
    const promptBody = JSON.stringify({
      type: 'client-request', rpcId: 'modern-1', method: 'session/prompt',
      payload: { args: { request: {
        requestId: 'req-1', sessionId: 's-modern', mode: 'queue',
        content: [{ type: 'image', mediaType: 'image/png', data: imgB64, name: 'modern.png' }, { type: 'text', text: '看看这张' }],
      } } },
    });
    const out = await b.window.fetch('/api/session/prompt', { method: 'POST', body: promptBody });
    const json = await out.json();
    assert.equal(json.result.ok, true, '应返回重发成功响应（DSH 视为发送成功）');
    assert.equal(json.rpcId, 'modern-1', '响应 rpcId 应改写回原请求');
    assert.equal(calls.length, 2, '应触发一次重发');
    // 落盘：内容应为捕获到的图片字节
    const saves = b.parentMessages.filter((m) => m.kind === 'saveImage');
    assert.equal(saves.length, 1, '0.1.2 格式的图片应被落盘');
    assert.equal(saves[0].dataB64, imgB64, '落盘内容应为本条消息的图片字节');
    // 重发体：仍是斜杠端点 + args.request，content 替换为纯文本（含图片路径），其余字段保留
    const resent = JSON.parse(calls[1].init.body);
    assert.equal(resent.method, 'session/prompt', '重发必须保留 0.1.2 的斜杠端点');
    assert.equal(resent.payload.args.request.sessionId, 's-modern', '业务字段应保留');
    assert.equal(resent.payload.args.request.requestId, 'req-1', 'requestId 必须保留（DSH 靠它观测 echo）');
    assert.equal(resent.payload.args.request.mode, 'queue');
    assert.equal(resent.payload.args.request.content.length, 1);
    assert.equal(resent.payload.args.request.content[0].type, 'text');
    assert.ok(resent.payload.args.request.content[0].text.includes('/ws/'), '重发文本应包含落盘路径');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('Critical 回归：视觉成功路径消费缓存后，同名新图不会被旧缓存顶替（静默发错图）', async () => {
  const calls: { input: unknown; init: any }[] = [];
  const fakeRealFetch = async (input: unknown, init: any) => {
    calls.push({ input, init });
    let body: any = {};
    try { body = JSON.parse(init.body || '{}'); } catch {}
    const content = body?.payload?.content ?? body?.payload?.args?.request?.content;
    const hasImage = Array.isArray(content) && content.some((c: any) => c && c.type === 'image');
    // 第一条（视觉模型）：成功；第二条（切到非视觉模型）：拒绝
    return jsonResponse(hasImage && calls.length > 1 ? REJECT_BODY : ACCEPT_BODY);
  };
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    const OLD = Buffer.from([1, 1, 1]).toString('base64');
    const NEW = Buffer.from([2, 2, 2, 2]).toString('base64');
    // 第一次上传 dup.png（旧内容）→ 视觉模型成功 → 缓存应被消费
    b.emitDoc('change', {
      target: { files: [{ name: 'dup.png', size: 3, lastModified: 1, type: 'image/png', arrayBuffer: async () => new Uint8Array([1, 1, 1]) }] },
    });
    await new Promise((r) => setTimeout(r, 20));
    const first = JSON.stringify({
      type: 'client-request', rpcId: 'd1', method: 'session.prompt',
      payload: { sessionId: 's-dup', content: [{ type: 'image', name: 'dup.png', data: OLD }] },
    });
    assert.equal((await (await b.window.fetch('/api/prompt', { method: 'POST', body: first })).json()).result.ok, true);
    // 第二次上传同名 dup.png（新内容，size 不同）→ 非视觉模型被拒 → 落盘内容必须是「新内容」
    b.emitDoc('change', {
      target: { files: [{ name: 'dup.png', size: 4, lastModified: 2, type: 'image/png', arrayBuffer: async () => new Uint8Array([2, 2, 2, 2]) }] },
    });
    await new Promise((r) => setTimeout(r, 20));
    const second = JSON.stringify({
      type: 'client-request', rpcId: 'd2', method: 'session.prompt',
      payload: { sessionId: 's-dup', content: [{ type: 'image', name: 'dup.png', data: NEW }] },
    });
    const out2 = await b.window.fetch('/api/prompt', { method: 'POST', body: second });
    assert.equal((await out2.json()).result.ok, true, '第二次应走降级重发');
    const saves = b.parentMessages.filter((m) => m.kind === 'saveImage');
    assert.equal(saves.length, 1, '只应落盘一次（第二次的新图）');
    assert.equal(saves[0].dataB64, NEW, '必须落盘新图片字节，绝不能命中同名旧缓存（静默发错图）');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('issue #6：Cmd+Z 撤销 / Cmd+Shift+Z 重做（原生 execCommand 失效时用手动栈兜底）', async () => {
  const fakeRealFetch = async (_input: unknown, _init: any) => jsonResponse(ACCEPT_BODY);
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });

    // 假输入框（React 受控 textarea 的简化）：值存 _v，由桥接的 value setter 写入
    const ta: any = {
      tagName: 'TEXTAREA',
      _v: '',
      isContentEditable: false,
      isConnected: true,
      selectionStart: 0,
      selectionEnd: 0,
      setSelectionRange() {},
      dispatchEvent() {},
    };
    Object.defineProperty(ta, 'value', {
      get() { return this._v; },
      set(v: string) { this._v = v; },
    });
    b.document.activeElement = ta;

    // 模拟输入两段文本（第二段与第一段间隔 > 归组窗口，产生两条撤销记录）。
    // 时序对齐真实浏览器：beforeinput 在改动前触发（此时 value 还是旧值），随后再应用改动。
    const type = (text: string) => {
      b.emitDoc('beforeinput', { target: ta }); // 改动前：此时 _v 为旧值，记录撤销点
      ta._v = text;                             // 应用改动
      b.emitDoc('input', { target: ta });       // 改动后：更新 last
    };
    type('hello');
    await new Promise((r) => setTimeout(r, 600)); // 超过 400ms 归组窗口
    type('hello world');

    const keydown = (k: any) => b.windowListeners.get('keydown')?.forEach((fn) => fn(k));

    // Cmd+Z：原生 execCommand('undo') 返回 false → 手动栈撤销一步 → hello
    keydown({ key: 'z', metaKey: true, ctrlKey: false, shiftKey: false, preventDefault() {}, stopPropagation() {} });
    assert.equal(ta._v, 'hello', '第一次撤销应回到 hello');
    // 再 Cmd+Z：回到输入前空串
    keydown({ key: 'z', metaKey: true, ctrlKey: false, shiftKey: false, preventDefault() {}, stopPropagation() {} });
    assert.equal(ta._v, '', '第二次撤销应回到输入前空串');
    // Cmd+Shift+Z：重做一步 → hello
    keydown({ key: 'z', metaKey: true, ctrlKey: false, shiftKey: true, preventDefault() {}, stopPropagation() {} });
    assert.equal(ta._v, 'hello', '重做应恢复 hello');
    // 重做第二段 → hello world
    keydown({ key: 'z', metaKey: true, ctrlKey: false, shiftKey: true, preventDefault() {}, stopPropagation() {} });
    assert.equal(ta._v, 'hello world', '再次重做应恢复 hello world');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

// ——— v0.4.3：「本轮文件改动」在 VS Code 中打开 Diff（真实产物 + DOM 桩端到端） ———

/**
 * 构造 DSH「本轮文件改动」卡片的 DOM 桩，形状按 DSH 0.2.0-rc.1 的真实产物：
 *   <div data-conversation-session="s-1">
 *     <div data-changed-files>
 *       <button aria-describedby=":r1:-0">   ← 行按钮（index 从后缀解析）
 *       <span id=":r1:-0" hidden>/ws/src/a.ts</span>  ← 绝对路径
 *       <button aria-expanded="false">       ← 展开/收起（必须排除）
 *   parent.closest('[data-changed-files]') / card.querySelectorAll('[aria-describedby]')
 *   / card.querySelector('[id="…"]') 都要按真实语义工作。
 */
function changedFilesCard(opts: {
  sessionId: string;
  /** 相对路径列表（摘要里的 path），用于生成绝对路径与 hidden span */
  relPaths: string[];
  /** 行按钮的 aria-describedby 后缀是否带 index（多文件卡片为 true） */
  indexedAria?: boolean;
}) {
  const abs = (rel: string) => '/ws/' + rel;
  const idxOf = (i: number) => (opts.indexedAria === false ? '' : `-${i}`);
  const spans = new Map<string, any>();
  const rows: any[] = [];
  opts.relPaths.forEach((rel, i) => {
    const described = `:r1:${idxOf(i)}`;
    const span = { textContent: abs(rel), getAttribute: () => null };
    spans.set(`${described}`, span);
    rows.push({
      described,
      attrs: { 'aria-describedby': described },
    });
  });
  const toggle = { attrs: { 'aria-expanded': 'false' } };
  return {
    abs,
    toggle,
    rows,
    build() {
      const card: any = {
        closest(sel: string) { return sel === '[data-changed-files]' ? card : null; },
        querySelectorAll(sel: string) {
          if (sel !== '[aria-describedby]') return [];
          return rows.map((r) => ({
            getAttribute: (n: string) => (n === 'aria-describedby' ? r.described : null),
          }));
        },
        querySelector(sel: string) {
          const m = /^\[id="(.*)"\]$/.exec(sel);
          if (!m) return null;
          return spans.get(m[1]!) ?? null;
        },
      };
      return card;
    },
  };
}

/** 把「命中卡片 / 命中行按钮 / 命中展开控件」三类元素接到统一的 click 事件上 */
function clickBridge(b: {
  emitDoc: (t: string, e: unknown) => void;
  documentStub?: unknown;
}, target: any, extra: Record<string, unknown> = {}) {
  const ev = {
    target,
    preventDefault() { (ev as any).prevented = true; },
    stopPropagation() { (ev as any).stopped = true; },
    ...extra,
  };
  b.emitDoc('click', ev);
  return ev as any;
}

test('v0.4.3：点击改动卡片行按钮 → 现取 diff 并转发 openDiff（坐标由旁路观测得到）', async () => {
  const card = changedFilesCard({ sessionId: 's-1', relPaths: ['src/a.ts'] });
  const cardEl = card.build();
  const rowBtn: any = {
    attrs: { 'aria-describedby': ':r1:-0' },
    closest: (sel: string) => (sel === 'button' ? rowBtn : sel === '[data-changed-files]' ? cardEl : null),
    getAttribute(name: string) { return (rowBtn.attrs as any)[name] ?? null; },
    matches: () => false,
  };
  const sessionRoot = {
    closest: (sel: string) =>
      sel === '[data-conversation-session]'
        ? { getAttribute: () => 's-1' }
        : sel === '[data-sidebar-right-session]'
          ? null
          : null,
  };
  // 行按钮自身兼作「会话根」查找入口：closest 需同时支持两种选择器
  rowBtn.closest = (sel: string) => {
    if (sel === 'button') return rowBtn;
    if (sel === '[data-changed-files]') return cardEl;
    if (sel === '[data-conversation-session]' || sel === '[data-sidebar-right-session]') return sessionRoot.closest(sel);
    return null;
  };
  rowBtn.getAttribute = (name: string) => {
    if (name === 'aria-describedby') return ':r1:-0';
    return null;
  };
  // 卡片自身也要能回答 findSessionId（它从被点元素向上找会话根）
  cardEl.closest = (sel: string) => (sel === '[data-changed-files]' ? cardEl : sessionRoot.closest(sel));

  const asked: string[] = [];
  const DIFF = {
    kind: 'text', path: 'src/a.ts', display: 'src/a.ts',
    before: true, after: true,
    hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-old', '+new'] }],
  };
  const fakeRealFetch = async (input: unknown, _init: any) => {
    const url = typeof input === 'string' ? input : (input as any)?.href ?? '';
    asked.push(url);
    if (url.includes('changes.summary')) {
      return jsonResponse({ turn: 1, files: [{ path: 'src/a.ts', display: 'src/a.ts', added: 1, deleted: 1 }], total: 1, added: 1, deleted: 1 });
    }
    if (url.includes('changes.diff')) return jsonResponse(DIFF);
    return jsonResponse(ACCEPT_BODY);
  };

  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    b.parentMessages.length = 0; // 丢掉握手回执

    // 模拟 DSH 渲染卡片时主动拉取 summary（真实行为：卡片渲染即取 summary）
    await b.window.fetch('api/changes.summary?sessionId=s-1&seq=5');
    // 等旁路观测的克隆体解析入缓存
    await new Promise((r) => setTimeout(r, 30));

    const ev = clickBridge(b, rowBtn);
    assert.equal(ev.prevented, true, '应接管点击，避免打开 DSH 自己的 review 视图');
    // 按需取数后转发（异步）
    await new Promise((r) => setTimeout(r, 60));

    const openDiffs = b.parentMessages.filter((m) => m.kind === 'openDiff');
    assert.equal(openDiffs.length, 1, `应转发一条 openDiff，实际 ${JSON.stringify(b.parentMessages)}`);
    assert.equal(openDiffs[0].path, 'src/a.ts');
    assert.deepEqual(openDiffs[0].diff, DIFF, '应转发服务端权威 diff（hunks）');
    assert.ok(asked.some((u) => u.includes('changes.diff')), '未命中缓存时应现取 diff');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('v0.4.3：点击「展开/收起全部」控件不得被当成文件行（否则误弹 diff）', async () => {
  const cardEl: any = {
    closest(sel: string) { return sel === '[data-changed-files]' ? cardEl : null; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  const toggleBtn: any = {
    closest: (sel: string) => (sel === 'button' || sel === '[data-changed-files]' ? (sel === '[data-changed-files]' ? cardEl : toggleBtn) : null),
    getAttribute: () => null,
    matches: (sel: string) => sel === '[aria-expanded]',
  };
  const fakeRealFetch = async () => jsonResponse(ACCEPT_BODY);
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    b.parentMessages.length = 0;
    await b.window.fetch('api/changes.summary?sessionId=s-1&seq=5');
    await new Promise((r) => setTimeout(r, 30));

    const ev = clickBridge(b, toggleBtn);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(!!ev.prevented, false, '展开控件不应被接管（交给 DSH 原生展开逻辑）');
    assert.equal(b.parentMessages.filter((m) => m.kind === 'openDiff').length, 0, '不应弹 diff');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('v0.4.3：点旧卡片（同一文件多轮都改过）→ 用轮次号取那一轮，绝不显示最新一轮的 diff', async () => {
  // 复现 F2：三轮都只改了 src/a.ts。旧逻辑按「路径指纹 + 取最新 seq」必中第 3 轮，
  // 于是点第 1 轮的卡片会显示第 3 轮的 diff。现在必须以 data-turn-tail 消歧。
  const DIFF1 = {
    kind: 'text', path: 'src/a.ts', display: 'src/a.ts', before: true, after: true,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-v1', '+v2'] }],
  };
  const DIFF3 = {
    kind: 'text', path: 'src/a.ts', display: 'src/a.ts', before: true, after: true,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-v3', '+v4'] }],
  };
  const turnHost = { getAttribute: (n: string) => (n === 'data-turn-tail' ? '1' : null) };
  const cardEl: any = {
    closest(sel: string) {
      if (sel === '[data-changed-files]') return cardEl;
      if (sel === '[data-turn-tail]') return turnHost; // 点的是第 1 轮的卡片
      return null;
    },
    querySelectorAll(sel: string) {
      if (sel !== '[aria-describedby]') return [];
      return [{ getAttribute: (n: string) => (n === 'aria-describedby' ? ':r1:-0' : null) }];
    },
    querySelector(sel: string) {
      const m = /^\[id="(.*)"\]$/.exec(sel);
      if (!m) {
        // 新实现按 [id] 遍历，不再拼属性选择器
        return null;
      }
      return m[1] === ':r1:-0' ? { textContent: '/ws/src/a.ts' } : null;
    },
  };
  const rowBtn: any = {
    closest(sel: string) {
      if (sel === 'button') return rowBtn;
      if (sel === '[data-changed-files]') return cardEl;
      if (sel === '[data-turn-tail]') return turnHost;
      if (sel === '[data-conversation-session]') return { getAttribute: () => 's-1' };
      if (sel === '[data-sidebar-right-session]') return null;
      return null;
    },
    getAttribute: (n: string) => (n === 'aria-describedby' ? ':r1:-0' : null),
    matches: () => false,
    querySelectorAll: () => [], // 供 cardPathsOf 之外的分支（本分支不需要）
  };
  // cardPathsOf 走 querySelectorAll("[id]") —— 补上真实语义
  const idSpan = { getAttribute: (n: string) => (n === 'id' ? ':r1:-0' : null), textContent: '/ws/src/a.ts' };
  cardEl.querySelectorAll = (sel: string) => {
    if (sel === '[id]') return [idSpan];
    if (sel === '[aria-describedby]') return [{ getAttribute: () => ':r1:-0' }];
    return [];
  };
  // 卡片自身也要能回答 findSessionId（它从被点元素向上找会话根）
  const sessionHost = { getAttribute: () => 's-1' };
  cardEl.closest = (sel: string) => {
    if (sel === '[data-changed-files]') return cardEl;
    if (sel === '[data-turn-tail]') return turnHost;
    if (sel === '[data-conversation-session]') return sessionHost;
    return null;
  };

  const asked: string[] = [];
  const fakeRealFetch = async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as any)?.href ?? '';
    asked.push(url);
    if (url.includes('changes.summary')) {
      // 同一文件的三轮：seq 10/20/30，turn 1/2/3
      const seq = Number(/seq=(\d+)/.exec(url)?.[1] ?? '0');
      const turn = seq === 10 ? 1 : seq === 20 ? 2 : 3;
      return jsonResponse({ turn, files: [{ path: 'src/a.ts', display: 'src/a.ts', added: 1, deleted: 1 }], total: 1, added: 1, deleted: 1 });
    }
    if (url.includes('changes.diff')) {
      // 按 seq 返回那一轮的 diff
      return jsonResponse(url.includes('seq=10') ? DIFF1 : DIFF3);
    }
    return jsonResponse(ACCEPT_BODY);
  };

  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    b.parentMessages.length = 0;
    // 三轮 summary 都已被 DSH 拉取过（真实场景：用户往上翻过历史）
    for (const seq of [10, 20, 30]) {
      await b.window.fetch(`api/changes.summary?sessionId=s-1&seq=${seq}`);
    }
    await new Promise((r) => setTimeout(r, 30));

    clickBridge(b, rowBtn);
    await new Promise((r) => setTimeout(r, 60));

    const openDiffs = b.parentMessages.filter((m) => m.kind === 'openDiff');
    assert.equal(openDiffs.length, 1, `应转发一条 openDiff，实际 ${JSON.stringify(b.parentMessages)}`);
    assert.deepEqual(openDiffs[0].diff, DIFF1, '必须显示第 1 轮的 diff，而不是最新一轮');
    assert.ok(asked.some((u) => u.includes('changes.diff') && u.includes('seq=10')), `应取第 1 轮的 diff，实际请求：${asked.join(', ')}`);
    // 注意：预取三轮 summary 时本就会请求 seq=30 的 **summary**；
    // 这里要断言的是**不得为第 3 轮取 diff**。
    assert.ok(
      !asked.some((u) => u.includes('changes.diff') && u.includes('seq=30')),
      '不得误取第 3 轮的 diff',
    );
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('v0.4.3：同一文件连点两次 → 只弹一个 diff（in-flight 去重，不重复动作）', async () => {
  const card = changedFilesCard({ sessionId: 's-1', relPaths: ['src/a.ts'] });
  const cardEl = card.build();
  const rowBtn: any = {
    closest(sel: string) {
      if (sel === 'button') return rowBtn;
      if (sel === '[data-changed-files]') return cardEl;
      if (sel === '[data-conversation-session]') return { getAttribute: () => 's-1' };
      return null;
    },
    getAttribute: (n: string) => (n === 'aria-describedby' ? ':r1:-0' : null),
    matches: () => false,
  };
  cardEl.closest = (sel: string) => (sel === '[data-changed-files]' ? cardEl : sel === '[data-conversation-session]' ? { getAttribute: () => 's-1' } : null);

  const DIFF = {
    kind: 'text', path: 'src/a.ts', display: 'src/a.ts', before: true, after: true,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
  };
  let diffCalls = 0;
  const fakeRealFetch = async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as any)?.href ?? '';
    if (url.includes('changes.summary')) {
      return jsonResponse({ turn: 1, files: [{ path: 'src/a.ts', display: 'src/a.ts', added: 1, deleted: 1 }], total: 1, added: 1, deleted: 1 });
    }
    if (url.includes('changes.diff')) {
      diffCalls += 1;
      // 故意延迟，制造「第一次还没回来就点了第二次」的窗口
      await new Promise((r) => setTimeout(r, 40));
      return jsonResponse(DIFF);
    }
    return jsonResponse(ACCEPT_BODY);
  };

  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    b.parentMessages.length = 0;
    await b.window.fetch('api/changes.summary?sessionId=s-1&seq=5');
    await new Promise((r) => setTimeout(r, 30));

    // 连点两次（第二次在第一次 fetch 完成之前）
    clickBridge(b, rowBtn);
    clickBridge(b, rowBtn);
    await new Promise((r) => setTimeout(r, 120));

    const openDiffs = b.parentMessages.filter((m) => m.kind === 'openDiff');
    assert.equal(openDiffs.length, 1, `连点不应弹多个 diff，实际 ${openDiffs.length} 个`);
    assert.equal(diffCalls, 1, `不应重复发起取数，实际 ${diffCalls} 次`);
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('v0.4.3：点击普通文件入口（非改动卡片）→ 转发 openFile 且携带当前会话 cwd', async () => {
  const CWD = 'G:\\projA';
  const fileBtn: any = {
    title: 'docs/readme.md',
    // 真实 closest 接受「选择器列表」（逗号分隔），需按子串匹配 fileMention 那一支
    closest: (sel: string) => {
      if (sel.includes('fileMention')) return fileBtn;
      if (sel === '[data-changed-files]') return null;
      if (sel === '[data-conversation-session]') return { getAttribute: () => 's-A' };
      return null;
    },
    getAttribute(name: string) { return name === 'title' ? fileBtn.title : null; },
    matches: () => false,
  };
  const fakeRealFetch = async () => jsonResponse(ACCEPT_BODY);
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    // 先 apply 并注入 cordis 上下文（提供 sessions 服务 → 会话 cwd）
    const app = b.apply();
    const fakeCtx = {
      get: (name: string) =>
        name === 'sessions'
          ? { list: { getSnapshot: () => ({ ids: ['s-A'], byId: { 's-A': { id: 's-A', cwd: CWD } } }) } }
          : undefined,
    };
    app.apply(fakeCtx);
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    b.parentMessages.length = 0;

    clickBridge(b, fileBtn);
    const opens = b.parentMessages.filter((m) => m.kind === 'openFile');
    assert.equal(opens.length, 1, `应转发一条 openFile，实际 ${JSON.stringify(b.parentMessages)}`);
    assert.equal(opens[0].path, 'docs/readme.md');
    // 关键：必须带上「当前 DSH 会话的工作区」，而不是让扩展退回 VS Code 工作区根
    assert.equal(opens[0].cwd, CWD, '相对路径应按当前 DSH 会话工作区解析');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});
