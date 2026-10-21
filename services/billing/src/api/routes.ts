import { CreateHoldBody, SettleHoldBody } from '@oasis/contracts/billing';
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

  app.post('/internal/holds/:id/settle', async (request) => {
    const { id } = parseWith(HoldParams, request.params);
    const { costMicro, detail } = parseWith(SettleHoldBody, request.body);
    return wallets.settle(id, costMicro, detail);
  });

  app.post('/internal/holds/:id/release', async (request, reply) => {
    await wallets.release(parseWith(HoldParams, request.params).id);
    return reply.code(204).send();
  });
}
