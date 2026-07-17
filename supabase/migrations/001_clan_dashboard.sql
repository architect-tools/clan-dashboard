-- ClanDashboard realtime backend for Supabase/Postgres.
-- Run with the Supabase SQL editor or CLI, then enable Anonymous Sign-Ins.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.clans (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null default '',
  member_password_hash text not null,
  admin_password_hash text not null,
  revision bigint not null default 0,
  admin_revision bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  clan_id uuid not null references public.clans(id) on delete cascade,
  member_id bigint,
  role text not null check (role in ('member', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Low-contention, admin-owned root state (settings, catalogs, logs, etc.).
create table if not exists public.clan_documents (
  clan_id uuid not null references public.clans(id) on delete cascade,
  key text not null,
  data jsonb not null default 'null'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (clan_id, key)
);

-- One row per member. Atomic member actions update only the addressed row/key.
create table if not exists public.members (
  clan_id uuid not null references public.clans(id) on delete cascade,
  member_id bigint not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (clan_id, member_id)
);
create index if not exists members_name_idx on public.members (clan_id, ((data->>'name')));

create table if not exists public.participation_events (
  clan_id uuid not null references public.clans(id) on delete cascade,
  event_date text not null,
  content text not null,
  member_ids bigint[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (clan_id, event_date, content)
);

create table if not exists public.status_boards (
  clan_id uuid not null references public.clans(id) on delete cascade,
  board_id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (clan_id, board_id)
);

create table if not exists public.status_board_cells (
  clan_id uuid not null,
  board_id text not null,
  member_id bigint not null,
  column_name text not null,
  updated_at timestamptz not null default now(),
  primary key (clan_id, board_id, member_id, column_name),
  foreign key (clan_id, board_id) references public.status_boards(clan_id, board_id) on delete cascade,
  foreign key (clan_id, member_id) references public.members(clan_id, member_id) on delete cascade
);

create table if not exists public.sales (
  clan_id uuid not null references public.clans(id) on delete cascade,
  sale_id text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (clan_id, sale_id)
);

create table if not exists public.sale_bids (
  clan_id uuid not null,
  sale_id text not null,
  member_id bigint,
  member_name text not null,
  amount numeric not null default 0,
  created_at timestamptz not null default now(),
  primary key (clan_id, sale_id, member_name),
  foreign key (clan_id, sale_id) references public.sales(clan_id, sale_id) on delete cascade
);

create table if not exists public.qa_reports (
  clan_id uuid not null references public.clans(id) on delete cascade,
  report_id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (clan_id, report_id)
);

create table if not exists public.applied_mutations (
  clan_id uuid not null references public.clans(id) on delete cascade,
  mutation_id text not null,
  created_at timestamptz not null default now(),
  primary key (clan_id, mutation_id)
);
create index if not exists applied_mutations_created_idx on public.applied_mutations (clan_id, created_at);

alter table public.clans enable row level security;
alter table public.profiles enable row level security;
alter table public.clan_documents enable row level security;
alter table public.members enable row level security;
alter table public.participation_events enable row level security;
alter table public.status_boards enable row level security;
alter table public.status_board_cells enable row level security;
alter table public.sales enable row level security;
alter table public.sale_bids enable row level security;
alter table public.qa_reports enable row level security;
alter table public.applied_mutations enable row level security;

create or replace function public.can_read_clan(p_clan_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.clan_id = p_clan_id
  );
$$;
revoke all on function public.can_read_clan(uuid) from public;
grant execute on function public.can_read_clan(uuid) to authenticated;

drop policy if exists clans_read on public.clans;
create policy clans_read on public.clans for select to authenticated
using (public.can_read_clan(id));

drop policy if exists profiles_read_self on public.profiles;
create policy profiles_read_self on public.profiles for select to authenticated
using (user_id = auth.uid());

do $$
declare t text;
begin
  foreach t in array array['clan_documents','members','participation_events','status_boards',
    'status_board_cells','sales','sale_bids','qa_reports','applied_mutations']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.can_read_clan(clan_id))', t || '_read', t);
  end loop;
end $$;

-- Anonymous gate helper: only active nicknames are exposed before login.
create or replace function public.dashboard_roster(p_slug text)
returns table(name text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select m.data->>'name'
  from public.members m join public.clans c on c.id = m.clan_id
  where c.slug = p_slug
    and coalesce((m.data->>'active')::boolean, true)
    and nullif(m.data->>'name', '') is not null
  order by m.data->>'name';
$$;
revoke all on function public.dashboard_roster(text) from public;
grant execute on function public.dashboard_roster(text) to anon, authenticated;

create or replace function public.dashboard_claim(p_slug text, p_member_name text, p_password text)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
declare
  v_clan public.clans%rowtype;
  v_member_id bigint;
  v_role text;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  select * into v_clan from public.clans where slug = p_slug;
  if not found then raise exception 'clan not found'; end if;

  select member_id into v_member_id from public.members
  where clan_id = v_clan.id and data->>'name' = trim(p_member_name)
    and coalesce((data->>'active')::boolean, true);
  if v_member_id is null then raise exception 'member not found'; end if;

  if v_clan.admin_password_hash = extensions.crypt(p_password, v_clan.admin_password_hash) then
    v_role := 'admin';
  elsif v_clan.member_password_hash = extensions.crypt(p_password, v_clan.member_password_hash) then
    v_role := 'member';
  else
    raise exception 'invalid password';
  end if;

  insert into public.profiles(user_id, clan_id, member_id, role)
  values (auth.uid(), v_clan.id, v_member_id, v_role)
  on conflict (user_id) do update set clan_id = excluded.clan_id, member_id = excluded.member_id,
    role = excluded.role, updated_at = now();
  return jsonb_build_object('clanId', v_clan.id, 'memberId', v_member_id,
    'name', trim(p_member_name), 'role', v_role);
end;
$$;
revoke all on function public.dashboard_claim(text,text,text) from public;
grant execute on function public.dashboard_claim(text,text,text) to authenticated;

create or replace function public.dashboard_profile()
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object('clanId', p.clan_id, 'memberId', p.member_id,
    'name', m.data->>'name', 'role', p.role)
  from public.profiles p
  join public.members m on m.clan_id = p.clan_id and m.member_id = p.member_id
  where p.user_id = auth.uid();
$$;
revoke all on function public.dashboard_profile() from public;
grant execute on function public.dashboard_profile() to authenticated;

-- Change nickname/role without creating another anonymous Auth user.
create or replace function public.dashboard_release()
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  delete from public.profiles where user_id=auth.uid();
  return true;
end;
$$;
revoke all on function public.dashboard_release() from public;
grant execute on function public.dashboard_release() to authenticated;

create or replace function public.dashboard_state_for(p_clan_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_state jsonb := '{}'::jsonb;
  v_members jsonb := '[]'::jsonb;
  v_by_date jsonb := '{}'::jsonb;
  v_boards jsonb := '[]'::jsonb;
  v_sales jsonb := '[]'::jsonb;
  v_qa jsonb := '[]'::jsonb;
  v_revision bigint;
  v_admin_revision bigint;
begin
  select coalesce(jsonb_object_agg(key, data), '{}'::jsonb)
    into v_state from public.clan_documents where clan_id = p_clan_id;
  select revision, admin_revision into v_revision, v_admin_revision
    from public.clans where id = p_clan_id;

  select coalesce(jsonb_agg(data order by member_id), '[]'::jsonb)
    into v_members from public.members where clan_id = p_clan_id;

  select coalesce(jsonb_object_agg(event_date, contents), '{}'::jsonb) into v_by_date
  from (
    select event_date, jsonb_object_agg(content, to_jsonb(member_ids)) as contents
    from public.participation_events where clan_id = p_clan_id group by event_date
  ) d;

  select coalesce(jsonb_agg(
    b.data || jsonb_build_object('data', coalesce((
      select jsonb_object_agg(member_id::text, cols) from (
        select member_id, jsonb_object_agg(column_name, true) as cols
        from public.status_board_cells c
        where c.clan_id = b.clan_id and c.board_id = b.board_id
        group by member_id
      ) cells
    ), '{}'::jsonb)) order by b.board_id
  ), '[]'::jsonb) into v_boards
  from public.status_boards b where b.clan_id = p_clan_id;

  select coalesce(jsonb_agg(
    s.data || jsonb_build_object('bids', coalesce((
      select jsonb_agg(jsonb_build_object('name', member_name, 'amount', amount) order by created_at)
      from public.sale_bids b where b.clan_id = s.clan_id and b.sale_id = s.sale_id
    ), '[]'::jsonb)) order by s.created_at
  ), '[]'::jsonb) into v_sales
  from public.sales s where s.clan_id = p_clan_id;

  select coalesce(jsonb_agg(data order by coalesce(data->>'createdAt','') desc), '[]'::jsonb)
    into v_qa from public.qa_reports where clan_id = p_clan_id;

  v_state := v_state || jsonb_build_object(
    'members', v_members,
    'participation', coalesce(v_state->'participation', '{}'::jsonb) || jsonb_build_object('byDate', v_by_date),
    'statusBoards', v_boards,
    'sales', v_sales,
    'qaReports', v_qa
  );
  v_state := jsonb_set(v_state, '{meta}', coalesce(v_state->'meta', '{}'::jsonb) ||
    jsonb_build_object('revision', coalesce(v_revision,0), 'adminRevision', coalesce(v_admin_revision,0)));
  return v_state;
end;
$$;
revoke all on function public.dashboard_state_for(uuid) from public;

create or replace function public.dashboard_state()
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_clan_id uuid;
begin
  select clan_id into v_clan_id from public.profiles where user_id = auth.uid();
  if v_clan_id is null then raise exception 'identity not claimed'; end if;
  return public.dashboard_state_for(v_clan_id);
end;
$$;
revoke all on function public.dashboard_state() from public;
grant execute on function public.dashboard_state() to authenticated;

create or replace function public.dashboard_mutate(p_kind text, p_payload jsonb, p_mutation_id text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_member_id bigint;
  v_member jsonb;
  v_key text;
  v_bag jsonb;
  v_on boolean;
  v_count integer;
  v_sale jsonb;
  v_sale_id text;
  v_member_name text;
  v_before integer;
  v_winner text;
  v_amount numeric;
  v_result jsonb := '{}'::jsonb;
  v_inserted integer;
  v_now_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000);
begin
  select * into v_profile from public.profiles where user_id = auth.uid();
  if not found then raise exception 'identity not claimed'; end if;
  if nullif(trim(p_mutation_id), '') is null then raise exception 'mutation id required'; end if;

  insert into public.applied_mutations(clan_id, mutation_id)
  values (v_profile.clan_id, p_mutation_id) on conflict do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return jsonb_build_object('ok', true, 'duplicate', true,
      'state', public.dashboard_state_for(v_profile.clan_id));
  end if;

  if p_kind in ('equipment.set','skill.toggle','skill.adjust') then
    v_member_id := coalesce(nullif(p_payload->>'memberId','')::bigint, v_profile.member_id);
    if v_profile.role <> 'admin' and v_member_id <> v_profile.member_id then
      raise exception '본인 데이터만 변경할 수 있습니다.';
    end if;
    select data into v_member from public.members
      where clan_id = v_profile.clan_id and member_id = v_member_id for update;
    if v_member is null then raise exception 'member not found'; end if;
    if v_profile.role <> 'admin' and coalesce((v_member->>'active')::boolean, true) is false then
      raise exception 'inactive member';
    end if;
  end if;

  if p_kind = 'equipment.set' then
    v_key := trim(p_payload->>'slot');
    if v_key = '' or length(v_key) > 200 then raise exception 'invalid equipment slot'; end if;
    v_bag := coalesce(v_member->'equip', '{}'::jsonb);
    if p_payload->'value' is null or p_payload->'value' = 'null'::jsonb then v_bag := v_bag - v_key;
    else v_bag := jsonb_set(v_bag, array[v_key], p_payload->'value', true); end if;
    v_member := jsonb_set(v_member, '{equip}', v_bag, true);
    update public.members set data = v_member, updated_at = now()
      where clan_id = v_profile.clan_id and member_id = v_member_id;
    v_result := jsonb_build_object('member', v_member, 'slot', v_key, 'value', p_payload->'value');

  elsif p_kind = 'skill.toggle' then
    if (p_payload->>'category') not in ('주문석','엘릭서') then raise exception 'invalid skill category'; end if;
    v_key := trim(p_payload->>'key');
    if v_key = '' or length(v_key) > 200 then raise exception 'invalid skill'; end if;
    v_member := jsonb_set(v_member, '{skills}', coalesce(v_member->'skills', '{}'::jsonb), true);
    v_bag := coalesce(v_member#>array['skills',p_payload->>'category'], '{}'::jsonb);
    v_on := not (v_bag ? v_key);
    if v_on then v_bag := jsonb_set(v_bag, array[v_key], 'true'::jsonb, true); else v_bag := v_bag - v_key; end if;
    v_member := jsonb_set(v_member, array['skills',p_payload->>'category'], v_bag, true);
    update public.members set data = v_member, updated_at = now()
      where clan_id = v_profile.clan_id and member_id = v_member_id;
    v_result := jsonb_build_object('member', v_member, 'category', p_payload->>'category', 'key', v_key, 'on', v_on);

  elsif p_kind = 'skill.adjust' then
    v_key := trim(p_payload->>'key');
    if v_key = '' or length(v_key) > 200 then raise exception 'invalid skill'; end if;
    v_member := jsonb_set(v_member, '{skills}', coalesce(v_member->'skills', '{}'::jsonb), true);
    v_bag := coalesce(v_member#>'{skills,공용주문석}', '{}'::jsonb);
    v_count := greatest(0, least(99, coalesce((v_bag->>v_key)::integer, 0) +
      case when coalesce((p_payload->>'delta')::integer, 0) < 0 then -1 else 1 end));
    if v_count = 0 then v_bag := v_bag - v_key;
    else v_bag := jsonb_set(v_bag, array[v_key], to_jsonb(v_count), true); end if;
    v_member := jsonb_set(v_member, '{skills,공용주문석}', v_bag, true);
    update public.members set data = v_member, updated_at = now()
      where clan_id = v_profile.clan_id and member_id = v_member_id;
    v_result := jsonb_build_object('member', v_member, 'category', '공용주문석', 'key', v_key, 'count', v_count);

  elsif p_kind = 'board.toggle' then
    v_member_id := coalesce(nullif(p_payload->>'memberId','')::bigint, v_profile.member_id);
    if v_profile.role <> 'admin' and v_member_id <> v_profile.member_id then raise exception '본인 데이터만 변경할 수 있습니다.'; end if;
    if not exists(select 1 from public.members where clan_id=v_profile.clan_id and member_id=v_member_id) then
      raise exception 'member not found';
    end if;
    v_key := trim(p_payload->>'column');
    if not exists (select 1 from public.status_boards where clan_id = v_profile.clan_id
      and board_id = p_payload->>'boardId' and coalesce(data->'columns','[]'::jsonb) ? v_key) then
      raise exception 'board column not found';
    end if;
    delete from public.status_board_cells where clan_id = v_profile.clan_id and board_id = p_payload->>'boardId'
      and member_id = v_member_id and column_name = v_key;
    get diagnostics v_before = row_count;
    v_on := v_before = 0;
    if v_on then insert into public.status_board_cells(clan_id,board_id,member_id,column_name)
      values(v_profile.clan_id,p_payload->>'boardId',v_member_id,v_key); end if;
    v_result := jsonb_build_object('boardId', p_payload->>'boardId', 'memberId', v_member_id, 'column', v_key, 'on', v_on);

  elsif p_kind = 'sale.create' then
    if v_profile.role <> 'admin' then raise exception 'admin only'; end if;
    v_sale_id := coalesce(nullif(trim(p_payload->>'id'),''), gen_random_uuid()::text);
    v_sale := jsonb_build_object('id',v_sale_id,'item',trim(p_payload->>'item'),
      'bidType',case when p_payload->>'bidType' in ('투력순','참여도순','경매','선착순') then p_payload->>'bidType' else '투력순' end,
      'basePrice',greatest(0,coalesce((p_payload->>'basePrice')::numeric,0)),
      'deadline',coalesce((p_payload->>'deadline')::bigint,v_now_ms+3600000));
    insert into public.sales(clan_id,sale_id,data) values(v_profile.clan_id,v_sale_id,v_sale);
    v_result := jsonb_build_object('sale', v_sale || jsonb_build_object('bids','[]'::jsonb));

  elsif p_kind in ('sale.bid','sale.cancelBid','sale.cancel','sale.close') then
    v_sale_id := p_payload->>'saleId';
    select data into v_sale from public.sales where clan_id = v_profile.clan_id and sale_id = v_sale_id for update;
    if v_sale is null then raise exception 'sale not found'; end if;

    if p_kind = 'sale.bid' then
      if coalesce((v_sale->>'deadline')::bigint,0) < v_now_ms then raise exception '마감된 내판입니다.'; end if;
      v_member_id := coalesce(nullif(p_payload->>'memberId','')::bigint, v_profile.member_id);
      if v_profile.role <> 'admin' and v_member_id <> v_profile.member_id then raise exception '본인 데이터만 변경할 수 있습니다.'; end if;
      select data->>'name' into v_member_name from public.members where clan_id=v_profile.clan_id and member_id=v_member_id;
      if v_member_name is null then raise exception 'member not found'; end if;
      insert into public.sale_bids(clan_id,sale_id,member_id,member_name,amount)
      values(v_profile.clan_id,v_sale_id,v_member_id,v_member_name,
        case when v_sale->>'bidType'='경매' then greatest(0,coalesce((p_payload->>'amount')::numeric,0)) else 0 end);
      v_result := jsonb_build_object('saleId',v_sale_id,'bid',jsonb_build_object('name',v_member_name,'amount',
        case when v_sale->>'bidType'='경매' then greatest(0,coalesce((p_payload->>'amount')::numeric,0)) else 0 end));

    elsif p_kind = 'sale.cancelBid' then
      if v_profile.role = 'admin' then v_member_name := trim(p_payload->>'memberName');
      else select data->>'name' into v_member_name from public.members where clan_id=v_profile.clan_id and member_id=v_profile.member_id; end if;
      delete from public.sale_bids where clan_id=v_profile.clan_id and sale_id=v_sale_id and member_name=v_member_name;
      get diagnostics v_before = row_count;
      if v_before = 0 then raise exception '입찰 내역이 없습니다.'; end if;
      v_result := jsonb_build_object('saleId',v_sale_id,'memberName',v_member_name);

    elsif p_kind = 'sale.cancel' then
      if v_profile.role <> 'admin' then raise exception 'admin only'; end if;
      delete from public.sales where clan_id=v_profile.clan_id and sale_id=v_sale_id;
      v_result := jsonb_build_object('saleId',v_sale_id);

    else
      if v_profile.role <> 'admin' then raise exception 'admin only'; end if;
      select b.member_name, b.amount into v_winner, v_amount
      from public.sale_bids b left join public.members m on m.clan_id=b.clan_id and m.member_id=b.member_id
      where b.clan_id=v_profile.clan_id and b.sale_id=v_sale_id
      order by
        case when v_sale->>'bidType'='투력순' then coalesce((m.data->>'power')::numeric,0) end desc nulls last,
        case when v_sale->>'bidType'='참여도순' then coalesce((m.data->>'score')::numeric,0) end desc nulls last,
        case when v_sale->>'bidType'='경매' then b.amount end desc nulls last,
        b.created_at asc limit 1;
      if v_winner is null then raise exception '입찰자가 없습니다.'; end if;
      if v_sale->>'bidType' <> '경매' then v_amount := coalesce((v_sale->>'basePrice')::numeric,0); end if;
      insert into public.clan_documents(clan_id,key,data) values(v_profile.clan_id,'distributionLog',jsonb_build_array(
        jsonb_build_object('id','id'||gen_random_uuid()::text,'date',to_char(current_date,'YYYY-MM-DD'),
          'item',v_sale->>'item','type','내판','member',v_winner,'from','','price',v_amount,'note',v_sale->>'bidType')))
      on conflict(clan_id,key) do update set data=excluded.data || public.clan_documents.data, updated_at=now();
      delete from public.sales where clan_id=v_profile.clan_id and sale_id=v_sale_id;
      update public.clans set admin_revision=admin_revision+1 where id=v_profile.clan_id;
      v_result := jsonb_build_object('saleId',v_sale_id,'winner',jsonb_build_object('name',v_winner,'amount',v_amount),
        'price',v_amount,'bidType',v_sale->>'bidType','item',v_sale->>'item');
    end if;

  elsif p_kind in ('qa.add','qa.update','qa.delete') then
    if v_profile.role <> 'admin' then raise exception 'admin only'; end if;
    if p_kind = 'qa.add' then
      v_key := coalesce(nullif(p_payload#>>'{report,id}',''),'qa-' || gen_random_uuid()::text);
      v_sale_id := coalesce(nullif(p_payload#>>'{report,slot}',''),
        'QA-' || to_char(clock_timestamp() at time zone 'UTC','YYYYMMDD-HH24MISSMS') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,6)));
      v_result := coalesce(p_payload->'report','{}'::jsonb) || jsonb_build_object(
        'id',v_key,'slot',v_sale_id,'status',coalesce(nullif(p_payload#>>'{report,status}',''),'open'),
        'severity',coalesce(nullif(p_payload#>>'{report,severity}',''),'normal'),
        'createdAt',coalesce(p_payload#>'{report,createdAt}',to_jsonb(clock_timestamp())),
        'updatedAt',to_jsonb(clock_timestamp()));
      insert into public.qa_reports(clan_id,report_id,data) values(v_profile.clan_id,v_key,v_result);
    elsif p_kind = 'qa.update' then
      v_key := p_payload->>'idOrSlot';
      update public.qa_reports set data=data || coalesce(p_payload->'patch','{}'::jsonb) ||
        jsonb_build_object('updatedAt',to_jsonb(clock_timestamp())), updated_at=now()
      where clan_id=v_profile.clan_id and (report_id=v_key or data->>'slot'=v_key) returning data into v_result;
      if v_result is null then raise exception 'QA report not found'; end if;
      if v_result->>'status' in ('resolved','closed') and nullif(v_result->>'resolvedAt','') is null then
        v_result := v_result || jsonb_build_object('resolvedAt',to_jsonb(clock_timestamp()));
        update public.qa_reports set data=v_result
          where clan_id=v_profile.clan_id and (report_id=v_key or data->>'slot'=v_key);
      end if;
    else
      v_key := p_payload->>'idOrSlot';
      delete from public.qa_reports where clan_id=v_profile.clan_id and (report_id=v_key or data->>'slot'=v_key);
      get diagnostics v_before = row_count;
      if v_before = 0 then raise exception 'QA report not found'; end if;
      v_result := jsonb_build_object('removed',true);
    end if;
  else
    raise exception 'unknown mutation: %', p_kind;
  end if;

  update public.clans set revision=revision+1, updated_at=now() where id=v_profile.clan_id;
  delete from public.applied_mutations where clan_id=v_profile.clan_id
    and created_at < now() - interval '7 days';
  return jsonb_build_object('ok',true,'result',v_result,'state',public.dashboard_state_for(v_profile.clan_id));
end;
$$;
revoke all on function public.dashboard_mutate(text,jsonb,text) from public;
grant execute on function public.dashboard_mutate(text,jsonb,text) to authenticated;

create or replace function public.dashboard_save(p_state jsonb, p_base_admin_revision bigint)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_clan public.clans%rowtype;
  v_key text;
  v_member jsonb;
  v_existing jsonb;
  v_date record;
  v_content record;
  v_board jsonb;
  v_board_id text;
  v_new boolean;
  v_mid text;
  v_cols jsonb;
  v_col text;
  v_doc_keys text[] := array['meta','settings','tiers','powerRanks','staff','contentCatalog','rotationQueues',
    'weaponProgress','dropLog','distributionLog','settlements','schedule','appSettings','distributionRules','ocrCrop','ocrAnchor'];
begin
  select * into v_profile from public.profiles where user_id=auth.uid();
  if not found or v_profile.role <> 'admin' then raise exception 'admin only'; end if;
  select * into v_clan from public.clans where id=v_profile.clan_id for update;
  if p_base_admin_revision is not null and p_base_admin_revision <> v_clan.admin_revision then
    raise exception 'conflict: 다른 관리자가 먼저 저장했습니다. 새로고침 후 다시 적용하세요.';
  end if;

  foreach v_key in array v_doc_keys loop
    if p_state ? v_key then
      insert into public.clan_documents(clan_id,key,data) values(v_profile.clan_id,v_key,p_state->v_key)
      on conflict(clan_id,key) do update set data=excluded.data, updated_at=now();
    end if;
  end loop;
  insert into public.clan_documents(clan_id,key,data)
  values(v_profile.clan_id,'participation',coalesce(p_state->'participation','{}'::jsonb)-'byDate')
  on conflict(clan_id,key) do update set data=excluded.data, updated_at=now();

  for v_member in select value from jsonb_array_elements(coalesce(p_state->'members','[]'::jsonb)) loop
    select data into v_existing from public.members where clan_id=v_profile.clan_id and member_id=(v_member->>'id')::bigint;
    if v_existing is not null then
      v_member := v_member || jsonb_build_object('equip',coalesce(v_existing->'equip','{}'::jsonb),
        'skills',coalesce(v_existing->'skills','{}'::jsonb));
    end if;
    insert into public.members(clan_id,member_id,data) values(v_profile.clan_id,(v_member->>'id')::bigint,v_member)
    on conflict(clan_id,member_id) do update set data=excluded.data,updated_at=now();
  end loop;
  delete from public.profiles p where p.clan_id=v_profile.clan_id and p.user_id<>auth.uid()
    and not exists(select 1 from jsonb_array_elements(coalesce(p_state->'members','[]'::jsonb)) m where (m->>'id')::bigint=p.member_id);
  delete from public.members m where m.clan_id=v_profile.clan_id
    and not exists(select 1 from jsonb_array_elements(coalesce(p_state->'members','[]'::jsonb)) x where (x->>'id')::bigint=m.member_id);

  delete from public.participation_events where clan_id=v_profile.clan_id;
  for v_date in select key,value from jsonb_each(coalesce(p_state#>'{participation,byDate}','{}'::jsonb)) loop
    for v_content in select key,value from jsonb_each(v_date.value) loop
      insert into public.participation_events(clan_id,event_date,content,member_ids)
      select v_profile.clan_id,v_date.key,v_content.key,coalesce(array_agg(value::bigint),'{}')
      from jsonb_array_elements_text(v_content.value);
    end loop;
  end loop;

  for v_board in select value from jsonb_array_elements(coalesce(p_state->'statusBoards','[]'::jsonb)) loop
    v_board_id := v_board->>'id';
    v_new := not exists(select 1 from public.status_boards where clan_id=v_profile.clan_id and board_id=v_board_id);
    insert into public.status_boards(clan_id,board_id,data) values(v_profile.clan_id,v_board_id,v_board-'data')
    on conflict(clan_id,board_id) do update set data=excluded.data,updated_at=now();
    if v_new then
      for v_mid,v_cols in select key,value from jsonb_each(coalesce(v_board->'data','{}'::jsonb)) loop
        for v_col in select key from jsonb_each(v_cols) where value='true'::jsonb loop
          insert into public.status_board_cells(clan_id,board_id,member_id,column_name)
          values(v_profile.clan_id,v_board_id,v_mid::bigint,v_col) on conflict do nothing;
        end loop;
      end loop;
    end if;
  end loop;
  delete from public.status_boards b where b.clan_id=v_profile.clan_id and not exists(
    select 1 from jsonb_array_elements(coalesce(p_state->'statusBoards','[]'::jsonb)) x where x->>'id'=b.board_id);
  delete from public.status_board_cells c using public.status_boards b
    where c.clan_id=b.clan_id and c.board_id=b.board_id and c.clan_id=v_profile.clan_id
      and not (coalesce(b.data->'columns','[]'::jsonb) ? c.column_name);

  update public.clans set name=coalesce(p_state#>>'{meta,clanName}',name), revision=revision+1,
    admin_revision=admin_revision+1, updated_at=now() where id=v_profile.clan_id;
  return jsonb_build_object('ok',true,'state',public.dashboard_state_for(v_profile.clan_id),
    'revision',v_clan.revision+1,'adminRevision',v_clan.admin_revision+1);
end;
$$;
revoke all on function public.dashboard_save(jsonb,bigint) from public;
grant execute on function public.dashboard_save(jsonb,bigint) to authenticated;

create or replace function public.dashboard_bootstrap(p_slug text, p_state jsonb, p_member_password text, p_admin_password text)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
declare
  v_clan_id uuid;
  v_key text;
  v_member jsonb;
  v_date record;
  v_content record;
  v_board jsonb;
  v_mid text;
  v_cols jsonb;
  v_col text;
  v_sale jsonb;
  v_bid jsonb;
  v_report jsonb;
  v_doc_keys text[] := array['meta','settings','tiers','powerRanks','staff','contentCatalog','rotationQueues',
    'weaponProgress','dropLog','distributionLog','settlements','schedule','appSettings','distributionRules','ocrCrop','ocrAnchor'];
begin
  -- EXECUTE is granted only to service_role below. Do not inspect JWT claims here:
  -- modern sb_secret API keys are opaque and authorize through the API gateway.
  if length(coalesce(p_member_password,'')) < 4 or length(coalesce(p_admin_password,'')) < 8 then
    raise exception 'member/admin passwords are too short';
  end if;
  insert into public.clans(slug,name,member_password_hash,admin_password_hash,revision,admin_revision)
  values(p_slug,coalesce(p_state#>>'{meta,clanName}',p_slug),extensions.crypt(p_member_password,extensions.gen_salt('bf')),
    extensions.crypt(p_admin_password,extensions.gen_salt('bf')),1,1)
  on conflict(slug) do update set name=excluded.name,member_password_hash=excluded.member_password_hash,
    admin_password_hash=excluded.admin_password_hash,revision=public.clans.revision+1,admin_revision=public.clans.admin_revision+1,
    updated_at=now() returning id into v_clan_id;

  delete from public.clan_documents where clan_id=v_clan_id;
  delete from public.members where clan_id=v_clan_id;
  delete from public.participation_events where clan_id=v_clan_id;
  delete from public.status_boards where clan_id=v_clan_id;
  delete from public.sales where clan_id=v_clan_id;
  delete from public.qa_reports where clan_id=v_clan_id;
  delete from public.applied_mutations where clan_id=v_clan_id;

  foreach v_key in array v_doc_keys loop
    if p_state ? v_key then insert into public.clan_documents(clan_id,key,data) values(v_clan_id,v_key,p_state->v_key); end if;
  end loop;
  insert into public.clan_documents(clan_id,key,data)
    values(v_clan_id,'participation',coalesce(p_state->'participation','{}'::jsonb)-'byDate');

  for v_member in select value from jsonb_array_elements(coalesce(p_state->'members','[]'::jsonb)) loop
    insert into public.members(clan_id,member_id,data) values(v_clan_id,(v_member->>'id')::bigint,v_member);
  end loop;
  for v_date in select key,value from jsonb_each(coalesce(p_state#>'{participation,byDate}','{}'::jsonb)) loop
    for v_content in select key,value from jsonb_each(v_date.value) loop
      insert into public.participation_events(clan_id,event_date,content,member_ids)
      select v_clan_id,v_date.key,v_content.key,coalesce(array_agg(value::bigint),'{}') from jsonb_array_elements_text(v_content.value);
    end loop;
  end loop;
  for v_board in select value from jsonb_array_elements(coalesce(p_state->'statusBoards','[]'::jsonb)) loop
    insert into public.status_boards(clan_id,board_id,data) values(v_clan_id,v_board->>'id',v_board-'data');
    for v_mid,v_cols in select key,value from jsonb_each(coalesce(v_board->'data','{}'::jsonb)) loop
      for v_col in select key from jsonb_each(v_cols) where value='true'::jsonb loop
        insert into public.status_board_cells(clan_id,board_id,member_id,column_name)
        values(v_clan_id,v_board->>'id',v_mid::bigint,v_col);
      end loop;
    end loop;
  end loop;
  for v_sale in select value from jsonb_array_elements(coalesce(p_state->'sales','[]'::jsonb)) loop
    insert into public.sales(clan_id,sale_id,data) values(v_clan_id,v_sale->>'id',v_sale-'bids');
    for v_bid in select value from jsonb_array_elements(coalesce(v_sale->'bids','[]'::jsonb)) loop
      insert into public.sale_bids(clan_id,sale_id,member_id,member_name,amount)
      values(v_clan_id,v_sale->>'id',(select member_id from public.members where clan_id=v_clan_id and data->>'name'=v_bid->>'name'),
        v_bid->>'name',coalesce((v_bid->>'amount')::numeric,0));
    end loop;
  end loop;
  for v_report in select value from jsonb_array_elements(coalesce(p_state->'qaReports','[]'::jsonb)) loop
    insert into public.qa_reports(clan_id,report_id,data)
    values(v_clan_id,coalesce(nullif(v_report->>'id',''),v_report->>'slot'),v_report);
  end loop;
  return jsonb_build_object('ok',true,'clanId',v_clan_id,'state',public.dashboard_state_for(v_clan_id));
end;
$$;
revoke all on function public.dashboard_bootstrap(text,jsonb,text,text) from public, anon, authenticated;
grant execute on function public.dashboard_bootstrap(text,jsonb,text,text) to service_role;
grant execute on function public.dashboard_state_for(uuid) to service_role;

-- Privileged QA automation uses the same normalized rows and revision signal as the UI.
-- This is intentionally service-role only; the browser uses dashboard_mutate instead.
create or replace function public.dashboard_service_qa(p_slug text, p_action text, p_id_or_slot text, p_data jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_clan_id uuid;
  v_key text;
  v_slot text;
  v_result jsonb;
  v_count integer;
begin
  -- EXECUTE is granted only to service_role; this also supports opaque sb_secret keys.
  select id into v_clan_id from public.clans where slug=p_slug for update;
  if v_clan_id is null then raise exception 'clan not found'; end if;

  if p_action = 'add' then
    v_key := coalesce(nullif(p_data->>'id',''),'qa-' || gen_random_uuid()::text);
    v_slot := coalesce(nullif(p_data->>'slot',''),
      'QA-' || to_char(clock_timestamp() at time zone 'UTC','YYYYMMDD-HH24MISSMS') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,6)));
    v_result := coalesce(p_data,'{}'::jsonb) || jsonb_build_object(
      'id',v_key,'slot',v_slot,'status',coalesce(nullif(p_data->>'status',''),'open'),
      'severity',coalesce(nullif(p_data->>'severity',''),'normal'),
      'createdAt',coalesce(p_data->'createdAt',to_jsonb(clock_timestamp())),
      'updatedAt',to_jsonb(clock_timestamp()));
    insert into public.qa_reports(clan_id,report_id,data) values(v_clan_id,v_key,v_result);
  elsif p_action = 'update' then
    update public.qa_reports set data=data || coalesce(p_data,'{}'::jsonb) ||
      jsonb_build_object('updatedAt',to_jsonb(clock_timestamp())), updated_at=now()
    where clan_id=v_clan_id and (report_id=p_id_or_slot or data->>'slot'=p_id_or_slot)
    returning data into v_result;
    if v_result is null then raise exception 'QA report not found'; end if;
    if v_result->>'status' in ('resolved','closed') and nullif(v_result->>'resolvedAt','') is null then
      v_result := v_result || jsonb_build_object('resolvedAt',to_jsonb(clock_timestamp()));
      update public.qa_reports set data=v_result
        where clan_id=v_clan_id and (report_id=p_id_or_slot or data->>'slot'=p_id_or_slot);
    end if;
  elsif p_action = 'delete' then
    delete from public.qa_reports where clan_id=v_clan_id and (report_id=p_id_or_slot or data->>'slot'=p_id_or_slot);
    get diagnostics v_count = row_count;
    if v_count = 0 then raise exception 'QA report not found'; end if;
    v_result := jsonb_build_object('removed',true);
  else
    raise exception 'unknown QA action: %', p_action;
  end if;

  update public.clans set revision=revision+1, updated_at=now() where id=v_clan_id;
  return v_result;
end;
$$;
revoke all on function public.dashboard_service_qa(text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.dashboard_service_qa(text,text,text,jsonb) to service_role;

-- Every successful transaction updates this one row. Clients subscribe to it,
-- then fetch a consistent state snapshot through dashboard_state().
do $$ begin
  alter publication supabase_realtime add table public.clans;
exception when duplicate_object then null;
end $$;

grant select on public.clans, public.profiles, public.clan_documents, public.members,
  public.participation_events, public.status_boards, public.status_board_cells,
  public.sales, public.sale_bids, public.qa_reports, public.applied_mutations to authenticated;
