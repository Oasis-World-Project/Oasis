import { CreateHoldBody, SettleHoldBody, TreasuryDepositBody } from '@oasis/contracts/billing';
import { parseWith, requireUserId, type ServiceApp } from '@oasis/service-kit';
import { z } from 'zod';
import type { WalletService } from '../service/wallet-service.ts';

const HoldParams = z.object({ id: z.uuid() });

export function registerRoutes(app: ServiceApp, wallets: WalletService): void {
  app.get('/v1/wallet', async (request) => wallets.wallet(requireUserId(request)));

  // 以下只给 model-gateway 用
  app.post('/internal/holds', async (request, reply) => {
    const result = await wallets.hold(parseWith(CreateHoldBody, request.body));
    return reply.code(201).send(result);
  });
  app.post('/internal/holds/:id/renew', async (request, reply) => {
    const { ttlMs } = parseWith(
      z.object({
        ttlMs: z
          .number()
          .int()
          .min(60000)
          .max(6 * 3600000),
      }),
      request.body,
    );
    await wallets.renew(parseWith(HoldParams, request.params).id, ttlMs);
    return reply.code(204).send();
  });

  app.post('/internal/holds/:id/settle', async (request) => {
    const { id } = parseWith(HoldParams, request.params);
    const { costMicro, detail } = parseWith(SettleHoldBody, request.body);
    return wallets.settle(id, costMicro, detail);
  });

  // 以下只给 conversation 用：群的金库（账户号就是群的 ID；谁能存、谁能看由 conversation 按群成员核对）
  app.get('/internal/treasuries/:id', async (request) =>
    wallets.treasury(parseWith(HoldParams, request.params).id),
  );
  app.post('/internal/treasuries/:id/deposits', async (request) => {
    const { userId, amountMicro } = parseWith(TreasuryDepositBody, request.body);
    return wallets.deposit(parseWith(HoldParams, request.params).id, userId, amountMicro);
  });
  app.post('/internal/treasuries/:id/dissolve', async (request) =>
    wallets.dissolve(parseWith(HoldParams, request.params).id),
  );

  app.post('/internal/holds/:id/release', async (request, reply) => {
    await wallets.release(parseWith(HoldParams, request.params).id);
    return reply.code(204).send();
  });
}
