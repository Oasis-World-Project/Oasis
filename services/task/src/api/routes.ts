// task 的接口。/internal/* 给 5.3 的规划和测试用；/v1/* 经 gateway 给前端，只能看、改自己的任务。
import { CreateTaskBody, NodeMessageBody } from '@oasis/contracts/task';
import { parseWith, requireUserId, type ServiceApp } from '@oasis/service-kit';
import { z } from 'zod';
import type { WorkflowService } from '../service/workflow-service.ts';

const TaskParams = z.object({ taskId: z.uuid() });
const NodeParams = TaskParams.extend({ nodeId: z.uuid() });
const EventsQuery = z.object({ after: z.coerce.number().int().min(-1).default(-1) });

export function registerRoutes(app: ServiceApp, workflows: WorkflowService): void {
  /** 提交任务和工作流方案，校验后立即开跑 */
  app.post('/internal/tasks', async (request, reply) => {
    const body = parseWith(CreateTaskBody, request.body);
    return reply.code(201).send(await workflows.create(body));
  });

  app.get('/v1/tasks', async (request) => ({
    tasks: await workflows.list(requireUserId(request)),
  }));

  app.get('/v1/tasks/:taskId', async (request) => {
    const { taskId } = parseWith(TaskParams, request.params);
    return workflows.get(requireUserId(request), taskId);
  });

  app.post('/v1/tasks/:taskId/cancel', async (request) => {
    const { taskId } = parseWith(TaskParams, request.params);
    return workflows.cancel(requireUserId(request), taskId);
  });

  /** 节点的运行过程（按序号增量拉取） */
  app.get('/v1/tasks/:taskId/nodes/:nodeId/events', async (request) => {
    const { taskId, nodeId } = parseWith(NodeParams, request.params);
    const { after } = parseWith(EventsQuery, request.query);
    return workflows.nodeEvents(requireUserId(request), taskId, nodeId, after);
  });

  /** 追问 / 补充要求：运行中的直接送达（delivered），还没开始的记下来（noted） */
  app.post('/v1/tasks/:taskId/nodes/:nodeId/messages', async (request, reply) => {
    const { taskId, nodeId } = parseWith(NodeParams, request.params);
    const { text } = parseWith(NodeMessageBody, request.body);
    const result = await workflows.message(requireUserId(request), taskId, nodeId, text);
    return reply.code(202).send({ result });
  });
}
