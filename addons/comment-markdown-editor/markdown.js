/**
 * 注释框 Markdown 渲染器。
 *
 * 设计约束：
 *  1. 输出必须是 **安全 HTML**——默认转义所有用户文本，URL 走白名单，
 *     因此可直接赋给 innerHTML 而无需二次清理。
 *  2. 解析顺序必须是"先块级、后行内"，且块级语法一律在**原始文本**上匹配
 *     （转义会让 `>` 变成 `&gt;`，引用行就再也匹配不到了）。
 *  3. 代码片段先抽成占位符，避免内容被后续规则二次处理。
 *
 * 支持语法（CommonMark + GFM 常用子集）：
 *   ATX 标题 `#`~`######`（允许 `#NoSpace`）、Setext 标题（`===` / `---`）、
 *   分隔线、引用（可嵌套、支持懒续行与引用内块级语法）、无序/有序列表
 *   （支持缩进嵌套、紧凑/松散）、任务列表 `- [x]`、围栏代码块（``` 与 ~~~，
 *   带语言标识）、行内代码、粗体、斜体、粗斜体、删除线、GFM 表格（含对齐）、
 *   图片、链接（含标题）、自动链接 `<url>`、硬换行（行尾两空格或 `\`）、
 *   反斜杠转义、段落。
 */

/** HTML 转义，安全兜底 */
export const escapeHtml = (text) =>
  String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** 仅允许 http/https/mailto/#，拦截 javascript: 等危险协议 */
export const sanitizeUrl = (url) => {
  const trimmed = String(url ?? "").trim();
  if (/^(https?:|mailto:|#)/i.test(trimmed)) return trimmed;
  return "#";
};

/** 图片地址只放行 http/https 与 data:image */
export const sanitizeImageUrl = (url) => {
  const trimmed = String(url ?? "").trim();
  if (/^https?:/i.test(trimmed)) return trimmed;
  if (/^data:image\//i.test(trimmed)) return trimmed;
  return "";
};

/** 可被反斜杠转义的 ASCII 标点（CommonMark 规范） */
const ESCAPABLE_RE = /\\([\\`*_{}[\]()#+\-.!|~>])/g;

/**
 * 把用户文本里的反斜杠转义替换为"占位符"，防止被行内标记误判。
 * 返回替换后的文本与还原函数。
 */
const protectEscapes = (text) => {
  const slots = [];
  const replaced = text.replace(ESCAPABLE_RE, (_m, ch) => {
    slots.push(ch);
    return `\u0000ASHMDESC${slots.length - 1}\u0000`;
  });
  const restore = (html) =>
    html.replace(/\u0000ASHMDESC(\d+)\u0000/g, (_m, i) => {
      const ch = slots[Number(i)];
      return ch === undefined ? "" : escapeHtml(ch);
    });
  return { replaced, restore };
};

/**
 * 拆分 GFM 表格行：`| a | b |` -> ["a", "b"]。
 * 处理首尾可选的竖线，并尊重 `\|` 转义。
 */
const splitTableRow = (line) => {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let current = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
};

/** 判断是否表格分隔行：`| --- | :--: |` */
const isTableDelimiter = (line) => {
  const cells = splitTableRow(line);
  if (cells.length === 0) return false;
  return cells.every((cell) => /^:?-{1,}:?$/.test(cell.replace(/\s/g, "")));
};

/** 从分隔行推导每列对齐方式 */
const parseAlignments = (line) =>
  splitTableRow(line).map((cell) => {
    const c = cell.replace(/\s/g, "");
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  });

/**
 * 把 Markdown 渲染为 HTML。
 * @param {string} text 原始 Markdown
 * @param {{ allowHtml?: boolean }} [options]
 * @returns {string}
 */
export const renderMarkdown = (text, options = {}) => {
  const allowHtml = options.allowHtml === true;
  const source = String(text ?? "");

  /** 行内代码 / 围栏代码块 的占位内容 */
  const codeSlots = [];
  const stashCode = (html) => {
    const token = `\u0000ASHMDCODE${codeSlots.length}\u0000`;
    codeSlots.push(html);
    return token;
  };

  /** 围栏代码块（块级）占位内容，与行内代码分开登记 */
  const blockSlots = [];
  const stashBlock = (html) => {
    const token = `\u0000ASHMDBLOCK${blockSlots.length}\u0000`;
    blockSlots.push(html);
    return token;
  };

  /** 表格（块级）占位内容 */
  const tableSlots = [];
  const stashTable = (html) => {
    const token = `\u0000ASHMDTABLE${tableSlots.length}\u0000`;
    tableSlots.push(html);
    return token;
  };

  /**
   * 提取围栏代码块（``` 与 ~~~）为块级占位符，块内内容不再参与任何解析。
   *
   * 以"行数组"为输入而非整段文本，是为了让它可以在引用/列表递归时再次调用——
   * 引用里的 ``` 行只有在剥掉 `>` 前缀之后才会显露出来，全局预处理捕获不到。
   *
   * @param {string[]} rows
   * @returns {string[]} 处理后的行数组（围栏内容被替换为单行占位符）
   */
  const extractFences = (rows) => {
    const result = [];
    for (let i = 0; i < rows.length; i++) {
      const open = /^[ \t]*(```|~~~)[ \t]*([a-zA-Z0-9+#._-]*)[ \t]*$/.exec(rows[i]);
      if (!open) {
        result.push(rows[i]);
        continue;
      }
      const fence = open[1];
      const lang = open[2];
      // 向后找闭合围栏
      const body = [];
      let j = i + 1;
      let closed = false;
      for (; j < rows.length; j++) {
        if (new RegExp(`^[ \\t]*${fence === "```" ? "```" : "~~~"}[ \\t]*$`).test(rows[j])) {
          closed = true;
          break;
        }
        body.push(rows[j]);
      }
      if (!closed) {
        // 未闭合：按普通文本处理
        result.push(rows[i]);
        continue;
      }
      const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      const html = `<pre><code${langClass}>${escapeHtml(body.join("\n"))}</code></pre>`;
      result.push(stashBlock(html));
      i = j;
    }
    return result;
  };

  /** 行内代码提取（整段文本级别） */
  const extractInlineCode = (text) =>
    text.replace(/`([^`\n]+)`/g, (_match, code) => stashCode(`<code>${escapeHtml(code)}</code>`));

  /**
   * 在**已转义**文本上套用行内强调标记（粗体 / 斜体 / 粗斜体 / 删除线 / 高亮）。
   * 独立出来是为了让链接文字也能复用——链接文字在 stash 前需要先做强调处理。
   * @param {string} text
   * @returns {string}
   */
  const applyInlineMarks = (text) => {
    let result = text;
    // 注意 `**a *b* c**` 这类嵌套：内层内容允许出现单个 `*`，
    // 因此不能用 `[^*]+`（会拒绝嵌套），改用"非贪婪 + 前后边界"。
    result = result.replace(
      /\*\*\*(\S(?:[^*]|\*(?!\*))*?\S|\S)\*\*\*/g,
      "<strong><em>$1</em></strong>",
    );
    result = result.replace(/\*\*(\S(?:[^*]|\*(?!\*))*?\S|\S)\*\*/g, "<strong>$1</strong>");
    result = result.replace(
      /(?<![*_\w])__(\S(?:[^_]|_(?!_))*?\S|\S)__(?!\w)/g,
      "<strong>$1</strong>",
    );
    // 斜体：左边界不能是 `*`/`_`/字母数字（避免吞掉粗体标记），右边界同理
    result = result.replace(/(^|[^*\w])\*(\S(?:[^*]*?\S)?)\*(?![*\w])/g, "$1<em>$2</em>");
    result = result.replace(/(^|[^_\w])_(\S(?:[^_]*?\S)?)_(?![_\w])/g, "$1<em>$2</em>");
    result = result.replace(/~~(\S(?:[^~]*?\S)?)~~/g, "<del>$1</del>");
    result = result.replace(/==(\S(?:[^=]*?\S)?)==/g, "<mark>$1</mark>");
    return result;
  };

  /**
   * 行内标记：图片 / 链接 / 自动链接 / 粗体 / 斜体 / 删除线 / 高亮。
   * 入参为原始（未转义）文本。
   */
  const inline = (line) => {
    /** 已生成的 HTML 片段暂存，避免被后续转义破坏 */
    const htmlSlots = [];
    const stashHtml = (html) => {
      const token = `\u0000ASHMDHTML${htmlSlots.length}\u0000`;
      htmlSlots.push(html);
      return token;
    };

    // 反斜杠转义先保护起来
    const { replaced: guarded, restore: restoreEscapes } = protectEscapes(line);
    let result = guarded;

    // 图片：URL 走白名单，alt 转义；不合法则整体按纯文本显示
    result = result.replace(
      /!\[([^\]]*)\]\(([^)\s]*)(?:\s+"([^"]*)")?\)/g,
      (match, alt, src) => {
        const url = sanitizeImageUrl(src);
        if (!url) return match;
        const title = "";
        return stashHtml(
          `<img src="${url}" alt="${escapeHtml(alt)}"${title} loading="lazy">`,
        );
      },
    );

    // 链接：label 转义，href 走白名单。
    // 负向后顾排除 "!"，避免把不合法图片语法的方括号误当普通链接。
    result = result.replace(
      /(?<!!)\[([^\]]+)\]\(([^)\s]*)(?:\s+"([^"]*)")?\)/g,
      (match, label, href, title) => {
        const url = sanitizeUrl(href);
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
        // 链接文字先转义再套强调标记，支持 `[**粗**](url)` 写法
        const labelHtml = applyInlineMarks(escapeHtml(label));
        return stashHtml(
          `<a href="${url}"${titleAttr} target="_blank" rel="noopener noreferrer">${labelHtml}</a>`,
        );
      },
    );

    // 自动链接 <https://...> / <mailto:...>
    result = result.replace(/<((?:https?:\/\/|mailto:)[^<>\s]+)>/g, (_match, url) => {
      const safe = sanitizeUrl(url);
      return stashHtml(
        `<a href="${safe}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`,
      );
    });

    // 转义剩余纯文本（占位符 \u0000 不受影响）
    if (!allowHtml) result = escapeHtml(result);

    // 行内强调标记
    result = applyInlineMarks(result);

    // 还原转义字符与已生成的 HTML 片段
    result = restoreEscapes(result);
    return result.replace(/\u0000ASHMDHTML(\d+)\u0000/g, (_m, index) => {
      const slot = htmlSlots[Number(index)];
      return slot === undefined ? "" : slot;
    });
  };

  /**
   * 还原各类占位符。
   *
   * 顺序很关键：**表格必须最先还原**。表格的 HTML 是在单元格里调用
   * inline() 生成后再整体 stash 的，因此表格内容里可能还嵌着行内代码的
   * 占位符；若先替换 codeSlots，这些嵌在 tableSlots 里的占位符不会被命中，
   * 表格还原后就会露出残留的占位符文本。
   */
  const restorePlaceholders = (html) => {
    let result = html;
    if (tableSlots.length > 0) {
      result = result.replace(
        /\u0000ASHMDTABLE(\d+)\u0000/g,
        (_m, i) => tableSlots[Number(i)] ?? "",
      );
    }
    if (codeSlots.length > 0) {
      result = result.replace(/\u0000ASHMDCODE(\d+)\u0000/g, (_m, i) => codeSlots[Number(i)] ?? "");
    }
    if (blockSlots.length > 0) {
      result = result.replace(/\u0000ASHMDBLOCK(\d+)\u0000/g, (_m, i) => blockSlots[Number(i)] ?? "");
    }
    return result;
  };
  // ── 块级解析 ───────────────────────────────────────────────────────────
  // 结构：renderBlocks(blockLines) 逐行扫描，列表与引用各自"收集成块"后
  // 递归调用 renderBlocks。所有解析函数都以 **参数** 接收行数组，绝不引用
  // 外层闭包变量——否则递归时会重新扫到父级行，导致无限递归。

  /** 匹配列表项，返回 { indent, tag, content } 或 null */
  const matchListItem = (line) => {
    const expanded = line.replace(/\t/g, "    ");
    let m = /^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$/.exec(expanded);
    if (m) {
      const checked = m[3].toLowerCase() === "x";
      const checkbox = `<input type="checkbox" disabled${checked ? " checked" : ""}>`;
      return {
        indent: m[1].length,
        tag: "ul",
        content: `<span class="ash-md-task">${checkbox} ${inline(m[4])}</span>`,
      };
    }
    m = /^(\s*)([-*+])\s+(.*)$/.exec(expanded);
    if (m) return { indent: m[1].length, tag: "ul", content: inline(m[3]) };
    m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(expanded);
    if (m) return { indent: m[1].length, tag: "ol", content: inline(m[3]) };
    return null;
  };

  /** 该行是否可能作为列表项的续行（缩进 >= 2 且有内容） */
  const isListContinuation = (line) => /^\s{2,}\S/.test(line);

  /**
   * 从 blockLines[startIndex] 起收集一个同层列表（含嵌套）。
   * @param {string[]} blockLines
   * @param {number} startIndex
   * @returns {{ html: string, next: number }}
   */
  const parseList = (blockLines, startIndex) => {
    const base = matchListItem(blockLines[startIndex]);
    const baseIndent = base.indent;
    const tag = base.tag;
    /** @type {{ source: string, sub: string[] }[]} */
    const items = [];
    /** 当前列表项的后继行（更深缩进的内容，或懒续行） */
    let currentSub = [];
    /** 上一个已完成的一级项（用于把 currentSub 挂到它名下） */
    let lastItem = null;
    let i = startIndex;
    let loose = false;

    for (; i < blockLines.length; i++) {
      const raw = blockLines[i];

      // 空行：向后看一行判断列表是否继续（松散列表）
      if (!raw.trim()) {
        const next = blockLines[i + 1];
        const nextItem = next ? matchListItem(next) : null;
        if (nextItem && nextItem.indent >= baseIndent) {
          loose = true;
          currentSub.push("");
          continue;
        }
        break;
      }

      const item = matchListItem(raw);

      if (item) {
        if (item.indent < baseIndent) break;
        // 同缩进但列表类型变了（ul <-> ol）：结束当前列表，交给外层重开
        if (item.indent === baseIndent && item.tag !== tag) break;
        if (item.indent === baseIndent) {
          // 先把上一个项的子行落定，再开新项
          if (lastItem) lastItem.sub = currentSub;
          currentSub = [];
          lastItem = { source: raw, sub: [] };
          items.push(lastItem);
          continue;
        }
        // 更深缩进：属于当前项的子列表
        currentSub.push(raw);
        continue;
      }

      // 非列表行：缩进更深 -> 当前项的子内容
      if (isListContinuation(raw)) {
        currentSub.push(raw);
        continue;
      }
      // 松散列表里无缩进的普通行 -> 视为当前项内的段落
      if (loose && currentSub.length) {
        currentSub.push("");
        currentSub.push(raw);
        continue;
      }
      break;
    }
    // 收束最后一个项的子行
    if (lastItem) lastItem.sub = currentSub;

    let html = `<${tag}>`;
    for (const entry of items) {
      const own = matchListItem(entry.source);
      const contentHtml = own ? own.content : "";
      const subHtml = entry.sub.length ? renderBlocks(blockLines, entry.sub).trim() : "";
      html += `<li>${contentHtml}${subHtml}</li>`;
    }
    html += `</${tag}>`;
    return { html, next: i };
  };

  /** 引用块起始判定 */
  const isQuoteStart = (line) => /^\s{0,3}>/.test(line);

  /**
   * 从 blockLines[startIndex] 起收集引用块（含懒续行）。
   * @returns {{ inner: string[], next: number, depth: number }}
   */
  const parseQuote = (blockLines, startIndex) => {
    const inner = [];
    let depth = 1;
    let i = startIndex;
    for (; i < blockLines.length; i++) {
      const cur = blockLines[i];
      const m = /^\s{0,3}(>+)\s?(.*)$/.exec(cur);
      if (m) {
        depth = Math.max(depth, m[1].length);
        inner.push(m[2]);
        continue;
      }
      // 懒续行：非空，且不是新块起始（标题/列表/分隔线/围栏）
      if (
        cur.trim() &&
        !/^\s*(#{1,6}[ \t]|[-*+]\s|\d+[.)]\s|(`{3,}|~{3,})|(-{3,}|\*{3,}|_{3,})[ \t]*$)/.test(
          cur,
        )
      ) {
        inner.push(cur);
        continue;
      }
      break;
    }
    return { inner, next: i, depth: Math.min(depth, 3) };
  };

  /**
   * 渲染一个块序列。列表/引用的子内容通过传入"子行数组"递归处理。
   * @param {string[]} blockLines 完整行数组（用于取 rawLine 判断硬换行）
   * @param {string[]} [view] 本次要渲染的行子集，默认整个 blockLines
   * @returns {string}
   */
  const renderBlocks = (blockLines, view) => {
    // 每进入一层（含引用/列表递归）都重新提取围栏代码块：
    // 引用里的 ``` 只有在剥掉 "> " 之后才成立，必须在这里而不是全局做。
    // 行内代码同样在这一层提取，保证引用内的 `code` 也能正确高亮。
    const rows = extractFences(view ?? blockLines).map((row) => extractInlineCode(row));
    const out = [];
    let i = 0;

    while (i < rows.length) {
      const rawLine = rows[i];
      const line = rawLine.replace(/\s+$/, "");

      // 代码块 / 表格占位符单独成行（行内代码占位符不可单独放行）
      if (
        /^\s*\u0000ASHMDBLOCK\d+\u0000\s*$/.test(line) ||
        /^\s*\u0000ASHMDTABLE\d+\u0000\s*$/.test(line)
      ) {
        out.push(line.trim());
        i++;
        continue;
      }

      if (!line.trim()) {
        i++;
        continue;
      }

      // ── 表格 ──
      if (line.includes("|") && i + 1 < rows.length && isTableDelimiter(rows[i + 1])) {
        const header = splitTableRow(line);
        const aligns = parseAlignments(rows[i + 1]);
        const body = [];
        let j = i + 2;
        while (j < rows.length && rows[j].trim() && rows[j].includes("|")) {
          body.push(splitTableRow(rows[j]));
          j++;
        }
        const cell = (content, index, tagName) => {
          const align = aligns[index] ?? "";
          const attr = align ? ` style="text-align:${align}"` : "";
          return `<${tagName}${attr}>${inline(content)}</${tagName}>`;
        };
        let html = "<table><thead><tr>";
        html += header.map((c, k) => cell(c, k, "th")).join("");
        html += "</tr></thead><tbody>";
        for (const row of body) {
          html += "<tr>";
          html += row.map((c, k) => cell(c, k, "td")).join("");
          html += "</tr>";
        }
        html += "</tbody></table>";
        out.push(stashTable(html));
        i = j;
        continue;
      }

      // ── Setext 标题 ──
      if (
        i + 1 < rows.length &&
        /^\s*(=+|-+)\s*$/.test(rows[i + 1]) &&
        line.trim() &&
        !matchListItem(line)
      ) {
        const level = rows[i + 1].trim().startsWith("=") ? 1 : 2;
        out.push(`<h${level}>${inline(line.trim())}</h${level}>`);
        i += 2;
        continue;
      }

      // ── ATX 标题（兼容 `#NoSpace`；多于 6 个 # 不算标题）──
      const heading = /^(#{1,6})(?!#)[ \t]*(.*?)[ \t]*#*[ \t]*$/.exec(line);
      if (heading && !matchListItem(line)) {
        const level = heading[1].length;
        out.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
        i++;
        continue;
      }

      // ── 分隔线（先于列表判定，避免 `---` 被当成列表）──
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) && !matchListItem(line)) {
        out.push("<hr>");
        i++;
        continue;
      }

      // ── 引用 ──
      if (isQuoteStart(line)) {
        const quote = parseQuote(rows, i);
        let html = renderBlocks(quote.inner).trim();
        for (let k = 0; k < quote.depth; k++) html = `<blockquote>${html}</blockquote>`;
        out.push(html);
        i = quote.next;
        continue;
      }

      // ── 列表 ──
      if (matchListItem(line)) {
        const list = parseList(rows, i);
        out.push(list.html);
        i = list.next;
        continue;
      }

      // ── 段落（含硬换行）──
      // 行尾两个以上空格 / 反斜杠 = 硬换行；反斜杠需先从正文剥掉。
      const hardBreak = /(?: {2,}|\\)$/.test(rawLine);
      const body = hardBreak && line.endsWith("\\") ? line.slice(0, -1) : line;
      out.push(`<p>${inline(body)}${hardBreak ? "<br>" : ""}</p>`);
      i++;
    }

    return out.join("");
  };

  return restorePlaceholders(renderBlocks(source.split("\n")));
};
