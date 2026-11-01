// 数字人成果的实时对话（ADR 0013）：canvas 核对成果是自己的、确实是数字人，再让 model-gateway 开会话。
// 结束、查看会话直接转给 model-gateway，由它按付费人核对是不是自己的会话。
import { AvatarSessionStarted, AvatarSessionView, AvatarStopBody } from '@oasis/contracts/avatar';
import { OASIS_HEADERS } from '@oasis/contracts/common';
import {
  HttpError,
  parseWith,
  requireUserId,
  type ServiceApp,
  type ServiceClient,
} from '@oasis/service-kit';
import { z } from 'zod';
import type { ArtifactService } from '../service/artifact-service.ts';

const IdParams = z.object({ id: z.uuid() });
const SessionParams = z.object({ sessionId: z.uuid() });

export function registerAvatarRoutes(
  app: ServiceApp,
  deps: { artifacts: ArtifactService; modelGateway: ServiceClient },
): void {
  const { artifacts, modelGateway } = deps;
  const payer = (userId: string) => ({ [OASIS_HEADERS.payerId]: userId });

  app.post('/v1/artifacts/:id/avatar-sessions', async (request, reply) => {
    const userId = requireUserId(request);
    const { id } = parseWith(IdParams, request.params);
    const row = await artifacts.get(userId, id);
    if (!row.avatarSpec) throw new HttpError(422, 'not_avatar', '这个成果不是数字人');
    const started = await modelGateway.json('POST', '/internal/avatar/sessions', {
      requestId: request.id,
      headers: payer(userId),
      body: {
        spec: row.avatarSpec,
        artifactId: row.id,
        ...(row.taskId ? { taskId: row.taskId } : {}),
      },
      schema: AvatarSessionStarted,
    });
    return reply.code(201).send(started);
  });

  app.post('/v1/avatar-sessions/:sessionId/stop', async (request, reply) => {
    const { sessionId } = parseWith(SessionParams, request.params);
    const body = parseWith(AvatarStopBody, request.body ?? {});
    await modelGateway.json('POST', `/internal/avatar/sessions/${sessionId}/stop`, {
      requestId: request.id,
      headers: payer(requireUserId(request)),
      body,
    });
    return reply.code(204).send();
  });

  app.get('/v1/avatar-sessions/:sessionId', async (request) => {
    const { sessionId } = parseWith(SessionParams, request.params);
    return modelGateway.json('GET', `/internal/avatar/sessions/${sessionId}`, {
      requestId: request.id,
      headers: payer(requireUserId(request)),
      schema: AvatarSessionView,
    });
  });
}
