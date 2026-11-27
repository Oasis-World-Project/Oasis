-- phase: expand
-- contract-plan: 不适用（只多收一种会话、成员上加一列，没有旧结构要收缩）
-- migrate:up
-- 群里每个人各管各的（用户 2026-11-26 定）：一个成员 @ 一个 AI，在「他和这个 AI 的家」里做——kind = 'home' 的一行，
-- 挂在群下面，options.member 是这个成员，一个成员和一个 AI 一行；过程只给他看。
-- 家在哪（他的电脑上给这个群选的文件夹，或云端）、动手前问不问，按成员记在 group_members.home 上
-- （{ workplace, permissions }，空是云端），他在这个群里的每个家都用它。
alter table conversations drop constraint conversations_kind_check;
alter table conversations add constraint conversations_kind_check
  check (kind in ('dm', 'group', 'seat', 'direct', 'task', 'home'));
create unique index conversations_home_once
  on conversations (parent_id, model_key, (options->>'member')) where kind = 'home';
alter table group_members add column home jsonb;

-- migrate:down
alter table group_members drop column home;
drop index conversations_home_once;
delete from conversations where kind = 'home';
alter table conversations drop constraint conversations_kind_check;
alter table conversations add constraint conversations_kind_check
  check (kind in ('dm', 'group', 'seat', 'direct', 'task'));
