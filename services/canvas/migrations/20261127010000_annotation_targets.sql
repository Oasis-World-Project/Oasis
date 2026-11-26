-- phase: migrate
-- migrate:up
-- 成果页的「批注」改成「编辑」（用户 2026-11-26 定）：不再有截图这一层，一处要改的地方记的是在哪（第几页、
-- 第几秒、画面上的一个点或一个框、选中的是什么）。存着的批注原地改写：
-- 1. 截图（批注的 frame 指着的上传文件）改回「没被用上」，由清扫照常连对象一起删掉；
-- 2. 圈改成同一个位置和大小的框，画笔改成起笔处的点；去掉 frame，补上 target（选中的是什么，以前没有）。
update uploads
set claimed_at = null
where id in (
  select (item->>'frame')::uuid
  from artifacts, jsonb_array_elements(annotations) as item
  where item->>'frame' is not null
);

update artifacts
set annotations = (
  select coalesce(
    jsonb_agg(
      (item - 'frame')
      || jsonb_build_object('target', null)
      || case
           when item->'shape'->>'kind' = 'ellipse'
             then jsonb_build_object('shape', (item->'shape') || jsonb_build_object('kind', 'box'))
           when item->'shape'->>'kind' = 'pen'
             then jsonb_build_object('shape', jsonb_build_object(
               'kind', 'pin',
               'x', item->'shape'->'points'->0->0,
               'y', item->'shape'->'points'->0->1))
           else '{}'::jsonb
         end
      order by position
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements(annotations) with ordinality as list(item, position)
)
where annotations <> '[]'::jsonb;

-- migrate:down
-- 圈和画笔原来的样子、截图都没留，改不回去：框当成圈，点照旧，补上空的 frame。
update artifacts
set annotations = (
  select coalesce(
    jsonb_agg(
      (item - 'target')
      || jsonb_build_object('frame', null)
      || case
           when item->'shape'->>'kind' = 'box'
             then jsonb_build_object('shape', (item->'shape') || jsonb_build_object('kind', 'ellipse'))
           else '{}'::jsonb
         end
      order by position
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements(annotations) with ordinality as list(item, position)
)
where annotations <> '[]'::jsonb;
