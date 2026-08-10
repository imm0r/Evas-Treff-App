-- Nobody gets in without an invitation, and nobody reads anything without an
-- account. Both halves matter: the whole point of moving off shared links was
-- that a link could not tell one relative from another.

-- 1. The door. An address nobody invited cannot become an account, no matter
--    what the sign-up form is asked to do.
create or replace function public.enforce_invite()
returns trigger
language plpgsql
security definer
set search_path = public
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

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.enforce_invite();

-- 2. Everything is closed until a policy opens it.
alter table public.people      enable row level security;
alter table public.invites     enable row level security;
alter table public.profiles    enable row level security;
alter table public.albums      enable row level security;
alter table public.photos      enable row level security;
alter table public.comments    enable row level security;
alter table public.board_posts enable row level security;

-- Signed in, therefore family: everyone reads everything.
create policy read_people      on public.people      for select to authenticated using (true);
create policy read_profiles    on public.profiles    for select to authenticated using (true);
create policy read_albums      on public.albums      for select to authenticated using (true);
create policy read_photos      on public.photos      for select to authenticated using (true);
create policy read_comments    on public.comments    for select to authenticated using (true);
create policy read_board       on public.board_posts for select to authenticated using (true);

-- Writing is yours alone. The check on insert is what makes the uploader
-- column trustworthy rather than decorative: it can only ever be you.
create policy add_albums on public.albums for insert to authenticated
  with check (created_by = auth.uid());

create policy add_photos on public.photos for insert to authenticated
  with check (uploader_id = auth.uid());
create policy drop_own_photos on public.photos for delete to authenticated
  using (uploader_id = auth.uid());

create policy add_comments on public.comments for insert to authenticated
  with check (author_id = auth.uid());
create policy drop_own_comments on public.comments for delete to authenticated
  using (author_id = auth.uid());

create policy add_board on public.board_posts for insert to authenticated
  with check (author_id = auth.uid());
create policy edit_own_board on public.board_posts for update to authenticated
  using (author_id = auth.uid()) with check (author_id = auth.uid());
create policy drop_own_board on public.board_posts for delete to authenticated
  using (author_id = auth.uid());

-- Your own profile is yours to correct; everyone else's is read-only.
create policy edit_own_profile on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- 3. Admins keep the guest list and the family photo.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

create policy admin_reads_invites  on public.invites for select to authenticated using (public.is_admin());
create policy admin_writes_invites on public.invites for all    to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy admin_writes_people  on public.people  for all    to authenticated
  using (public.is_admin()) with check (public.is_admin());
