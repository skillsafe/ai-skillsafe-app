import { marked } from "marked";

/**
 * Mirror of skillsafe.ai/web's `renderMarkdownWithFrontmatter` so SKILL.md
 * documents render the same in this desktop client as on the website.
 *
 * If the input begins with a YAML frontmatter block, the frontmatter is
 * parsed (regex, no external lib) and emitted as an `.fm-table` 2-column
 * key/value table; the rest of the body is passed through `marked`.
 */
export function renderMarkdown(content: string): string {
  if (!content) return "";
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fmMatch) return marked.parse(content, { async: false }) as string;

  const fmBlock = fmMatch[1];
  const body = fmMatch[2];
  const rows: [string, string][] = [];
  let currentKey = "";
  let inList = false;
  const listItems: string[] = [];

  function flushList() {
    if (inList && currentKey) {
      rows.push([currentKey, listItems.join(", ")]);
      listItems.length = 0;
      inList = false;
      currentKey = "";
    }
  }

  for (const line of fmBlock.split(/\r?\n/)) {
    const listItem = line.match(/^\s+-\s+(.+)$/);
    if (listItem) {
      inList = true;
      listItems.push(listItem[1].replace(/^["']|["']$/g, ""));
      continue;
    }
    flushList();
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      const val = kv[2].replace(/^["']|["']$/g, "").trim();
      if (val) {
        rows.push([currentKey, val]);
        currentKey = "";
      }
    }
  }
  flushList();

  let html = "";
  if (rows.length > 0) {
    html += `<table class="fm-table"><tbody>`;
    for (const [key, val] of rows) {
      html += `<tr><td class="fm-key">${escapeHtml(key)}</td><td class="fm-val">${escapeHtml(val)}</td></tr>`;
    }
    html += `</tbody></table>`;
  }
  html += marked.parse(body, { async: false }) as string;
  return html;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
