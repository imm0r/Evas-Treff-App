-- Rezepte.
--
-- Das, was sonst auf einer Karteikarte in Omas Handschrift steht und beim
-- Weiterreichen verloren geht.

create table public.recipes (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  title        text not null check (length(title) between 1 and 120),
  -- Für wie viele. NULL heißt: steht nicht dabei, so wie auf den meisten
  -- Karteikarten auch nicht.
  servings     smallint check (servings between 1 and 99),
  -- Zutaten und Zubereitung als Text mit Zeilenumbrüchen, nicht als eigene
  -- Tabellen.
  --
  -- Eine Zeile ist eine Zutat, und die App zeigt sie als Liste — das war der
  -- Wunsch. Was sie NICHT tut, ist "500 g Mehl" in Menge und Zutat zerlegen:
  -- Familienrezepte sagen "eine Prise", "2-3 Äpfel", "Mehl bis es geht", und
  -- jede Zerlegung davon rät. Geraten wird hier nicht — die Zeile steht so da,
  -- wie sie jemand aufgeschrieben hat.
  ingredients  text not null default '' check (length(ingredients) <= 4000),
  steps        text not null default '' check (length(steps)       <= 8000),
  note         text check (note is null or length(note) <= 2000),
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);

-- Bilder. Eins ist das Hauptbild, weitere dürfen dazu.
--
-- Kein `is_cover`-Schalter und keine zweite Spalte am Rezept: zwei Orte, an
-- denen dasselbe steht, geraten irgendwann auseinander. Das Hauptbild ist
-- schlicht das mit der kleinsten `sort_order` — "zum Hauptbild machen" setzt
-- sie unter die aller anderen, und es gibt weiterhin nur eine Wahrheit.
create table public.recipe_photos (
  id           uuid primary key default gen_random_uuid(),
  recipe_id    uuid not null references public.recipes(id) on delete cascade,
  storage_path text not null,
  thumb_path   text not null,
  sort_order   integer not null default 0,
  uploaded_by  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index recipe_photos_of on public.recipe_photos (recipe_id, sort_order);

alter table public.recipes       enable row level security;
alter table public.recipe_photos enable row level security;

-- Angemeldet, also Familie: alle lesen alles.
create policy read_recipes on public.recipes       for select to authenticated using (true);
create policy read_rphotos on public.recipe_photos for select to authenticated using (true);

-- Anlegen darf jeder, aber nur auf den eigenen Namen.
create policy add_recipes on public.recipes for insert to authenticated
  with check (created_by = auth.uid());
create policy add_rphotos on public.recipe_photos for insert to authenticated
  with check (uploaded_by = auth.uid());

-- Ändern und löschen: wer es aufgeschrieben hat, oder ein Admin. Dieselbe
-- Regel wie bei Terminen und Fotos.
create policy edit_own_recipes on public.recipes for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());
create policy drop_own_recipes on public.recipes for delete to authenticated
  using (created_by = auth.uid() or public.is_admin());

-- Bilder darf auch umsortieren, wem das REZEPT gehört — sonst könnte niemand
-- das Hauptbild wechseln, sobald zwei Leute etwas beigesteuert haben.
create policy edit_rphotos on public.recipe_photos for update to authenticated
  using (uploaded_by = auth.uid() or public.is_admin()
    or exists (select 1 from public.recipes r
               where r.id = recipe_id and r.created_by = auth.uid()))
  with check (uploaded_by = auth.uid() or public.is_admin()
    or exists (select 1 from public.recipes r
               where r.id = recipe_id and r.created_by = auth.uid()));
create policy drop_rphotos on public.recipe_photos for delete to authenticated
  using (uploaded_by = auth.uid() or public.is_admin()
    or exists (select 1 from public.recipes r
               where r.id = recipe_id and r.created_by = auth.uid()));
