// harness：Agent 运行时：唯一接触 DeepSeek Harness 的服务，把工作流节点变成一次 agent 运行。
import { postgresAndEventBus, startService } from '@oasis/service-kit';

await startService({ name: 'harness', ...postgresAndEventBus });
