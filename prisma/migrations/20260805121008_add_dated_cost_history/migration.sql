-- CreateTable
CREATE TABLE "MaterialPrice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "costPerUnit" REAL NOT NULL,
    "effectiveFrom" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MaterialPrice_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProductCostVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "effectiveFrom" TEXT NOT NULL,
    "materialCost" REAL NOT NULL DEFAULT 0,
    "returnMaterialCost" REAL NOT NULL DEFAULT 0,
    "factoryCost" REAL NOT NULL DEFAULT 0,
    "otherCost" REAL NOT NULL DEFAULT 0,
    "returnDeliveryMode" TEXT NOT NULL DEFAULT 'settings',
    "returnDeliveryPercent" REAL NOT NULL DEFAULT 100,
    "reason" TEXT NOT NULL DEFAULT 'edit',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DeliveryZonePrice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "realCost" REAL NOT NULL,
    "effectiveFrom" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeliveryZonePrice_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "DeliveryZone" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "MaterialPrice_shop_materialId_effectiveFrom_idx" ON "MaterialPrice"("shop", "materialId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialPrice_shop_materialId_effectiveFrom_key" ON "MaterialPrice"("shop", "materialId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "ProductCostVersion_shop_productId_effectiveFrom_idx" ON "ProductCostVersion"("shop", "productId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCostVersion_shop_productId_effectiveFrom_key" ON "ProductCostVersion"("shop", "productId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "DeliveryZonePrice_shop_zoneId_effectiveFrom_idx" ON "DeliveryZonePrice"("shop", "zoneId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryZonePrice_shop_zoneId_effectiveFrom_key" ON "DeliveryZonePrice"("shop", "zoneId", "effectiveFrom");
