-- phase: migrate
-- migrate:up
-- 权限从三项（access 只读/可改项目文件夹/完全访问、beyond 超出时问/允许/不做、paidTools 花钱的工具问不问）
-- 收成两档（用户 2026-11-26 定）：手动（改项目文件夹里的不问，出文件夹的事、花钱的工具问）、自动（都不问）；
-- 云端沙箱不分档，都不问。存着的设置原地改写：完全访问且超出时直接允许的、在云端的 → 自动；其余 → 手动，
-- 原来设了「直接允许」「不问」的那一类记进 always（以后都允许）。
update conversations
set permissions =
  case
    when workplace is null
      or workplace->>'kind' = 'cloud'
      or (permissions->>'access' = 'full' and permissions->>'beyond' = 'allow')
    then jsonb_build_object('mode', 'auto')
    else jsonb_build_object(
      'mode', 'manual',
      'always', to_jsonb(array_remove(array[
        case when permissions->>'beyond' = 'allow' then 'command' end,
        case when permissions->>'paidTools' = 'allow' then 'tool' end
      ], null))
    )
  end
  || case when permissions ? 'web' then jsonb_build_object('web', permissions->'web') else '{}'::jsonb end
where permissions ? 'access';

-- migrate:down
update conversations
set permissions =
  jsonb_build_object(
    'access', case when permissions->>'mode' = 'auto' then 'full' else 'project' end,
    'beyond', case
      when workplace is null or workplace->>'kind' = 'cloud' then 'deny'
      when permissions->>'mode' = 'auto' or coalesce(permissions->'always', '[]'::jsonb) ? 'command' then 'allow'
      else 'ask'
    end,
    'paidTools', case
      when permissions->>'mode' = 'auto' or coalesce(permissions->'always', '[]'::jsonb) ? 'tool' then 'allow'
      else 'ask'
    end
  )
  || case when permissions ? 'web' then jsonb_build_object('web', permissions->'web') else '{}'::jsonb end
where permissions ? 'mode';
