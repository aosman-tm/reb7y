-- CreateTable
CREATE TABLE "SettingsVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "effectiveFrom" TEXT NOT NULL,
    "paymentFeePercent" REAL NOT NULL DEFAULT 0,
    "paymentFeeFlat" REAL NOT NULL DEFAULT 0,
    "codFeePercent" REAL NOT NULL DEFAULT 0,
    "codRoundTripDefault" BOOLEAN NOT NULL DEFAULT false,
    "returnDeliveryMode" TEXT NOT NULL DEFAULT 'full',
    "returnDeliveryPercent" REAL NOT NULL DEFAULT 100,
    "returnDeliveryFixed" REAL NOT NULL DEFAULT 0,
    "depositMode" TEXT NOT NULL DEFAULT 'none',
    "depositValue" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WorkerSalary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "monthlySalary" REAL NOT NULL,
    "effectiveFrom" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkerSalary_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExpenseAmount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "effectiveFrom" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExpenseAmount_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SettingsVersion_shop_effectiveFrom_idx" ON "SettingsVersion"("shop", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "SettingsVersion_shop_effectiveFrom_key" ON "SettingsVersion"("shop", "effectiveFrom");

-- CreateIndex
CREATE INDEX "WorkerSalary_shop_workerId_effectiveFrom_idx" ON "WorkerSalary"("shop", "workerId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerSalary_shop_workerId_effectiveFrom_key" ON "WorkerSalary"("shop", "workerId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "ExpenseAmount_shop_expenseId_effectiveFrom_idx" ON "ExpenseAmount"("shop", "expenseId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseAmount_shop_expenseId_effectiveFrom_key" ON "ExpenseAmount"("shop", "expenseId", "effectiveFrom");
