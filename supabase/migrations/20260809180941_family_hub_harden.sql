-- Tightening what the database linter found.

-- 1. citext does not belong in the schema the API exposes.
alter extension citext set schema extensions;

-- Its search_path has to follow, or the cast below stops resolving and every
-- sign-up fails - so this is re-tested after the move, not assumed.
create or replace function public.enforce_invite()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  invite public.invites%rowtype;
begin
  select * into invite from public.invites where email = new.email::citext;
  if not found then
    raise exception 'Diese E-Mail-Adresse ist nicht eingeladen.'
      using errcode = 'check_violation';
  end if;

  insert into public.profiles (id, email, person_id, is_admin)
  values (new.id, new.email::citext, invite.person_id, invite.is_admin);

  update public.invites set used_at = now() where email = new.email::citext;
  return new;
end;
$$;

-- 2. Neither function is meant to be called over the API.
--
-- enforce_invite is a trigger and nothing else, so nobody needs to reach it;
-- only the auth service, which fires the trigger, keeps the right.
revoke execute on function public.enforce_invite() from public, anon, authenticated;
grant execute on function public.enforce_invite() to supabase_auth_admin;

-- is_admin stays callable by signed-in users because the row-level policies
-- evaluate it as the querying user. It answers only "are you an admin", about
-- the caller and nobody else. Anonymous callers have no business asking.
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
