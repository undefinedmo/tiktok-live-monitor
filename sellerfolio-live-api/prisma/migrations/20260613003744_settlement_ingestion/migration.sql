-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('ESTIMATED', 'SETTLED');

-- CreateTable
CREATE TABLE "settlement_imports" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "platform" "PlatformType" NOT NULL,
    "filename" VARCHAR(500) NOT NULL,
    "range_start" TIMESTAMPTZ,
    "range_end" TIMESTAMPTZ,
    "downloaded_at" TIMESTAMPTZ,
    "reported_count" INTEGER,
    "row_count" INTEGER NOT NULL,
    "matched_count" INTEGER NOT NULL DEFAULT 0,
    "unmatched_count" INTEGER NOT NULL DEFAULT 0,
    "total_settlement_cents" INTEGER NOT NULL DEFAULT 0,
    "total_fees_cents" INTEGER NOT NULL DEFAULT 0,
    "uploaded_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_settlements" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "order_id" UUID,
    "platform" "PlatformType" NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "external_order_id" VARCHAR(255) NOT NULL,
    "related_order_id" VARCHAR(255),
    "status" "SettlementStatus" NOT NULL DEFAULT 'ESTIMATED',
    "net_sales_cents" INTEGER NOT NULL DEFAULT 0,
    "gross_sales_cents" INTEGER NOT NULL DEFAULT 0,
    "fees_cents" INTEGER NOT NULL DEFAULT 0,
    "referral_fee_cents" INTEGER NOT NULL DEFAULT 0,
    "sales_tax_on_referral_cents" INTEGER NOT NULL DEFAULT 0,
    "tiktok_shipping_fee_cents" INTEGER NOT NULL DEFAULT 0,
    "customer_paid_shipping_cents" INTEGER NOT NULL DEFAULT 0,
    "customer_payment_cents" INTEGER NOT NULL DEFAULT 0,
    "sales_tax_payment_cents" INTEGER NOT NULL DEFAULT 0,
    "platform_discount_cents" INTEGER NOT NULL DEFAULT 0,
    "estimated_settlement_cents" INTEGER NOT NULL DEFAULT 0,
    "sku_id" VARCHAR(255),
    "sku_name" VARCHAR(255),
    "product_name" VARCHAR(500),
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "estimated_settle_time" VARCHAR(120),
    "unsettled_reason" VARCHAR(255),
    "creation_date" TIMESTAMPTZ,
    "raw" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "order_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "settlement_imports_organization_id_idx" ON "settlement_imports"("organization_id");

-- CreateIndex
CREATE INDEX "order_settlements_organization_id_idx" ON "order_settlements"("organization_id");

-- CreateIndex
CREATE INDEX "order_settlements_order_id_idx" ON "order_settlements"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_settlements_organization_id_platform_external_order_i_key" ON "order_settlements"("organization_id", "platform", "external_order_id");

-- AddForeignKey
ALTER TABLE "settlement_imports" ADD CONSTRAINT "settlement_imports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_settlements" ADD CONSTRAINT "order_settlements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_settlements" ADD CONSTRAINT "order_settlements_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "settlement_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_settlements" ADD CONSTRAINT "order_settlements_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
