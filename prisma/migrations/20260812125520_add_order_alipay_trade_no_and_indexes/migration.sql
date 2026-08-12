-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "alipayTradeNo" TEXT;

-- CreateIndex
CREATE INDEX "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");
