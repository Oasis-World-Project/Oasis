// canvas：画布：成果、批注、文件（存对象存储），每个成果只留最新一版。
import { postgresAndEventBus, startService } from '@oasis/service-kit';

await startService({ name: 'canvas', ...postgresAndEventBus });
