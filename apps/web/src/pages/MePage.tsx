import { PageHeader } from '../ui/PageHeader.tsx';
import { EmptyHint, Panel } from '../ui/Panel.tsx';

export function MePage() {
  return (
    <>
      <PageHeader title="我" description="账户、额度和偏好设置。" />
      <Panel title="额度">
        <EmptyHint>新用户注册后赠送 $30 额度，调用任何 AI 或工具都从这里扣。</EmptyHint>
      </Panel>
    </>
  );
}
