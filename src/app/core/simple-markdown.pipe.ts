import { Pipe, PipeTransform } from '@angular/core';

/**
 * Minimal, safe formatting for agent replies: escapes HTML first, then
 * supports **bold**, `code`, fenced code blocks and "- " bullet lines.
 * The result is bound via [innerHTML], which Angular sanitises again.
 */
@Pipe({ name: 'simpleMarkdown' })
export class SimpleMarkdownPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    if (!value) return '';
    const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const blocks: string[] = [];
    const withFences = escaped.replace(/```[a-z]*\n([\s\S]*?)```/g, (_m, code: string) => {
      blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
      return `\u0000${blocks.length - 1}\u0000`;
    });
    const lines = withFences.split('\n');
    const out: string[] = [];
    let inList = false;
    for (const line of lines) {
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        if (!inList) {
          out.push('<ul>');
          inList = true;
        }
        out.push(`<li>${inline(bullet[1])}</li>`);
        continue;
      }
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      out.push(line.trim() === '' ? '' : `<p>${inline(line)}</p>`);
    }
    if (inList) out.push('</ul>');
    return out.join('').replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)]);
  }
}

function inline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
