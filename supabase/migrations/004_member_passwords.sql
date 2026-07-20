-- Per-member six-digit passwords. Credentials are never included in the
-- dashboard state snapshot and are exposed only through admin-checked RPCs.

create table if not exists public.member_passwords (
  clan_id uuid not null,
  member_id bigint not null,
  password_hash text not null,
  password_plain text not null check (password_plain ~ '^[0-9]{6}$'),
  updated_at timestamptz not null default now(),
  primary key (clan_id, member_id),
  unique (clan_id, password_plain),
  foreign key (clan_id, member_id) references public.members(clan_id, member_id) on delete cascade
);
alter table public.member_passwords enable row level security;
revoke all on table public.member_passwords from public, anon, authenticated;

create or replace function public.dashboard_issue_member_password(p_clan_id uuid, p_member_id bigint)
returns text
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
declare
  v_password text;
  v_existing text;
  v_attempt integer;
begin
  if not exists (
    select 1 from public.members m
    where m.clan_id=p_clan_id and m.member_id=p_member_id
  ) then
    raise exception 'member not found';
  end if;

  select mp.password_plain into v_existing
  from public.member_passwords mp
  where mp.clan_id=p_clan_id and mp.member_id=p_member_id;

  for v_attempt in 1..100 loop
    v_password := (100000 + floor(random() * 900000)::integer)::text;
    if v_password = v_existing then continue; end if;
    begin
      insert into public.member_passwords(clan_id,member_id,password_hash,password_plain)
      values(p_clan_id,p_member_id,extensions.crypt(v_password,extensions.gen_salt('bf')),v_password)
      on conflict(clan_id,member_id) do update set
        password_hash=excluded.password_hash,
        password_plain=excluded.password_plain,
        updated_at=now();
      return v_password;
    exception when unique_violation then
      null;
    end;
  end loop;
  raise exception 'could not allocate unique member password';
end;
$$;
revoke all on function public.dashboard_issue_member_password(uuid,bigint) from public, anon, authenticated;

create or replace function public.dashboard_member_password_on_insert()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform public.dashboard_issue_member_password(new.clan_id,new.member_id);
  return new;
end;
$$;
revoke all on function public.dashboard_member_password_on_insert() from public, anon, authenticated;

drop trigger if exists members_issue_password on public.members;
create trigger members_issue_password
after insert on public.members
for each row execute function public.dashboard_member_password_on_insert();

do $$
declare v_member record;
begin
  for v_member in
    select m.clan_id,m.member_id from public.members m
    where not exists (
      select 1 from public.member_passwords mp
      where mp.clan_id=m.clan_id and mp.member_id=m.member_id
    )
  loop
    perform public.dashboard_issue_member_password(v_member.clan_id,v_member.member_id);
  end loop;
end $$;

create or replace function public.dashboard_member_passwords()
returns table(member_id bigint, name text, password text, active boolean)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_profile public.profiles%rowtype;
begin
  select * into v_profile from public.profiles where user_id=auth.uid();
  if not found or v_profile.role <> 'admin' then raise exception 'admin only'; end if;

  return query
  select m.member_id,m.data->>'name',mp.password_plain,
    coalesce((m.data->>'active')::boolean,true)
  from public.members m
  join public.member_passwords mp using(clan_id,member_id)
  where m.clan_id=v_profile.clan_id
  order by coalesce((m.data->>'active')::boolean,true) desc,m.data->>'name';
end;
$$;
revoke all on function public.dashboard_member_passwords() from public, anon;
grant execute on function public.dashboard_member_passwords() to authenticated;

create or replace function public.dashboard_reset_member_password(p_member_id bigint)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_name text;
  v_password text;
begin
  select * into v_profile from public.profiles where user_id=auth.uid();
  if not found or v_profile.role <> 'admin' then raise exception 'admin only'; end if;

  select m.data->>'name' into v_name from public.members m
  where m.clan_id=v_profile.clan_id and m.member_id=p_member_id;
  if v_name is null then raise exception 'member not found'; end if;

  v_password := public.dashboard_issue_member_password(v_profile.clan_id,p_member_id);
  delete from public.profiles p
  where p.clan_id=v_profile.clan_id and p.member_id=p_member_id and p.role='member';
  return jsonb_build_object('memberId',p_member_id,'name',v_name,'password',v_password);
end;
$$;
revoke all on function public.dashboard_reset_member_password(bigint) from public, anon;
grant execute on function public.dashboard_reset_member_password(bigint) to authenticated;

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
  select * into v_clan from public.clans where slug=p_slug;
  if not found then raise exception 'clan not found'; end if;

  select member_id into v_member_id from public.members
  where clan_id=v_clan.id and data->>'name'=trim(p_member_name)
    and coalesce((data->>'active')::boolean,true);
  if v_member_id is null then raise exception 'member not found'; end if;

  if v_clan.admin_password_hash=extensions.crypt(p_password,v_clan.admin_password_hash) then
    v_role := 'admin';
  elsif exists (
    select 1 from public.member_passwords mp
    where mp.clan_id=v_clan.id and mp.member_id=v_member_id
      and mp.password_hash=extensions.crypt(p_password,mp.password_hash)
  ) then
    v_role := 'member';
  else
    raise exception 'invalid password';
  end if;

  insert into public.profiles(user_id,clan_id,member_id,role)
  values(auth.uid(),v_clan.id,v_member_id,v_role)
  on conflict(user_id) do update set clan_id=excluded.clan_id,member_id=excluded.member_id,
    role=excluded.role,updated_at=now();
  return jsonb_build_object('clanId',v_clan.id,'memberId',v_member_id,
    'name',trim(p_member_name),'role',v_role);
end;
$$;
revoke all on function public.dashboard_claim(text,text,text) from public;
grant execute on function public.dashboard_claim(text,text,text) to authenticated;

-- Existing shared-password member profiles must pass the new per-member gate.
delete from public.profiles where role='member';

