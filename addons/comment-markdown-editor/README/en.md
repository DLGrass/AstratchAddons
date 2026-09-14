# Markdown Comment Editor

Write Markdown directly inside workspace comments and switch to a live preview at any time. Comments can finally be laid out like documents — headings, lists, tables and code blocks all render properly instead of being crammed into one block of plain text.

> Enabling this addon will make comments non-collapsible.

## Usage

A toggle button appears on the right side of the comment top bar. Click it to switch between two modes:

| Mode | Button | Description |
| --- | --- | --- |
| Edit | Edit | A regular text box where you type Markdown |
| Preview | Preview | The text box is hidden and the rendered result is shown |

- You can also press **Ctrl+M** to toggle. The shortcut only works while the focus is inside that comment (or while it is already in preview mode), so it never interferes with other input in the workspace.
- Every time you enter preview mode the current content is rendered again — edit, then switch over to see the result.
- The preview area scrolls on its own, so long comments never burst out of the comment box.

## Supported syntax

### Block level

| Syntax | How to write it |
| --- | --- |
| Headings | `# H1` through `###### H6`, or text followed by a `===` / `---` line |
| Horizontal rule | `---`, `***` or `___` |
| Blockquote | `> text`, supports `>>` nesting and lazy continuation lines |
| Unordered list | Start a line with `- `, `* ` or `+ ` |
| Ordered list | Start a line with `1. ` or `1) `; the starting number can be anything |
| Nested list | Indent 2 more spaces per level |
| Task list | `- [ ]` todo, `- [x]` done (the checkboxes are read-only) |
| Code block | Wrap in three backticks or three tildes, optionally with a language |
| Table | A header row plus a `| --- | --- |` delimiter row; use `:---`, `:---:` and `---:` for left / center / right alignment |
| Hard line break | Two trailing spaces or a trailing `\` |

Code block example:

````markdown
```js
const message = 'Hello world';
```
````

### Inline

| Syntax | How to write it |
| --- | --- |
| Bold | `**bold**` or `__bold__` |
| Italic | `*italic*` or `_italic_` |
| Bold italic | `***bold italic***` |
| Strikethrough | `~~strikethrough~~` |
| Highlight | `==highlight==` |
| Inline code | `` `code` `` |
| Link | `[label](https://example.com)` |
| Autolink | `<https://example.com>` |
| Image | `![alt](https://example.com/a.png)` |
| Escape | Put a `\` before a punctuation mark, e.g. `\*asterisks\*` |

These can be combined — lists inside blockquotes, code blocks inside list items, and bold plus inline code inside table cells all render correctly.

## Settings

| Name | Default | Description |
| --- | --- | --- |
| Default mode | `edit` | The mode a comment opens in |
| Toggle shortcut | `Ctrl+M` | Keyboard shortcut to switch between edit and preview |
| Render raw HTML | `false` | Whether to pass raw HTML inside comments through |

### Default mode

Decides which mode is used when a comment is created or loaded.

**`edit`** (default): start in edit mode to write the content, then switch to preview when needed.

**`preview`**: open straight into the rendered result — handy when comments are used as project documentation.

### Toggle shortcut

The keyboard shortcut used to switch between edit and preview, for example `Ctrl+M`, `Alt+M` or `Ctrl+Shift+M`.

- At least one modifier key (`Ctrl` / `Alt` / `Shift`) is required. A bare single letter falls back to the default `Ctrl+M`, so it never swallows your normal typing.
- The shortcut only applies while the focus is inside the comment.

### Render raw HTML

When **enabled**, raw HTML written inside comments is rendered as-is. Only enable this for your own, trusted projects.

When **disabled** (default), all HTML is escaped, so anything like `<script>` is shown as plain text.

## Security

- Comment content is **escaped by default**; no HTML or script written in a comment is ever executed.
- Links are restricted to `http`, `https`, `mailto` and the in-page anchor `#`.
- Images are restricted to `http`, `https` and `data:image/`.
- Dangerous protocols such as `javascript:` are blocked — links fall back to `#`, and images are shown as plain text.
