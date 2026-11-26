// 群的金库：群里的 AI 花的钱都从这里出（账户号就是群的 ID，钱记在 billing）。成员从自己的钱包存进来，
// 存进来就是群的、不能取回；解散群时剩下的按各人存入的比例退回各自的钱包。
import { TreasuryBody, TreasuryRefunds } from '@oasis/contracts/billing';
import { HttpError, type ServiceClient } from '@oasis/service-kit';

export function createVault(billing: ServiceClient) {
  const get = (groupId: string) =>
    billing.json('GET', `/internal/treasuries/${groupId}`, { schema: TreasuryBody });
  return {
    get,
    deposit: (groupId: string, userId: string, amountMicro: number) =>
      billing.json('POST', `/internal/treasuries/${groupId}/deposits`, {
        body: { userId, amountMicro },
        schema: TreasuryBody,
      }),
    dissolve: (groupId: string) =>
      billing.json('POST', `/internal/treasuries/${groupId}/dissolve`, {
        body: {},
        schema: TreasuryRefunds,
      }),
    /** 群里的 AI 开一轮前：金库空了就不开 */
    async funded(groupId: string) {
      if ((await get(groupId)).availableMicro <= 0)
        throw new HttpError(402, 'vault_empty', '金库空了，存入后群里的 AI 才能用');
    },
  };
}
export type Vault = ReturnType<typeof createVault>;
