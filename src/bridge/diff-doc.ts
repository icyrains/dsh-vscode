// src/bridge/diff-doc.ts — 为「本轮文件改动」Diff 的旧侧提供**内存内**文档内容
//
// 为什么不用临时文件：
//  1) 用户的工作区多是 Perforce / SVN 工作副本（本机装了 P4VFS、TortoiseSVN、svn-scm）。
//     往源码目录旁落 `dsh-diff-before-*` 会被版本控制视为「未纳管新文件」，
//     污染 `svn status` / P4 变更列表，甚至有被误提交的风险；
//  2) 打开后立刻 unlink，文件监视器可能让 diff 视图退化成「文件已删除」。
// 因此改用 VS Code 官方推荐做法：自定义 scheme + TextDocumentContentProvider，
// 旧侧内容只存在于内存中，不落任何文件（git 扩展的 gitfs 也是这个套路）。
import * as vscode from 'vscode';

/** 旧侧文档的 scheme（与真实文件路径不会冲突） */
export const DIFF_BEFORE_SCHEME = 'dsh-diff-before';

/** 保留的旧侧文档数上限（超过后按加入顺序淘汰最旧的） */
const MAX_ENTRIES = 200;

/** 保留的旧侧文本总字节上限（防止大文件把内存撑起来），64 MiB */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * 旧侧文本的内存仓库，同时充当该 scheme 的 TextDocumentContentProvider。
 *
 * 生命周期：随扩展激活创建、随扩展停用释放；条目按「条数 + 总字节」双上限淘汰，
 * 因此长时间使用也不会无界增长。
 */
export class DiffDocStore implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly docs = new Map<string, string>();
  /** 淘汰顺序（先加入的在前）；Map 的插入序可直接用，这里显式维护以便按字节淘汰 */
  private order: string[] = [];
  private totalBytes = 0;
  private seq = 0;
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  /** 内容不会在存好之后变化，因此实际上永不触发；保留以满足接口 */
  readonly onDidChange = this.emitter.event;

  /**
   * 存入一份旧侧文本。
   * @param text 旧侧全文
   * @param baseName 目标文件名（仅用于让 diff 标题/语言模式识别扩展名）
   * @returns 指向该内存文档的 URI
   */
  put(text: string, baseName: string): vscode.Uri {
    this.seq += 1;
    const key = `b${this.seq}`;
    this.docs.set(key, text);
    this.order.push(key);
    this.totalBytes += Buffer.byteLength(text, 'utf8');
    this.evict();
    // path 首段为 key，其余为文件名：provideTextDocumentContent 只读首段取内容，
    // 文件名部分只影响 VS Code 的语言模式推断（从而保留语法高亮）。
    const safeName = baseName === '' ? 'before' : baseName;
    return vscode.Uri.from({ scheme: DIFF_BEFORE_SCHEME, path: `/${key}/${safeName}` });
  }

  /** 按「条数 + 总字节」上限淘汰最旧的条目 */
  private evict(): void {
    while (this.order.length > MAX_ENTRIES || (this.totalBytes > MAX_TOTAL_BYTES && this.order.length > 1)) {
      const oldest = this.order.shift();
      if (oldest === undefined) break;
      const text = this.docs.get(oldest);
      if (text !== undefined) this.totalBytes -= Buffer.byteLength(text, 'utf8');
      this.docs.delete(oldest);
    }
  }

  /** 从 URI 取回旧侧文本；已被淘汰或格式不符时返回空串（不抛） */
  provideTextDocumentContent(uri: vscode.Uri): string {
    const key = this.keyOf(uri);
    return key === '' ? '' : this.docs.get(key) ?? '';
  }

  /** 取 URI path 的首段作为 key */
  private keyOf(uri: vscode.Uri): string {
    const parts = String(uri.path).split('/').filter((s) => s !== '');
    return parts.length === 0 ? '' : parts[0] as string;
  }

  /** 当前保留的条目数（诊断/测试用） */
  get size(): number {
    return this.docs.size;
  }

  dispose(): void {
    this.docs.clear();
    this.order = [];
    this.totalBytes = 0;
    this.emitter.dispose();
  }
}

/**
 * 在扩展激活时注册旧侧文档提供者。
 * @param disposables 扩展的 subscriptions（提供者随扩展停用一并释放）
 * @returns 供桥接使用的仓库实例
 */
export function registerDiffDocProvider(disposables: vscode.Disposable[]): DiffDocStore {
  const store = new DiffDocStore();
  disposables.push(store, vscode.workspace.registerTextDocumentContentProvider(DIFF_BEFORE_SCHEME, store));
  return store;
}

/**
 * 取一个路径的文件名（用于给内存旧侧文档一个带扩展名的名字，保留语法高亮）。
 * 只做纯字符串切分，避免依赖 node:path 的平台差异。
 * @param p 文件路径（任意平台的绝对/相对路径）
 */
export function basenameOf(p: string): string {
  const at = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return at < 0 ? p : p.slice(at + 1);
}

/**
 * 旧侧文档的展示名：`<文件名>（本轮改动前）`。
 * 让用户在 diff 标题与标签页上直接看出左侧是「改动前的快照」而非磁盘文件。
 * @param baseName 目标文件名
 */
export function beforeDocLabel(baseName: string): string {
  return baseName === '' ? '改动前' : `${baseName}（本轮改动前）`;
}
