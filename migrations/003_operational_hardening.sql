BEGIN;

ALTER TABLE manager.sites
  ADD COLUMN IF NOT EXISTS repo_url text,
  ADD COLUMN IF NOT EXISTS repo_branch text NOT NULL DEFAULT 'main';

CREATE UNIQUE INDEX IF NOT EXISTS dns_provider_domains_hostname_uidx
  ON manager.dns_provider_domains(hostname);

COMMIT;
