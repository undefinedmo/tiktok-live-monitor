-- CreateEnum
CREATE TYPE "CostTemplateType" AS ENUM ('PERCENT', 'FLAT');

-- CreateEnum
CREATE TYPE "RuleLogic" AS ENUM ('AND', 'OR');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "classification" VARCHAR(20),
ADD COLUMN     "cost_cents" INTEGER,
ADD COLUMN     "fees_cents" INTEGER,
ADD COLUMN     "flag" VARCHAR(20),
ADD COLUMN     "is_giveaway" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "net_cents" INTEGER,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "video_seek_seconds" INTEGER;

-- CreateTable
CREATE TABLE "cost_templates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "type" "CostTemplateType" NOT NULL,
    "value" DECIMAL(10,2) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "logic_type" "RuleLogic" NOT NULL DEFAULT 'AND',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_conditions" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "field" VARCHAR(40) NOT NULL,
    "operator" VARCHAR(20) NOT NULL,
    "value" TEXT,
    "value2" TEXT,

    CONSTRAINT "rule_conditions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_actions" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "action_type" VARCHAR(30) NOT NULL,
    "target_value" TEXT,

    CONSTRAINT "rule_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cost_templates_organization_id_idx" ON "cost_templates"("organization_id");

-- CreateIndex
CREATE INDEX "rules_organization_id_idx" ON "rules"("organization_id");

-- CreateIndex
CREATE INDEX "rule_conditions_rule_id_idx" ON "rule_conditions"("rule_id");

-- CreateIndex
CREATE INDEX "rule_actions_rule_id_idx" ON "rule_actions"("rule_id");

-- AddForeignKey
ALTER TABLE "cost_templates" ADD CONSTRAINT "cost_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rules" ADD CONSTRAINT "rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_conditions" ADD CONSTRAINT "rule_conditions_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_actions" ADD CONSTRAINT "rule_actions_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

