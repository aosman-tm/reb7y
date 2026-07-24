-- CreateTable
CREATE TABLE "Material" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'piece',
    "costPerUnit" REAL NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProductCost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "otherCost" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BomLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productCostId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "quantity" REAL NOT NULL DEFAULT 1,
    CONSTRAINT "BomLine_productCostId_fkey" FOREIGN KEY ("productCostId") REFERENCES "ProductCost" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BomLine_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdSpend" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DeliveryZone" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keywords" TEXT NOT NULL DEFAULT '',
    "realCost" REAL NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OrderCost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "realDeliveryCost" REAL,
    "deliveryOutcome" TEXT NOT NULL DEFAULT 'delivered',
    "roundTrip" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "paymentFeePercent" REAL NOT NULL DEFAULT 0,
    "paymentFeeFlat" REAL NOT NULL DEFAULT 0,
    "codFeePercent" REAL NOT NULL DEFAULT 0,
    "codRoundTripDefault" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Material_shop_idx" ON "Material"("shop");

-- CreateIndex
CREATE INDEX "ProductCost_shop_idx" ON "ProductCost"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCost_shop_productId_key" ON "ProductCost"("shop", "productId");

-- CreateIndex
CREATE INDEX "BomLine_productCostId_idx" ON "BomLine"("productCostId");

-- CreateIndex
CREATE INDEX "BomLine_materialId_idx" ON "BomLine"("materialId");

-- CreateIndex
CREATE INDEX "AdSpend_shop_idx" ON "AdSpend"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "AdSpend_shop_date_key" ON "AdSpend"("shop", "date");

-- CreateIndex
CREATE INDEX "DeliveryZone_shop_idx" ON "DeliveryZone"("shop");

-- CreateIndex
CREATE INDEX "OrderCost_shop_idx" ON "OrderCost"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "OrderCost_shop_orderId_key" ON "OrderCost"("shop", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Settings_shop_key" ON "Settings"("shop");
