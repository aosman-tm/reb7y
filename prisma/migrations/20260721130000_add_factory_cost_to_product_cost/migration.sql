-- Add a dedicated per-item factory/manufacturing cost for each product recipe.
ALTER TABLE "ProductCost"
ADD COLUMN "factoryCost" REAL NOT NULL DEFAULT 0;
