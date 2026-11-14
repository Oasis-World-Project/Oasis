import { AiSettings } from '@oasis/contracts/agent';
import { parseWith, requireUserId, type ServiceApp } from '@oasis/service-kit';
import { z } from 'zod';
import type { ModelService } from '../service/model-service.ts';

const KeyParams = z.object({ key: z.string().min(1).max(50) });
const RouteQuery = z.object({ userId: z.uuid() });

export function registerRoutes(app: ServiceApp, models: ModelService): void {
  app.get('/v1/models', async (request) => {
    requireUserId(request);
    return { models: await models.list() };
  });

  /** 用户给 AI 们的设置（「只用国内模型」） */
  app.get('/v1/settings', async (request) => models.settings(requireUserId(request)));
  app.put('/v1/settings', async (request) =>
    models.saveSettings(requireUserId(request), parseWith(AiSettings, request.body)),
  );

  // 只给 conversation 用：开一轮时拿到这个 AI 的上游型号、人设和这个用户的设置
  app.get('/internal/models/:key/route', async (request) =>
    models.route(
      parseWith(KeyParams, request.params).key,
      parseWith(RouteQuery, request.query).userId,
    ),
  );
}
