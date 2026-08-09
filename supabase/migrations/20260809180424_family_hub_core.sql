-- The family hub, moved off GitHub.
--
-- Two ideas carry over from the version that stored everything as files, and
-- both are worth keeping now that there is a database:
--
--   * A photo is identified by the hash of its contents, so uploading the same
--     picture twice is a no-op rather than a second copy.
--   * Who took a photo is recorded as a name, not only as an account. Photos
--     migrated from the old album have no account behind them, and a person
--     who never registers should still be able to appear in the album.

create extension if not exists citext;

-- Everyone on the family photo. Independent of accounts on purpose: eleven
-- people are on that picture and not all of them will ever sign in.
create table public.people (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  face_x      real not null check (face_x between 0 and 1),
  face_y      real not null check (face_y between 0 and 1),
  -- Earlier spellings. A name is written into old records, so correcting one
  -- must reach backwards or the person is split in two.
  aliases     text[] not null default '{}',
  sort_order  int not null default 0
);

-- Who may create an account. Without this, anyone who finds the address can
-- register and read every family photo.
create table public.invites (
  email       citext primary key,
  person_id   uuid references public.people(id) on delete set null,
  is_admin    boolean not null default false,
  invited_at  timestamptz not null default now(),
  used_at     timestamptz
);

-- A registered account, hung off Supabase's auth.users.
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       citext not null,
  person_id   uuid references public.people(id) on delete set null,
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now()
);

create table public.albums (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  title       text not null,
  event_date  date,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table public.photos (
  id            uuid primary key default gen_random_uuid(),
  album_id      uuid not null references public.albums(id) on delete cascade,
  storage_path  text not null,
  thumb_path    text not null,
  content_hash  text not null,
  taken_at      timestamptz not null,
  uploader_id   uuid references public.profiles(id) on delete set null,
  uploader_name text not null,
  width         int,
  height        int,
  bytes         int,
  created_at    timestamptz not null default now(),
  -- The same picture twice in one album is the same picture.
  unique (album_id, content_hash)
);

create table public.comments (
  id           uuid primary key default gen_random_uuid(),
  photo_id     uuid not null references public.photos(id) on delete cascade,
  body         text not null check (length(body) between 1 and 2000),
  author_id    uuid references public.profiles(id) on delete set null,
  author_name  text not null,
  created_at   timestamptz not null default now()
);

create table public.board_posts (
  id           uuid primary key default gen_random_uuid(),
  body         text not null default '' check (length(body) <= 4000),
  image_path   text,
  author_id    uuid references public.profiles(id) on delete set null,
  author_name  text not null,
  created_at   timestamptz not null default now(),
  -- A post with neither words nor picture is not a post.
  check (length(body) > 0 or image_path is not null)
);

create index photos_album_taken on public.photos (album_id, taken_at desc);
create index comments_photo on public.comments (photo_id, created_at);
create index board_posts_created on public.board_posts (created_at desc);
create index profiles_person on public.profiles (person_id);
