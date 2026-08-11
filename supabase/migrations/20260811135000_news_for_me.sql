/*
 * Alles Neue in EINER Antwort.
 *
 * Diese Frage wird bei jedem Betreten der Seite gestellt, also darf sie nicht
 * fünf Rundreisen kosten. Als Funktion statt als fünf Abfragen aus dem
 * Browser: eine Rundreise, und was „neu" heißt, steht an einer Stelle statt
 * verteilt über fünf Aufrufer.
 *
 * SECURITY INVOKER (die Voreinstellung, hier ausdrücklich hingeschrieben):
 * die Funktion sieht genau das, was der Aufrufer sehen darf. Mit DEFINER wäre
 * sie ein Loch neben jeder Sichtbarkeitsregel, die dieses Projekt sonst
 * aufstellt.
 *
 * Das eigene Zutun ist nie eine Neuigkeit — wer gerade selbst zwölf Fotos
 * hochgeladen hat, will beim nächsten Aufruf nicht lesen, dass es zwölf neue
 * Fotos gibt.
 *
 * Bei den Mitteilungen zwei getrennte Angaben, weil es zwei verschiedene
 * Fragen sind:
 *
 *   `unread`  — was sich mir in den Weg stellen DARF. Nur das öffnet die Seite
 *               beim Betreten.
 *   die Liste — was noch aktuell ist und deshalb auf der Seite steht, auch
 *               wenn ich es längst gelesen habe.
 *
 * Ohne diese Trennung hätte man nur die Wahl zwischen „der Aushang zum
 * Grillfest springt mich jeden Tag neu an" und „er ist nach dem ersten Blick
 * für immer weg".
 */
create or replace function public.news_for_me()
returns json
language sql
stable
security invoker
set search_path = public
as $$
  with grenze as (
    select coalesce(news_seen_at, '-infinity'::timestamptz) as seit
    from public.profiles where id = auth.uid()
  ),
  mitteilungen as (
    select a.id, a.body, a.until, a.created_at,
           a.created_at > (select seit from grenze) as ungelesen,
           pe.name as author
    from public.announcements a
    left join public.profiles pr on pr.id = a.created_by
    left join public.people   pe on pe.id = pr.person_id
    where a.created_at > (select seit from grenze)
       or (a.until is not null and a.until >= current_date)
  ),
  neue_fotos as (
    select p.album_id, a.slug, a.title, p.thumb_path, p.media_type, p.created_at
    from public.photos p
    join public.albums a on a.id = p.album_id
    where p.created_at > (select seit from grenze)
      and p.uploader_id is distinct from auth.uid()
  ),
  fotos_je_album as (
    select slug, title,
           count(*) as anzahl,
           count(*) filter (where media_type = 'video') as videos,
           (array_agg(thumb_path order by created_at desc))[1:4] as vorschau,
           max(created_at) as zuletzt
    from neue_fotos group by slug, title
  )
  select json_build_object(
    'since', (select seit from grenze),
    'announcements', json_build_object(
      'unread', (select count(*) from mitteilungen where ungelesen),
      'items', coalesce((
        select json_agg(json_build_object(
                 'id', id, 'body', body, 'until', until,
                 'author', author, 'at', created_at, 'unread', ungelesen)
               order by created_at desc)
        from mitteilungen), '[]'::json)),
    'photos', json_build_object(
      'count', (select count(*) from neue_fotos),
      'albums', coalesce((
        select json_agg(json_build_object(
                 'slug', slug, 'title', title, 'count', anzahl,
                 'videos', videos, 'thumbs', vorschau) order by zuletzt desc)
        from fotos_je_album), '[]'::json)),
    'comments', json_build_object(
      'count', (select count(*) from public.comments c
                where c.created_at > (select seit from grenze)
                  and c.author_id is distinct from auth.uid()),
      'items', coalesce((
        select json_agg(x) from (
          select c.author_name as author, left(c.body, 140) as body,
                 c.photo_id, a.slug as album
          from public.comments c
          join public.photos p on p.id = c.photo_id
          join public.albums a on a.id = p.album_id
          where c.created_at > (select seit from grenze)
            and c.author_id is distinct from auth.uid()
          order by c.created_at desc limit 4) x), '[]'::json)),
    'posts', json_build_object(
      'count', (select count(*) from public.board_posts b
                where b.created_at > (select seit from grenze)
                  and b.author_id is distinct from auth.uid()),
      'items', coalesce((
        select json_agg(x) from (
          select author_name as author, left(body, 160) as body
          from public.board_posts
          where created_at > (select seit from grenze)
            and author_id is distinct from auth.uid()
          order by created_at desc limit 3) x), '[]'::json)),
    'recipes', json_build_object(
      'count', (select count(*) from public.recipes r
                where r.created_at > (select seit from grenze)
                  and r.created_by is distinct from auth.uid()),
      'items', coalesce((
        select json_agg(x) from (
          select r.slug, r.title, pe.name as author
          from public.recipes r
          left join public.profiles pr on pr.id = r.created_by
          left join public.people   pe on pe.id = pr.person_id
          where r.created_at > (select seit from grenze)
            and r.created_by is distinct from auth.uid()
          order by r.created_at desc limit 4) x), '[]'::json)),
    'events', json_build_object(
      'count', (select count(*) from public.events e
                where e.created_at > (select seit from grenze)
                  and e.created_by is distinct from auth.uid()),
      'items', coalesce((
        select json_agg(x) from (
          select title, starts_on, place
          from public.events
          where created_at > (select seit from grenze)
            and created_by is distinct from auth.uid()
          order by starts_on limit 4) x), '[]'::json))
  );
$$;

-- Postgres gibt EXECUTE auf neue Funktionen automatisch an PUBLIC, also auch
-- an den anonymen Schlüssel, der öffentlich im Repo steht. Die Funktion gäbe
-- ohne Anmeldung zwar nichts preis (jede Tabelle darunter ist per RLS auf
-- `authenticated` beschränkt, `auth.uid()` wäre null), aber eine Funktion, die
-- niemand ohne Sitzung braucht, soll auch niemand ohne Sitzung aufrufen können.
revoke execute on function public.news_for_me() from public, anon;
grant  execute on function public.news_for_me() to authenticated;
