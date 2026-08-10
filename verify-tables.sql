-- Verify inventory tables exist and count rows
SELECT 'inventory' as table_name, COUNT(*)::int as row_count FROM inventory;
SELECT 'inventory_receipts' as table_name, COUNT(*)::int as row_count FROM inventory_receipts;
SELECT 'inventory_movements' as table_name, COUNT(*)::int as row_count FROM inventory_movements;

-- Verify the unique partial index exists
SELECT indexname FROM pg_indexes WHERE tablename='inventory_receipts' AND indexname LIKE '%one_open%';
