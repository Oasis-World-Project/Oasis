// 任务名：用户确认的任务单的标题；没有任务单就是那句要求的开头（答题、确认时往回找）。
import { describe, expect, it } from 'vitest';
import { opening, taskTitle, type Said } from '../src/service/task-title.ts';

const user = (content: string): Said => ({ author: 'user', kind: 'text', content });
const ai = (content: string): Said => ({ author: 'ai', kind: 'text', content });
const plan = (title: string) =>
  ai(
    `先看任务单：\n\n\`\`\`oasis-plan\n${JSON.stringify({ title, steps: ['写分镜'] })}\n\`\`\`\n\n确认就开始。`,
  );
const questions = ai(
  '先问一个问题：\n\n```oasis-questions\n{"questions":[{"id":"q1","text":"视频比例？","options":["竖屏 9:16","横屏 16:9"]}]}\n```',
);

describe('任务名', () => {
  it('没有任务单：就是这句要求的开头（第一行，到第一个句号、冒号为止，太长截短）', () => {
    expect(taskTitle([user('hi'), ai('你好！有什么要做的？')], '画一只橘猫')).toBe('画一只橘猫');
    expect(
      opening(
        '给「拾光咖啡」的秋季新品桂花拿铁做一条 7秒左右的竖屏短视频：3 个镜头\n每个镜头先出关键帧',
      ),
    ).toBe('给「拾光咖啡」的秋季新品桂花拿铁做一条 7秒左右的竖屏短视频');
    expect(opening('长'.repeat(40))).toBe(`${'长'.repeat(30)}…`);
    expect(taskTitle([], '   ')).toBe('未命名任务');
  });

  it('确认任务单：用任务单的标题；回的是一句新的要求就不用', () => {
    const before = [user('给拾光咖啡做个短视频'), plan('拾光咖啡 · 桂花拿铁 7 秒竖屏短片')];
    expect(taskTitle(before, '确认，开始做')).toBe('拾光咖啡 · 桂花拿铁 7 秒竖屏短片');
    expect(taskTitle(before, '算了，先帮我写一份开业活动的宣传文案，三段')).toBe(
      '算了，先帮我写一份开业活动的宣传文案，三段',
    );
  });

  it('答题：往回找那句要求；答完题、再确认任务单时用任务单的标题', () => {
    const before = [user('做一条开业短视频，介绍新店'), questions];
    expect(taskTitle(before, '1. 视频比例？——竖屏 9:16')).toBe('做一条开业短视频，介绍新店');
    expect(
      taskTitle([...before, user('1. 视频比例？——竖屏 9:16'), plan('开业短视频')], '确认，开始做'),
    ).toBe('开业短视频');
  });

  it('开了新话题就不往前找；任务卡不算 AI 说的话', () => {
    const divider: Said = { author: 'user', kind: 'topic', content: '开了新话题' };
    expect(taskTitle([plan('旧任务'), divider], '可以')).toBe('可以');
    const card: Said = { author: 'ai', kind: 'task', content: '任务结束' };
    expect(taskTitle([user('做海报'), plan('海报'), card], '确认，开始做')).toBe('海报');
  });
});
