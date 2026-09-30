// test/vscode-stub.ts — 测试专用的 vscode 运行时桩
// 测试环境（node --test）没有 VS Code 宿主，被单测间接引用的模块（config.ts、
// panel/provider.ts 等）顶层 `import * as vscode` 需要在本模块作用域内解析。
// 这里只提供最小可用对象：接口形状以"被引用的那几个模块实际读到的成员"为准
// （v0.4.2 撤回 PR #11 后仍需 env/window/commands/Uri，因为 provider 会读它们）。
export const workspace = {
  getConfiguration: () => ({
    get: () => undefined,
  }),
  // v0.4.3：Diff 旧侧内存文档提供者的注册点（单测里只返回可释放句柄）
  registerTextDocumentContentProvider: (_scheme: string, _provider: unknown) => ({ dispose: () => {} }),
};

export const window = {
  showTextDocument: async () => undefined,
  showWarningMessage: () => undefined,
};

export const env = {
  // 远程分类（classifyRemote）读它：undefined 视为本地窗口
  remoteName: undefined,
  openExternal: async () => true,
  clipboard: {
    writeText: async () => undefined,
    readText: async () => '',
  },
};

export const commands = {
  executeCommand: async () => undefined,
};

/**
 * 极简 Uri 桩：只需支持 diff-doc 用到的 `Uri.from({scheme, path})`
 * 以及已被引用的 `file` / `parse`。不实现 VS Code 的完整编码规则，
 * 但保证被读到的 `scheme` / `path` / `toString()` 语义正确。
 */
export const Uri = {
  file: (p: string) => ({
    fsPath: p,
    scheme: 'file',
    path: p,
    toString: () => 'file://' + p,
  }),
  parse: (s: string) => ({ scheme: '', path: s, fsPath: s, toString: () => s }),
  from: (parts: { scheme: string; path: string }) => ({
    scheme: parts.scheme,
    path: parts.path,
    fsPath: parts.path,
    toString: () => `${parts.scheme}:${parts.path}`,
  }),
};

/** 最小 EventEmitter：只需 event 与 dispose（内存文档内容存好后不再变化） */
export class EventEmitter<T> {
  private readonly listeners = new Set<(e: T) => void>();
  readonly event = (listener: (e: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T): void {
    for (const l of this.listeners) l(value);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export default { workspace, window, env, commands, Uri, EventEmitter };
