// billing：额度钱包：注册送 $30、预扣与结算、用量统计、群里消耗算群主。
import { postgresAndEventBus, startService } from '@oasis/service-kit';

await startService({ name: 'billing', ...postgresAndEventBus });
