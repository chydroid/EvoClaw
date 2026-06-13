/**
 * Shared Markdown-to-HTML Renderer
 *
 * Converts markdown text to styled HTML for use across the web UI.
 * Used by WebChatPage for chat messages and SkillsConfig for skill instructions/examples.
 */

import { htmlEscape } from "./highlight";

/**
 * Simple inline format for text that shouldn't go through the full markdown pipeline.
 * Handles bold, italic, code, and emoji - but not links or auto-linking.
 */
function inlineFormatSimple(s: string): string {
  let formatted = htmlEscape(s);
  formatted = formatted.replace(/`([^`]+)`/g, (_, code) => {
    return `<code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:3px;font-size:13px;">${code}</code>`;
  });
  formatted = formatted.replace(/\*\*(.+?)\*\*/g, (_, bold) => {
    return `<strong style="color:var(--text-primary);">${bold}</strong>`;
  });
  formatted = formatted.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, italic) => {
    return `<em>${italic}</em>`;
  });
  return formatted;
}

export function renderMarkdown(text: string): string {
  const decoded = text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&ensp;/g, " ")
    .replace(/&emsp;/g, "  ")
    .replace(/&nbsp;/g, " ")
    .replace(/&thinsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&lsquo;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"');

  // ── Pre-process: extract <details>...</details> blocks and replace with placeholders ──
  // This prevents the markdown parser from escaping the HTML tags inside details blocks.
  const detailsBlocks: string[] = [];
  const preprocessed = decoded.replace(/<details([^>]*)>([\s\S]*?)<\/details>/gi, (match, attrs, content) => {
    // Parse the content: extract <summary>...</summary> and body
    const summaryMatch = content.match(/<summary([^>]*)>([\s\S]*?)<\/summary>/i);
    const summaryText = summaryMatch ? summaryMatch[2].trim() : "Details";
    const bodyContent = summaryMatch
      ? content.slice(summaryMatch.index! + summaryMatch[0].length).trim()
      : content.trim();

    // Render the body content through markdown (recursive)
    const renderedBody = renderMarkdown(bodyContent);
    const renderedSummary = inlineFormatSimple(summaryText);

    // Instead of using attrs directly, filter to only safe attributes (including unquoted values)
    const filterOnAttrs = (s: string) => s.replace(/\s*on\w+\s*=\s*"[^"]*"/gi, '').replace(/\s*on\w+\s*=\s*'[^']*'/gi, '').replace(/\s*on\w+\s*=\s*[^\s>]+/gi, '');
    const safeAttrs = filterOnAttrs(attrs);

    const idx = detailsBlocks.length;
    detailsBlocks.push(
      `<details${safeAttrs} style="margin:8px 0;border:1px solid var(--border,rgba(255,255,255,0.1));border-radius:6px;padding:0;">` +
      `<summary${summaryMatch ? filterOnAttrs(summaryMatch[1]) : ""} style="cursor:pointer;padding:8px 12px;font-weight:500;color:var(--text-primary);user-select:none;">${renderedSummary}</summary>` +
      `<div style="padding:4px 12px 12px;border-top:1px solid var(--border,rgba(255,255,255,0.1));">${renderedBody}</div>` +
      `</details>`
    );
    return `\x00DETAILS${idx}\x00`;
  });

  const lines = preprocessed.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeBlockLines: string[] = [];
  let inTable = false;
  let tableRows: string[][] = [];
  let tableAlign: string[] = [];
  let inList = false;
  let listType: "ul" | "ol" = "ul";
  let listItems: string[] = [];

  const closeList = () => {
    if (inList) {
      const tag = listType;
      result.push(
        `<${tag} style="margin:4px 0;padding-left:20px;">${listItems.map((li) => `<li style="margin:2px 0;">${li}</li>`).join("")}</${tag}>`
      );
      inList = false;
      listItems = [];
    }
  };

  const closeTable = () => {
    if (inTable && tableRows.length > 0) {
      const headerRow = tableRows[0];
      const bodyRows = tableRows.slice(1);
      // Force the table to fill the bubble width. Cells keep content on one
      // line; the wrapping div scrolls horizontally when the content is wider
      // than the bubble.
      result.push('<div style="overflow-x:auto;width:100%;margin:8px 0;">');
      result.push('<table style="border-collapse:collapse;width:100%;font-size:13px;table-layout:auto;">');
      result.push("<thead><tr>");
      headerRow.forEach((cell, i) => {
        const align = tableAlign[i] || "left";
        result.push(
          `<th style="border:1px solid var(--border,rgba(255,255,255,0.1));padding:6px 12px;text-align:${align};background:var(--bg-tertiary,#21262d);font-weight:600;white-space:nowrap;word-break:keep-all;">${cell}</th>`
        );
      });
      result.push("</tr></thead>");
      if (bodyRows.length > 0) {
        result.push("<tbody>");
        bodyRows.forEach((row) => {
          result.push("<tr>");
          row.forEach((cell, i) => {
            const align = tableAlign[i] || "left";
            result.push(
              `<td style="border:1px solid var(--border,rgba(255,255,255,0.1));padding:6px 12px;text-align:${align};white-space:nowrap;word-break:keep-all;">${cell}</td>`
            );
          });
          result.push("</tr>");
        });
        result.push("</tbody>");
      }
      result.push("</table></div>");
      inTable = false;
      tableRows = [];
      tableAlign = [];
    }
  };

  const inlineFormat = (s: string): string => {
    let formatted = s;
    const linkPlaceholders: string[] = [];
    const colorSpanPlaceholders: string[] = [];

    // Preserve <span style="color:...">...</span> tags before escaping
    formatted = formatted.replace(/<span\s+style="color:[^"]*"[^>]*>[\s\S]*?<\/span>/gi, (match) => {
      const idx = colorSpanPlaceholders.length;
      colorSpanPlaceholders.push(match);
      return `\x00COLORSPAN${idx}\x00`;
    });

    formatted = formatted.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (match, text, link) => {
      const escapedText = htmlEscape(text);
      const escapedLink = htmlEscape(link);
      const html = `<a href="${escapedLink}" target="_blank" rel="noopener" style="color:var(--accent);">${escapedText}</a>`;
      const idx = linkPlaceholders.length;
      linkPlaceholders.push(html);
      return `\x00LINK${idx}\x00`;
    });
    formatted = formatted.replace(/\[([^\]]+)\]\((\/[^\s)]+)\)/g, (match, text, link) => {
      const escapedText = htmlEscape(text);
      const escapedLink = htmlEscape(link);
      const html = `<a href="${escapedLink}" target="_blank" rel="noopener" style="color:var(--accent);">${escapedText}</a>`;
      const idx = linkPlaceholders.length;
      linkPlaceholders.push(html);
      return `\x00LINK${idx}\x00`;
    });

    const parts = formatted.split(/((?<!href=")(?:https?:\/\/[^\s<>\[\]()]+|\/api\/[^\s<>\[\]()]+))/g);
    formatted = parts.map((part, index) => {
      if (index % 2 === 1) {
        const extraAttrs = ' target="_blank" rel="noopener"';
        return `<a href="${htmlEscape(part)}" style="color:var(--accent);"${extraAttrs}>${htmlEscape(part)}</a>`;
      } else {
        let text = htmlEscape(part);
        text = text.replace(/`([^`]+)`/g, (_, code) => {
          return `<code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:3px;font-size:13px;">${code}</code>`;
        });
        text = text.replace(/\*\*(.+?)\*\*/g, (_, bold) => {
          return `<strong style="color:var(--text-primary);">${bold}</strong>`;
        });
        text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, italic) => {
          return `<em>${italic}</em>`;
        });
        return text;
      }
    }).join("");

    for (let i = linkPlaceholders.length - 1; i >= 0; i--) {
      formatted = formatted.replace(`\x00LINK${i}\x00`, linkPlaceholders[i]);
    }

    for (let i = colorSpanPlaceholders.length - 1; i >= 0; i--) {
      formatted = formatted.replace(`\x00COLORSPAN${i}\x00`, colorSpanPlaceholders[i]);
    }

    // In the color span replacement, validate that only color property is used
    formatted = formatted.replace(/style="color:[^"]*"/g, (match) => {
      const styleContent = match.match(/style="([^"]*)"/)?.[1] || '';
      // Only allow color property
      if (/^color:/i.test(styleContent.trim()) && !/;(?!\s*$)/.test(styleContent.replace(/color:[^;]+;?/i, ''))) {
        return match;
      }
      // If there are other properties, extract only color
      const colorMatch = styleContent.match(/color:\s*[^;]+/i);
      return colorMatch ? `style="${colorMatch[0]}"` : '';
    });

    return formatted;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (line.startsWith("```")) {
      if (inCodeBlock) {
        const safeLang = (codeBlockLang || "code").replace(/["'<>]/g, "");
        result.push(
          `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-lang-label">${safeLang}</span></div><pre class="code-block-pre"><code>${codeBlockLines.map((l) => htmlEscape(l)).join("\n")}</code></pre></div>`
        );
        inCodeBlock = false;
        codeBlockLines = [];
        codeBlockLang = "";
      } else {
        closeList();
        closeTable();
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
        codeBlockLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.every((c) => /^[-:]+$/.test(c))) {
        tableAlign = cells.map((c) => {
          if (c.startsWith(":") && c.endsWith(":")) return "center";
          if (c.endsWith(":")) return "right";
          return "left";
        });
        continue;
      }
      inTable = true;
      closeList();
      tableRows.push(cells.map((c) => inlineFormat(c)));
      continue;
    } else if (inTable) {
      closeTable();
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) {
      closeList();
      result.push('<hr style="border:none;border-top:1px solid var(--border,rgba(255,255,255,0.1));margin:12px 0;"/>');
      continue;
    }

    const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      closeList();
      const level = headerMatch[1].length;
      const sizes: Record<number, string> = { 1: "20px", 2: "18px", 3: "16px", 4: "15px", 5: "14px", 6: "13px" };
      result.push(
        `<h${level} style="font-size:${sizes[level]};font-weight:600;margin:12px 0 6px;padding-bottom:4px;border-bottom:1px solid var(--border,rgba(255,255,255,0.08));color:var(--text-primary);">${inlineFormat(headerMatch[2])}</h${level}>`
      );
      continue;
    }

    if (trimmed.startsWith(">")) {
      closeList();
      const quoteContent = trimmed.slice(1).trim();
      result.push(
        `<blockquote style="border-left:3px solid var(--accent,#58a6ff);padding:4px 12px;margin:6px 0;background:var(--bg-tertiary,rgba(255,255,255,0.04));color:var(--text-secondary);">${inlineFormat(quoteContent)}</blockquote>`
      );
      continue;
    }

    const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (ulMatch) {
      closeTable();
      if (!inList || listType !== "ul") {
        closeList();
        inList = true;
        listType = "ul";
      }
      listItems.push(inlineFormat(ulMatch[1]));
      continue;
    }

    const olMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (olMatch) {
      closeTable();
      if (!inList || listType !== "ol") {
        closeList();
        inList = true;
        listType = "ol";
      }
      listItems.push(inlineFormat(olMatch[2]));
      continue;
    }

    closeList();
    if (trimmed === "") {
      result.push('<div style="height:8px;"></div>');
    } else {
      result.push(`<p style="margin:4px 0;line-height:1.6;">${inlineFormat(trimmed)}</p>`);
    }
  }

  if (inCodeBlock) {
    const safeLang = (codeBlockLang || "code").replace(/["'<>]/g, "");
    result.push(
      `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-lang-label">${safeLang}</span></div><pre class="code-block-pre"><code>${codeBlockLines.map((l) => htmlEscape(l)).join("\n")}</code></pre></div>`
    );
  }
  closeList();
  closeTable();

  // Restore <details> block placeholders
  let finalResult = result.join("");
  for (let i = detailsBlocks.length - 1; i >= 0; i--) {
    finalResult = finalResult.replace(`\x00DETAILS${i}\x00`, detailsBlocks[i]);
  }

  return finalResult;
}