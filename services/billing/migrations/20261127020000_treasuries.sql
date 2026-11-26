-- phase: expand
-- contract-plan: 不适用（只加列、多收两种流水，没有旧结构要收缩）
-- migrate:up
-- 金库（用户 2026-11-26 定）：群里的钱从群的金库出。钱包按账户算——个人的账户号是用户 ID，群的金库是群的 ID，
-- 都在 wallets 里（user_id 这一列就是账户号）。成员把自己钱包里的钱存进金库，解散时剩下的按各人存入的比例退回。
-- 1. 冻结和流水上记「是谁叫 AI 花的」（actor_id；个人钱包花自己的钱时不用记）；
-- 2. 流水多两种：transfer_out（从这个账户转出）、transfer_in（转进这个账户），actor_id 记对方是谁
--    （存入时金库这一行上是存的人，退回时是收的人），detail.giftedMicro 记其中有多少是注册送的额度；
-- 3. 解散了的金库记下时间（closed_at）：不能再冻结；解散时还冻结着的钱，之后退回来了再按比例退给各人。
alter table holds add column actor_id uuid;
alter table wallets add column closed_at timestamptz;
alter table ledger_entries add column actor_id uuid;
alter table ledger_entries drop constraint ledger_entries_kind_check;
alter table ledger_entries
  add constraint ledger_entries_kind_check
  check (kind in ('grant', 'charge', 'transfer_out', 'transfer_in'));
create index ledger_actor on ledger_entries (user_id, actor_id) where actor_id is not null;

-- migrate:down
drop index ledger_actor;
delete from ledger_entries where kind in ('transfer_out', 'transfer_in');
alter table ledger_entries drop constraint ledger_entries_kind_check;
alter table ledger_entries
  add constraint ledger_entries_kind_check check (kind in ('grant', 'charge'));
alter table ledger_entries drop column actor_id;
alter table holds drop column actor_id;
alter table wallets drop column closed_at;
