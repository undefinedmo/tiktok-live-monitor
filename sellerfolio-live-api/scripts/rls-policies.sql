-- Row-Level Security policies (forward-looking, optional).
--
-- HOW IT WORKS: every org-scoped table is isolated by `organization_id`. The app must
-- connect as a NON-superuser role and run `SET app.organization_id = '<uuid>'` per request
-- (superusers/table owners bypass RLS unless FORCE is set, which it is below).
--
-- Apply with:  npm run db:rls   (after migrating). Keep in sync as tables are added.

-- helper: current org from session var (NULL-safe)
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

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
      'CREATE POLICY org_isolation ON %I USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());',
      t
    );
  END LOOP;

  -- organizations: keyed by `id`
  EXECUTE 'ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;';
  EXECUTE 'ALTER TABLE organizations FORCE ROW LEVEL SECURITY;';
  EXECUTE 'DROP POLICY IF EXISTS org_isolation ON organizations;';
  EXECUTE 'CREATE POLICY org_isolation ON organizations USING (id = app_current_org()) WITH CHECK (id = app_current_org());';
END $$;
