// harness 只有内部接口（gateway 不转发 /internal）：task 等服务用它启动运行、看进度、追问、停止、取消。
// harness 不调 model-gateway、inspector：检查由 task 拿产出包链接交给 inspector（ADR 0024）。
import {
  ApplicationReportBody,
  OutputsLinkBody,
  RunMessageBody,
  StartRunBody,
} from '@oasis/contracts/harness';
import { parseWith, type ServiceApp } from '@oasis/service-kit';
import { z } from 'zod';
import type { RunService } from '../service/run-service.ts';

const RunParams = z.object({ runId: z.uuid() });
const FileParams = RunParams.extend({ '*': z.string().min(1).max(500) });
const EventsQuery = z.object({
  after: z.coerce.number().int().min(-1).default(-1),
  limit: z.coerce.number().int().positive().max(1000).default(200),
});
const Owner = z.object({ payerId: z.uuid(), taskId: z.uuid() });
/** 浏览器检查报告带平台截图（首屏和测试步骤），比默认的 1 MiB 请求体大 */
const REPORT_BODY_LIMIT = 64 * 1024 * 1024;

export function registerRoutes(app: ServiceApp, runs: RunService): void {
  app.get('/internal/execution/environment', () => runs.environment());
  /** 产出包的临时下载链接：交给 inspector 检查（ADR 0024） */
  app.post('/internal/runs/:runId/outputs/link', async (request) => {
    const { runId } = parseWith(RunParams, request.params);
    const { payerId, taskId } = parseWith(OutputsLinkBody, request.body);
    return runs.outputsLink(runId, payerId, taskId);
  });
  /** 交付关卡的浏览器检查报告：task 拿 inspector 的结论交来留档，再查一次就覆盖 */
  app.put(
    '/internal/runs/:runId/application-check',
    { bodyLimit: REPORT_BODY_LIMIT },
    async (request, reply) => {
      const { runId } = parseWith(RunParams, request.params);
      await runs.saveApplicationReport(runId, parseWith(ApplicationReportBody, request.body));
      return reply.code(204).send();
    },
  );
  app.post('/internal/runs/:runId/application-check/report', async (request, reply) => {
    const { runId } = parseWith(RunParams, request.params);
    const { payerId, taskId } = parseWith(Owner, request.body);
    return reply
      .type('application/json')
      .send(await runs.applicationReport(runId, payerId, taskId));
  });
  /** 启动一次运行：立即返回（202），运行在后台进行，结束时发出 harness.run.finished */
  app.post('/internal/runs', async (request, reply) => {
    const body = parseWith(StartRunBody, request.body);
    return reply.code(202).send(await runs.start(body));
  });

  app.get('/internal/runs/:runId', async (request) => {
    const { runId } = parseWith(RunParams, request.params);
    return runs.get(runId);
  });

  /** 运行过程中的事件，按序号增量拉取（after = 已经拿到的最大序号） */
  app.get('/internal/runs/:runId/events', async (request) => {
    const { runId } = parseWith(RunParams, request.params);
    const { after, limit } = parseWith(EventsQuery, request.query);
    return { events: await runs.events(runId, after, limit) };
  });

  /** 读一个产出文件（out/ 下的相对路径） */
  app.get('/internal/runs/:runId/files/*', async (request, reply) => {
    const { runId, '*': path } = parseWith(FileParams, request.params);
    const file = await runs.fileStream(runId, path);
    return reply
      .type(file.contentType)
      .header('content-length', file.size)
      .header('x-oasis-file-sha256', file.sha256 ?? '')
      .send(file.content);
  });

  /** 用户追问或补充要求（只对运行中的节点有效） */
  app.post('/internal/runs/:runId/messages', async (request, reply) => {
    const { runId } = parseWith(RunParams, request.params);
    const { text } = parseWith(RunMessageBody, request.body);
    await runs.message(runId, text);
    return reply.code(202).send();
  });

  /** 停止：存下产出（会话留在持久工作目录里），之后可以用 continueFrom 接着做 */
  app.post('/internal/runs/:runId/stop', async (request, reply) => {
    const { runId } = parseWith(RunParams, request.params);
    await runs.stop(runId);
    return reply.code(202).send();
  });

  app.post('/internal/runs/:runId/cancel', async (request, reply) => {
    const { runId } = parseWith(RunParams, request.params);
    await runs.cancel(runId);
    return reply.code(202).send();
  });
}
