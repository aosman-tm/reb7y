-- CreateTable
CREATE TABLE "LineCostRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "unitPrice" REAL,
    "targetProductId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "LineCostRule_shop_idx" ON "LineCostRule"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "LineCostRule_shop_productId_variantId_unitPrice_key" ON "LineCostRule"("shop", "productId", "variantId", "unitPrice");
