-- Wann ein Termin vorbei ist — als eine Spalte, nicht als Fallunterscheidung.
--
-- Der Kalender fragt „was ist noch nicht vorbei". Mit zwei Spalten heißt das
-- `starts_on >= heute or ends_on >= heute`, und daran ist etwas faul: bei
-- einem eintägigen Termin ist `ends_on` NULL, also ist der zweite Teil NULL
-- und der ganze Ausdruck ergibt NULL statt `false`. In einem WHERE fliegt die
-- Zeile trotzdem raus — das Ergebnis stimmt also, aber nur, weil dreiwertige
-- Logik zufällig in dieselbe Richtung zeigt. Ein späteres NOT davor, und es
-- kippt lautlos.
--
-- Nachgemessen, nicht vermutet: die Wahrheitstabelle für alle sieben Fälle
-- (eintägig vorbei/heute/künftig, mehrtägig laufend/endet heute/vorbei/künftig)
-- lief gegen genau diese Datenbank, und „eintägig, vorbei" kam als NULL zurück.
--
-- Also einmal ausrechnen und hinschreiben. `over_on >= heute` ist immer wahr
-- oder falsch, liest sich wie die Frage, die gestellt wird, und lässt sich
-- indizieren.
alter table public.events
  add column over_on date generated always as (coalesce(ends_on, starts_on)) stored;

-- Der Index auf `ends_on` allein hat damit keinen Nutzer mehr.
drop index if exists public.events_ends_on;
create index events_over_on on public.events (over_on);
