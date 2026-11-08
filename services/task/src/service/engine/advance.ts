// 事务里的推进：开出节点的一步、停下节点、按图调度能跑的节点、运行整个工作流、取消整个任务。
// 节点这一步具体开哪些运行由它的种类插件决定（kinds/），这里只管状态和次数。
import { randomUUID } from 'node:crypto';
import { HttpError } from '@oasis/service-kit';
import type { Node } from '../../repo/task-store.ts';
import { graphProblems } from '../graph.ts';
import { inputsOf, isOpen, kindOf, openRuns, reworkStep } from '../kinds/index.ts';
import { decide } from '../schedule.ts';
import { FINAL, type Engine } from './shared.ts';

type Advance = Pick<
  Engine,
  | 'openStep'
  | 'endRuns'
  | 'halt'
  | 'startNode'
  | 'schedule'
  | 'runAll'
  | 'cancelAll'
  | 'withDownstream'
>;

export function createAdvance(engine: Engine): Advance {
  const { store, maxParallel } = engine.deps;
  return {
    async openStep(snapshot, w, node, step, fx) {
      let lastRunId: string | undefined;
      for (const request of step.requests) {
        const runId = randomUUID();
        const record = {
          ...(node.config.requires ? { requires: node.config.requires } : {}),
          ...(request.goal ? { goal: true } : {}),
          model: request.model,
          prompt: request.prompt,
          inputsFrom: request.inputsFrom,
          ...(request.continueFrom ? { continueFrom: request.continueFrom } : {}),
          ...(request.steps ? { steps: request.steps } : {}),
        };
        await w.addRun({
          id: runId,
          nodeId: node.id,
          attempt: node.attempts,
          purpose: request.purpose,
          status: 'pending',
          meta: request.meta,
          request: record,
        });
        fx.submit.push({ runId, task: snapshot.task, nodeId: node.id, request: record });
        lastRunId = runId;
      }
      await w.setNode(node.id, {
        status: 'running',
        currentRunId: lastRunId ?? node.currentRunId,
        startedAt: node.startedAt ?? new Date(),
        finishedAt: null,
        ...(step.config ? { config: step.config } : {}),
      });
    },

    /**
     * 还没交给 harness 的直接记下结局（对账不会再重交），已经交出去的通知 harness 停止（存下产出，
     * 会话留在持久工作目录里）或取消。
     */
    async endRuns(w, runs, how, fx) {
      for (const run of runs) {
        if (run.status === 'pending') {
          await w.setRun(run.id, {
            status: how === 'stop' ? 'stopped' : 'cancelled',
            finishedAt: new Date(),
          });
        }
        fx[how].push(run.id);
      }
    },

    async halt(snapshot, w, node, fx) {
      fx.abortChecks.push({ taskId: snapshot.task.id, nodeId: node.id });
      await engine.endRuns(w, openRuns(snapshot, node.id), 'stop', fx);
      await w.setNode(node.id, { status: 'stopped' });
    },

    async startNode(snapshot, w, node, fx) {
      const kind = kindOf(node);
      // 整体验收退回补文件、或修改时接着原会话改：能接着上次的会话就接着改，否则重做这一步
      if (node.config.repairChecks?.length || node.config.revision) {
        const { repairChecks = [], revision, ...config } = node.config;
        const clean = { ...node, config } as Node;
        // 没有 AI 能接着改的节点（工具节点）：拿上游最新的产出重新跑一遍
        if (!kind.reworkable) {
          await w.setNode(node.id, { config, reworks: node.reworks + 1 });
          await engine.openStep(snapshot, w, clean, kind.start(snapshot, clean), fx);
          return;
        }
        const previous = node.currentRunId ? await store.findRun(node.currentRunId) : undefined;
        const canResume = previous && (previous.status === 'succeeded' || previous.meta.resumable);
        const step = canResume
          ? reworkStep(clean, repairChecks, revision)
          : previous
            ? kind.retry(snapshot, clean, previous)
            : kind.start(snapshot, clean);
        // 接着改时上游可能已经有了新产出：拿最新的
        if (canResume) {
          const latest = inputsOf(snapshot, node);
          for (const request of step.requests) request.inputsFrom = latest;
        }
        await w.setNode(node.id, { config, reworks: node.reworks + 1 });
        await engine.openStep(snapshot, w, node, step, fx);
        return;
      }
      if (node.status === 'stopped') {
        const last = node.currentRunId ? await store.findRun(node.currentRunId) : undefined;
        const next = kind.resume(snapshot, node, last);
        if (next === 'gate' && last) {
          await w.setNode(node.id, { status: 'checking' });
          fx.gate.push({ taskId: snapshot.task.id, nodeId: node.id, runId: last.id });
          return;
        }
        if (next !== 'gate') await engine.openStep(snapshot, w, node, next, fx);
        return;
      }
      if (node.status === 'failed') {
        await w.setNode(node.id, { attempts: 0, reworks: 0, warning: null });
      }
      await w.setNode(node.id, { attempts: node.attempts + 1 });
      const previous = node.currentRunId ? await store.findRun(node.currentRunId) : undefined;
      const step =
        previous?.status === 'failed' && previous.meta.resumable
          ? kind.retry(snapshot, node, previous)
          : kind.start(snapshot, node);
      await engine.openStep(snapshot, w, node, step, fx);
    },

    async schedule(snapshot, w, fx) {
      const decision = decide({
        taskStatus: snapshot.task.status,
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        maxParallel,
      });
      for (const node of decision.blocked) await w.setNode(node.id, { status: 'blocked' });
      for (const node of decision.unblocked) await w.setNode(node.id, { status: 'waiting' });
      for (const node of decision.start) await engine.startNode(snapshot, w, node, fx);
      if (decision.task?.status === 'succeeded' && snapshot.task.sheet) {
        // 从任务单来的任务：先对照任务单整体验收，再算完成
        await w.setTask({ status: 'accepting', attention: null });
        fx.accept.push(snapshot.task.id);
      } else if (decision.task) {
        const finished = FINAL.includes(decision.task.status);
        await w.setTask({ ...decision.task, finishedAt: finished ? new Date() : null });
      }
    },

    /**
     * 运行整个工作流：先检查整张图（断开的线头、环），有问题就列出来、不开跑；
     * 没问题就把新建的节点加进来、停下的接着做、失败的再试，然后一路往下跑。
     */
    async runAll(snapshot, w, fx) {
      const problems = graphProblems(snapshot);
      if (problems.length > 0) {
        throw new HttpError(409, 'workflow_invalid', `工作流有错误：${problems.join('；')}`);
      }
      await w.setTask({ status: 'running', attention: null, finishedAt: null });
      for (const node of snapshot.nodes) {
        if (node.status === 'draft') await w.setNode(node.id, { status: 'waiting' });
        if (node.status === 'failed') {
          await w.setNode(node.id, { status: 'waiting', attempts: 0, reworks: 0, warning: null });
        }
        if (node.status === 'stopped') await engine.startNode(snapshot, w, node, fx);
      }
      await engine.schedule(snapshot, w, fx);
    },

    async cancelAll(snapshot, w, fx) {
      fx.abortChecks.push({ taskId: snapshot.task.id });
      const now = new Date();
      await engine.endRuns(w, snapshot.activeRuns.filter(isOpen), 'cancel', fx);
      if (snapshot.task.status === 'planning' && snapshot.task.plannerRunId) {
        fx.cancel.push(snapshot.task.plannerRunId);
      }
      for (const node of snapshot.nodes) {
        if (!FINAL.includes(node.status)) {
          await w.setNode(node.id, { status: 'cancelled', finishedAt: now });
        }
      }
      await w.setTask({ status: 'cancelled', attention: null, finishedAt: now });
    },

    /** 交付节点改了，下游要基于新产出跟着更新 */
    withDownstream(snapshot, nodes) {
      const affected = new Set(nodes.map((n) => n.id));
      for (;;) {
        const size = affected.size;
        for (const edge of snapshot.edges)
          if (edge.fromNodeId && affected.has(edge.fromNodeId) && edge.toNodeId)
            affected.add(edge.toNodeId);
        if (size === affected.size) return affected;
      }
    },
  };
}
