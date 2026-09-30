// bridge-client/lib/client.js — DSH 页面内桥接 bundle（浏览器端，工厂注册）
// 重要说明：本文件是"模板"，工厂体内的核心逻辑占位标记会在构建时（scripts/build.mjs）
// 被 core.js 的纯逻辑内容替换，输出到 out/bridge-client/lib/client.js。
// 这样做的原因：DSH 的 client bundle 通过普通 <script> 加载，工厂的 require 只解析
// 包名 / 平台种子词，不支持相对路径 require('./core.js')；ESM import 在普通 script 中
// 同样不可用。因此把 core.js 内联进工厂，保证"生产运行的逻辑 = 单测验证的逻辑"同一份源码。
// 分工：core.js 保持纯函数、无 DOM、无 window 引用；本文件只做 DOM 事件绑定与 postMessage。
// 额外职责（Task 复制修复 v0.2.4）：VS Code 在 macOS 上会吞掉嵌套 iframe 里的
// Cmd+C / Cmd+V / Cmd+A 等标准快捷键与右键菜单（microsoft/vscode#129178 / #180234），
// 因此握手成功后由本文件捕获 keydown/contextmenu：keydown 用 document.execCommand
// 模拟标准编辑命令（复制/粘贴/剪切/全选/撤销/重做），失败时经剪贴板桥接兜底；
// contextmenu 弹出自定义右键菜单，不再依赖 VS Code 的原生菜单。
window.__ModuleLoader__.load({
  // id 必须等于 package.json 的 name（节点侧以此作为图条目 id 与 URL 路径）
  id: "dsh-vscode-bridge",
  // factory 体在 materialize 阶段执行（shell 启动时为每个插件行触发）
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    /*__CORE_INLINE__*/
    // —— 验证标记：证明本 bundle 已在页面内 materialize 并执行（供 Task 0/9 回归用） ——
    window.__dshVscodeBridgeReady = true;
    console.log("[dsh-vscode-bridge] client.js executed");
    // —— 握手状态 ——
    let bridgeToken = ""; // 父页面下发的握手 token；未握手前为空，不激活任何拦截
    // 桥接包版本（与插件版本统一，随包发布；安装器按「版本不一致或 client.js 内容不一致」强制重装）
    const BRIDGE_VERSION = "0.5.0";
    // cordis 客户端上下文（由 exports.apply 注入）：惰性解析 sessions 服务取会话 cwd。
    // 保持 undefined 直到 apply 被调用，避免误判「服务不存在」。
    let clientCtx = undefined;

    // —— 剪贴板写桥接：VS Code webview 对跨源 iframe 的 navigator.clipboard.writeText 有权限拦截 ——
    // 背景：即使 iframe 声明 allow="clipboard-write"，VS Code（Electron）仍会拒绝写入
    // （microsoft/vscode#182642），DSH 的 execCommand('copy') 回退在内嵌场景也不可靠。
    // 因此握手成功后接管 writeText：文本经父页面转发给扩展宿主，由 vscode.env.clipboard 写系统剪贴板。
    let copyRequestSeq = 0;
    const copyPending = new Map();

    function copyViaBridge(text) {
      return new Promise((resolve, reject) => {
        const requestId = "copy-" + (++copyRequestSeq) + "-" + Date.now();
        const timer = setTimeout(() => {
          copyPending.delete(requestId);
          reject(new Error("dsh-vscode-bridge copyText timeout"));
        }, 5000);
        copyPending.set(requestId, {
          resolve: (ok) => {
            clearTimeout(timer);
            if (ok) resolve(); else reject(new Error("dsh-vscode-bridge copyText failed"));
          },
        });
        parent.postMessage(buildCopyTextMessage(text, requestId), "*");
      });
    }

    function installClipboardBridge() {
      const clipboard = navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== "function") return;
      const originalWriteText = clipboard.writeText.bind(clipboard);
      const bridgedWriteText = function (text) {
        // 未握手（普通浏览器 / 桥接禁用）走原生 API；已握手走扩展宿主，绕开 VS Code 权限拦截。
        if (bridgeToken === "") return originalWriteText(text);
        return copyViaBridge(String(text));
      };
      // 先 defineProperty（可覆盖 configurable 的实例自有属性），失败再退化为直接赋值。
      try {
        Object.defineProperty(clipboard, "writeText", { configurable: true, writable: true, value: bridgedWriteText });
      } catch {
        try {
          clipboard.writeText = bridgedWriteText;
        } catch {
          // 剪贴板对象完全不可改写时放弃接管：DSH 仍会走原生 API 与其 execCommand 回退。
        }
      }
    }
    installClipboardBridge();

    // —— 剪贴板读桥接：供 Cmd+V 粘贴兜底 ——
    // VS Code 对 iframe 内的 execCommand('paste') 不一定放行，因此扩展宿主直接读系统剪贴板
    // （vscode.env.clipboard.readText 无 webview 权限限制），把文本回传后插入焦点可编辑元素。
    let readRequestSeq = 0;
    const readPending = new Map();

    function readViaBridge() {
      return new Promise((resolve, reject) => {
        const requestId = "read-" + (++readRequestSeq) + "-" + Date.now();
        const timer = setTimeout(() => {
          readPending.delete(requestId);
          reject(new Error("dsh-vscode-bridge readText timeout"));
        }, 5000);
        readPending.set(requestId, {
          resolve: (ok, text) => {
            clearTimeout(timer);
            if (ok) resolve(text); else reject(new Error("dsh-vscode-bridge readText failed"));
          },
        });
        parent.postMessage(buildReadTextMessage(requestId), "*");
      });
    }

    // —— 标准编辑命令仿真（修复 VS Code 吞掉 iframe 内 Cmd+C/V/A/X/Z 的问题） ——
    // 原理：VS Code 只在顶层 webview 转发快捷键（setIgnoreMenuShortcuts + 命令回投），
    // 嵌套 iframe 收不到命令；但 iframe 内的 keydown 事件仍可达，于是这里捕获按键后
    // 自行调用 document.execCommand 模拟（Flutter DevTools 已在同类场景验证有效），
    // 失败时再用剪贴板桥接兜底，保证复制/粘贴在 macOS 上可用。

    // 读取当前选区文本（复制/剪切及右键菜单可用性判断用）。
    // 注意：Chromium 中 textarea/input 聚焦时的选区不体现在 window.getSelection()，
    // 因此除文档选区外，还要读聚焦可编辑元素内的选区，避免复制兜底/菜单置灰失效。
    function readSelectionText() {
      let text = "";
      try {
        const sel = window.getSelection();
        text = sel && sel.rangeCount ? sel.toString() : "";
      } catch {
        text = "";
      }
      if (text) return text;
      // 文档选区为空：尝试从聚焦的 textarea/input 读其内部选区
      try {
        const el = focusedEditable();
        if (el && typeof el.value === "string" && typeof el.selectionStart === "number") {
          text = el.value.slice(el.selectionStart, el.selectionEnd);
        }
      } catch {
        text = "";
      }
      return text;
    }

    // 执行页面级编辑命令；成功返回 true，失败（不支持/被拒）返回 false
    function tryExecCommand(cmd) {
      try {
        return document.execCommand(cmd);
      } catch {
        return false;
      }
    }

    // 当前焦点是否在可编辑元素（textarea / 可输入 input / contenteditable）
    function focusedEditable() {
      const el = document.activeElement;
      return isEditableElement(el) ? el : null;
    }

    // 用原生 setter 写入可编辑元素的值并触发 input 事件（兼容 React 受控组件，
    // 直接赋值 el.value 不会让 React onChange 感知状态变化）
    function writeEditableValue(el, value) {
      const proto =
        el.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : el.tagName === "INPUT"
            ? HTMLInputElement.prototype
            : null;
      const setter = proto && Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) {
        setter.call(el, value);
      } else {
        el.value = value;
      }
      // 通知 React/原生监听器：input 事件会携带新值触发 onChange
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // 把文本插入焦点可编辑元素（粘贴/剪切的兜底写入路径）
    function insertTextIntoFocused(el, text) {
      // contenteditable 用 execCommand 插入，自动处理光标/撤销栈
      if (isEditableElement(el) && el.isContentEditable) {
        try {
          document.execCommand("insertText", false, text);
          return true;
        } catch {
          return false;
        }
      }
      // textarea / input：手动替换选区并触发 input 事件
      try {
        const next = computeInsertedValue(el.value, el.selectionStart, el.selectionEnd, text);
        writeEditableValue(el, next);
        const pos = (el.selectionStart ?? 0) + text.length;
        try {
          el.setSelectionRange(pos, pos);
        } catch {
          // 非文本型元素可能不支持 setSelectionRange，忽略
        }
        return true;
      } catch {
        return false;
      }
    }

    // —— 撤销/重做（Cmd/Ctrl+Z、Cmd+Shift+Z / Ctrl+Y） ——
    // 背景：VS Code 会吞掉 iframe 内快捷键（本桥接在 keydown 捕获阶段接管）；
    // 且 DSH 输入框为 React 受控组件，其「原生撤销栈」通常为空，document.execCommand('undo')
    // 会返回 false 且无效果（issue #6：macOS 无法 Cmd+Z 撤销）。因此握手后为每个可编辑元素
    // 维护手动撤销/重做栈：原生 execCommand 生效时优先用原生，失败时用手动栈兜底。
    const inputHistory = new Map(); // el -> { undo: string[], redo: string[], last: string, lastTs: number }
    const UNDO_GROUP_MS = 400; // 连续输入归组窗口：窗口内的输入合并为一条撤销记录
    const UNDO_MAX = 100; // 每元素撤销栈上限（防无限增长）
    let programmaticWrite = false; // 我们自己的 writeEditableValue 期间抑制输入历史跟踪

    // 跟踪可编辑元素的输入：beforeinput 在改动前触发，可拿到「改动前值」压入撤销栈
    function bindUndoTracking() {
      if (bindUndoTracking.bound) return; bindUndoTracking.bound = true;
      document.addEventListener("beforeinput", (e) => {
        if (bridgeToken === "" || programmaticWrite) return;
        const el = e.target;
        if (!isEditableElement(el) || typeof el.value !== "string") return;
        const now = Date.now();
        const rec = inputHistory.get(el);
        if (!rec) {
          // 首次输入：把「改动前值」（含空串）作为第一条撤销记录，保证能一步退回输入前
          inputHistory.set(el, { undo: [el.value], redo: [], last: el.value, lastTs: now });
          return;
        }
        if (now - rec.lastTs > UNDO_GROUP_MS) {
          rec.undo.push(rec.last);
          if (rec.undo.length > UNDO_MAX) rec.undo.shift();
          rec.redo.length = 0; // 新输入使重做历史失效
        }
        rec.lastTs = now;
      }, true);
      document.addEventListener("input", (e) => {
        if (bridgeToken === "" || programmaticWrite) return;
        const el = e.target;
        if (!isEditableElement(el) || typeof el.value !== "string") return;
        const rec = inputHistory.get(el);
        if (rec) rec.last = el.value;
        else inputHistory.set(el, { undo: [el.value], redo: [], last: el.value, lastTs: Date.now() });
      }, true);
    }

    // 清理已脱离文档的元素历史（防 Map 无限增长）
    function pruneInputHistory() {
      for (const [el] of inputHistory) {
        if (el.isConnected === false) inputHistory.delete(el);
      }
    }

    // 手动撤销：弹出撤销栈恢复值（原生 execCommand 失败时的兜底）
    function manualUndo() {
      const el = focusedEditable();
      if (!el || typeof el.value !== "string") return false;
      const rec = inputHistory.get(el);
      if (!rec || rec.undo.length === 0) return false;
      const prev = rec.undo.pop();
      rec.redo.push(el.value);
      programmaticWrite = true;
      try {
        writeEditableValue(el, prev);
      } finally {
        programmaticWrite = false;
      }
      rec.last = prev;
      pruneInputHistory();
      return true;
    }

    // 手动重做（Cmd+Shift+Z / Ctrl+Y 兜底）
    function manualRedo() {
      const el = focusedEditable();
      if (!el || typeof el.value !== "string") return false;
      const rec = inputHistory.get(el);
      if (!rec || rec.redo.length === 0) return false;
      const next = rec.redo.pop();
      rec.undo.push(el.value);
      programmaticWrite = true;
      try {
        writeEditableValue(el, next);
      } finally {
        programmaticWrite = false;
      }
      rec.last = next;
      pruneInputHistory();
      return true;
    }

    // 执行一条被仿真的编辑命令（异步，粘贴/复制兜底需要桥接往返）
    async function handleEditCommand(cmd) {
      switch (cmd) {
        case "copy": {
          // 优先 execCommand（立即且不移动选区）；失败则把选区文本经桥接写入系统剪贴板
          if (tryExecCommand("copy")) return;
          const text = readSelectionText();
          if (!text) return;
          try {
            await copyViaBridge(text);
          } catch {
            // 写剪贴板失败：静默放弃（与没有选区时按 Cmd+C 行为一致）
          }
          break;
        }
        case "cut": {
          if (tryExecCommand("cut")) return;
          const el = focusedEditable();
          if (!el) return;
          const text = readSelectionText();
          // 剪贴板内容取 textarea 选区（readSelectionText 的 window.getSelection 在
          // 输入框内可能读不到），因此优先直接从元素选区读值
          const elText =
            typeof el.value === "string" && typeof el.selectionStart === "number"
              ? el.value.slice(el.selectionStart, el.selectionEnd)
              : text;
          if (!elText) return;
          try {
            await copyViaBridge(elText);
          } catch {
            return;
          }
          // 删除选区并同步 React 状态
          insertTextIntoFocused(el, "");
          break;
        }
        case "paste": {
          // 优先 execCommand('paste')：成功后浏览器会自行派发 paste 事件，
          // DSH 的输入控件（含富文本/代码编辑器）能按原生逻辑处理
          if (tryExecCommand("paste")) return;
          // 兜底：经桥接读取系统剪贴板，手动写入焦点可编辑元素
          const el = focusedEditable();
          if (!el) return;
          let text = null;
          try {
            text = await readViaBridge();
          } catch {
            return;
          }
          if (typeof text !== "string" || text === "") return;
          insertTextIntoFocused(el, text);
          break;
        }
        case "selectAll":
          tryExecCommand("selectAll");
          break;
        case "undo":
          // 优先原生撤销（内容最完整）；React 受控输入框原生撤销栈为空时用手动栈兜底
          if (!tryExecCommand("undo")) manualUndo();
          break;
        case "redo":
          if (!tryExecCommand("redo")) manualRedo();
          break;
      }
    }

    // —— 自定义右键菜单（VS Code 不向 iframe 上层弹原生菜单，此处自绘） ——
    // 菜单样式采用中性深色（带阴影与圆角），在浅/深色主题下都清晰可辨。
    const MENU_CSS =
      "#dsh-bridge-menu{position:fixed;z-index:2147483647;min-width:160px;margin:0;padding:4px;" +
      "background:#2d2d30;color:#cccccc;border:1px solid #454545;border-radius:6px;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.35);font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "user-select:none;display:none;}" +
      "#dsh-bridge-menu button{display:block;width:100%;text-align:left;padding:5px 10px;" +
      "background:transparent;border:none;color:inherit;font:inherit;border-radius:4px;cursor:pointer;}" +
      "#dsh-bridge-menu button:hover:not(:disabled){background:#094771;color:#fff;}" +
      "#dsh-bridge-menu button:disabled{opacity:.38;cursor:default;}" +
      "#dsh-bridge-menu .dsh-bridge-sep{height:1px;background:#454545;margin:4px 8px;}" +
      "#dsh-bridge-menu .dsh-bridge-ok{color:#89d185;}" +
      "#dsh-bridge-menu button:focus{outline:none;}";
    let menuEl = null;
    let menuCopyBtn = null;
    let menuPasteBtn = null;
    let menuCutBtn = null;
    let menuUndoBtn = null;
    let menuRedoBtn = null;

    // 按当前焦点/选区状态刷新菜单项的可用性
    function updateMenuEnabled() {
      const editable = focusedEditable();
      const hasSelection = readSelectionText() !== "";
      menuCopyBtn.disabled = !hasSelection;
      menuCutBtn.disabled = !(editable && hasSelection);
      menuPasteBtn.disabled = !editable;
      menuUndoBtn.disabled = !editable;
      menuRedoBtn.disabled = !editable;
    }

    // 菜单项点击统一入口：隐藏菜单后执行对应编辑命令
    function menuAction(cmd) {
      hideMenu();
      void handleEditCommand(cmd);
    }

    // 懒创建菜单 DOM（首次右键时注入样式与按钮）
    function ensureMenu() {
      if (menuEl) return menuEl;
      const style = document.createElement("style");
      style.textContent = MENU_CSS;
      document.head.append(style);
      menuEl = document.createElement("div");
      menuEl.id = "dsh-bridge-menu";
      menuEl.setAttribute("role", "menu");
      const mkBtn = (label, cmd) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.setAttribute("role", "menuitem");
        b.addEventListener("click", () => menuAction(cmd));
        return b;
      };
      const sep = () => {
        const s = document.createElement("div");
        s.className = "dsh-bridge-sep";
        return s;
      };
      // 复制/粘贴/剪切/全选 + 撤销/重做（顺序与系统菜单惯例一致）
      menuCopyBtn = mkBtn("复制", "copy");
      menuPasteBtn = mkBtn("粘贴", "paste");
      menuCutBtn = mkBtn("剪切", "cut");
      const menuSelectAllBtn = mkBtn("全选", "selectAll");
      menuUndoBtn = mkBtn("撤销", "undo");
      menuRedoBtn = mkBtn("重做", "redo");
      menuEl.append(menuCopyBtn, menuPasteBtn, menuCutBtn, menuSelectAllBtn, sep(), menuUndoBtn, menuRedoBtn);
      document.body.append(menuEl);
      // 菜单自身点击不冒泡到"关闭菜单"的全局监听
      menuEl.addEventListener("pointerdown", (e) => e.stopPropagation());
      return menuEl;
    }

    // 在指定视口坐标显示菜单（自动翻转避免溢出窗口）
    function showMenuAt(x, y) {
      const menu = ensureMenu();
      updateMenuEnabled();
      menu.style.display = "block";
      const rect = menu.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = x;
      let top = y;
      if (left + rect.width > vw - 4) left = Math.max(4, vw - rect.width - 4);
      if (top + rect.height > vh - 4) top = Math.max(4, top - rect.height - 8);
      menu.style.left = left + "px";
      menu.style.top = top + "px";
    }

    // 隐藏自定义右键菜单
    function hideMenu() {
      if (menuEl) menuEl.style.display = "none";
    }

    // —— DOM 拦截：外链与文件入口（markdown 文件名 / produced 芯片 / present 卡片）点击 → postMessage 转发给父页面（扩展） ——
    function bindLinkInterception() {
      document.addEventListener("click", (e) => {
        if (bridgeToken === "") return; // 未握手（普通浏览器打开）不激活
        const target = e.target;
        if (!target || typeof target.closest !== "function") return;
        // 外链：DSH 前端渲染为 <a target="_blank">，白名单校验后转发系统浏览器打开
        const anchor = target.closest("a");
        if (anchor && isAllowedExternalUrl(anchor.href)) {
          e.preventDefault();
          e.stopPropagation();
          parent.postMessage(buildOpenExternalMessage(anchor.href), "*");
          return;
        }
        // v0.4.3：先把「本轮文件改动」卡片的点击接管为「在 VS Code 中打开 Diff」。
        // 必须放在普通文件入口之前——卡片行按钮同样是文件入口，但语义是「查看改动」
        // 而非「打开文件」。任何一步取不到坐标就返回 false，落到下面的原生文件转发。
        if (tryOpenChangesDiff(target, e)) return;
        // 文件入口按钮：markdown 文件名（CSS Module 哈希类名）/ produced 芯片 / present 卡片
        // 统一走 FILE_ENTRY_SELECTOR + resolveFileEntryPath（替代原先恒不命中的
        // classList.contains('fileMention')，见 issue #22）。
        const btn = target.closest(FILE_ENTRY_SELECTOR);
        if (btn) {
          const path = resolveFileEntryPath(btn);
          if (path !== null && path !== "") {
            e.preventDefault();
            e.stopPropagation();
            // v0.4.3：携带当前 DSH 会话的工作目录作为相对路径解析基准（扩展侧优先用它，
            // 缺失时才退回 VS Code 工作区根）。会话 id 取自 DOM（快照没有 current 字段）。
            parent.postMessage(buildOpenFileMessage(path, currentSessionCwd(target)), "*");
          }
        }
      }, true); // 捕获阶段：先于 DSH 自身处理器
    }

    // —— v0.4.3：「本轮文件改动」在 VS Code 中打开 Diff ——
    // 坐标难点（源码实证）：seq 只存在于 React 闭包（`changes.seq`），DOM 里完全没有；
    // 单靠 DOM 无法构造 `/api/changes.diff` 的必需参数。
    // 因此这里旁路观察 DSH 自己发出的两个请求（本插件已 patch window.fetch 做图片降级）：
    //   · `changes.summary?sessionId&seq`  → 记下 seq，并缓存该轮的 files 列表；
    //   · `changes.diff?sessionId&seq&index` → 直接拿到服务端权威 diff（hunks）。
    // 两者都以「服务端返回的 JSON」为数据源，不依赖任何 CSS Module 哈希类名或本地化文案。
    // 有界缓存（BoundedMap）：面板长开时内存有界。
    // summary 小，按条数限即可；diff 可能是「两侧各 ≤2 MiB」量级，
    // 因此**同时**设条数与总字节上限（64 MiB），避免只按条数限时最坏占用上 GB 堆。
    const changesCache = new BoundedMap(200); // key(sessionId|seq) -> summary JSON
    const diffCache = new BoundedMap(500, jsonByteSize, 64 * 1024 * 1024); // key(sessionId|seq|index) -> diff JSON

    /** 从当前会话 id 解析其工作目录（相对路径基准）；取不到返回 undefined */
    function currentSessionCwd(el) {
      try {
        const sessionId = findSessionId(el || document.body) || lastSeenSessionId;
        if (sessionId === "") return undefined;
        const sessions = clientCtx === undefined ? undefined : clientCtx.get("sessions");
        return sessionCwdFrom(sessions && sessions.list && sessions.list.getSnapshot(), sessionId);
      } catch {
        return undefined;
      }
    }

    /**
     * 尝试把一次点击转成「在 VS Code 中打开 Diff」。
     *
     * 时序说明（关键）：summary 在卡片渲染时就被 DSH 拉取（所以点得动时它一定在缓存里），
     * 但 **diff 只在悬停预览或打开 review 标签页时才被拉取**——直接点行按钮时通常还没有。
     * 因此这里不是「查缓存」，而是「先接管点击、再按需取数」：命中缓存立即发；
     * 未命中就按服务端坐标现取，失败则退回普通「打开文件」，绝不让点击变成无响应。
     *
     * @returns true 表示已接管该点击（调用方不得再走原生文件转发）
     */
    function tryOpenChangesDiff(target, e) {
      if (bridgeToken === "") return false;
      let card;
      try {
        card = target.closest(CHANGED_FILES_CARD_SELECTOR);
      } catch {
        return false;
      }
      if (!card) return false;
      // 展开/收起全部控件也在卡片内，但它不是文件行——必须排除，
      // 否则点「展开全部 N 个文件」会被误判成点击第 0 个文件而弹出 diff。
      const btn = typeof target.closest === "function" ? target.closest("button") : null;
      const anchorEl = btn || target;
      if (isChangesToggle(anchorEl)) return false;
      const index = changedFileIndexOf(anchorEl);
      const sessionId = findSessionId(card) || lastSeenSessionId;
      if (sessionId === "") return false;
      // 同一会话可能有多轮改动：先用卡片里读到的绝对路径对齐出「同一轮」，
      // 对不上再退回最新一轮（宁可显示最新，也不要张冠李戴显示别的轮次）。
      const entry = pickChangesFor(sessionId, card);
      if (entry === null) return false;
      const file = changedFileAt(entry.summary, index);
      if (file === null) return false;

      // 坐标齐全 → 立即接管点击，避免 DSH 打开自己的 review 视图
      e.preventDefault();
      e.stopPropagation();
      const cwd = currentSessionCwd(anchorEl);
      const key = changesKey(sessionId, entry.seq) + "|" + index;
      const cached = diffCache.get(key);
      if (isWorkspaceFileDiff(cached)) {
        postOpenDiff(file, cached, cwd);
        return true;
      }
      // 同一文件在首次取数完成前被连点：直接忽略后续点击。
      // 否则每次点击都会走「缓存未命中」分支，弹出多个 VS Code diff 标签页。
      if (inFlight.has(key)) return true;
      inFlight.add(key);
      // 按需取数（不阻塞点击；用户点一次就够，无需先悬停/开 review）
      void fetchAndPostDiff(sessionId, entry.seq, index, file, cwd, key);
      return true;
    }

    /** 正在取数的 diff 键（防止连点造成重复动作） */
    const inFlight = new Set();

    /** 按服务端坐标现取 diff 并转发；任何失败都退回「打开文件」，不让点击无响应 */
    async function fetchAndPostDiff(sessionId, seq, index, file, cwd, key) {
      try {
        const res = await window.fetch(changesDiffUrl(sessionId, seq, index));
        if (!res || res.ok !== true) throw new Error("HTTP " + (res ? res.status : "no response"));
        const diff = await res.json();
        if (!isWorkspaceFileDiff(diff)) throw new Error("意外的 diff 形状");
        diffCache.set(key, diff);
        postOpenDiff(file, diff, cwd);
      } catch (err) {
        // 取数失败（会话已销毁 / binary / 网络 / 形状不符）：仍把文件打开，至少不丢用户意图
        console.warn("[dsh-vscode-bridge] 取 diff 失败，退回打开文件:", err);
        parent.postMessage(buildOpenFileMessage(file.path, cwd), "*");
      } finally {
        inFlight.delete(key);
      }
    }

    /** 转发「在 VS Code 中打开 Diff」消息 */
    function postOpenDiff(file, diff, cwd) {
      parent.postMessage(
        buildOpenDiffMessage({ path: file.path, diff, cwd, display: file.display }),
        "*",
      );
      console.log("[dsh-vscode-bridge] open diff in VS Code → " + file.path);
    }

    /** 取某会话最近一次已缓存的 changes 摘要（返回 { seq, summary } 或 null） */
    function latestChangesFor(sessionId) {
      let best = null;
      for (const [key, summary] of changesCache.entries()) {
        const at = key.indexOf("|");
        if (at <= 0 || key.slice(0, at) !== sessionId) continue;
        const seq = Number(key.slice(at + 1));
        if (!Number.isFinite(seq)) continue;
        if (best === null || seq > best.seq) best = { seq, summary };
      }
      return best;
    }

    /** 列出某会话全部已缓存的改动轮次 */
    function allChangesFor(sessionId) {
      const out = [];
      for (const [key, summary] of changesCache.entries()) {
        const at = key.indexOf("|");
        if (at <= 0 || key.slice(0, at) !== sessionId) continue;
        const seq = Number(key.slice(at + 1));
        if (Number.isFinite(seq)) out.push({ seq, summary });
      }
      return out;
    }

    /**
     * 读出某个「改动卡片」里各文件行的绝对路径（按 DOM 顺序）。
     * 实证：每行的 `aria-describedby` 指向一个 hidden span，其 textContent
     * 即 `resolveWorkspacePath(cwd, file.path)` 的绝对路径；表头（单文件卡片）
     * 的 aria-describedby 直接指向同类 hidden span。
     * 这些是稳定语义，不受 CSS Module 哈希类名影响。
     *
     * 实现刻意「按 id 属性直接比对」而不是拼 `[id="…"]` 选择器：
     * React 18 的 useId 产出形如 `:r5:`（含冒号），拼进属性选择器要靠 CSS.escape
     * 才安全，而直接遍历 `[id]` 比对字符串既无转义风险，也不依赖 CSS.escape 是否存在。
     */
    function cardPathsOf(card) {
      const paths = [];
      try {
        // 先收集卡片内所有带 id 的元素，建立 id -> 文本 的映射
        const byId = new Map();
        for (const el of card.querySelectorAll("[id]")) {
          const id = typeof el.getAttribute === "function" ? el.getAttribute("id") : null;
          if (typeof id === "string" && id !== "" && !byId.has(id)) {
            byId.set(id, typeof el.textContent === "string" ? el.textContent.trim() : "");
          }
        }
        // 再按 aria-describedby（可能是空格分隔的 id 列表）取回绝对路径
        for (const el of card.querySelectorAll("[aria-describedby]")) {
          const described = el.getAttribute("aria-describedby");
          if (typeof described !== "string" || described === "") continue;
          for (const one of described.split(/\s+/)) {
            if (one === "") continue;
            const text = byId.get(one);
            if (typeof text === "string" && text !== "" && !paths.includes(text)) paths.push(text);
          }
        }
      } catch {
        return [];
      }
      return paths;
    }

    /**
     * 选出与当前卡片同轮的 summary；**无法确定时返回 null**（由调用方退回原生行为）。
     *
     * 消歧优先级：
     *   ① 卡片所属轮次号（`[data-turn-tail]` 的 `data-turn-tail`）与服务端 summary 的
     *      `turn` 精确比对——这是**唯一可靠**的依据；
     *   ② 退而用卡片绝对路径对齐（`matchChangesSeq`）。
     *
     * 刻意**不再**「对不上就退回最新一轮」：同一文件在多轮里都被改时，各轮指纹完全相同，
     * 退回最新会把旧卡片显示成最新一轮的 diff（张冠李戴）。宁可什么都不做（保留 DSH 原生
     * 行为），也不要展示别的轮次的对比。
     */
    function pickChangesFor(sessionId, card) {
      const candidates = allChangesFor(sessionId);
      if (candidates.length === 0) return null;
      // ① 轮次号精确匹配
      const turn = findTurn(card);
      if (turn !== null) {
        const byTurn = matchChangesTurn(candidates, turn);
        if (byTurn !== null) return byTurn;
      }
      if (candidates.length === 1) return candidates[0];
      // ② 文件路径指纹；多候选择同样对齐时 matchChangesSeq 会返回 null（判为歧义）
      return matchChangesSeq(candidates, cardPathsOf(card));

    }

    // —— keydown 拦截：仿真标准编辑快捷键（VS Code 吞掉 Cmd+C/V/A/X/Z 的修复） ——
    function onKeyDown(e) {
      // Esc 仅用于收起自定义右键菜单，任何状态下都响应
      if (e.key === "Escape") {
        hideMenu();
        // 不 preventDefault：把 Esc 继续交给 DSH 页面自身处理（如关闭弹窗）
        return;
      }
      if (bridgeToken === "") return; // 未握手（普通浏览器）不干涉原生行为
      const cmd = getShortcutCommand(e);
      if (!cmd) return;
      // 捕获阶段拦截：阻止事件继续传播，避免 DSH 自身处理器或 VS Code 二次处理产生冲突
      e.preventDefault();
      e.stopPropagation();
      hideMenu();
      void handleEditCommand(cmd);
    }

    // —— contextmenu 拦截：弹出自定义右键菜单（VS Code 不向 iframe 弹原生菜单） ——
    function onContextMenu(e) {
      if (bridgeToken === "") return; // 未握手（普通浏览器）保留原生右键菜单
      e.preventDefault();
      e.stopPropagation();
      showMenuAt(e.clientX, e.clientY);
    }

    // —— 接收父页面消息：握手 + 剪贴板回执 ——
    function onParentMessage(e) {
      const d = e.data;
      if (!d || typeof d !== "object") return;
      // 握手：父页面下发 { kind: 'bridgeHello', token }，校验非空后回执 bridgeAck
      if (d.kind === "bridgeHello" && typeof d.token === "string" && d.token !== "") {
        bridgeToken = d.token;
        imageFallbackEnabled = d.imageFallback === true; // v0.3.0：非视觉模型图片降级开关（随 hello 下发）
        // 诊断日志：页面可据此确认握手成功与降级开关状态（排查“图片上传不生效”用）
        console.log("[dsh-vscode-bridge] handshake ok, v" + BRIDGE_VERSION + ", imageFallback=" + imageFallbackEnabled);
        // 附件图片捕获已由工厂期常驻绑定（bindImageCapture），此处仅刷新开关即可生效
        // 回执统一用 core.js 的 buildSyncWorkspaceAck 构造，形状与工作区同步回执一致
        // （{ kind: 'bridgeAck', ok }，不带 token 字段）；顶层 webview 靠 origin + source
        // 校验消息来源，按 { kind: 'bridgeAck', ok } 解析，避免同 kind 两种形状。
        // 回执携带桥接版本：扩展侧日志据此直接确认页面里跑的是哪个版本的桥接代码
        parent.postMessage(buildSyncWorkspaceAck(true, undefined, BRIDGE_VERSION), "*");
        return;
      }
      // 剪贴板写回执：resolve / reject 对应的 writeText Promise
      if (d.kind === "copyTextAck" && typeof d.requestId === "string" && typeof d.ok === "boolean") {
        const pending = copyPending.get(d.requestId);
        if (pending) {
          copyPending.delete(d.requestId);
          pending.resolve(d.ok);
        }
        return;
      }
      // 剪贴板读回执：resolve / reject 对应的 readText Promise
      if (d.kind === "readTextAck" && typeof d.requestId === "string" && typeof d.ok === "boolean") {
        const pending = readPending.get(d.requestId);
        if (pending) {
          readPending.delete(d.requestId);
          pending.resolve(d.ok, d.ok && typeof d.text === "string" ? d.text : "");
        }
        return;
      }
      // v0.5.0 引用插入：扩展侧右键「引用到 DSH」→ 顶层脚本投递到这里 → 插入原生引用芯片。
      // 只认合法形状（kind + requestId + 非空 entries），结果回执给扩展侧做用户提示。
      // 该消息不经 token 校验：它由扩展的自有 webview 顶层脚本按 iframe 窗口投递
      // （与 copyTextAck 等下行同一条通道），且不做任何"信任页面内容"的事——
      // 只是把文件插入用户自己的输入框，危害面与用户手动拖拽相同。
      const insertReq = parseInsertReferenceMessage(d);
      if (insertReq !== null) {
        const result = insertFileReferences(insertReq.entries);
        parent.postMessage(
          buildInsertReferenceAck(insertReq.requestId, result.ok, result.reason, result.inserted),
          "*",
        );
        return;
      }
    }


    // —— v0.3.0 图片自由上传：捕获图片字节 + 发送被拒(模型无视觉)自动降级为路径转发 ——
    // 全程仅在该标识为 true（父页面握手时随 bridgeHello 下发 dsh.image.fallback=true）时生效；
    // 未握手或降级关闭时，本段落不改变任何原生行为（与 v0.2.4 保持一致）。
    let imageFallbackEnabled = false; // 是否允许非视觉模型图片降级
    const imageCache = new Map(); // key(imageCacheKey) -> { name, b64, mime }（当前待用的捕获，用后即消费移除）
    let fallbackResendInFlight = false; // 幂等：一个被拒只触发一次重发
    let lastSeenSessionId = ""; // 最近一次对话(session) id，用于会话切换时判定上一对话终止
    let imgNameSeq = 0; // 图片文件名全局递增序号：保证同一毫秒内落盘的多批图片也不重名（防覆盖）

    // —— 临时图片「模型看完即删」生命周期 ——
    // 模型在回合内通过图像工具按路径读取文件，文件必须存活到读取完成。因此每条消息的
    // 临时图按「批次」管理：① 同会话发出下一条消息时删除**更早的批次**（保留最新一批——
    //    queue 模式下最新批可能仍在被读取，见 code review）；② 若不再发消息，TTL 兜底自动删
    //    （默认 5 分钟，测试可经 window.__dshBridgeImageTtlMs 覆盖）：模型读取通常在数秒内完成，
    //    5 分钟足以覆盖长回合，同时避免长任务期间图片被提前删除；
    // ③ 会话新建/删除/切换、页面卸载、扩展停用、手动命令等既有触发全部保留（全删）。
    const IMAGE_TTL_MS =
      typeof window.__dshBridgeImageTtlMs === "number" && window.__dshBridgeImageTtlMs > 0
        ? window.__dshBridgeImageTtlMs
        : 300000;
    const pendingBatches = []; // { paths: string[], timer }：已落盘、尚未删除的临时图批次

    // 删除一个批次：从待删表移除（幂等）、清定时器、向扩展宿主发 deleteImages 并从落盘表摘除
    function deleteBatch(batch) {
      const idx = pendingBatches.indexOf(batch);
      if (idx < 0) return;
      pendingBatches.splice(idx, 1);
      if (batch.timer) { clearTimeout(batch.timer); batch.timer = null; }
      if (batch.paths.length === 0) return;
      parent.postMessage(buildDeleteImagesRequest("imgused-" + Date.now(), batch.paths), "*");
      console.log("[dsh-vscode-bridge] image fallback: 临时图片已用完，删除 " + batch.paths.length + " 张: " + batch.paths.join(", "));
    }

    // 立即删除全部待删批次（会话结束/页面卸载/扩展停用等场景）
    function flushAllBatches(reason) {
      if (pendingBatches.length === 0) return;
      const count = pendingBatches.reduce((n, b) => n + b.paths.length, 0);
      for (const batch of [...pendingBatches]) deleteBatch(batch);
      console.log("[dsh-vscode-bridge] image fallback: " + reason + "，立即删除已用完的临时图片 " + count + " 张");
    }

    // 下一条消息发出时：只删除「更早的批次」，保留最新一批。
    // 背景（code review）：DSH ≥0.1.2 的 queue 模式允许模型仍在跑时继续发消息，若「发下一条
    // 就全删」，可能删掉模型尚未读取的图片。串行场景下最新批即上一条消息的图（多半已读完），
    // 但它同时是「可能正在被读」的那批，故一律保留，交由 TTL 兜底清理。
    function flushBatchesExceptLatest(reason) {
      if (pendingBatches.length <= 1) return;
      const latest = pendingBatches[pendingBatches.length - 1];
      const older = pendingBatches.filter((b) => b !== latest);
      const count = older.reduce((n, b) => n + b.paths.length, 0);
      for (const batch of older) deleteBatch(batch);
      console.log("[dsh-vscode-bridge] image fallback: " + reason + "，删除更早的临时图片 " + count + " 张（保留最新一批，TTL 兜底）");
    }

    // 消费本条消息匹配到的缓存条目（成功路径与降级路径共用；返回被消费的条目数组）
    function consumeCapturedImages(content) {
      const used = matchCapturedImages(content, Array.from(imageCache.entries()).map(([key, v]) => ({ key, ...v })));
      for (const entry of used) {
        if (entry && typeof entry.key === "string") imageCache.delete(entry.key);
      }
      return used;
    }

    // 对话终止（新建/删除/切换会话）→ 立即删除已落盘临时图片并清偿缓存。
    // clearCaptures=true 仅用于明确的「新建/删除会话」：此刻尚未进入新会话的输入，
    // 缓存的旧字节不会再被使用；会话切换(仅 prompt 观测)不清 imageCache，
    // 避免误删当前消息刚捕获、正要用于降级的图片。
    function handleConversationEnd(reason, clearCaptures) {
      flushAllBatches("会话" + reason);
      if (clearCaptures && imageCache.size > 0) imageCache.clear();
    }

    // 字节数组 → base64（页面内 btoa 可用；仅用于桥接通道传输，不影响 DSH 原生附件）
    function bytesToBase64(bytes) {
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }

    // —— v0.5.0：VS Code 右键「引用到 DSH」——
    //
    // 用户目标：在 VS Code 文件树/编辑器里右键「引用到 DSH」，文件立刻变成当前 DSH 会话
    // 输入框里的一个 @ 引用芯片，随后可直接打字发送——与「把文件拖进输入框」完全同效。
    //
    // 为什么走 DSH 的 cordis 服务而不是模拟键盘/粘贴：
    //   1) DSH 的 @ 引用是 Lexical 原子节点（ReferenceChipNode），不是纯文本。伪造一个
    //      等价的 chip 需要触达其内部构造，版本一变即碎；而 DSH 自己就提供了正规入口。
    //   2) `conversation.input.shell(sessionId).addFiles(references, ids)` 正是 DSH
    //      「拖拽文件进输入框」调用的同一个方法（见 ui-conversation 的 addFiles），
    //      调用它得到的芯片与原生拖拽逐字节一致，且自带撤销/粘贴/发送语义。
    //   3) 相对路径必须按「该会话的工作目录」解析（不是 VS Code 工作区根）：
    //      扩展传绝对路径，这里用 DSH 自己的相对化规则换算（buildReferenceInsertions），
    //      多根工作区/远程场景下不会指错文件。
    //
    // 服务全部惰性解析且缺一即降级为「明确失败」，绝不让桥接因缺少某个服务而整体挂掉。

    // 当前主视图会话 id：优先 uiWorkspace 的 selection（与主视图真正的驱动源一致），
    // 退回 DOM 里可见的 [data-conversation-session]。返回空串表示定不到。
    function currentSessionId() {
      let selection;
      try {
        selection = clientCtx?.get?.("uiWorkspace")?.selection?.getSnapshot?.();
      } catch {
        selection = undefined;
      }
      let domId = "";
      try {
        const el = document.querySelector(CONVERSATION_SESSION_SELECTOR);
        domId = el ? el.getAttribute("data-conversation-session") || "" : "";
      } catch {
        domId = "";
      }
      return resolveTargetSessionId(selection, domId);
    }

    // 取会话工作目录：走共享的 sessionCwdFrom（与「点相对路径打开文件」同一套取法）
    function sessionCwdOf(sessionId) {
      try {
        const sessions = clientCtx?.get?.("sessions");
        const snapshot = sessions?.list?.getSnapshot?.();
        return sessionCwdFrom(snapshot, sessionId);
      } catch {
        return undefined;
      }
    }

    // 执行一次插入：解析目标会话 → 相对化 + 生成原生引用载荷 → 调 DSH 原生 addFiles。
    // 返回 { ok, reason, inserted }；reason 为机读原因，由扩展侧翻成用户文案。
    function insertFileReferences(entries) {
      if (clientCtx === undefined) return { ok: false, reason: "no-context" };
      const sessionId = currentSessionId();
      if (sessionId === "") return { ok: false, reason: "no-session" };
      const cwd = sessionCwdOf(sessionId);
      const references = buildReferenceInsertions(entries, cwd);
      if (references.length === 0) return { ok: false, reason: "no-reference" };
      let shell;
      try {
        shell = clientCtx.get("conversation")?.input?.shell?.(sessionId);
      } catch {
        shell = undefined;
      }
      if (!shell || typeof shell.addFiles !== "function") return { ok: false, reason: "no-composer" };
      let accepted = false;
      try {
        // 第二参数是本批新分配的附件 id 列表；引用插入不涉及图片附件，传空数组即可。
        accepted = shell.addFiles(references, []) === true;
      } catch {
        return { ok: false, reason: "insert-failed" };
      }
      if (!accepted) return { ok: false, reason: "insert-refused" };
      return { ok: true, inserted: references.length };
    }

    // 附件捕获入口：图片类型 + 有指纹 + 未缓存，才把字节缓存起来
    function captureImageFile(file) {
      if (!imageFallbackEnabled) return; // 降级关闭不捕获
      if (!file || typeof file.arrayBuffer !== "function") return;
      if (typeof file.type !== "string" || !file.type.toLowerCase().startsWith("image/")) return;
      const key = imageCacheKey(file);
      if (!key || imageCache.has(key)) return; // 同指纹去重
      file.arrayBuffer()
        .then((buf) => { if (imageCache.has(key)) return; imageCache.set(key, { name: file.name, b64: bytesToBase64(new Uint8Array(buf)), mime: file.type }); })
        .catch(() => {});
    }

    // DOM 附件捕获：change(文件选择)/drop(拖拽)/paste(粘贴) 三路，捕获阶段先于 DSH 处理器
    // 注：本函数在握手成功时由 hello 分支调用（绑定一次即常驻，内部用开关过滤）
    function bindImageCapture() {
      if (bindImageCapture.bound) return; bindImageCapture.bound = true;
      document.addEventListener("change", (e) => {
        const t = e.target;
        if (t && t.files) { for (const f of Array.from(t.files)) captureImageFile(f); }
      }, true);
      document.addEventListener("drop", (e) => {
        if (e.dataTransfer && e.dataTransfer.files) { for (const f of Array.from(e.dataTransfer.files)) captureImageFile(f); }
      }, true);
      document.addEventListener("paste", (e) => {
        if (e.clipboardData && e.clipboardData.items) {
          for (const it of Array.from(e.clipboardData.items)) {
            if (it.kind === "file") { const f = it.getAsFile(); if (f) captureImageFile(f); }
          }
        }
      }, true);
    }

    // 经桥接把一张图片落盘到扩展宿主侧（工作区根），成功返回绝对路径，失败/超时返回 null
    function saveImageViaBridge(b64, name, requestId) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 5000);
        function onAck(e) {
          const parsed = parseSaveImageAck(e.data, requestId);
          if (!parsed) return;
          clearTimeout(timer);
          window.removeEventListener("message", onAck);
          resolve(parsed.ok && parsed.path ? parsed.path : null);
        }
        window.addEventListener("message", onAck);
        parent.postMessage(buildSaveImageRequest(requestId, name, b64, undefined), "*");
      });
    }

    // 图片被拒后：只把「本条消息实际包含的图片」（按消息顺序）落盘并组装
    // 「原文 + 图片一/二…：路径」内容 → 以新 rpcId 重发 → 用后从缓存消费移除。
    // 返回重发响应（调用方据此认为发送成功，DSH 不再弹"不支持图像输入"报错）；
    // 任何一步失败或无法落盘时返回 null（调用方回退原生被拒响应，绝不吞用户消息）。
    async function handlePromptImageRejected(parsed, url, init, origFetch) {
      try {
        // 两代线格式统一解包（≤0.1.1 payload.content；≥0.1.2 payload.args.request.content）
        const payload = unwrapRpcRequest(parsed);
        // 按消息内的顺序把图片块映射到已捕获缓存（匹配 name/data），只取本条消息实际用到的图片
        const used = matchCapturedImages(payload.content,
          Array.from(imageCache.entries()).map(([key, v]) => ({ key, ...v })));
        const pointerLines = [];
        const savedPaths = [];
        for (let i = 0; i < used.length; i++) {
          const entry = used[i];
          const ext = "." + (entry.mime ? entry.mime.split("/")[1].toLowerCase() : "png");
          const name = imageCacheFilename(String(Date.now()) + "-" + (imgNameSeq++), i, ext);
          if (!name) continue; // 扩展名不在白名单：跳过该张
          const p = await saveImageViaBridge(entry.b64, name, "img-" + Date.now() + "-" + i);
          if (p) { savedPaths.push(p); pointerLines.push(buildImagePointerLine(p, i + 1)); }
        }
        if (savedPaths.length === 0) {
          console.warn("[dsh-vscode-bridge] image fallback: 没有可落盘的图片缓存（未打开工作区?），保持原生报错");
          return null; // 无可用落盘：不作降级
        }
        const content = buildTextOnlyContent(payload.content, pointerLines);
        const resendBody = buildTextResendRequest(parsed, content);
        // 重发时剥离原请求的 signal：避免复用可能已中止/中止中的 AbortSignal 导致重发被中途取消
        const { signal: _signal, ...initNoSignal } = init || {};
        const resp = await origFetch(url, { ...initNoSignal, body: JSON.stringify(resendBody) });
        // 消费：**重发成功拿到响应后**才从缓存移除本条消息用到的图片——若重发抛错（网络异常），
        // 缓存保留，用户重试仍可降级（先删后发会因缓存已空而彻底降级失败）。
        for (const entry of used) {
          if (entry && typeof entry.key === "string") imageCache.delete(entry.key);
        }
        // 登记本批临时图：模型在回合内读取；下一条消息发出时删除更早批次（保留最新批），TTL 兜底自动删
        const batch = { paths: savedPaths.slice(), timer: null };
        batch.timer = setTimeout(() => deleteBatch(batch), IMAGE_TTL_MS);
        pendingBatches.push(batch);
        console.log("[dsh-vscode-bridge] image fallback: 已把图片改为地址随消息重发（" + savedPaths.length + " 张）: " + savedPaths.join(", ") + "（模型读完后即删）");
        return resp;
      } catch (err) {
        // 降级全程失败：返回 null，由调用方回退原生被拒响应（绝不吞用户消息）
        console.error("[dsh-vscode-bridge] image fallback failed:", err);
        return null;
      } finally {
        fallbackResendInFlight = false;
      }
    }

    // 拦截 prompt RPC：发送含图内容被「模型不支持图像输入」拒绝时，把图片落盘为文件、
    // 以「原文 + 图片地址」重发，并用重发成功响应顶替被拒响应返回给 DSH——
    // 用户视角：图片照常发出、模型正常回答，全程无感知，不再弹"不支持图像输入"报错。
    function interceptPromptFetch() {
      const origFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const res = await origFetch(input, init);
        try {
          if (!imageFallbackEnabled || bridgeToken === "") return res;
          if (!init || init.method !== "POST" || typeof init.body !== "string" || init.body === "") return res;
          const parsed = JSON.parse(init.body);
          // DSH 线格式两代兼容：
          //  - ≤0.1.1：{ type, method:'session.prompt', rpcId, payload:{ sessionId, content } }
          //  - ≥0.1.2：{ type:'client-request', method:'session/prompt', rpcId,
          //              payload:{ args:{ request:{ requestId, sessionId, mode, content } } } }
          // unwrapRpcRequest 负责把两代都还原成「业务请求对象」，normalizeRpcMethod 把
          // 斜杠端点归一成点分（session/prompt → session.prompt）供下方判断复用。
          const payload = unwrapRpcRequest(parsed);
          // —— 对话生命周期：新建/删除会话或 prompt 观测到会话 id 变更 → 上一对话终止，清理临时图片 ——
          const method = normalizeRpcMethod(parsed && parsed.method);
          const sessionId = payload && typeof payload.sessionId === "string" ? payload.sessionId : "";
          if (method === "session.create") handleConversationEnd("新建", true);
          // 注：DSH ≥0.1.2 已无 session.delete 端点（删除会话走 workspace/archiveSession），
          // 该分支仅为 ≤0.1.1 兼容保留；0.1.2 下靠 sessionId 变更与 TTL 兜底清理
          else if (method === "session.delete") handleConversationEnd("删除", true);
          else if (sessionId !== "" && lastSeenSessionId !== "" && sessionId !== lastSeenSessionId) {
            handleConversationEnd("切换", false); // 保留当前消息刚捕获的图片（不清 imageCache）
          }
          if (sessionId !== "") lastSeenSessionId = sessionId;
          // 同会话继续发送消息：删除「更早的」临时图批次，**保留最新一批**——DSH ≥0.1.2 的
          // queue 模式允许模型仍在跑时继续发消息，全删可能删掉模型尚未读取的图片
          // （code review 发现）；最新批由 TTL 兜底清理。
          if (method === "session.prompt" && sessionId !== "") flushBatchesExceptLatest("下一条消息");
          if (!payload || !Array.isArray(payload.content) || !isPromptWithImages(payload.content)) return res;
          const clone = res.clone();
          let respJson = null;
          try { respJson = await clone.json(); } catch {}
          if (!detectModelReject(respJson)) {
            // 视觉模型正常接受（或其它非「模型不支持图片」的失败）：本条消息的图片已由 DSH
            // 原生处理，桥接缓存不再需要 → 立即消费，避免同会话后续同名文件命中陈旧条目
            // 把旧图字节落盘（code review Critical：静默发错图）。
            consumeCapturedImages(payload.content);
            return res;
          }
          console.log("[dsh-vscode-bridge] image fallback: 模型不支持图片，落盘并改为地址重发");
          if (fallbackResendInFlight) { console.log("[dsh-vscode-bridge] image fallback: 已有进行中的降级，保持原生响应"); return res; }
          // input 多为 URL 实例（.href）；resolveFetchUrl 兼容 string/URL/Request 三种
          const u = resolveFetchUrl(input);
          if (u === "") { console.warn("[dsh-vscode-bridge] image fallback: 无法解析请求 URL，保持原生报错"); return res; }
          fallbackResendInFlight = true;
          const patched = await handlePromptImageRejected(parsed, u, init, origFetch);
          if (!patched) return res; // 降级失败/无法落盘：回退原生被拒响应（不吞错误）
          // 用「原请求身份(rpcId)」把重发响应交回调用方：DSH 按发送成功处理
          console.log("[dsh-vscode-bridge] image fallback: 已用重发成功响应顶替被拒响应");
          return typeof parsed.rpcId === "string"
            ? await rewriteRpcId(patched, parsed.rpcId)
            : patched;
        } catch {}
        return res;
      };
    }

    // —— v0.4.3：旁路观察 DSH 的改动取数请求（summary / diff），为「在 VS Code 中打开 Diff」攒坐标 ——
    // 为什么必须旁路：seq 只活在 React 闭包里，DOM 拿不到；而 `/api/changes.diff` 需要
    // (sessionId, seq, index)。DSH 打开 review 视图时必然会发这两个请求，顺手克隆响应即可，
    // 零额外耦合、不依赖类名哈希，也不给用户增加任何延迟（克隆体异步解析，原响应立即返回）。
    function interceptChangesFetch() {
      const wrappedFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const res = await wrappedFetch(input, init);
        try {
          if (bridgeToken === "") return res;
          const coords = parseChangesQuery(resolveFetchUrl(input), document.baseURI);
          if (coords === null) return res;
          // 克隆体独立消费；失败静默（观测失败绝不能影响 DSH 自身功能）
          void res
            .clone()
            .json()
            .then((json) => {
              if (coords.route === "summary") {
                changesCache.set(changesKey(coords.sessionId, coords.seq), json);
                return;
              }
              diffCache.set(changesKey(coords.sessionId, coords.seq) + "|" + coords.index, json);
            })
            .catch(() => {});
        } catch {
          // 观测失败不影响原生行为
        }
        return res;
      };
    }

    // 页面卸载清理：删除本次已由本页落盘的缓存图片（避免长期占用工作区存储）
    function bindPageCleanup() {
      window.addEventListener("pagehide", () => {
        flushAllBatches("页面卸载");
      });
    }

    // —— 入口：立即可绑定的拦截先挂载；图片捕获在握手后才绑定 ——
    bindLinkInterception();
    bindImageCapture(); // 附件图片捕获常驻挂载（未握手/关闭时经 imageFallbackEnabled 过滤，零干扰）
    bindUndoTracking(); // 撤销/重做历史跟踪常驻挂载（未握手时零干扰）
    interceptPromptFetch(); // fetch 拦截常驻挂载（内部用开关过滤，未握手/关闭时零干扰）
    interceptChangesFetch(); // v0.4.3：改动坐标观测常驻挂载（同上，未握手时零干扰）
    bindPageCleanup();
    window.addEventListener("message", onParentMessage);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("contextmenu", onContextMenu, true);
    // 点击菜单外任意处／滚动／窗口失焦时收起自定义菜单
    document.addEventListener("pointerdown", (e) => {
      if (menuEl && !menuEl.contains(e.target)) hideMenu();
    }, true);
    window.addEventListener("blur", hideMenu);
    window.addEventListener("scroll", hideMenu, true);
    // cordis 插件约定：apply 挂载点。
    // v0.4.3：保存 cordis 上下文，供「相对路径按当前 DSH 会话工作区解析」在点击时惰性查 cwd。
    // 刻意**不**声明 exports.inject = ['sessions']：硬依赖一旦不满足会让整个桥接（含外链、
    // 剪贴板、图片降级）都无法挂载；这里改为惰性解析，服务不可用时只是拿不到 cwd，
    // 由扩展侧退回 VS Code 工作区根，其余能力完全不受影响。
    exports.apply = (ctx) => {
      clientCtx = ctx;
    };
    return module.exports;
  }
});