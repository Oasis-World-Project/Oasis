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

  it('表格画成表格：表头、每行的格子、对齐；格子不够的行补空；后面的段落照常', () => {
    render(
      <Markdown
        source={
          '签到表\n| 序号 | 姓名 | 小计 |\n| :--: | :--- | ---: |\n| 1 | **林夏** | 45 |\n| 2 | 阿杰 |\n\n共 2 人'
        }
      />,
    );
    expect(screen.getByText('签到表').tagName).toBe('P');
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      '序号',
      '姓名',
      '小计',
    ]);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getAllByRole('cell')).toHaveLength(6);
    expect(screen.getByText('林夏').tagName).toBe('STRONG');
    expect(screen.getByRole('cell', { name: '45' }).style.textAlign).toBe('right');
    expect(screen.getByText('共 2 人').tagName).toBe('P');
  });

  it('内容里的 HTML 只当文字显示', () => {
    const { container } = render(<Markdown source={'<img src=x onerror=alert(1)> 你好'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeTruthy();
  });
});
