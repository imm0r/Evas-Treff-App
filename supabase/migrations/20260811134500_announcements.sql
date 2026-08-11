-- Mitteilungen an die Familie.
--
-- Das, was sonst in fünf Einzelchats dreimal erzählt und einmal vergessen
-- wird. Anders als ein Pinnwandbeitrag WARTET eine Mitteilung nicht darauf,
-- gefunden zu werden: sie steht beim nächsten Betreten der Seite vor allem
-- anderen.
--
-- Genau deshalb dürfen sie nur Admins schreiben. Ein Beitrag, der sich elf
-- Leuten in den Weg stellt, ist etwas anderes als einer, den man beim
-- Vorbeiscrollen sieht — und für Letzteres gibt es die Pinnwand.
create table public.announcements (
  id          uuid primary key default gen_random_uuid(),
  body        text not null check (length(btrim(body)) between 1 and 2000),
  -- Bis wann es aktuell ist. NULL heißt „eine Nachricht, kein Aushang":
  -- einmal gelesen, verschwindet sie.
  --
  -- Mit Datum bleibt sie bis dahin stehen, ohne sich erneut in den Weg zu
  -- stellen — „Grillfest am Samstag" soll man nachlesen können, ohne dass es
  -- einen jeden Tag neu anspringt. Gelesen ist gelesen; aktuell ist trotzdem
  -- aktuell.
  until       date,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index announcements_recent on public.announcements (created_at desc);

alter table public.announcements enable row level security;

create policy read_announcements on public.announcements for select to authenticated using (true);
create policy admin_writes_announcements on public.announcements for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
