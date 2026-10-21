// agent：模型目录（8 类）、每个用户的 AI 人设、自带 Key（加密存储）。
import { postgresAndEventBus, startService } from '@oasis/service-kit';

await startService({ name: 'agent', ...postgresAndEventBus });
