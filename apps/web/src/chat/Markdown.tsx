// 预览 Markdown 成果用的简单渲染：标题、段落、列表、引用、代码块、粗体和行内代码。
// 直接生成 React 元素，不拼 HTML，AI 写的内容里就算有标签也只会原样显示成文字。
import type { ReactNode } from 'react';

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'paragraph'; text: string };

const LIST_ITEM = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/;

function parse(source: string): Block[] {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    if (line.startsWith('```')) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) code.push(lines[i++] ?? '');
      blocks.push({ kind: 'code', text: code.join('\n') });
      i += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, text: heading[2] ?? '' });
      i += 1;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = item[1] !== undefined;
      const items: string[] = [];
      let m: RegExpExecArray | null = item;
      while (m && (m[1] !== undefined) === ordered) {
        items.push(m[2] ?? '');
        i += 1;
        m = LIST_ITEM.exec(lines[i] ?? '');
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    if (line.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && (lines[i] ?? '').startsWith('>'))
        quote.push((lines[i++] ?? '').replace(/^>\s?/, ''));
      blocks.push({ kind: 'quote', text: quote.join('\n') });
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !/^(#{1,6}\s|```|>)/.test(lines[i] ?? '') &&
      !LIST_ITEM.test(lines[i] ?? '')
    ) {
      paragraph.push(lines[i++] ?? '');
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }
  return blocks;
}

/** 行内：**粗体** 和 `代码` */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
      return (
        <code key={index} className="rounded bg-track px-1 py-0.5 text-[0.92em]">
          {part.slice(1, -1)}
        </code>
      );
    return part;
  });
}

const HEADING_CLASS = [
  'text-[24px] font-light',
  'text-[19px] font-medium',
  'text-[16px] font-medium',
];

export function Markdown({ source }: { source: string }) {
  return (
    <div className="flex flex-col gap-3.5 text-[14.5px] leading-[1.75] text-ink">
      {parse(source).map((block, index) => {
        switch (block.kind) {
          case 'heading': {
            const Tag = `h${Math.min(block.level + 1, 6)}` as 'h2';
            return (
              <Tag
                key={index}
                className={`m-0 mt-2 leading-snug ${HEADING_CLASS[Math.min(block.level, 3) - 1]}`}
              >
                {inline(block.text)}
              </Tag>
            );
          }
          case 'list': {
            const List = block.ordered ? 'ol' : 'ul';
            return (
              <List
                key={index}
                className={`m-0 flex flex-col gap-1 pl-5 ${block.ordered ? 'list-decimal' : 'list-disc'}`}
              >
                {block.items.map((item, i) => (
                  <li key={i}>{inline(item)}</li>
                ))}
              </List>
            );
          }
          case 'quote':
            return (
              <blockquote
                key={index}
                className="m-0 whitespace-pre-wrap rounded-item bg-glass-strong px-4 py-2.5 text-ink-muted"
              >
                {inline(block.text)}
              </blockquote>
            );
          case 'code':
            return (
              <pre
                key={index}
                className="m-0 overflow-x-auto rounded-item bg-track px-4 py-3 text-[13px] leading-relaxed"
              >
                <code>{block.text}</code>
              </pre>
            );
          case 'paragraph':
            return (
              <p key={index} className="m-0 whitespace-pre-wrap">
                {inline(block.text)}
              </p>
            );
        }
      })}
    </div>
  );
}
