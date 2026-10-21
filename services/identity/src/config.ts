import { postgresAndEventBus } from '@oasis/service-kit';
import { z } from 'zod';

export const identityEnv = {
  ...postgresAndEventBus.env,
  /** 发验证码邮件的 SMTP 地址；本地是 Mailpit */
  SMTP_URL: z.url({ protocol: /^smtps?$/ }),
  MAIL_FROM: z.string().min(3),
  /** 验证码哈希用的密钥，泄露后需要更换 */
  AUTH_CODE_PEPPER: z.string().min(16),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** 会话 Cookie 是否只走 HTTPS；只有本地开发可以关掉 */
  COOKIE_SECURE: z.stringbool().default(true),
};
