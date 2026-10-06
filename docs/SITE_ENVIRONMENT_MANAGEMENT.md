# Per-site environment management

WebAdmin supports site-scoped runtime environment configuration for Supabase.

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Secrets are stored outside Git under `/etc/web-manager/secrets/sites/<slug>.env` with root-only permissions.
The UI must expose registration status only and must never return the stored service-role key.
Runtime compose overrides live outside the production repository under `/etc/web-manager/site-env-compose/<slug>.yml`.
When a managed secret exists, deployment must include that override so container recreation preserves the environment.
