// 节点详情面板的几块：小标题、上下游（谁交来什么、交给谁，只读）、追问和补要求的输入框。
import type { NodeBody, TaskBody } from '@oasis/contracts/task';
import { ArrowUp } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { messageNode } from '../api/queries.ts';
import type { WorkflowActions } from './use-workflow-actions.ts';

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 text-[12px] font-normal text-ink-muted">{title}</h3>
      {children}
    </section>
  );
}

const chip =
  'inline-flex h-8 max-w-full items-center gap-1 rounded-full bg-track px-3 text-[12.5px]';
export const smallButton =
  'h-8 rounded-full border-0 bg-track px-3 text-[12.5px] font-medium text-ink disabled:cursor-not-allowed disabled:opacity-40';

/** 上下游：谁交来什么、交给谁 */
export function Links({ task, node }: { task: TaskBody; node: NodeBody }) {
  const nodeOf = (id: string | null) => task.nodes.find((n) => n.id === id);
  const incoming = task.edges.filter((e) => e.to === node.id && nodeOf(e.from));
  const outgoing = task.edges.filter((e) => e.from === node.id && nodeOf(e.to));
  return (
    <>
      <Section title="从上游拿到">
        {incoming.length === 0 && (
          <p className="m-0 text-[13px] text-ink-muted">没有上游，直接从任务开始做。</p>
        )}
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {incoming.map((edge) => {
            const from = nodeOf(edge.from);
            return (
              <li key={edge.id} className={chip}>
                <span className="truncate">
                  {from?.title}
                  {from && from.outputs.length > 0 && (
                    <span className="text-ink-muted"> · {from.outputs.length} 个文件</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </Section>
      {outgoing.length > 0 && (
        <Section title="交给下游">
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {outgoing.map((edge) => (
              <li key={edge.id} className={chip}>
                <span className="truncate">{nodeOf(edge.to)?.title}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

export function Ask({
  task,
  node,
  actions,
}: {
  task: TaskBody;
  node: NodeBody;
  actions: WorkflowActions;
}) {
  const [text, setText] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const running = node.status === 'running' && node.kind === 'work';
  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    const result = await actions.run('ask', () => messageNode(task.id, node.id, value));
    if (result) {
      setText('');
      setSent(
        result.result === 'delivered'
          ? '已经告诉它了，它做完手上这一步就会看到。'
          : '记下了，开跑或继续时会带上。',
      );
    }
  }
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-1.5 border-t border-hairline px-4 pb-4 pt-3"
    >
      {sent && (
        <p role="status" className="m-0 text-[12px] text-ink-muted">
          {sent}
        </p>
      )}
      <div className="flex items-center gap-1.5 rounded-full bg-glass-active py-1 pl-4 pr-1 shadow-edge-strong">
        <label htmlFor="node-ask" className="sr-only">
          {running ? '问问这个节点' : '给这个节点补要求'}
        </label>
        <input
          id="node-ask"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSent(null);
          }}
          disabled={actions.busy !== null}
          placeholder={running ? '问问这个节点，或者补一句要求…' : '补一句要求，开跑时带上…'}
          className="h-9 min-w-0 flex-1 border-0 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-muted"
        />
        <button
          type="submit"
          aria-label="发送"
          disabled={actions.busy !== null || !text.trim()}
          className="flex size-9 shrink-0 items-center justify-center rounded-full border-0 bg-accent text-on-accent disabled:opacity-45"
        >
          <ArrowUp size={16} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}
