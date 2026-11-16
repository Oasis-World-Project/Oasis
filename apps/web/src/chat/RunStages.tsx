// 进度页下半部：过程。AI 每说一句话是一段，一段一个框，按先后连成一条线：框里是那句话、状态和用时、
// 折叠的步骤（点开看每一步）、系统提示。做出的东西在上面的成果里，这里不重复放；用户的话不放。
import { Info } from 'lucide-react';
import { ProcessFold, StepIcon } from './Process.tsx';
import { splitBlocks } from './blocks.ts';
import { Markdown } from './Markdown.tsx';
import type { Stage } from './run-progress.ts';
import { elapsedText } from './TaskCard.tsx';

const STATUS: Record<Stage['status'], string> = {
  running: '进行中',
  done: '完成',
  failed: '有没做成的',
};

/** 这段说的话：问卷、任务单不在这里画成卡片，只说一句去私聊里看 */
function Said({ text }: { text: string }) {
  if (!text.trim()) return <p className="m-0 text-ink-muted">开始动手</p>;
  return (
    <>
      {splitBlocks(text).map((block, index) =>
        block.kind === 'text' ? (
          <div key={index} className="[overflow-wrap:anywhere]">
            <Markdown source={block.text} />
          </div>
        ) : (
          <p key={index} className="m-0 text-[12.5px] text-ink-muted">
            {block.kind === 'questions'
              ? '（这里有几道题，在私聊里答）'
              : `（任务单「${block.data.title}」，在私聊里看）`}
          </p>
        ),
      )}
    </>
  );
}

export function RunStages({ stages, now }: { stages: Stage[]; now: number }) {
  return (
    <section aria-label="过程" className="flex flex-col gap-2.5">
      <h2 className="m-0 text-[13px] font-medium text-ink-muted">过程</h2>
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {stages.map((stage, index) => {
          const started = stage.startedAt ? Date.parse(stage.startedAt) : undefined;
          const ended =
            stage.status === 'running' ? now : stage.finishedAt ? Date.parse(stage.finishedAt) : 0;
          return (
            <li key={stage.key} className="relative pl-10">
              <span
                aria-hidden="true"
                className={`absolute left-0 top-3 flex size-7 items-center justify-center rounded-full font-display text-[12px] font-medium ${
                  stage.status === 'running' ? 'bg-accent text-on-accent' : 'bg-solid text-on-solid'
                }`}
              >
                {index + 1}
              </span>
              {index < stages.length - 1 && (
                <span
                  aria-hidden="true"
                  className="absolute bottom-[-12px] left-[13px] top-10 w-px bg-track"
                />
              )}
              <article
                aria-label={`第 ${index + 1} 段`}
                className="flex flex-col gap-2 rounded-card bg-glass-strong px-4 py-3 text-[14px] leading-relaxed shadow-edge-strong"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <Said text={stage.text} />
                  </div>
                  <span className="flex shrink-0 items-center gap-1.5 pt-1 text-[12px] text-ink-muted">
                    <StepIcon status={stage.status} />
                    {STATUS[stage.status]}
                    {started !== undefined &&
                      ended > started &&
                      ` · ${elapsedText(ended - started)}`}
                  </span>
                </div>
                {stage.steps.length > 0 && <ProcessFold parts={stage.steps} live={false} />}
                {stage.notices.map((text, at) => (
                  <p
                    key={at}
                    className="m-0 flex items-center gap-1.5 text-[12.5px] text-ink-muted"
                  >
                    <Info size={13} aria-hidden="true" />
                    {text}
                  </p>
                ))}
              </article>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
