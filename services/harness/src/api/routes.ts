// harness 的接口：内部的（gateway 不转发 /internal）给 conversation 开一轮、看进度、插话、停止、
// 取消、清理对话，给 canvas 读产出文件；对外只有一条——用户电脑上的桌面版经 gateway 连上来
// （WebSocket，gateway 认过人、在 x-oasis-user-id 里写上是谁）。harness 不调 inspector。
import { OASIS_HEADERS } from '@oasis/contracts/common';
import {
  RunMaterialsBody,
  RunMessageBody,
  StartRunBody,
  UndoRunBody,
} from '@oasis/contracts/harness';
import { HttpError, parseWith, type ServiceApp } from '@oasis/service-kit';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import type { DeviceHub } from '../executor/device.ts';
import type { RunService } from '../service/run-service.ts';

/** 桌面版一次发来的消息最多多大（取回的产出是 tar 的 base64） */
const DEVICE_MESSAGE_MAX_BYTES = 768 * 1024 * 1024;
const DeviceQuery = z.object({
  pathname: z.literal('/v1/devices/connect'),
  userId: z.uuid(),
  deviceId: z.string().regex(/^[\w-]{8,64}$/),
});

/** 用户电脑上的桌面版连上来（GET /v1/devices/connect?device=<设备号>，升级成 WebSocket） */
export function registerDevices(app: ServiceApp, devices: DeviceHub): void {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: DEVICE_MESSAGE_MAX_BYTES });
  app.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://harness');
    const parsed = DeviceQuery.safeParse({
      pathname: url.pathname,
      userId: request.headers[OASIS_HEADERS.userId],
      deviceId: url.searchParams.get('device'),
    });
    if (!parsed.success) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const { userId, deviceId } = parsed.data;
    sockets.handleUpgrade(request, socket, head, (ws) => devices.attach(ws, userId, deviceId));
  });
  // 只是不再接新的连接；已连上的电脑等进行中的运行收尾后再断开（见 main.ts）
  app.addHook('onClose', async () => sockets.close());
}

const RunParams = z.object({ runId: z.uuid() });
const ConversationParams = z.object({ conversationId: z.uuid() });
const FileParams = RunParams.extend({ '*': z.string().min(1).max(500) });
const EventsQuery = z.object({
  after: z.coerce.number().int().min(-1).default(-1),
  limit: z.coerce.number().int().positive().max(1000).default(200),
  /** 暂时没有新事件时最多等多少毫秒再回（这一轮有新事件或结束就马上回） */
  wait: z.coerce.number().int().min(0).max(30_000).default(0),
});

export function registerRoutes(app: ServiceApp, runs: RunService): void {
  app.get('/internal/execution/environment', () => runs.environment());

  /** 开一轮：立即返回（202），这一轮在后台进行 */
  app.post('/internal/runs', async (request, reply) => {
    const body = parseWith(StartRunBody, request.body);
    return reply.code(202).send(await runs.start(body));
  });

  app.get('/internal/runs/:runId', async (request) => {
    const { runId } = parseWith(RunParams, request.params);
    return runs.get(runId);
  });

  /** 运行过程中的事件，按序号增量拉取（after = 已经拿到的最大序号）；带 wait 时没有新的就等一会儿 */
  app.get('/internal/runs/:runId/events', async (request) => {
    const { runId } = parseWith(RunParams, request.params);
    const { after, limit, wait } = parseWith(EventsQuery, request.query);
    return { events: await runs.events(runId, after, limit, wait) };
  });

  /** 读一个产出文件（out/ 下的相对路径）：画布登记成果时复制 */
  app.get('/internal/runs/:runId/files/*', async (request, reply) => {
    const { runId, '*': path } = parseWith(FileParams, request.params);
    const file = await runs.fileStream(runId, path);
    return reply.type(file.contentType).header('content-length', file.size).send(file.content);
  });

  /** 读这一轮工作目录里的一个文件（相对 /workspace）：进度页预览中间产物 */
  app.get('/internal/runs/:runId/workspace/*', async (request, reply) => {
    const { runId, '*': path } = parseWith(FileParams, request.params);
    const file = await runs.workspaceFile(runId, path);
    return reply.type(file.contentType).header('content-length', file.size).send(file.content);
  });

  /** 用户在这一轮进行中插话 */
  app.post('/internal/runs/:runId/messages', async (request, reply) => {
    const { runId } = parseWith(RunParams, request.params);
    const { text } = parseWith(RunMessageBody, request.body);
    await runs.message(runId, text);
    return reply.code(202).send();
  });

  /** 一轮进行中往它的工作目录里再放文件（群里别的 AI 刚交的群文件） */
  app.post('/internal/runs/:runId/materials', async (request, reply) => {
    const { runId } = parseWith(RunParams, request.params);
    const { materials } = parseWith(RunMaterialsBody, request.body);
    await runs.addMaterials(runId, materials);
    return reply.code(204).send();
  });

  /** 停止：记下已有的产出（会话留在持久工作目录里），下一轮接着做 */
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

  /** 撤回这份会话最近的一轮：AI 的记忆退回它之前，这一轮的记录删掉；返回之后接着哪一轮做 */
  app.post('/internal/runs/:runId/undo', async (request) => {
    const { runId } = parseWith(RunParams, request.params);
    return runs.undo(runId, parseWith(UndoRunBody, request.body).conversationId);
  });

  /** 删对话、开新话题：删掉这个对话的运行记录和持久工作目录（真删除，可重复调用） */
  app.post('/internal/conversations/:conversationId/purge', async (request, reply) => {
    const { conversationId } = parseWith(ConversationParams, request.params);
    if (!(await runs.purgeConversation(conversationId)))
      throw new HttpError(409, 'run_active', '这个对话还有一轮没结束，先停下再删');
    return reply.code(204).send();
  });
}
