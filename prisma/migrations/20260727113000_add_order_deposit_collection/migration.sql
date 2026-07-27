-- Deposit collection defaults (shop-level) and per-order overrides
ALTER TABLE "Settings"
ADD COLUMN "depositMode" TEXT NOT NULL DEFAULT 'none';

ALTER TABLE "Settings"
ADD COLUMN "depositValue" REAL NOT NULL DEFAULT 0;

ALTER TABLE "OrderCost"
ADD COLUMN "depositMode" TEXT NOT NULL DEFAULT 'settings';

ALTER TABLE "OrderCost"
ADD COLUMN "depositValue" REAL NOT NULL DEFAULT 0;
