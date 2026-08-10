-- An invitation counts as used when someone walks through the door, not when
-- they ask for the key. Requesting a magic link creates the auth.users row
-- immediately, long before anybody clicks the mail - so stamping used_at there
-- would show "joined" for people who never did.

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

  -- The profile is created up front: the moment the confirmation link is
  -- clicked the session is live, and every access rule reads this row.
  insert into public.profiles (id, email, person_id, is_admin)
  values (new.id, new.email::citext, invite.person_id, invite.is_admin)
  on conflict (id) do nothing;

  return new;
end;
$$;

create or replace function public.mark_invite_used()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.email_confirmed_at is not null and old.email_confirmed_at is null then
    update public.invites set used_at = now()
    where email = new.email::citext and used_at is null;
  end if;
  return new;
end;
$$;

revoke execute on function public.mark_invite_used() from public, anon, authenticated;
grant execute on function public.mark_invite_used() to supabase_auth_admin;

create trigger on_auth_user_confirmed
  after update of email_confirmed_at on auth.users
  for each row execute function public.mark_invite_used();

-- Undo the premature stamp from the test link.
update public.invites i set used_at = null
where used_at is not null
  and not exists (
    select 1 from auth.users u
    where u.email::citext = i.email and u.email_confirmed_at is not null
  );
