// 群的金库在回归里的那几步（group.mjs 用）：空着时叫 AI 不开工；成员从各自的钱包存进去；
// 花的记在叫它的人头上；解散时剩下的按各人存入的比例退回。
const OWNER_PUT = 4_000_000;
const MEMBER_PUT = 2_000_000;

/**
 * 金库空着时叫一次 AI（应不开工），再由群主存 $4、群员存 $2。
 * 返回之后两步的核对：spentBy（刚做完的一轮花的是金库、记在谁头上）、beforeDissolve（解散前记下余额，
 * 解散后调它返回的函数核对退回）。
 */
export async function openVault(t, { owner, member, groupId, ai, say }) {
  const url = `/conversation/v1/groups/${groupId}/vault`;
  const wallets = async () => ({
    owner: (await owner.wallet()).availableMicro,
    member: (await member.wallet()).availableMicro,
  });
  const start = await wallets();
  const empty = await say(member, groupId, '有人吗', [{ kind: 'ai', key: ai }]);
  t.check(
    empty.messages.at(-1)?.status === 'failed' &&
      empty.messages.at(-1)?.error?.includes('金库空了') &&
      !empty.ais.some((seat) => seat.runId),
    `金库空着时叫 AI 应不开工、写明金库空了：${JSON.stringify(empty.messages.at(-1) ?? null)}`,
  );
  await owner.api.post(`${url}/deposits`, { amountMicro: OWNER_PUT });
  const filled = await member.api.post(`${url}/deposits`, { amountMicro: MEMBER_PUT });
  const put = await wallets();
  t.check(
    filled.availableMicro === OWNER_PUT + MEMBER_PUT &&
      start.owner - put.owner === OWNER_PUT &&
      start.member - put.member === MEMBER_PUT,
    `存进金库的钱应从各自的钱包转出：金库 ${filled.availableMicro}，群主 ${start.owner}→${put.owner}，群员 ${start.member}→${put.member}`,
  );
  return {
    /** 刚做完的一轮：花的是金库的钱，记在叫它的这个人头上，两个人的钱包都没动 */
    async spentBy(caller) {
      const [vault, now] = [await owner.api.get(url), await wallets()];
      const others = vault.members.filter((m) => m.userId !== caller.userId);
      t.check(
        vault.availableMicro < OWNER_PUT + MEMBER_PUT &&
          vault.members.find((m) => m.userId === caller.userId)?.spentMicro > 0 &&
          others.every((m) => m.spentMicro === 0) &&
          now.owner === put.owner &&
          now.member === put.member,
        `群里的 AI 应花金库的钱、记在叫它的人头上：金库 ${vault.availableMicro}，各人 ${JSON.stringify(vault.members)}，群主 ${put.owner}→${now.owner}，群员 ${put.member}→${now.member}`,
      );
    },
    /** 解散前记下金库里还剩多少；解散后调返回的函数：剩下的按 4:2 退回各自的钱包 */
    async beforeDissolve() {
      const left = (await owner.api.get(url)).availableMicro;
      return async () => {
        const end = await wallets();
        const back = { owner: end.owner - put.owner, member: end.member - put.member };
        t.check(
          left > 0 &&
            back.owner + back.member === left &&
            Math.abs(back.owner - 2 * back.member) <= 2,
          `解散群后金库里剩下的 ${left} 应按 4:2 退回：群主 ${back.owner}，群员 ${back.member}`,
        );
      };
    },
  };
}
