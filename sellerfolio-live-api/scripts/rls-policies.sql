-- Row-Level Security policies (forward-looking, optional).
--
-- HOW IT WORKS: every org-scoped table is isolated by `organization_id`. The app must
-- connect as a NON-superuser role and, for EVERY request, run inside a transaction:
--
--     BEGIN;
--     SET LOCAL app.organization_id = '<org-uuid>';   -- LOCAL = scoped to this txn only
--     ... queries ...
--     COMMIT;
--
-- Use SET LOCAL (never plain SET): with a connection pool, plain SET leaks the value to
-- whoever gets the connection next. As a belt-and-suspenders, configure the pg Pool to run
-- `DISCARD ALL` on connection release.
--
-- Apply with:  npm run db:rls   (after migrating). Keep in sync as tables are added.

-- Resolver for the current org. search_path is pinned so a future role with CREATE on its
-- own schema cannot shadow it; policies below call it schema-qualified as public.app_current_org().
CREATE OR REPLACE FUNCTION public.app_current_org() RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid;
$$;

DO $$
DECLARE t text;
BEGIN
  -- tables whose tenant key is `organization_id`
  FOREACH t IN ARRAY ARRAY[
    'memberships','api_tokens','invitations','invoices','subscriptions',
    'usage_counters','usage_events','platform_connections','shows','customers',
    'orders','order_items','shipments','receipts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS org_isolation ON %I;', t);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I USING (organization_id = public.app_current_org()) WITH CHECK (organization_id = public.app_current_org());',
      t
    );
  END LOOP;

  -- organizations: keyed by `id`
  EXECUTE 'ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;';
  EXECUTE 'ALTER TABLE organizations FORCE ROW LEVEL SECURITY;';
  EXECUTE 'DROP POLICY IF EXISTS org_isolation ON organizations;';
  EXECUTE 'CREATE POLICY org_isolation ON organizations USING (id = public.app_current_org()) WITH CHECK (id = public.app_current_org());';

  -- permission_overrides: keyed indirectly via membership
  EXECUTE 'ALTER TABLE permission_overrides ENABLE ROW LEVEL SECURITY;';
  EXECUTE 'ALTER TABLE permission_overrides FORCE ROW LEVEL SECURITY;';
  EXECUTE 'DROP POLICY IF EXISTS org_isolation ON permission_overrides;';
  EXECUTE 'CREATE POLICY org_isolation ON permission_overrides USING (membership_id IN (SELECT id FROM memberships WHERE organization_id = public.app_current_org())) WITH CHECK (membership_id IN (SELECT id FROM memberships WHERE organization_id = public.app_current_org()));';

  -- audit_logs: organization_id is nullable (system rows). Tenants see their own + system rows,
  -- but may only write rows scoped to their org.
  EXECUTE 'ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;';
  EXECUTE 'ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;';
  EXECUTE 'DROP POLICY IF EXISTS org_isolation ON audit_logs;';
  EXECUTE 'CREATE POLICY org_isolation ON audit_logs USING (organization_id IS NULL OR organization_id = public.app_current_org()) WITH CHECK (organization_id = public.app_current_org());';
END $$;
