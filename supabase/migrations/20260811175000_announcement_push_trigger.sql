-- Wenn eine Mitteilung entsteht, sollen die Telefone klingeln.
--
-- `pg_net` schickt die Anfrage in einer Warteschlange ab, nicht mitten in der
-- Transaktion. Das ist entscheidend: ein Push-Dienst, der gerade langsam ist,
-- darf das Aushängen einer Mitteilung nicht aufhalten oder scheitern lassen.
--
-- Nebenwirkung, über die man einmal stolpert: eine zurückgerollte Transaktion
-- nimmt den Auftrag mit. Ein Test in einer Rollback-Transaktion sieht deshalb
-- NIE eine Antwort — nicht weil der Auslöser kaputt ist, sondern weil es die
-- Anfrage nach dem Rollback nicht mehr gibt.
create extension if not exists pg_net with schema extensions;

/*
 * Das gemeinsame Geheimnis steht im Vault, nicht hier.
 *
 * Diese Datei liegt in einem ÖFFENTLICHEN Repository. Stünde der Wert darin,
 * könnte jeder die Funktion aufrufen und der ganzen Familie Nachrichten aufs
 * Telefon schicken. Angelegt wurde er mit
 *
 *   select vault.create_secret('<wert>', 'push_hook_secret', '...');
 *
 * und derselbe Wert muss bei den Edge Functions als PUSH_HOOK_SECRET
 * hinterlegt sein.
 */
create or replace function public.announce_push()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  geheim text;
begin
  select decrypted_secret into geheim
  from vault.decrypted_secrets where name = 'push_hook_secret';

  -- Kein Geheimnis hinterlegt: dann eben keine Benachrichtigung. Die
  -- Mitteilung selbst ist wichtiger als der Klingelton und darf daran nicht
  -- scheitern.
  if geheim is null then
    return new;
  end if;

  perform net.http_post(
    url := 'https://xpkkezwrmqgwgenpqvhq.supabase.co/functions/v1/push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-secret', geheim),
    body := jsonb_build_object('record', to_jsonb(new)),
    timeout_milliseconds := 5000
  );
  return new;
end $$;

create trigger announcements_push
  after insert on public.announcements
  for each row execute function public.announce_push();

comment on function public.announce_push is
  'Weckt die Edge Function `push`, sobald eine Mitteilung angelegt wird. '
  'Läuft über pg_net, also asynchron — ein lahmer Push-Dienst darf das '
  'Aushängen nicht blockieren.';
