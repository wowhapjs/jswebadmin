# Global runtime environment

WebAdmin stores shared runtime secrets in `/etc/web-manager/secrets/global.env` (root:root 0600).

Current managed variables:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The values are never returned by the API, rendered back in the UI, logged, or committed to Git.
`site-deploy` passes this file to Docker Compose with `--env-file` when it exists. A site receives a value only when its own `compose.yml` references that variable, so unrelated containers do not automatically inherit the secret.
