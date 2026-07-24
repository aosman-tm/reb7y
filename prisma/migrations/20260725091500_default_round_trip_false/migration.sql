-- Set round-trip default to false (unchecked) for settings,
-- and update existing shops to the new default behavior.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "paymentFeePercent" REAL NOT NULL DEFAULT 0,
    "paymentFeeFlat" REAL NOT NULL DEFAULT 0,
    "codFeePercent" REAL NOT NULL DEFAULT 0,
    "codRoundTripDefault" BOOLEAN NOT NULL DEFAULT false,
    "returnDeliveryMode" TEXT NOT NULL DEFAULT 'full',
    "returnDeliveryPercent" REAL NOT NULL DEFAULT 100,
    "returnDeliveryFixed" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "new_Settings" (
    "id",
    "shop",
    "currency",
    "paymentFeePercent",
    "paymentFeeFlat",
    "codFeePercent",
    "codRoundTripDefault",
    "returnDeliveryMode",
    "returnDeliveryPercent",
    "returnDeliveryFixed",
    "createdAt",
    "updatedAt"
)
SELECT
    "id",
    "shop",
    "currency",
    "paymentFeePercent",
    "paymentFeeFlat",
    "codFeePercent",
    false,
    "returnDeliveryMode",
    "returnDeliveryPercent",
    "returnDeliveryFixed",
    "createdAt",
    "updatedAt"
FROM "Settings";

DROP TABLE "Settings";
ALTER TABLE "new_Settings" RENAME TO "Settings";
CREATE UNIQUE INDEX "Settings_shop_key" ON "Settings"("shop");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
