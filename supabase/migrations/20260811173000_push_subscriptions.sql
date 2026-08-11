-- Wohin eine Benachrichtigung geschickt wird.
--
-- Eine Zeile je GERÄT, nicht je Person: Handy und Tablet sind zwei Empfänger,
-- und wer nur auf einem einschaltet, soll auch nur dort geweckt werden.
create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  -- Die Adresse beim Push-Dienst von Apple, Google oder Mozilla. Eindeutig,
  -- weil dasselbe Gerät sich nach jedem Neustart des Browsers erneut anmeldet
  -- — ohne das sammelten sich Karteileichen und jede Mitteilung ginge
  -- dreifach raus.
  endpoint    text not null unique,
  -- Die beiden Schlüssel des Geräts. Ohne sie lässt sich die Nachricht nicht
  -- verschlüsseln; der Push-Dienst selbst kann sie deshalb nicht mitlesen.
  p256dh      text not null,
  auth        text not null,
  -- Damit man in der Liste "iPhone" von "Laptop" unterscheiden kann, wenn man
  -- eins abmelden will.
  device      text,
  created_at  timestamptz not null default now(),
  last_sent_at timestamptz
);

create index push_subscriptions_of on public.push_subscriptions (profile_id);

alter table public.push_subscriptions enable row level security;

-- Die eigenen Geräte, und nur die. Wer wo eingeschaltet hat, geht sonst
-- niemanden etwas an — dieselbe Überlegung wie bei `comment_reads`.
create policy own_push on public.push_subscriptions for all to authenticated
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());

comment on table public.push_subscriptions is
  'Ein Gerät, das Benachrichtigungen bekommen möchte. Der Versand läuft über '
  'die Edge Function `push`, die mit dem Dienstschlüssel arbeitet und deshalb '
  'an dieser Regel vorbei alle Zeilen sieht.';
