// task：任务与工作流：任务、节点图（串行/并行/讨论/互审）、节点状态机、重跑。
import { postgresAndEventBus, startService } from '@oasis/service-kit';

await startService({ name: 'task', ...postgresAndEventBus });
