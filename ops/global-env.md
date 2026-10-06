# Global runtime environment

WebAdmin stores shared runtime secrets in `/etc/web-manager/secrets/global.env` (`root:root 0600`).

Current managed variables:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The values are never returned by the API, rendered back in the UI, logged, or committed to Git.

## Runtime injection

`docker compose --env-file` by itself only supplies values for Compose variable interpolation; it does **not** automatically place every variable into a container's runtime environment. Therefore `site-deploy` creates a temporary root-only Compose override under `/run/web-manager/` and attaches `/etc/web-manager/secrets/global.env` as `env_file` to the application's primary service.

The primary service is selected by the Manager DB published port. If a Compose project contains only one service, that service is used as the fallback. Deploy is rejected when no unambiguous application service can be identified.

This makes the global environment available inside the deployed application container without committing secrets or modifying each site's repository. The same injection path is used during activation and rollback so runtime configuration remains consistent.
