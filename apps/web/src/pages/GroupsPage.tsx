import { PageHeader } from '../ui/PageHeader.tsx';
import { EmptyHint, Panel } from '../ui/Panel.tsx';

export function GroupsPage() {
  return (
    <>
      <PageHeader title="群聊" description="和朋友、和各家 AI 在同一个群里聊天、发任务。" />
      <Panel title="我的群">
        <EmptyHint>还没有群。拉群后，你参与的所有群会列在这里。</EmptyHint>
      </Panel>
    </>
  );
}
