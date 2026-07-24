-- Returned-order cost rules
ALTER TABLE "BomLine"
ADD COLUMN "countOnReturn" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ProductCost"
ADD COLUMN "returnDeliveryMode" TEXT NOT NULL DEFAULT 'settings';

ALTER TABLE "ProductCost"
ADD COLUMN "returnDeliveryPercent" REAL NOT NULL DEFAULT 100;

ALTER TABLE "Settings"
ADD COLUMN "returnDeliveryMode" TEXT NOT NULL DEFAULT 'full';

ALTER TABLE "Settings"
ADD COLUMN "returnDeliveryPercent" REAL NOT NULL DEFAULT 100;

ALTER TABLE "Settings"
ADD COLUMN "returnDeliveryFixed" REAL NOT NULL DEFAULT 0;
