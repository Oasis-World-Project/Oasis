import { parseWith, requireUserId, type ServiceApp } from '@oasis/service-kit';
import { z } from 'zod';
import type { ModelService } from '../service/model-service.ts';

const KeyParams = z.object({ key: z.string().min(1).max(50) });

export function registerRoutes(app: ServiceApp, models: ModelService): void {
  app.get('/v1/models', async (request) => {
    requireUserId(request);
    return { models: await models.list() };
  });

  // 只给 task 的规划员用：已接入的模型和它们的上游模型 ID
  app.get('/internal/models/catalog', async () => ({ models: await models.catalog() }));

  // 只给 conversation 用：拿到调用某个模型所需的上游模型 ID 和人设
  app.get('/internal/models/:key/route', async (request) =>
    models.route(parseWith(KeyParams, request.params).key),
  );
}
