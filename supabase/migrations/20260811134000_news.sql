-- „Was ist passiert, seit ich das letzte Mal da war?"
--
-- Der Boden, unter dem nichts mehr als neu gilt. `default now()` wie schon bei
-- `comments_seen_at`: sonst wären beim allerersten Aufruf sämtliche 253 Fotos
-- „neu", und die Seite wäre kaputt, bevor sie jemand zum ersten Mal sieht.
alter table public.profiles
  add column news_seen_at timestamptz not null default now();

-- Der Merker gehört zu den Spalten, die man an sich selbst setzen darf. Die
-- Liste ist bewusst kurz — siehe die Migration davor, in der genau diese
-- Offenheit eine Rechteausweitung war.
grant update (person_id, news_seen_at) on public.profiles to authenticated;
