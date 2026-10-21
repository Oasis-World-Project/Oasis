// identity：账号与登录（邮箱验证码），注册后发出 user.registered 事件。
import { postgresAndEventBus, startService } from '@oasis/service-kit';

await startService({ name: 'identity', ...postgresAndEventBus });
