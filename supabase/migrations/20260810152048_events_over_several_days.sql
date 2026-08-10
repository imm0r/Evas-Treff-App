-- Termine, die mehrere Tage dauern.
--
-- „Jahrestreffen 2027: 05.08. – 10.08." ging bisher nicht: ein Termin hatte
-- genau einen Tag. Ein Familientreffen, ein Urlaub, ein langes Wochenende sind
-- aber der Normalfall für das, was man ein Jahr vorher einträgt.
--
-- Als zweite Spalte und nicht als Dauer in Tagen: „bis zum 10." ist das, was
-- man sagt und in einen Kalender schreibt; „sechs Tage" muss man erst
-- ausrechnen und beim Ändern erneut.
--
-- NULL heißt eintägig. Damit bleibt jeder bestehende Termin genau das, was er
-- war, ohne dass irgendwo ein Ende erfunden werden muss.
alter table public.events
  add column ends_on date,
  -- Ein Ende vor dem Anfang ist kein Zeitraum, sondern ein Tippfehler.
  add constraint events_ends_after_start
    check (ends_on is null or ends_on >= starts_on);

-- Gefragt wird künftig „was ist noch nicht vorbei", und das trifft auch
-- Termine, deren ANFANG schon hinter uns liegt: das Jahrestreffen soll am
-- 7. August noch im Kalender stehen und nicht am 6. verschwinden.
create index events_ends_on on public.events (ends_on);
