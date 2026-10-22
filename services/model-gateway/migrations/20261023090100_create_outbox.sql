-- phase: expand
-- contract-plan: 不适用（新建表，没有旧结构需要收缩）
-- migrate:up
-- 事务发件箱：属于任务的模型调用结算后，在同一个事务里写下 model-gateway.call.settled，再由后台投递
create table outbox (
  id uuid primary key,
  subject text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  published_at timestamptz
);
create index outbox_unpublished on outbox (created_at) where published_at is null;

-- migrate:down
drop table outbox;
