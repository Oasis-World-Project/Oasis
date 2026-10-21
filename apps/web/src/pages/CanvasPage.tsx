import { PageHeader } from '../ui/PageHeader.tsx';
import { EmptyHint, Panel } from '../ui/Panel.tsx';

export function CanvasPage() {
  return (
    <>
      <PageHeader
        title="画布"
        description="AI 们交付的所有成果，按任务汇总，可以按类别和群筛选。"
      />
      <Panel title="全部成果">
        <EmptyHint>
          任务完成后，文档、图片等成果会出现在这里，打开就能圈画批注、发给 AI 修改。
        </EmptyHint>
      </Panel>
    </>
  );
}
