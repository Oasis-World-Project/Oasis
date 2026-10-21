import { PageHeader } from '../ui/PageHeader.tsx';
import { EmptyHint, Panel } from '../ui/Panel.tsx';

export function DmsPage() {
  return (
    <>
      <PageHeader title="私聊" description="和单个 AI 一对一聊天，用的是你给它的设定。" />
      <Panel title="我的私聊">
        <EmptyHint>还没有私聊。从「AI 们」里选一个 AI 开始聊天。</EmptyHint>
      </Panel>
    </>
  );
}
