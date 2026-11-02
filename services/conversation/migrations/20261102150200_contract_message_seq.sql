-- phase: contract
-- migrate:up
alter table messages alter column seq set not null;
alter table messages alter column seq set default 0;
alter table messages add constraint messages_seq_positive check(seq>0);
create unique index messages_conversation_seq on messages(conversation_id,seq);
-- migrate:down
drop index messages_conversation_seq;
alter table messages drop constraint messages_seq_positive;
alter table messages alter column seq drop default;
alter table messages alter column seq drop not null;
