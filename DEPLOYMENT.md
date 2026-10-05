# Deployment policy

GitHub `main` is the single source of truth for production code. All coding and deployment activity is orchestrated by ChatGPT; GitHub Actions or automatic push-to-production deployment is intentionally not used.

Production changes follow this order:

1. ChatGPT changes and commits code to GitHub.
2. The target commit is identified by its full 40-character SHA.
3. The server runs `site-deploy <slug> <sha>`.
4. The deploy runner fetches `origin/main`, verifies that the requested SHA is on `origin/main`, runs preflight checks, resets the production working tree to that exact SHA, activates the service, and performs local/public health checks.
5. On success, `manager.sites.current_commit` and `manager.deployments` are updated.
6. If activation or health checks fail, the runner automatically resets to the previous SHA, reactivates the prior version, health-checks it, and records the rollback.

## Rules

- Do not edit production source files directly on the server.
- Do not use `git pull` as the deployment primitive; deployment is pinned to an explicit commit SHA.
- A dirty production working tree blocks deployment.
- GitHub commit success is not deployment success; deployment health checks must pass separately.
- Secrets such as DuckDNS credentials remain server-side and are never stored in GitHub.
- Destructive database migrations and irreversible deletion still require explicit approval.
- Emergency server hotfixes are exceptional: immediately reproduce the change in GitHub and redeploy the resulting SHA to remove drift.

## Privilege model

`web-admin` runs as the unprivileged `webadmin` OS account. Root-only operations are limited to `/usr/local/sbin/web-admin-priv`, which exposes only validated Desktop Commander start/stop and DuckDNS secret installation operations. Arbitrary shell execution is not exposed through the web application.

The production deploy runner is `/usr/local/sbin/site-deploy` and is invoked deliberately by the ChatGPT operations workflow rather than automatically from GitHub.
