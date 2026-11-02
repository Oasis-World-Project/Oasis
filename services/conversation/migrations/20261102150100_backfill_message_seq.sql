-- phase: migrate
-- migrate:up
-- New inserts already start above the count of legacy rows. Only legacy NULLs are assigned.
with ranked as (select id,row_number() over(partition by conversation_id order by created_at,id) as n from messages where seq is null)
update messages m set seq=ranked.n from ranked where m.id=ranked.id;
-- migrate:down
-- Preserve assigned ordering on rollback; expand/down removes the additive columns.
select 1;
