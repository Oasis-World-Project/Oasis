// 给 LiveAvatar 回调用的大模型入口（ADR 0013 §6）：单独端口，只有一条路径，经隧道和反向代理暴露到公网。
// 不和主端口放在一起：主端口上的 /internal/* 只认请求头里的付费人，不能让服务器上的其他进程碰到。
import { createHttpServer, HttpError, type Logger } from '@oasis/service-kit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Caller } from '../service/metering.ts';
import type { RunKeyService } from '../service/run-key-service.ts';

type Completions = (
  caller: Caller,
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown>;

export const AVATAR_COMPLETIONS_PATH = '/avatar/v1/chat/completions';

export function createAvatarLlmServer(deps: {
  logger: Logger;
  runKeys: RunKeyService;
  completions: Completions;
  /** 只放行正在进行的数字人会话的 Key（沙箱里 agent 的 Key 不能从这里用） */
  isActiveSession: (runId: string | undefined) => boolean;
}) {
  const app = createHttpServer({
    service: 'model-gateway-avatar',
    version: 'avatar-llm',
    commit: process.env.GIT_COMMIT ?? 'dev',
    logger: deps.logger,
    resources: [],
    isShuttingDown: () => false,
  });
  app.post(AVATAR_COMPLETIONS_PATH, { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const caller = await deps.runKeys.authenticate(request.headers.authorization);
    if (!deps.isActiveSession(caller.runId)) {
      throw new HttpError(401, 'invalid_run_key', '运行凭证无效或已过期');
    }
    return deps.completions(caller, request, reply);
  });
  return app;
}
