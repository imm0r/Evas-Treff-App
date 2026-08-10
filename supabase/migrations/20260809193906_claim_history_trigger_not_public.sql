-- The project's default privileges grant EXECUTE on every new function to
-- anon and authenticated, so a plain "revoke from public" leaves those two
-- explicit grants standing. Name them.
--
-- A trigger function is checked at CREATE TRIGGER time, not when it fires, so
-- the trigger keeps working with no grants at all.
revoke execute on function claim_history_trigger() from public, anon, authenticated;

-- Pure string transform, but nothing in the browser calls it: keep it off the
-- exposed API too.
revoke execute on function hub_slug(text) from public, anon, authenticated;
