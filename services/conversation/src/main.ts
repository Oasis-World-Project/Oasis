// conversation：私聊和群聊。私聊里的 AI 就是干活的主 AI：用户说一句开一轮（harness 的一次运行），
// 一轮进行中说的话是插话；这里跟进每一轮，把 AI 说的话和做的步骤写进消息，结束时成品登记进画布。
// 群里的每个 AI 有一个席位，它的一轮和私聊的是同一套，消息写进群里。好友和人与人的私聊也在这里。
import { fileURLToPath } from 'node:url';
import { createPostgres, createServiceClient, startService } from '@oasis/service-kit';
import { registerFriendRoutes } from './api/friend-routes.ts';
import { registerGroupFileRoutes } from './api/group-file-routes.ts';
import { registerGroupRoutes } from './api/group-routes.ts';
import { registerRoutes } from './api/routes.ts';
import { conversationEnv } from './config.ts';
import { createConversationRepo } from './repo/conversation-repo.ts';
import { createFriendRepo } from './repo/friend-repo.ts';
import { createGroupFilesRepo } from './repo/group-files-repo.ts';
import { createGroupRepo } from './repo/group-repo.ts';
import { createGroupSeats } from './repo/group-seats.ts';
import { createGroupTalk } from './repo/group-talk.ts';
import { createDmService } from './service/dm-service.ts';
import { createFriendService } from './service/friend-service.ts';
import { createGroupFiles } from './service/group-files.ts';
import { createGroupService } from './service/group-service.ts';
import { createGroupSpeak } from './service/group-speak.ts';
import { createProfiles } from './service/profiles.ts';
import { createPurge } from './service/purge.ts';
import { createTurns } from './service/turns.ts';

/** 多久看一次有没有别的实例丢下的一轮（它的跟进租约过期后接手） */
const SWEEP_MS = 30_000;

await startService({
  name: 'conversation',
  env: conversationEnv,
  resources: async ({ config, logger }) => ({
    postgres: createPostgres(config.DATABASE_URL, logger),
  }),
  migrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
  routes: (app, { config, resources, logger }) => {
    const repo = createConversationRepo(resources.postgres.pool);
    const agent = createServiceClient('agent', config.AGENT_URL, { timeoutMs: 5_000 });
    const modelGateway = createServiceClient('model-gateway', config.MODEL_GATEWAY_URL, {
      timeoutMs: 10_000,
    });
    // 登记成品要从 harness 复制文件，可能要一会儿
    const canvas = createServiceClient('canvas', config.CANVAS_URL, { timeoutMs: 600_000 });
    const harness = createServiceClient('harness', config.HARNESS_URL, { timeoutMs: 30_000 });
    const files = createGroupFiles({
      repo: createGroupFilesRepo(resources.postgres.pool),
      canvas,
      logger,
      maxFiles: config.GROUP_FILES_MAX,
      handoverBytes: config.GROUP_FILES_HANDOVER_BYTES,
    });
    const turns = createTurns({
      repo,
      agent,
      harness,
      canvas,
      modelGateway,
      logger,
      pollMs: config.TURN_POLL_MS,
      delivered: files.delivered,
    });
    const purge = createPurge({ harness, modelGateway, canvas });
    const dms = createDmService({
      repo,
      agent,
      harness,
      canvas,
      modelGateway,
      turns,
      purge,
      logger,
    });
    registerRoutes(app, dms);
    const groupRepo = createGroupRepo(resources.postgres.pool, {
      members: config.GROUP_MAX_MEMBERS,
      groups: config.GROUP_MAX_PER_USER,
      messagesPerMinute: config.GROUP_MESSAGES_PER_MINUTE,
      ais: config.GROUP_MAX_AIS,
    });
    const profiles = createProfiles({
      identity: createServiceClient('identity', config.IDENTITY_URL, { timeoutMs: 5_000 }),
      logger,
      onName: (profile) => groupRepo.syncName(profile.id, profile.name),
    });
    const seats = createGroupSeats(resources.postgres.pool);
    /** 每个群现在有几条推送连着（有人开着这个群） */
    const watching = new Map<string, number>();
    const speak = createGroupSpeak({
      talk: createGroupTalk(resources.postgres.pool),
      seats,
      store: repo,
      turns,
      agent,
      modelGateway,
      logger,
      files,
      model: config.GROUP_JUDGE_MODEL,
      quietMs: config.GROUP_QUIET_MS,
      watched: (groupId) => watching.has(groupId),
    });
    registerGroupRoutes(
      app,
      createGroupService({
        repo: groupRepo,
        seats,
        store: repo,
        turns,
        agent,
        profiles,
        files,
        speak,
        purge,
        logger,
      }),
      config.GROUP_STREAMS_PER_USER,
      watching,
    );
    registerGroupFileRoutes(app, files);
    registerFriendRoutes(
      app,
      createFriendService({
        repo: createFriendRepo(resources.postgres.pool, {
          friends: config.FRIEND_MAX,
          pending: config.FRIEND_REQUESTS_PENDING,
        }),
        profiles,
        files,
      }),
    );
    const resume = () =>
      void turns
        .resumeAll()
        .catch((err: unknown) => logger.warn({ err }, '接着跟进没结束的轮失败，稍后再试'));
    const sweep = setInterval(() => {
      resume();
      void speak
        .sweep(SWEEP_MS)
        .catch((err: unknown) => logger.warn({ err }, '看群里有没有 AI 想开口失败，稍后再试'));
    }, SWEEP_MS);
    sweep.unref();
    app.addHook('onReady', async () => resume());
    app.addHook('onClose', async () => {
      clearInterval(sweep);
      speak.close();
      await turns.close();
    });
  },
});
