-- Everything written before there were accounts carries only a name.
--
-- The old app stored who uploaded a photo in its file path, so the import
-- brings across `uploader_name` and nothing else. Without this, a relative
-- signs in, sees forty of their own photos, and cannot delete one of them:
-- the rules ask for `uploader_id = auth.uid()`, and that column is null.
--
-- So: the moment an account is tied to a face, it adopts everything that name
-- ever wrote. Both orders work — link first and the rows are claimed here,
-- import later and the rows arrive already owned only if their author has an
-- account, which is why the import must call claim_all() when it is done.

-- The name as it survives a file path: "Eva-Maria" and "Eva Maria" are the
-- same person, because the hyphen is indistinguishable from the space it
-- replaced. Mirrors PS.album.slug in the app, deliberately including its
-- 24-character truncation.
create or replace function hub_slug(value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select left(
    regexp_replace(regexp_replace(coalesce(value, ''), '[^[:alnum:]]+', '-', 'g'), '^-+|-+$', '', 'g'),
    24)
$$;

/*
 * Hand every unowned row written under this person's name (or any earlier
 * spelling of it) to their account.
 *
 * Only ever fills in a null. A row that already has an author keeps it, so
 * this can run as often as it likes and can never move somebody else's photo.
 */
create or replace function claim_history(p_profile uuid, p_person uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  spellings text[];
begin
  if p_profile is null or p_person is null then return; end if;

  select array_agg(public.hub_slug(s))
    into spellings
    from public.people p, unnest(array[p.name] || coalesce(p.aliases, '{}')) as s
   where p.id = p_person;

  if spellings is null then return; end if;

  update public.photos set uploader_id = p_profile
   where uploader_id is null and public.hub_slug(uploader_name) = any (spellings);

  update public.comments set author_id = p_profile
   where author_id is null and public.hub_slug(author_name) = any (spellings);

  update public.board_posts set author_id = p_profile
   where author_id is null and public.hub_slug(author_name) = any (spellings);
end;
$$;

create or replace function claim_history_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.claim_history(new.id, new.person_id);
  return new;
end;
$$;

drop trigger if exists claim_history_on_profile on public.profiles;
create trigger claim_history_on_profile
  after insert or update of person_id on public.profiles
  for each row when (new.person_id is not null)
  execute function claim_history_trigger();

/*
 * The other order: the import runs after people have already signed in, so
 * rows arrive unowned even though their author has an account. Called once at
 * the end of tools/migrate-to-supabase.mjs.
 */
create or replace function claim_all()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in select id, person_id from public.profiles where person_id is not null loop
    perform public.claim_history(r.id, r.person_id);
  end loop;
end;
$$;

-- Nothing here is for the browser to call: an account claims its own history
-- through the trigger, and the import runs with the service role.
revoke execute on function claim_history(uuid, uuid) from anon, authenticated;
revoke execute on function claim_all() from anon, authenticated;

select claim_all();
