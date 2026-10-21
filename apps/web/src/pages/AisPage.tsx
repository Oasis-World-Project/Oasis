import { PageHeader } from '../ui/PageHeader.tsx';
import { EmptyHint, Panel } from '../ui/Panel.tsx';

export function AisPage() {
  return (
    <>
      <PageHeader
        title="AI 们"
        description="14 个对话 AI 可以私聊、拉进群、单独设置；图像、视频、音频等工具模型只能查看，由对话 AI 在干活时调用。"
      />
      <Panel title="模型目录">
        <EmptyHint>
          8
          个分类的模型会列在这里：大语言模型、图像生成、视觉理解、视频生成、音频、向量、3D、其他模型。
        </EmptyHint>
      </Panel>
    </>
  );
}
