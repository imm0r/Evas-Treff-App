-- Fotos umhängen, und sehen, wo etwas Neues geschrieben wurde.
--
-- Zwei Wünsche aus der Familie, die nichts miteinander zu tun haben, aber
-- beide an denselben zwei Tabellen hängen.

-- 1. Ein Foto in ein anderes Album schieben.
--
-- Bisher gab es auf `photos` gar kein UPDATE — anlegen und löschen, sonst
-- nichts. Ein Album ist aber eine Aufräum-Entscheidung, die man später trifft:
-- erst lädt jemand vom Handy hoch, dann fällt auf, dass die Hälfte zu Ostern
-- gehört und nicht zum Geburtstag.
--
-- Die Zeile darf nur der bewegen, der sie hochgeladen hat — oder ein Admin,
-- damit nichts für immer im falschen Album steht, wenn jemand nicht mehr
-- dazukommt. Dieselbe Regel wie beim Löschen.
--
-- Und nur die Spalte `album_id`: Row Level Security kennt keine Spalten, also
-- macht das der GRANT. Ohne ihn dürfte derselbe Mensch auch `content_hash`
-- oder `uploader_id` überschreiben, und dann wäre die Urheberschaft, auf der
-- alle anderen Regeln aufbauen, nur noch Dekoration.
revoke update on public.photos from anon, authenticated;
grant update (album_id) on public.photos to authenticated;

create policy move_own_photos on public.photos for update to authenticated
  using (uploader_id = auth.uid() or public.is_admin())
  with check (uploader_id = auth.uid() or public.is_admin());

-- Ein Album umbenennen darf, wer es angelegt hat, oder ein Admin. Kommt beim
-- Anlegen ein Tippfehler rein, ist das sonst für immer der Name.
create policy edit_own_albums on public.albums for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

-- 2. „Auf diesem Bild steht etwas Neues."
--
-- Gewünscht war ein Hinweis, WO neue Kommentare stehen — nicht bloß, DASS es
-- welche gibt. Also pro Foto, nicht pro Konto.
--
-- Eine Zeile entsteht erst, wenn jemand die Kommentare eines Fotos wirklich
-- aufmacht. Elf Menschen mal fünfzig Fotos wären 550 Zeilen, wenn man sie auf
-- Vorrat anlegte; so sind es die paar, die tatsächlich gelesen wurden.
create table public.comment_reads (
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  photo_id    uuid not null references public.photos(id)   on delete cascade,
  seen_at     timestamptz not null default now(),
  primary key (profile_id, photo_id)
);

alter table public.comment_reads enable row level security;

-- Wer was gelesen hat, geht nur ihn selbst etwas an. In einer Familie ist
-- „ich sehe, dass du es gesehen hast" keine Funktion, sondern ein Vorwurf.
create policy own_reads on public.comment_reads for all to authenticated
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- Der Boden, unter dem nichts mehr als neu gilt.
--
-- Ohne ihn wären beim ersten Aufruf alle dreißig alten Kommentare „neu", und
-- der Hinweis wäre schon kaputt, bevor ihn jemand zum ersten Mal sieht. Weil
-- die Spalte `not null default now()` ist, bekommen die bestehenden Konten
-- genau jetzt als Boden — also gilt ab hier nur noch, was danach geschrieben
-- wird.
alter table public.profiles
  add column comments_seen_at timestamptz not null default now();

-- Gefragt wird immer „die Kommentare zu diesen Fotos, seit wann auch immer",
-- und das ist ohne Index ein Scan über alles.
create index comments_photo_created on public.comments (photo_id, created_at);
