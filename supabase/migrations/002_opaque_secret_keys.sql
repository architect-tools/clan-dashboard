-- Compatibility wrappers for modern opaque sb_secret API keys.
-- PostgREST already authorizes these calls as the service_role database role,
-- but migrations deployed before this file also inspected a legacy JWT claim.

create or replace function public.dashboard_bootstrap_service(
  p_slug text,
  p_state jsonb,
  p_member_password text,
  p_admin_password text
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  return public.dashboard_bootstrap(p_slug,p_state,p_member_password,p_admin_password);
end;
$$;
revoke all on function public.dashboard_bootstrap_service(text,jsonb,text,text) from public, anon, authenticated;
grant execute on function public.dashboard_bootstrap_service(text,jsonb,text,text) to service_role;

create or replace function public.dashboard_service_qa_service(
  p_slug text,
  p_action text,
  p_id_or_slot text,
  p_data jsonb
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  return public.dashboard_service_qa(p_slug,p_action,p_id_or_slot,p_data);
end;
$$;
revoke all on function public.dashboard_service_qa_service(text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.dashboard_service_qa_service(text,text,text,jsonb) to service_role;
