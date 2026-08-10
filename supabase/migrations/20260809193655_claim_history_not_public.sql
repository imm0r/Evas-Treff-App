-- CREATE FUNCTION grants EXECUTE to PUBLIC, and anon/authenticated inherit it,
-- so revoking from those two roles by name changed nothing. Revoke from PUBLIC
-- and hand it back only to the import, which runs with the service role.
--
-- Nobody signed in needs to call these: an account claims its own history
-- through the trigger on `profiles`, which runs as the owner regardless.
revoke execute on function claim_history(uuid, uuid) from public;
revoke execute on function claim_all() from public;
revoke execute on function claim_history_trigger() from public;

grant execute on function claim_all() to service_role;
