// task 的接口。/internal/* 给 5.3 的规划和测试用；/v1/* 经 gateway 给前端，只能看、改自己的任务。
import {
  CreateEdgeBody,
  CreateTaskBody,
  DecisionBody,
  NodeMessageBody,
  PlanNode,
  QuoteBody,
  TaskRevisionBody,
  UpdateEdgeBody,
  UpdateNodeBody,
} from '@oasis/contracts/task';
import { fileResponseHeaders, parseWith, requireUserId, type ServiceApp } from '@oasis/service-kit';
import { z } from 'zod';
import type { Quotes } from '../service/quote.ts';
import type { Revisions } from '../service/revision.ts';
import type { WorkflowService } from '../service/workflow-service.ts';

const TaskParams = z.object({ taskId: z.uuid() });
const NodeParams = TaskParams.extend({ nodeId: z.uuid() });
const EdgeParams = TaskParams.extend({ edgeId: z.uuid() });
const FileParams = NodeParams.extend({ '*': z.string().min(1).max(500) });
const EventsQuery = z.object({
  after: z.coerce.number().int().min(-1).default(-1),
  runId: z.uuid().optional(),
});
const FileQuery = z.object({ download: z.enum(['0', '1']).default('0') });
const RetireBody = z.object({ replacedBy: z.uuid() });
const OwnerParams = z.object({ ownerId: z.uuid() });
const MaterialsInUseBody = z.object({ ownerId: z.uuid(), ids: z.array(z.uuid()) });

export function registerRoutes(
  app: ServiceApp,
  workflows: WorkflowService,
  quotes: Quotes,
  revisions: Revisions,
): void {
  /** 给任务单报价（ADR 0016 §4）：三档预算和用时；草案用不了时 quote 为 null */
  app.post('/internal/quotes', async (request) => {
    const body = parseWith(QuoteBody, request.body);
    return { quote: await quotes.quote({ ...body, requestId: request.id }) };
  });

  /** 提交任务和工作流方案，校验后立即开跑 */
  app.post('/internal/tasks', async (request, reply) => {
    const body = parseWith(CreateTaskBody, request.body);
    return reply.code(201).send(await workflows.create(body));
  });

  /** 节点交出的一个文件（canvas 登记成果时复制） */
  app.get('/internal/tasks/:taskId/files/:nodeId/*', async (request, reply) => {
    const { taskId, nodeId, '*': path } = parseWith(FileParams, request.params);
    const file = await workflows.fileInternal(taskId, nodeId, path);
    return reply
      .type(file.contentType)
      .header('content-length', file.size)
      .header('x-oasis-file-sha256', file.sha256 ?? '')
      .send(file.content);
  });

  /** 一个人的任务列表（私聊里的 AI 在用户问起时据此回答进度） */
  app.get('/internal/owners/:ownerId/tasks', async (request) => {
    const { ownerId } = parseWith(OwnerParams, request.params);
    return { tasks: await workflows.list(ownerId) };
  });

  /** 这些上传文件里哪些是任务素材（conversation 删私聊时留着它们，ADR 0012 §15） */
  app.post('/internal/materials/in-use', async (request) => {
    const { ownerId, ids } = parseWith(MaterialsInUseBody, request.body);
    return { ids: await workflows.materialsInUse(ownerId, ids) };
  });

  /** 任务详情（conversation 发交付消息用） */
  app.get('/internal/tasks/:taskId', async (request) => {
    const { taskId } = parseWith(TaskParams, request.params);
    return workflows.getInternal(taskId);
  });

  /** 修改成果：画布上的修改意见直接交给 AI 团队，在原任务里接着改（ADR 0012，不经过私聊） */
  app.post('/v1/tasks/:taskId/revisions', async (request) => {
    const { taskId } = parseWith(TaskParams, request.params);
    const body = parseWith(TaskRevisionBody, request.body);
    return revisions.revise(requireUserId(request), taskId, body, request.id);
  });

  /** 旧式修订任务交付后删除被替换的上一版（canvas 换好成果后调用，ADR 0012；新的修改不再新建任务） */
  app.post('/internal/tasks/:taskId/retire', async (request, reply) => {
    const { taskId } = parseWith(TaskParams, request.params);
    const { replacedBy } = parseWith(RetireBody, request.body);
    await workflows.retire(taskId, replacedBy);
    return reply.code(204).send();
  });

  /** 删除任务：连同成果、工作流和中间产物（只能删已经结束的） */
  app.delete('/v1/tasks/:taskId', async (request, reply) => {
    const { taskId } = parseWith(TaskParams, request.params);
    await workflows.remove(requireUserId(request), taskId);
    return reply.code(204).send();
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
      .header('content-length', file.size)
      .header('x-oasis-file-sha256', file.sha256 ?? '')
      .send(file.content);
  });

  /** 节点的全部运行（ADR 0007 §6） */
  app.get('/v1/tasks/:taskId/nodes/:nodeId/application-check', async (request, reply) => {
    const { taskId, nodeId } = parseWith(NodeParams, request.params);
    return reply
      .headers(fileResponseHeaders('application/json', 'application-check.json', true))
      .send(await workflows.applicationReport(requireUserId(request), taskId, nodeId));
  });
  /** 冻结的某一版工作流（ADR 0022），只读 */
  app.get('/v1/tasks/:taskId/versions/:version', async (request) => {
    const { taskId, version } = parseWith(
      TaskParams.extend({ version: z.coerce.number().int().positive() }),
      request.params,
    );
    return workflows.version(requireUserId(request), taskId, version);
  });
  app.get('/v1/tasks/:taskId/nodes/:nodeId/runs', async (request) => {
    const { taskId, nodeId } = parseWith(NodeParams, request.params);
    return { runs: await workflows.nodeRuns(requireUserId(request), taskId, nodeId) };
  });

  /** 一次运行的过程（按序号增量拉取）；不给 runId 时看节点当前这次 */
  app.get('/v1/tasks/:taskId/nodes/:nodeId/events', async (request) => {
    const { taskId, nodeId } = parseWith(NodeParams, request.params);
    const { after, runId } = parseWith(EventsQuery, request.query);
    return workflows.nodeEvents(requireUserId(request), taskId, nodeId, after, runId);
  });

  /** 编辑节点时能选的模型和工具 */
  app.get('/v1/workflow/options', async (request) => {
    requireUserId(request);
    return workflows.options();
  });

  /** 追问 / 补充要求：运行中的直接送达（delivered），还没开始、已停止的记下来（noted） */
  app.post('/v1/tasks/:taskId/nodes/:nodeId/messages', async (request, reply) => {
    const { taskId, nodeId } = parseWith(NodeParams, request.params);
    const { text } = parseWith(NodeMessageBody, request.body);
    const result = await workflows.message(requireUserId(request), taskId, nodeId, text);
    return reply.code(202).send({ result });
  });
}
