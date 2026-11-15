-- phase: expand
-- contract-plan: 不适用（只新增资料列，没有被替换的旧结构需要收缩）
-- migrate:up
-- 账号资料：账号 ID（系统发的 8 位数字，不能改，别人按它加好友）、名字、签名、性别、地区、头像。
alter table users add column account_no text;
do $$
declare
  r record;
  candidate text;
begin
  for r in select id from users where account_no is null loop
    loop
      candidate := (10000000 + floor(random() * 90000000))::bigint::text;
      exit when not exists (select 1 from users where account_no = candidate);
    end loop;
    update users set account_no = candidate where id = r.id;
  end loop;
end $$;
alter table users alter column account_no set not null;
alter table users add constraint users_account_no_format check (account_no ~ '^[1-9][0-9]{7}$');
create unique index users_account_no on users (account_no);
-- 名字先给一个默认的（「用户」加账号 ID 后四位），用户自己改
alter table users add column name text;
update users set name = '用户' || right(account_no, 4);
alter table users alter column name set not null;
alter table users add constraint users_name_length check (length(name) between 1 and 20);
alter table users add column bio text not null default '' check (length(bio) <= 60);
alter table users add column gender text not null default '' check (gender in ('', 'male', 'female', 'other'));
alter table users add column region text not null default '' check (length(region) <= 30);
-- 头像：前端裁成小图（最多 200 KB）直接存在库里；avatar_version 每换一次加一，头像地址带着它，换了就是新地址
alter table users add column avatar bytea check (avatar is null or octet_length(avatar) <= 200000);
alter table users add column avatar_type text;
alter table users add column avatar_version integer not null default 0;

-- migrate:down
alter table users drop column avatar_version;
alter table users drop column avatar_type;
alter table users drop column avatar;
alter table users drop column region;
alter table users drop column gender;
alter table users drop column bio;
alter table users drop column name;
drop index users_account_no;
alter table users drop column account_no;
