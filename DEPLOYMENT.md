# Deployment policy

GitHub `main` is the source of truth for this site.

Production changes follow this order:

1. Change and commit files in GitHub.
2. On the server, fetch/pull `origin/main` into `/srv/sites/web-admin`.
3. Restart `web-admin.service` when backend code changes.
4. Verify local API and public HTTPS health.

Do not make production-only edits directly on the server and leave them uncommitted.
