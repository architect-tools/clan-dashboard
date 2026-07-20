-- Safe, service-role-only mutations that the local QA worker may apply after
-- Codex returns a validated structured result.

create or replace function public.dashboard_service_request_mutate(
  p_slug text,
  p_action text,
  p_data jsonb
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_clan_id uuid;
  v_items jsonb;
  v_result jsonb;
  v_name text;
  v_category text;
  v_points numeric;
  v_weekly integer;
  v_active boolean;
begin
  select id into v_clan_id from public.clans where slug = p_slug for update;
  if v_clan_id is null then raise exception 'clan not found'; end if;

  if p_action = 'content.upsert' then
    v_name := btrim(coalesce(p_data->>'name', ''));
    v_category := btrim(coalesce(p_data->>'category', ''));
    if v_name = '' then raise exception 'content name is required'; end if;
    if v_category = '' then raise exception 'content category is required'; end if;

    v_points := coalesce((p_data->>'points')::numeric, 0);
    v_weekly := greatest(1, coalesce((p_data->>'weekly')::integer, 1));
    v_active := coalesce((p_data->>'active')::boolean, v_points > 0);
    v_result := jsonb_build_object(
      'category', v_category,
      'name', v_name,
      'points', v_points,
      'weekly', v_weekly,
      'active', v_active
    );

    select data into v_items
    from public.clan_documents
    where clan_id = v_clan_id and key = 'contentCatalog'
    for update;
    v_items := coalesce(v_items, '[]'::jsonb);
    if jsonb_typeof(v_items) <> 'array' then raise exception 'contentCatalog is not an array'; end if;

    select coalesce(jsonb_agg(item), '[]'::jsonb) into v_items
    from jsonb_array_elements(v_items) item
    where item->>'name' <> v_name;
    v_items := v_items || jsonb_build_array(v_result);

    insert into public.clan_documents(clan_id, key, data)
    values(v_clan_id, 'contentCatalog', v_items)
    on conflict(clan_id, key) do update
      set data = excluded.data, updated_at = now();
  else
    raise exception 'unsupported request mutation: %', p_action;
  end if;

  update public.clans set revision = revision + 1, updated_at = now() where id = v_clan_id;
  return v_result;
end;
$$;
revoke all on function public.dashboard_service_request_mutate(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.dashboard_service_request_mutate(text,text,jsonb) to service_role;

create or replace function public.dashboard_service_request_mutate_service(
  p_slug text,
  p_action text,
  p_data jsonb
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  return public.dashboard_service_request_mutate(p_slug,p_action,p_data);
end;
$$;
revoke all on function public.dashboard_service_request_mutate_service(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.dashboard_service_request_mutate_service(text,text,jsonb) to service_role;
