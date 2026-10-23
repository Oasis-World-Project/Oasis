import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/chat/Markdown.tsx';

describe('Markdown 预览', () => {
  it('标题、列表、段落和粗体都能显示', () => {
    render(<Markdown source={'# 标题\n\n第一段**重点**\n\n- 一\n- 二\n\n1. 甲\n2. 乙'} />);
    expect(screen.getByRole('heading', { name: '标题' })).toBeTruthy();
    expect(screen.getByText('重点').tagName).toBe('STRONG');
    const lists = screen.getAllByRole('list');
    expect(lists.map((l) => l.tagName)).toEqual(['UL', 'OL']);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });

  it('内容里的 HTML 只当文字显示', () => {
    const { container } = render(<Markdown source={'<img src=x onerror=alert(1)> 你好'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeTruthy();
  });
});
