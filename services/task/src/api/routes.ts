// task 的接口。/internal/* 给 5.3 的规划和测试用；/v1/* 经 gateway 给前端，只能看、改自己的任务。
import {
  CreateEdgeBody,
  CreateTaskBody,
  DecisionBody,
  NodeMessageBody,
  PlanNode,
  UpdateEdgeBody,
  UpdateNodeBody,
} from '@oasis/contracts/task';
import { fileResponseHeaders, parseWith, requireUserId, type ServiceApp } from '@oasis/service-kit';
import { z } from 'zod';
import type { WorkflowService } from '../service/workflow-service.ts';

const TaskParams = z.object({ taskId: z.uuid() });
const NodeParams = TaskParams.extend({ nodeId: z.uuid() });
const EdgeParams = TaskParams.extend({ edgeId: z.uuid() });
const FileParams = NodeParams.extend({ '*': z.string().min(1).max(500) });
const EventsQuery = z.object({ after: z.coerce.number().int().min(-1).default(-1) });
const FileQuery = z.object({ download: z.enum(['0', '1']).default('0') });

export function registerRoutes(app: ServiceApp, workflows: WorkflowService): void {
  /** 提交任务和工作流方案，校验后立即开跑 */
  app.post('/internal/tasks', async (request, reply) => {
    const body = parseWith(CreateTaskBody, request.body);
    return reply.code(201).send(await workflows.create(body));
  });

  /** 任务详情（conversation 发交付消息用） */
  app.get('/internal/tasks/:taskId', async (request) => {
    const { taskId } = parseWith(TaskParams, request.params);
    return workflows.getInternal(taskId);
  });

  app.get('/v1/tasks', async (request) => ({
    tasks: await workflows.list(requireUserId(request)),
  }));

  app.get('/v1/tasks/:taskId', async (request) => {
    const { taskId } = parseWith(TaskParams, request.params);
    return workflows.get(requireUserId(request), taskId);
  });

  // ---- 整个任务：运行（先检查整张图）、停止、取消、「需要处理」时三选一 ----
  app.post('/v1/tasks/:taskId/run', async (request) => {
    const { taskId } = parseWith(TaskParams, request.params);
    return workflows.run(requireUserId(request), taskId);
  });

  app.post('/v1/tasks/:taskId/stop', async (request) => {
    const { taskId } = parseWith(TaskParams, request.params);
    return workflows.stop(requireUserId(request), taskId);
  });

  app.post('/v1/tasks/:taskId/cancel', async (request) => {
    const { taskId } = parseWith(TaskParams, request.params);
    return workflows.cancel(requireUserId(request), taskId);
  });

  app.post('/v1/tasks/:taskId/decision', async (request) => {
    const { taskId } = parseWith(TaskParams, request.params);
    const body = parseWith(DecisionBody, request.body);
    return workflows.decide(requireUserId(request), taskId, body);
  });

  // ---- 节点：新建、改、删（还没开始的），单独运行、停止 ----
  app.post('/v1/tasks/:taskId/nodes', async (request, reply) => {
    const { taskId } = parseWith(TaskParams, request.params);
    const body = parseWith(PlanNode, request.body);
    return reply.code(201).send(await workflows.createNode(requireUserId(request), taskId, body));
  });

  app.patch('/v1/tasks/:taskId/nodes/:nodeId', async (request) => {
    const { taskId, nodeId } = parseWith(NodeParams, request.params);
    const body = parseWith(UpdateNodeBody, request.body);
    return workflows.updateNode(requireUserId(request), taskId, nodeId, body);
  });

  app.delete('/v1/tasks/:taskId/nodes/:nodeId', async (request) => {
    const { taskId, nodeId } = parseWith(NodeParams, request.params);
    return workflows.deleteNode(requireUserId(request), taskId, nodeId);
  });

  app.post('/v1/tasks/:taskId/nodes/:nodeId/run', async (request) => {
    const { taskId, nodeId } = parseWith(NodeParams, request.params);
    return workflows.runNode(requireUserId(request), taskId, nodeId);
  });

  app.post('/v1/tasks/:taskId/nodes/:nodeId/stop', async (request) => {
    const { taskId, nodeId } = parseWith(NodeParams, request.params);
    return workflows.stopNode(requireUserId(request), taskId, nodeId);
  });

  // ---- 连线：新建、接上线头 / 改一端、删除 ----
  app.post('/v1/tasks/:taskId/edges', async (request, reply) => {
    const { taskId } = parseWith(TaskParams, request.params);
    const { from, to } = parseWith(CreateEdgeBody, request.body);
    return reply
      .code(201)
      .send(await workflows.createEdge(requireUserId(request), taskId, from, to));
  });

  app.patch('/v1/tasks/:taskId/edges/:edgeId', async (request) => {
    const { taskId, edgeId } = parseWith(EdgeParams, request.params);
    const body = parseWith(UpdateEdgeBody, request.body);
    return workflows.updateEdge(requireUserId(request), taskId, edgeId, body);
  });

  app.delete('/v1/tasks/:taskId/edges/:edgeId', async (request) => {
    const { taskId, edgeId } = parseWith(EdgeParams, request.params);
    return workflows.deleteEdge(requireUserId(request), taskId, edgeId);
  });

  /** 下载节点交出的一个文件 */
  app.get('/v1/tasks/:taskId/files/:nodeId/*', async (request, reply) => {
    const { taskId, nodeId, '*': path } = parseWith(FileParams, request.params);
    const { download } = parseWith(FileQuery, request.query);
    const file = await workflows.file(requireUserId(request), taskId, nodeId, path);
    return reply
      .headers(fileResponseHeaders(file.contentType, path, download === '1'))
      .send(file.content);
  });

  /** 节点的运行过程（按序号增量拉取） */
  app.get('/v1/tasks/:taskId/nodes/:nodeId/events', async (request) => {
    const { taskId, nodeId } = parseWith(NodeParams, request.params);
    const { after } = parseWith(EventsQuery, request.query);
    return workflows.nodeEvents(requireUserId(request), taskId, nodeId, after);
  });

  /** 追问 / 补充要求：运行中的直接送达（delivered），还没开始、已停止的记下来（noted） */
  app.post('/v1/tasks/:taskId/nodes/:nodeId/messages', async (request, reply) => {
    const { taskId, nodeId } = parseWith(NodeParams, request.params);
    const { text } = parseWith(NodeMessageBody, request.body);
    const result = await workflows.message(requireUserId(request), taskId, nodeId, text);
    return reply.code(202).send({ result });
  });
}
