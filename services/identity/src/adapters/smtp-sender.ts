// 通过 SMTP 发登录验证码。本地开发发到 Mailpit；上线换成正式的邮件服务，只改 SMTP_URL。
import nodemailer from 'nodemailer';
import type { LoginCodeSender } from '../service/auth-service.ts';

export function createSmtpSender(options: { smtpUrl: string; from: string }): LoginCodeSender {
  const transport = nodemailer.createTransport(options.smtpUrl);
  return {
    async send(email, code) {
      await transport.sendMail({
        from: options.from,
        to: email,
        subject: `Oasis 登录验证码：${code}`,
        text: `你的 Oasis 登录验证码是 ${code}，10 分钟内有效。\n\n如果不是你本人操作，忽略这封邮件即可。`,
      });
    },
  };
}
