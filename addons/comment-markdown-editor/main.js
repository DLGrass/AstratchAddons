import { renderMarkdown } from "./markdown.js";

export default (ctx) => {
  const { vm } = ctx;
  // 翻译：host 用 i18next 承载插件翻译，条目注册在 `addon_<id>` 命名空间下，
  // 调用方式为完整键名 `ctx.t("addon_<id>:key")`。
  // 注意：商店（registry）安装时运行时 id 就是 info.yaml 的 id；
  // 而自定义导入时 id = "custom-" + slugify(文件夹名)（见 host 的 src/addons/custom.ts），
  // 翻译会被注册到另一个命名空间，且 ctx 不暴露运行时 id——
  // 所以这里用探针在候选命名空间中找出真实命中的那个并缓存。

  /** info.yaml 中声明的插件 id 与对应的规范命名空间 */
  const ADDON_ID = "comment-markdown-editor";
  const CANONICAL_NS = `addon_${ADDON_ID}`;

  /**
   * 候选命名空间：
   *  - addon_comment-markdown-editor                     商店安装
   *  - addon_custom-comment-markdown-editor-v1-0-0       自定义导入 release 文件夹（comment-markdown-editor@v1.0.0 slug 化）
   *  - addon_custom-comment-markdown-editor              自定义导入且文件夹名恰为插件 id
   */
  const NS_CANDIDATES = [
    CANONICAL_NS,
    "addon_custom-comment-markdown-editor-v1-0-0",
    "addon_custom-comment-markdown-editor",
  ];

  /** 探测命中并缓存的命名空间 */
  let resolvedNs = null;

  /** ctx.t 兼容封装：在候选命名空间中找到真正命中的完整键名。
   * 注意 i18next 对「命名空间不存在」的回显是裸键名（返回 "btnEdit" 而非
   * "addon_xxx:btnEdit"），所以命中判断必须同时排除 full 和 key 两种回显。 */
  const t = (key) => {
    const order = resolvedNs
      ? [resolvedNs, ...NS_CANDIDATES.filter((ns) => ns !== resolvedNs)]
      : NS_CANDIDATES;
    for (const ns of order) {
      const full = `${ns}:${key}`;
      const value = ctx.t(full);
      if (value != null && value !== full && value !== key) {
        resolvedNs = ns;
        return value;
      }
    }
    // 兜底：宿主若把 ctx.t 预绑定到插件命名空间，裸键名也能命中
    const value = ctx.t(key);
    if (value != null && value !== key) return value;
    return key;
  };

  // 一次性诊断：输出各命名空间探针的真实命中情况；
  // 若翻译仍不生效，把控制台这条日志反馈回来即可进一步定位。
  try {
    const probeHit = (ns) => {
      const full = `${ns}:btnEdit`;
      const value = ctx.t(full);
      return value != null && value !== full && value !== "btnEdit";
    };
    console.info("[comment-markdown-editor] i18n probe:", {
      canonical: probeHit(CANONICAL_NS),
      customVersioned: probeHit("addon_custom-comment-markdown-editor-v1-0-0"),
      customPlain: probeHit("addon_custom-comment-markdown-editor"),
      bare: ctx.t("btnEdit"),
      resolvedNs,
    });
  } catch {
    /* 忽略诊断失败 */
  }

  /** 标记属性：已增强的注释框 */
  const PROCESSED_ATTR = "data-ashMdProcessed";

  // ── 全局常量 ────────────────────────────────────────────────────────────
  const TOGGLE_CONTAINER_CLASS = "ash-md-toggle-container";
  const MODE_INDICATOR_CLASS = "ash-md-mode-indicator";
  const TOGGLE_BUTTON_CLASS = "ash-md-toggle-button";
  const PREVIEW_CONTAINER_CLASS = "ash-md-preview-container";
  /** 自建的两层 foreignObject 的类名（用于 CSS 定位与 RTL 反向镜像） */
  const TOGGLE_HOST_CLASS = "ash-md-toggle-host";
  const PREVIEW_HOST_CLASS = "ash-md-preview-host";
  const STYLE_ELEMENT_ID = "ash-md-comment-styles";

  const MODE_EDIT = "edit";
  const MODE_PREVIEW = "preview";

  /** CommentView 顶栏高度，与 Astratch/plugins/scratch-comment.ts 的常量一致 */
  const COMMENT_TOPBAR_HEIGHT = 24;
  /** 读不到注释框实际宽度时的兜底宽度 */
  const FALLBACK_COMMENT_WIDTH = 220;

  /**
   * 把 SVG 长度属性解析成数字。
   * Blockly 写入的是带尾随换行的字符串（如 "300\n"），必须 parseFloat。
   * @returns {number | null} 无法解析时返回 null
   */
  const readLength = (raw) => {
    if (raw === null || raw === undefined) return null;
    const value = Number.parseFloat(String(raw));
    return Number.isFinite(value) ? value : null;
  };

  /**
   * 仅在值确实变化时才写属性。
   * 插件的几何 MutationObserver 就挂在注释框上，写入相同值虽然不会产生
   * 新的 mutation 记录，但显式比较能省掉无谓的 setAttribute 调用。
   */
  const setAttrIfChanged = (element, name, value) => {
    if (element.getAttribute(name) === value) return;
    element.setAttribute(name, value);
  };

  /** 记录每个已增强注释框的清理函数，禁用时逐个回滚 */
  const disposers = new Set();

  // ── 工具函数 ────────────────────────────────────────────────────────────

  /** 取主工作区（与其它插件保持一致） */
  const getWorkspace = () => vm.runtime.blocks?.workspaceSvg ?? null;

  /** 归一化快捷键设置："Ctrl+M" -> { ctrl: true, shift: false, alt: false, key: "m" } */
  const parseShortcut = (raw) => {
    const fallback = { ctrl: true, shift: false, alt: false, key: "m" };
    if (typeof raw !== "string" || !raw.trim()) return fallback;

    const parts = raw
      .split("+")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    if (parts.length === 0) return fallback;

    const result = { ctrl: false, shift: false, alt: false, key: "" };
    for (const part of parts) {
      if (part === "ctrl" || part === "control" || part === "cmd" || part === "meta") {
        result.ctrl = true;
      } else if (part === "shift") {
        result.shift = true;
      } else if (part === "alt" || part === "option") {
        result.alt = true;
      } else {
        result.key = part;
      }
    }
    // 未指定修饰键时退回默认，避免单字母快捷键吞掉正常输入
    if (!result.ctrl && !result.alt && !result.shift) return fallback;
    if (!result.key) return fallback;
    return result;
  };

  /** 判断按键事件是否匹配解析出的快捷键 */
  const matchesShortcut = (event, shortcut) => {
    if (event.key.toLowerCase() !== shortcut.key) return false;
    return (
      event.ctrlKey === shortcut.ctrl &&
      event.shiftKey === shortcut.shift &&
      event.altKey === shortcut.alt
    );
  };

  // ── 样式注入 ────────────────────────────────────────────────────────────

  /**
   * 注入插件样式。使用 CSS 变量跟随 Astratch 主题，避免硬编码配色。
   * 样式只注入一次，cleanup 时移除。
   */
  const injectStyles = () => {
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    style.textContent = `
.${TOGGLE_CONTAINER_CLASS} {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  box-sizing: border-box;
  height: 100%;
  /* 顶栏右侧只有删除按钮（20px 图标贴右缘），这里留 12px。
     外层 foreignObject 铺满注释宽度，所以注释框放大时按钮跟着一起移动。 */
  padding-right: 12px;
  pointer-events: auto;
}
.${MODE_INDICATOR_CLASS} {
  font-size: 11px;
  color: #000;
  opacity: 0.65;
  letter-spacing: 0.4px;
  transition: opacity 0.2s ease;
  user-select: none;
}
.${MODE_INDICATOR_CLASS}[data-mode="${MODE_PREVIEW}"] {
  opacity: 1;
  font-weight: 600;
}
.${TOGGLE_BUTTON_CLASS} {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.5;
  cursor: pointer;
  border-radius: 5px;
  border: 1px solid rgba(0, 0, 0, 0.15);
  background: rgba(255, 255, 255, 0.35);
  color: #000;
  opacity: 0.85;
  transition: opacity 0.2s ease, background 0.2s ease, transform 0.1s ease;
  user-select: none;
}
.${TOGGLE_BUTTON_CLASS}:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.6);
}
.${TOGGLE_BUTTON_CLASS}:active {
  transform: scale(0.95);
}
.${TOGGLE_BUTTON_CLASS}[data-mode="${MODE_PREVIEW}"] {
  background: rgba(76, 175, 80, 0.28);
  border-color: rgba(76, 175, 80, 0.45);
}
.${PREVIEW_CONTAINER_CLASS} {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  /* 注释框的背景和边框其实来自 .blocklyTextarea 自身（Blockly 注入的
     --commentFillColour / --commentBorderColour）。预览时文本域被隐藏，
     背景会跟着一起消失，所以预览层必须把同一套外观自己画回来，
     否则看起来就是"注释框没有背景了"。 */
  background-color: var(--commentFillColour, #fffcc7);
  border: 1px solid var(--commentBorderColour, #f2e49b);
  /* 与 .blocklyTextarea 的 padding 一致，切换模式时正文位置不跳动 */
  padding: 5px;
  overflow-y: auto;
  overflow-x: hidden;
  font-size: 14px;
  line-height: 1.7;
  /* 与 public.scss 中 .blocklyComment .blocklyTextarea 的强制黑色保持一致 */
  color: #000;
  word-break: break-word;
  scrollbar-width: thin;
}
.${PREVIEW_CONTAINER_CLASS} > :first-child { margin-top: 0; }
.${PREVIEW_CONTAINER_CLASS} > :last-child { margin-bottom: 0; }
.${PREVIEW_CONTAINER_CLASS} h1 { font-size: 1.6em; }
.${PREVIEW_CONTAINER_CLASS} h2 { font-size: 1.35em; }
.${PREVIEW_CONTAINER_CLASS} h3 { font-size: 1.15em; }
.${PREVIEW_CONTAINER_CLASS} h1,
.${PREVIEW_CONTAINER_CLASS} h2,
.${PREVIEW_CONTAINER_CLASS} h3,
.${PREVIEW_CONTAINER_CLASS} h4,
.${PREVIEW_CONTAINER_CLASS} h5,
.${PREVIEW_CONTAINER_CLASS} h6 {
  margin: 10px 0 6px;
  font-weight: 600;
  line-height: 1.3;
}
.${PREVIEW_CONTAINER_CLASS} h1,
.${PREVIEW_CONTAINER_CLASS} h2 {
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.35);
}
.${PREVIEW_CONTAINER_CLASS} p,
.${PREVIEW_CONTAINER_CLASS} ul,
.${PREVIEW_CONTAINER_CLASS} ol,
.${PREVIEW_CONTAINER_CLASS} blockquote,
.${PREVIEW_CONTAINER_CLASS} pre { margin: 6px 0; }
.${PREVIEW_CONTAINER_CLASS} ul,
.${PREVIEW_CONTAINER_CLASS} ol { padding-left: 22px; }
.${PREVIEW_CONTAINER_CLASS} li { margin: 2px 0; }
.${PREVIEW_CONTAINER_CLASS} li > .ash-md-task {
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
}
.${PREVIEW_CONTAINER_CLASS} li > .ash-md-task > input[type="checkbox"] {
  margin: 0 4px 0 0;
  vertical-align: middle;
  accent-color: #4caf50;
}
.${PREVIEW_CONTAINER_CLASS} li.ash-md-task { list-style: none; margin-left: -18px; }
.${PREVIEW_CONTAINER_CLASS} blockquote {
  padding: 2px 12px;
  border-left: 3px solid rgba(128, 128, 128, 0.5);
  opacity: 0.85;
}
.${PREVIEW_CONTAINER_CLASS} code {
  padding: 1px 5px;
  border-radius: 4px;
  font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
  font-size: 0.92em;
  background: rgba(128, 128, 128, 0.18);
}
.${PREVIEW_CONTAINER_CLASS} pre {
  padding: 8px 10px;
  overflow-x: auto;
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.14);
}
.${PREVIEW_CONTAINER_CLASS} pre code { padding: 0; background: none; }
.${PREVIEW_CONTAINER_CLASS} img {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
  margin: 4px 0;
}
.${PREVIEW_CONTAINER_CLASS} a {
  color: #4a9eff;
  text-decoration: none;
}
.${PREVIEW_CONTAINER_CLASS} a:hover { text-decoration: underline; }
.${PREVIEW_CONTAINER_CLASS} hr {
  border: none;
  border-top: 1px solid rgba(128, 128, 128, 0.35);
  margin: 10px 0;
}
.${PREVIEW_CONTAINER_CLASS} table {
  border-collapse: collapse;
  margin: 6px 0;
  display: block;
  max-width: 100%;
  overflow-x: auto;
}
.${PREVIEW_CONTAINER_CLASS} th,
.${PREVIEW_CONTAINER_CLASS} td {
  padding: 4px 8px;
  border: 1px solid rgba(128, 128, 128, 0.35);
}
.${PREVIEW_CONTAINER_CLASS} th {
  font-weight: 600;
  background: rgba(128, 128, 128, 0.14);
}
.${PREVIEW_CONTAINER_CLASS} mark {
  padding: 0 2px;
  border-radius: 3px;
  background: rgba(255, 214, 0, 0.4);
  color: inherit;
}
.${PREVIEW_CONTAINER_CLASS} del { opacity: 0.7; }
.${PREVIEW_CONTAINER_CLASS} li > ul,
.${PREVIEW_CONTAINER_CLASS} li > ol { margin: 2px 0; }
/* RTL：Blockly 对顶栏整体做了 transform: scale(-1,1) 镜像，
   按钮层长在顶栏里，需要反向镜像回来才不会连文字一起反着显示。 */
.blocklyRTL .${TOGGLE_HOST_CLASS} { transform: scale(-1, 1); }
`;
    document.head.appendChild(style);
  };

  // ── 注释框增强 ──────────────────────────────────────────────────────────

  /**
   * 对单个注释框做增强。
   * @param {Element} bubbleGroup g.blocklyScratchCommentBubble 或 g.blocklyComment
   */
  const enhanceComment = (bubbleGroup) => {
    if (!bubbleGroup || bubbleGroup.getAttribute(PROCESSED_ATTR)) return;

    // 注释框本体（可能是传入的组自身，也可能是其子节点）
    const commentRoot = bubbleGroup.classList.contains("blocklyComment")
      ? bubbleGroup
      : bubbleGroup.querySelector(".blocklyComment");
    if (!commentRoot) return;

    const textarea = commentRoot.querySelector("textarea.blocklyTextarea");
    if (!textarea) return;

    const topBar = commentRoot.querySelector(".blocklyCommentTopbar");
    if (!topBar) return;

    // 文本域所在的 foreignObject（预览层的挂载点与隐藏目标）。
    // 只隐藏外层的 foreignObject，不能隐藏 commentRoot——后者包含顶栏，
    // 隐藏它会把切换按钮一起藏掉，导致无法切回编辑模式。
    const editorHost = textarea.closest("foreignObject");
    if (!editorHost) return;

    // 立即标记，避免 MutationObserver 重复进入
    commentRoot.setAttribute(PROCESSED_ATTR, "true");
    bubbleGroup.setAttribute(PROCESSED_ATTR, "true");

    const shortcut = parseShortcut(ctx.settings.get("shortcut"));
    const showIndicator = ctx.settings.get("showIndicator") !== false;
    const startInPreview = ctx.settings.get("defaultMode") === MODE_PREVIEW;

    // ── 顶部栏：模式指示器 + 切换按钮 ──
    const toggleContainer = document.createElement("div");
    toggleContainer.className = TOGGLE_CONTAINER_CLASS;
    // 顶部栏是 SVG，容器需作为 foreignObject 才能承载 HTML
    const toggleForeignObject = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "foreignObject",
    );
    toggleForeignObject.classList.add(TOGGLE_HOST_CLASS);
    toggleForeignObject.setAttribute("x", "0");
    toggleForeignObject.setAttribute("y", "0");
    // 宽度会在 syncGeometry() 里按注释框实际宽度设置
    toggleForeignObject.setAttribute("width", String(FALLBACK_COMMENT_WIDTH));
    toggleForeignObject.setAttribute("height", String(COMMENT_TOPBAR_HEIGHT));
    // 靠右对齐、以及让开顶栏右侧的删除按钮，都交给 CSS（flex-end + padding-right）
    toggleForeignObject.appendChild(toggleContainer);

    const modeIndicator = document.createElement("span");
    modeIndicator.className = MODE_INDICATOR_CLASS;

    const toggleButton = document.createElement("button");
    toggleButton.className = TOGGLE_BUTTON_CLASS;
    toggleButton.type = "button";
    toggleButton.dataset.mode = MODE_EDIT;

    /** 按当前模式刷新按钮 / 指示器文案（文案唯一写入点） */
    const applyLabels = (mode) => {
      const preview = mode === MODE_PREVIEW;
      toggleButton.textContent = t(preview ? "btnPreview" : "btnEdit");
      toggleButton.title = t(preview ? "btnPreviewTitle" : "btnEditTitle");
      modeIndicator.textContent = t(preview ? "modePreview" : "modeEdit");
      modeIndicator.dataset.mode = mode;
    };

    /** t() 未命中时会原样返回键名，据此判断翻译是否真的可解析 */
    const labelsResolved = () => t("btnEdit") !== "btnEdit";

    /**
     * 初始文案带重试：host 的 i18n 表可能晚于插件主函数就绪，
     * 就绪前渲染的文案会回显键名（如 "modeEdit"），就绪后重刷即可纠正。
     * 重试读的是 dataset.mode，期间用户切换模式也不会写错文案。
     */
    let labelRetryTimer = 0;
    const scheduleLabelRetry = (attemptsLeft) => {
      if (labelsResolved() || attemptsLeft <= 0) return;
      labelRetryTimer = setTimeout(() => {
        applyLabels(toggleButton.dataset.mode);
        scheduleLabelRetry(attemptsLeft - 1);
      }, 250);
    };
    applyLabels(toggleButton.dataset.mode);
    scheduleLabelRetry(20);

    if (showIndicator) toggleContainer.appendChild(modeIndicator);
    toggleContainer.appendChild(toggleButton);
    topBar.appendChild(toggleForeignObject);

    // ── 预览容器 ──
    // 预览是 HTML 内容，必须放在 foreignObject 里才能被 SVG 渲染。
    // 单独建一个覆盖整个注释正文区的 foreignObject（不放进文本域那个，
    // 因为它的尺寸由 CommentView.updateSize 控制，会被覆写）。
    const previewForeignObject = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "foreignObject",
    );
    previewForeignObject.classList.add(PREVIEW_HOST_CLASS);
    previewForeignObject.style.display = "none";
    // 几何参数由 syncGeometry() 从文本域的 foreignObject 镜像过来
    previewForeignObject.setAttribute("x", "0");
    previewForeignObject.setAttribute("y", String(COMMENT_TOPBAR_HEIGHT));
    previewForeignObject.setAttribute("width", "0");
    previewForeignObject.setAttribute("height", "0");

    const previewContainer = document.createElement("div");
    previewContainer.className = PREVIEW_CONTAINER_CLASS;
    previewForeignObject.appendChild(previewContainer);

    // 插在 resize 手柄之前：预览层要铺满正文区，但不能盖住手柄，
    // 否则一进预览模式注释框就再也拖不动了。
    const resizeHandle = commentRoot.querySelector(".blocklyResizeHandle");
    if (resizeHandle) commentRoot.insertBefore(previewForeignObject, resizeHandle);
    else commentRoot.appendChild(previewForeignObject);

    /** 本插件自己插入的节点：几何观察器要忽略它们，避免自触发 */
    const ownNodes = new Set([toggleForeignObject, previewForeignObject]);

    /**
     * 把注释框当前尺寸同步到插件自建的这两层上。
     *
     * 真源是文本域的 foreignObject：Blockly 的
     * CommentView.setSizeWithoutFiringEvents() 在每次尺寸变化时都会重写它的
     * width（= 注释宽度）、height（= 注释高度 - 顶栏高度）、y（= 顶栏高度），
     * 并同步更新顶栏背景条的 width。这里直接读这些值，不自己算。
     */
    const syncGeometry = () => {
      let width = readLength(editorHost.getAttribute("width"));
      let height = readLength(editorHost.getAttribute("height"));
      const y = readLength(editorHost.getAttribute("y"));
      const x = readLength(editorHost.getAttribute("x"));

      // 兜底：极少数时序下文本域的属性可能还没写入，退回顶栏背景条 / 注释框自身，
      // 避免预览层停在 0×0 变成一片空白。
      if (width === null) {
        const topBarBackground = commentRoot.querySelector(".blocklyCommentTopbarBackground");
        width =
          readLength(topBarBackground?.getAttribute("width")) ??
          readLength(commentRoot.getAttribute("width"));
      }
      if (height === null) {
        const total = readLength(commentRoot.getAttribute("height"));
        if (total !== null) height = total - COMMENT_TOPBAR_HEIGHT;
      }

      if (width !== null) {
        setAttrIfChanged(previewForeignObject, "width", String(width));
        // 按钮层铺满整个顶栏宽度，靠 CSS 的 flex-end 贴在右侧
        setAttrIfChanged(toggleForeignObject, "width", String(width));
      }
      if (height !== null) {
        setAttrIfChanged(previewForeignObject, "height", String(Math.max(height, 0)));
      }
      if (y !== null) setAttrIfChanged(previewForeignObject, "y", String(y));
      // RTL 下 Blockly 会把文本域 x 设为 -width，预览层要跟着镜像
      setAttrIfChanged(previewForeignObject, "x", String(x ?? 0));
    };

    /** 合并同一帧内的多次尺寸变化，避免拖动缩放时反复重排 */
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (callback) => setTimeout(callback, 16);
    let syncFrame = 0;
    const scheduleSync = () => {
      if (syncFrame) return;
      syncFrame = raf(() => {
        syncFrame = 0;
        syncGeometry();
      });
    };

    // 拖动右下角手柄时，上述属性会被 Blockly 逐个重写，这里跟着同步
    const geometryObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (ownNodes.has(mutation.target)) continue;
        scheduleSync();
        return;
      }
    });
    geometryObserver.observe(commentRoot, {
      attributes: true,
      subtree: true,
      attributeFilter: ["width", "height", "x", "y"],
    });

    syncGeometry();

    const renderPreview = () => {
      previewContainer.innerHTML = renderMarkdown(textarea.value, {
        allowHtml: ctx.settings.get("allowHtml") === true,
      });
    };

    /** 切换编辑 / 预览模式 */
    const setMode = (nextMode) => {
      if (toggleButton.dataset.mode === nextMode) return;
      toggleButton.dataset.mode = nextMode;
      applyLabels(nextMode);

      if (nextMode === MODE_PREVIEW) {
        // 隐藏 foreignObject（文本域宿主），显示预览
        editorHost.style.visibility = "hidden";
        previewForeignObject.style.display = "";
        renderPreview();
      } else {
        editorHost.style.visibility = "";
        previewForeignObject.style.display = "none";
        textarea.focus();
      }
    };

    const toggleMode = () => {
      setMode(toggleButton.dataset.mode === MODE_EDIT ? MODE_PREVIEW : MODE_EDIT);
    };

    const onButtonClick = (event) => {
      event.stopPropagation();
      event.preventDefault();
      toggleMode();
    };
    toggleButton.addEventListener("click", onButtonClick);
    // 顶部栏整体可拖动，按钮上按下时要拦住，避免触发注释框拖动
    const onButtonPointerDown = (event) => event.stopPropagation();
    toggleButton.addEventListener("pointerdown", onButtonPointerDown);

    // 文本变化时若处于预览模式，实时刷新
    const onInput = () => {
      if (toggleButton.dataset.mode === MODE_PREVIEW) renderPreview();
    };
    textarea.addEventListener("input", onInput);

    // 快捷键：仅在焦点位于该注释框内，或已处于预览模式时生效
    const onKeyDown = (event) => {
      if (!matchesShortcut(event, shortcut)) return;
      const active = document.activeElement;
      const editingThis =
        active === textarea || (active && commentRoot.contains(active));
      const previewing = toggleButton.dataset.mode === MODE_PREVIEW;
      if (!editingThis && !previewing) return;
      event.preventDefault();
      event.stopPropagation();
      toggleMode();
    };
    document.addEventListener("keydown", onKeyDown, true);

    // ── 清理：把注释框恢复为原状 ──
    const dispose = () => {
      document.removeEventListener("keydown", onKeyDown, true);
      geometryObserver.disconnect();
      if (labelRetryTimer) {
        clearTimeout(labelRetryTimer);
        labelRetryTimer = 0;
      }
      if (syncFrame) {
        const cancel =
          typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;
        cancel(syncFrame);
        syncFrame = 0;
      }
      textarea.removeEventListener("input", onInput);
      toggleButton.removeEventListener("click", onButtonClick);
      toggleButton.removeEventListener("pointerdown", onButtonPointerDown);
      editorHost.style.visibility = "";
      toggleForeignObject.remove();
      previewForeignObject.remove();
      commentRoot.removeAttribute(PROCESSED_ATTR);
      bubbleGroup.removeAttribute(PROCESSED_ATTR);
    };
    disposers.add(dispose);

    // 注释框被删除时自动移除 disposer，避免 set 无限增长
    commentRoot.addEventListener(
      "DOMNodeRemovedFromDocument",
      () => {
        disposers.delete(dispose);
      },
      { once: true },
    );

    if (startInPreview) setMode(MODE_PREVIEW);
  };

  /** 扫描当前工作区内所有注释框并增强 */
  const scanComments = () => {
    const workspace = getWorkspace();
    if (!workspace) return;
    const bubbleCanvas = workspace.getBubbleCanvas?.() ?? null;
    const scope = bubbleCanvas ?? document;
    for (const group of Array.from(scope.querySelectorAll("g.blocklyComment"))) {
      enhanceComment(group);
    }
  };

  // ── 启动 ────────────────────────────────────────────────────────────────
  injectStyles();

  // 1) 首次扫描：工作区可能尚未创建，稍后重试一次
  scanComments();
  const initialTimer = setTimeout(scanComments, 800);

  // 2) 监听 DOM 新增节点：注释框是动态插入 bubbleCanvas 的
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const element = /** @type {Element} */ (node);
        if (element.matches?.("g.blocklyComment")) {
          enhanceComment(element);
        } else if (element.querySelector?.("g.blocklyComment")) {
          scanComments();
          return;
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // 3) 目标切换 / 项目更新会重建工作区与注释框
  const onWorkspaceChanged = () => {
    setTimeout(scanComments, 100);
  };
  vm.on("switch_target", onWorkspaceChanged);
  vm.on("update_project", onWorkspaceChanged);
  vm.on("create_project", onWorkspaceChanged);

  // 4) 兜底轮询：部分场景（加载项目/折叠展开）不触发 MutationObserver
  const pollTimer = setInterval(() => {
    const pending = document.querySelector("g.blocklyComment:not([" + PROCESSED_ATTR + "])");
    if (pending) scanComments();
  }, 2000);

  // ── 清理函数 ────────────────────────────────────────────────────────────
  return () => {
    clearTimeout(initialTimer);
    clearInterval(pollTimer);
    observer.disconnect();
    vm.off("switch_target", onWorkspaceChanged);
    vm.off("update_project", onWorkspaceChanged);
    vm.off("create_project", onWorkspaceChanged);
    for (const dispose of Array.from(disposers)) {
      try {
        dispose();
      } catch (error) {
        console.error("Markdown comment cleanup failed:", error);
      }
    }
    disposers.clear();
    document.getElementById(STYLE_ELEMENT_ID)?.remove();
  };
};
