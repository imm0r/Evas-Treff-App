-- Two private buckets. Private is the whole point: a public bucket would put
-- the photos back on the open web, which is what the shared-link version was
-- criticised for.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('photos', 'photos', false, 15728640, array['image/jpeg']),
  ('people', 'people', false,  5242880, array['image/jpeg', 'application/json'])
on conflict (id) do nothing;

-- Signed in, therefore family: everyone may look.
create policy read_photo_files on storage.objects for select to authenticated
  using (bucket_id in ('photos', 'people'));

create policy add_photo_files on storage.objects for insert to authenticated
  with check (bucket_id = 'photos');

-- Delete what you uploaded. `owner` is set by Storage to whoever put the file
-- there; the rows migrated from GitHub have none, so an admin can clear those.
create policy drop_own_photo_files on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (owner = auth.uid() or public.is_admin()));

create policy admin_writes_people_files on storage.objects for all to authenticated
  using (bucket_id = 'people' and public.is_admin())
  with check (bucket_id = 'people' and public.is_admin());
