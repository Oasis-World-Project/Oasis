import { AiSettings, ChooseTierBody } from '@oasis/contracts/agent';
import { parseWith, requireUserId, type ServiceApp } from '@oasis/service-kit';
import { z } from 'zod';
import type { ModelService } from '../service/model-service.ts';

const KeyParams = z.object({ key: z.string().min(1).max(50) });
const RouteQuery = z.object({ userId: z.uuid() });

export function registerRoutes(app: ServiceApp, models: ModelService): void {
  app.get('/v1/models', async (request) => ({
    models: await models.list(requireUserId(request)),
  }));

  /** 给一个 AI 换档位（快速 / 均衡 / 强力 / 最强） */
  app.put('/v1/models/:key/tier', async (request) =>
    models.chooseTier(
      requireUserId(request),
      parseWith(KeyParams, request.params).key,
      parseWith(ChooseTierBody, request.body).tier,
    ),
  );

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
