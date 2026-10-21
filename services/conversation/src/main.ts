// conversation：群聊与私聊：群、成员、邀请、消息、@、发言方式，调 Jev 决定谁接话。
import { postgresAndEventBus, startService } from '@oasis/service-kit';

await startService({ name: 'conversation', ...postgresAndEventBus });
