// 结构化 JSON 日志，只写 stdout，不写本地文件（项目工程方向 §2.2）。
import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(service: string, level: string): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}
