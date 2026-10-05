-- Agent role permission baseline and public site metadata view.
-- Non-destructive / additive migration.
-- Apply with a database owner/superuser; runtime agents use web_manager afterward.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid=e.enumtypid
    JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='manager' AND t.typname='agent_role' AND e.enumlabel='READ_ONLY'
  ) THEN
    ALTER TYPE manager.agent_role ADD VALUE 'READ_ONLY';
  END IF;
END$$;

ALTER TABLE manager.agent_sessions
  DROP CONSTRAINT IF EXISTS agent_sessions_check;

ALTER TABLE manager.agent_sessions
  ADD CONSTRAINT agent_sessions_check CHECK (
    (role='MAIN_ADMIN'::manager.agent_role AND target_site_id IS NULL)
    OR (role = ANY (ARRAY['SITE_ADMIN'::manager.agent_role,'SITE_DB_ADMIN'::manager.agent_role]) AND target_site_id IS NOT NULL)
    OR (role='READ_ONLY'::manager.agent_role)
  );

CREATE TABLE IF NOT EXISTS manager.agent_role_policies (
  role manager.agent_role PRIMARY KEY,
  permissions jsonb NOT NULL,
  description text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO manager.agent_role_policies(role,permissions,description) VALUES
('MAIN_ADMIN',
 '{"public_site_inventory_read":"all","public_homepage_url_read":"all","public_domain_health_read":"all","site_metadata_read":"all","site_write":"all","site_deploy":"all","site_database_write":"all","global_infrastructure":"write","agent_permissions":"write","secrets":"restricted-helper-only","destructive_requires_confirmation":true}'::jsonb,
 'Global administrator. Public site metadata is always readable; all non-destructive platform/site operations are writable within policy.'),
('SITE_ADMIN',
 '{"public_site_inventory_read":"all","public_homepage_url_read":"all","public_domain_health_read":"all","site_metadata_read":"target","site_logs_read":"target","site_deployments_read":"target","site_code_write":"target","site_deploy":"target","site_runtime_write":"target-non-destructive","site_domains_write":"target-non-destructive","site_database_write":"none","global_infrastructure":"none","secrets":"none","destructive_requires_confirmation":true}'::jsonb,
 'Target-site administrator. May always read public site addresses/inventory, and may manage the assigned site without global infrastructure or secret access.'),
('SITE_DB_ADMIN',
 '{"public_site_inventory_read":"all","public_homepage_url_read":"all","public_domain_health_read":"all","site_metadata_read":"target","site_database_read":"target","site_database_write":"target","site_code_write":"none","site_deploy":"none","global_infrastructure":"none","secrets":"none","destructive_requires_confirmation":true}'::jsonb,
 'Target-site database administrator. Public site identity/address is readable for context; DB authority remains target-scoped.'),
('READ_ONLY',
 '{"public_site_inventory_read":"all","public_homepage_url_read":"all","public_domain_health_read":"all","site_metadata_read":"public-only","site_write":"none","site_database_write":"none","global_infrastructure":"none","secrets":"none","destructive_requires_confirmation":true}'::jsonb,
 'Read-only role. Public non-secret site metadata including homepage URLs is readable across live sites.')
ON CONFLICT(role) DO UPDATE
SET permissions=excluded.permissions,
    description=excluded.description,
    updated_at=now();

CREATE OR REPLACE VIEW manager.site_public_overview AS
SELECT
  s.id AS site_id,
  s.slug,
  s.name,
  CASE WHEN d.hostname IS NULL OR d.hostname='' THEN NULL ELSE 'https://' || d.hostname END AS homepage_url,
  d.hostname,
  s.status,
  s.health_status,
  s.port,
  s.repo_url,
  s.repo_branch,
  s.current_commit,
  d.dns_status,
  d.tls_status
FROM manager.sites s
LEFT JOIN LATERAL (
  SELECT sd.hostname,sd.dns_status,sd.tls_status
  FROM manager.site_domains sd
  WHERE sd.site_id=s.id
  ORDER BY sd.is_primary DESC,sd.created_at
  LIMIT 1
) d ON true
WHERE s.archived_at IS NULL;

CREATE OR REPLACE FUNCTION manager.apply_agent_role_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  baseline jsonb;
BEGIN
  SELECT p.permissions INTO baseline
  FROM manager.agent_role_policies p
  WHERE p.role=NEW.role;

  IF baseline IS NULL THEN
    RAISE EXCEPTION 'No agent role policy configured for role %', NEW.role;
  END IF;

  NEW.permissions := COALESCE(NEW.permissions,'{}'::jsonb) || baseline;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_sessions_apply_role_policy ON manager.agent_sessions;
CREATE TRIGGER agent_sessions_apply_role_policy
BEFORE INSERT OR UPDATE OF role,permissions ON manager.agent_sessions
FOR EACH ROW EXECUTE FUNCTION manager.apply_agent_role_policy();

-- Runtime agents connect as web_manager. Public site identity/address metadata must be
-- directly readable; policy configuration is readable and updatable by MAIN_ADMIN flows.
GRANT SELECT, INSERT, UPDATE ON manager.agent_role_policies TO web_manager;
GRANT SELECT ON manager.site_public_overview TO web_manager;
GRANT EXECUTE ON FUNCTION manager.apply_agent_role_policy() TO web_manager;

UPDATE manager.agent_sessions a
SET permissions = a.permissions || p.permissions
FROM manager.agent_role_policies p
WHERE a.role=p.role;

COMMENT ON VIEW manager.site_public_overview IS
'Non-secret public site metadata. Homepage URLs and public domain/health information are readable by every agent role; write authority remains role-scoped.';
