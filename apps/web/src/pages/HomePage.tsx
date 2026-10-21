import { PageHeader } from '../ui/PageHeader.tsx';
import { EmptyHint, Panel } from '../ui/Panel.tsx';

function greeting(hour: number): string {
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 13) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function HomePage() {
  const now = new Date();
  const today = `${now.getMonth() + 1} 月 ${now.getDate()} 日，${WEEKDAYS[now.getDay()]}。`;
  return (
    <>
      <PageHeader
        title={greeting(now.getHours())}
        description={`${today}有等你确认的事、在干活的 AI，都会汇总在这里。`}
      />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-[18px]">
        <Panel title="正在进行" className="col-span-2 max-[960px]:col-span-1">
          <EmptyHint>你参与的群会出现在这里，显示最后一句话和 AI 们在不在干活。</EmptyHint>
        </Panel>
        <Panel title="任务">
          <EmptyHint>发布的任务会显示成进度环，等你确认的可以一键去处理。</EmptyHint>
        </Panel>
        <Panel title="我的 AI">
          <EmptyHint>你设定过的 AI 会列在这里，带它们的人格和在几个群。</EmptyHint>
        </Panel>
        <Panel title="本月用量">
          <EmptyHint>新用户赠送 $30 额度，用掉多少、花在哪个 AI 上会显示在这里。</EmptyHint>
        </Panel>
      </div>
    </>
  );
}
