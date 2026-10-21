// gateway：唯一对外入口。登录校验（第 4 阶段）、限流、WebSocket 推送都放在这里。
import { startService } from '@oasis/service-kit';
import { gatewayService } from './app.ts';

await startService(gatewayService);
