// 模型范围（ADR 0027）：「只用国内模型」开关按用户存在 model-gateway，由它过滤给 AI 团队的模型和
// 工具型号；这里只替网页读写这个开关（gateway 不转发 model-gateway）。
import { ModelScope } from '@oasis/contracts/model-gateway';
import type { ServiceClient } from '@oasis/service-kit';

export function createModelScopes(modelGateway: ServiceClient) {
  const path = (userId: string) => `/internal/v1/model-scopes/${userId}`;
  return {
    get: (userId: string): Promise<ModelScope> =>
      modelGateway.json('GET', path(userId), { schema: ModelScope }),
    set: (userId: string, scope: ModelScope): Promise<ModelScope> =>
      modelGateway.json('PUT', path(userId), { body: scope, schema: ModelScope }),
  };
}

export type ModelScopes = ReturnType<typeof createModelScopes>;
