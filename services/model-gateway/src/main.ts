// model-gateway：所有模型调用的唯一出口（OpenAI 兼容），计量后上报 billing。
import { postgresAndEventBus, startService } from '@oasis/service-kit';

await startService({ name: 'model-gateway', ...postgresAndEventBus });
