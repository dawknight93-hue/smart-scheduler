/*
# Lock OAuth token storage to the server

The Google refresh token is a credential and must never be reachable through
browser Data API calls. The sync edge function uses the Supabase service role
for this table, so direct anon and authenticated access is revoked.

## Security
- Revoke all table privileges from anon and authenticated.
- Keep RLS enabled and remove the prior public policies.
- The edge function remains the only application path that reads or writes
  OAuth token rows.
*/

REVOKE ALL ON TABLE gcal_oauth_tokens FROM anon, authenticated;
DROP POLICY IF EXISTS "anon_all_gcal_oauth_tokens" ON gcal_oauth_tokens;
DROP POLICY IF EXISTS "anon_insert_gcal_oauth_tokens" ON gcal_oauth_tokens;
DROP POLICY IF EXISTS "anon_update_gcal_oauth_tokens" ON gcal_oauth_tokens;
DROP POLICY IF EXISTS "anon_delete_gcal_oauth_tokens" ON gcal_oauth_tokens;
