import { ErrorBody, ReadyBody } from '@oasis/contracts/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, createService, type ServiceResource } from '../src/index.ts';

const BASE_ENV = { PORT: '0', LOG_LEVEL: 'silent' };

function fakeResource(
  name: string,
  options: { ok?: boolean; closed?: string[] } = {},
): ServiceResource {
  return {
    name,
    ready: async () => {
      if (options.ok === false) throw new Error(`${name} down`);
    },
    close: async () => {
      options.closed?.push(name);
    },
  };
}

describe('配置', () => {
  it('缺少的环境变量一次全部列出', async () => {
    const attempt = createService(
      { name: 't', env: { FOO_URL: z.string(), BAR_KEY: z.string() } },
      BASE_ENV,
    );
    await expect(attempt).rejects.toBeInstanceOf(ConfigError);
    await expect(attempt).rejects.toThrow(/FOO_URL[\s\S]*BAR_KEY/);
  });

  it('通用配置有默认值，类型被正确转换', async () => {
    const service = await createService({ name: 't', env: {} }, BASE_ENV);
    expect(service.config.PORT).toBe(0);
    expect(service.config.SHUTDOWN_GRACE_MS).toBe(10_000);
  });
});

describe('探针与通用接口', () => {
  it('/health 返回 ok，/v1/meta 返回服务名和版本', async () => {
    const service = await createService(
      { name: 'identity', env: {} },
      { ...BASE_ENV, SERVICE_VERSION: '1.2.3', GIT_COMMIT: 'abc1234' },
    );
    const health = await service.app.inject('/health');
    expect(health.json()).toEqual({ status: 'ok' });
    const meta = await service.app.inject('/v1/meta');
    expect(meta.json()).toEqual({ service: 'identity', version: '1.2.3', commit: 'abc1234' });
  });

  it('依赖全部可用时 /ready 返回 200', async () => {
    const service = await createService(
      {
        name: 't',
        env: {},
        resources: async () => [fakeResource('postgres'), fakeResource('nats')],
      },
      BASE_ENV,
    );
    const res = await service.app.inject('/ready');
    expect(res.statusCode).toBe(200);
    expect(ReadyBody.parse(res.json())).toEqual({
      status: 'ready',
      checks: { postgres: 'ok', nats: 'ok' },
    });
  });

  it('任一依赖不可用时 /ready 返回 503 并指出是哪一项', async () => {
    const service = await createService(
      {
        name: 't',
        env: {},
        resources: async () => [fakeResource('postgres'), fakeResource('nats', { ok: false })],
      },
      BASE_ENV,
    );
    const res = await service.app.inject('/ready');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready', checks: { postgres: 'ok', nats: 'failed' } });
  });

  it('沿用调用方的 x-request-id，并在响应里带回', async () => {
    const service = await createService({ name: 't', env: {} }, BASE_ENV);
    const res = await service.app.inject({ url: '/health', headers: { 'x-request-id': 'req-42' } });
    expect(res.headers['x-request-id']).toBe('req-42');
  });
});

describe('错误格式', () => {
  it('不存在的接口返回统一的 404 错误体', async () => {
    const service = await createService({ name: 't', env: {} }, BASE_ENV);
    const res = await service.app.inject('/nope');
    expect(res.statusCode).toBe(404);
    expect(ErrorBody.parse(res.json()).error.code).toBe('not_found');
  });

  it('未处理的异常返回 500，且不向外泄露内部信息', async () => {
    const service = await createService(
      {
        name: 't',
        env: {},
        routes: (app) => {
          app.get('/v1/boom', async () => {
            throw new Error('数据库密码是 hunter2');
          });
        },
      },
      BASE_ENV,
    );
    const res = await service.app.inject('/v1/boom');
    expect(res.statusCode).toBe(500);
    const body = ErrorBody.parse(res.json());
    expect(body.error.code).toBe('internal_error');
    expect(res.body).not.toContain('hunter2');
  });
});

describe('优雅关闭', () => {
  it('关闭期间 /ready 返回 503，依赖按创建顺序的倒序关闭', async () => {
    const closed: string[] = [];
    const service = await createService(
      {
        name: 't',
        env: {},
        resources: async () => [
          fakeResource('postgres', { closed }),
          fakeResource('nats', { closed }),
        ],
      },
      { ...BASE_ENV, SHUTDOWN_DRAIN_MS: '50' },
    );
    const stopping = service.stop();
    const during = await service.app.inject('/ready');
    expect(during.statusCode).toBe(503);
    await stopping;
    expect(closed).toEqual(['nats', 'postgres']);
  });

  it('重复调用 stop 只关闭一次', async () => {
    const closed: string[] = [];
    const service = await createService(
      { name: 't', env: {}, resources: async () => [fakeResource('postgres', { closed })] },
      BASE_ENV,
    );
    await Promise.all([service.stop(), service.stop()]);
    expect(closed).toEqual(['postgres']);
  });
});
