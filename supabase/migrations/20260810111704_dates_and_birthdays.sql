-- Termine und Geburtstage.
--
-- Zwei Dinge, die im Kalender nebeneinander stehen und sonst nichts gemeinsam
-- haben. Ein Geburtstag gehört einer Person, kommt jedes Jahr wieder und hat
-- keinen Urheber. Ein Termin ist einmalig, hat einen, der ihn angelegt hat,
-- und eine Gästeliste. Deshalb zwei ganz verschiedene Formen.

-- 1. Geburtstage hängen an der Person, nicht an einem Konto.
--
-- Nicht als `date`: bei den Älteren weiß niemand mehr das Jahr, und ein
-- erfundenes Jahr wäre eine Lüge, die später als Alter auf dem Bildschirm
-- steht. Tag und Monat allein reichen für "am 3. Mai"; das Alter erscheint
-- nur, wenn das Jahr wirklich bekannt ist.
alter table public.people
  add column birth_day   smallint check (birth_day   between 1 and 31),
  add column birth_month smallint check (birth_month between 1 and 12),
  add column birth_year  smallint check (birth_year  between 1900 and 2100),
  -- Ein Tag ohne Monat ist kein Datum. Beide oder keins.
  add constraint people_birthday_complete
    check ((birth_day is null) = (birth_month is null)),
  -- Ein Jahr ohne Tag und Monat wäre nur eine Zahl ohne Anlass.
  add constraint people_birth_year_needs_a_day
    check (birth_year is null or birth_day is not null);

create table public.events (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(title) between 1 and 120),
  starts_on   date not null,
  -- NULL heißt ganztägig. Die meisten Familientermine haben keine Uhrzeit,
  -- und "00:00" wäre dafür die falsche Antwort.
  starts_at   time,
  place       text check (place is null or length(place) <= 200),
  note        text check (note  is null or length(note)  <= 2000),
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- Zu- und Absagen. Eine Zeile pro Person und Termin, nie mehr.
create table public.event_replies (
  event_id    uuid not null references public.events(id) on delete cascade,
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  answer      text not null check (answer in ('ja', 'nein', 'vielleicht')),
  replied_at  timestamptz not null default now(),
  primary key (event_id, profile_id)
);

create index events_starts_on on public.events (starts_on);

alter table public.events        enable row level security;
alter table public.event_replies enable row level security;

-- Angemeldet, also Familie: alle lesen alles.
create policy read_events  on public.events        for select to authenticated using (true);
create policy read_replies on public.event_replies for select to authenticated using (true);

-- Anlegen darf jeder, aber nur auf den eigenen Namen.
create policy add_events on public.events for insert to authenticated
  with check (created_by = auth.uid());

-- Ändern und löschen darf, wer ihn angelegt hat — oder ein Admin, damit ein
-- verwaister Termin nicht für immer im Kalender steht.
create policy edit_own_events on public.events for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());
create policy drop_own_events on public.events for delete to authenticated
  using (created_by = auth.uid() or public.is_admin());

-- Für sich selbst antworten, und nur für sich.
create policy add_own_reply on public.event_replies for insert to authenticated
  with check (profile_id = auth.uid());
create policy edit_own_reply on public.event_replies for update to authenticated
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());
create policy drop_own_reply on public.event_replies for delete to authenticated
  using (profile_id = auth.uid());
