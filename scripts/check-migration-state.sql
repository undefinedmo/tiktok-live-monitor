SELECT migration_name, started_at, finished_at, rolled_back_at, logs
FROM _prisma_migrations
WHERE migration_name LIKE '%v1_parity%' OR migration_name LIKE '%ad_spend%'
ORDER BY started_at DESC;

SELECT 'customers.is_blocked'  AS check, EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'customers' AND column_name = 'is_blocked'
) AS present
UNION ALL SELECT 'items.earnings_status', EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'items' AND column_name = 'earnings_status'
) UNION ALL SELECT 'dismissed_duplicates table', EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_name = 'dismissed_duplicates'
) UNION ALL SELECT 'shows.ad_spend_total_cents', EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'shows' AND column_name = 'ad_spend_total_cents'
) UNION ALL SELECT 'consignments.include_ad_spend_in_cost', EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'consignments' AND column_name = 'include_ad_spend_in_cost'
);
