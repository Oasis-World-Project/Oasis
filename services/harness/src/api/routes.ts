// harness 只有内部接口（gateway 不转发 /internal）：task 等服务用它启动运行、看进度、追问、停止、取消。
import { OutputsLinkBody, RunMessageBody, StartRunBody } from '@oasis/contracts/harness';
import { parseWith, type ServiceApp } from '@oasis/service-kit';
import { z } from 'zod';
import { WebsiteTestArgs } from '@oasis/contracts/ui-test';
import type { RunService } from '../service/run-service.ts';
import type { PreviewService } from '../service/preview-service.ts';

const RunParams = z.object({ runId: z.uuid() });
const FileParams = RunParams.extend({ '*': z.string().min(1).max(500) });
const EventsQuery = z.object({
  after: z.coerce.number().int().min(-1).default(-1),
  limit: z.coerce.number().int().positive().max(1000).default(200),
});

export function registerRoutes(app: ServiceApp, runs: RunService, previews?: PreviewService): void {
  app.get('/internal/execution/environment', () => runs.environment());
  /** 产出包的临时下载链接：交给 inspector 检查（ADR 0024） */
  app.post('/internal/runs/:runId/outputs/link', async (request) => {
    const { runId } = parseWith(RunParams, request.params);
    const { payerId, taskId } = parseWith(OutputsLinkBody, request.body);
    return runs.outputsLink(runId, payerId, taskId);
  });
  for (const kind of ['audio', 'video'] as const) {
    app.post(`/internal/runs/:runId/${kind}-check`, async (request) => {
      const { runId } = parseWith(RunParams, request.params);
      const { payerId, taskId } = parseWith(
        z.object({ payerId: z.uuid(), taskId: z.uuid() }),
        request.body,
      );
      return runs[`${kind}Check`](runId, payerId, taskId);
    });
  }
  if (previews) {
    app.post('/internal/websites/check', async (request) =>
      previews.checkWebsite(
        parseWith(WebsiteTestArgs.extend({ payerId: z.uuid(), taskId: z.uuid() }), request.body),
      ),
    );
    app.post('/internal/runs/:runId/application-check/report', async (request, reply) => {
      const { runId } = parseWith(RunParams, request.params);
      const { payerId, taskId } = parseWith(
        z.object({ payerId: z.uuid(), taskId: z.uuid() }),
        request.body,
      );
      return reply.type('application/json').send(await previews.report({ runId, payerId, taskId }));
    });
    // 节点自查（ADR 0017）：读运行中沙箱的 out/<dir>，跑和关卡同一套浏览器检查，不留档
    app.post('/internal/runs/:runId/application-check/live', async (request, reply) => {
      const { runId } = parseWith(RunParams, request.params);
      const body = parseWith(
        z.object({
          payerId: z.uuid(),
          taskId: z.uuid(),
          dir: z
            .string()
            .min(1)
            .max(200)
            .refine(
              (dir) =>
                !dir.includes('\\') &&
                dir.split('/').every((part) => part && part !== '.' && part !== '..'),
              'dir 是 out/ 下的相对目录',
            ),
        }),
        request.body,
      );
      const abort = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) abort.abort();
      });
      return previews.checkLive({ runId, ...body, signal: abort.signal });
    });
    app.post('/internal/runs/:runId/application-check', async (request, reply) => {
      const { runId } = parseWith(RunParams, request.params);
      const { payerId, taskId } = parseWith(
        z.object({ payerId: z.uuid(), taskId: z.uuid() }),
        request.body,
      );
      // 检查不设时限：task 在用户停止/取消节点时断开请求，这里随之回收浏览器
      const abort = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) abort.abort();
      });
      return previews.checkRun({ runId, payerId, taskId, signal: abort.signal });
    });
  }
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
