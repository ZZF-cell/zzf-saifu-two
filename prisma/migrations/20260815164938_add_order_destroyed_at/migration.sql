-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "destroyedAt" TIMESTAMP(3);

-- 存量回填：此前已销毁（privacy.destroyed = true）的订单，destroyedAt 补为迁移时刻。
-- 销毁时间点历史数据无法还原，用迁移时刻近似；查询层依赖 destroyedAt 过滤用户/品牌侧视图。
UPDATE "Order" SET "destroyedAt" = NOW() WHERE "privacy"->>'destroyed' = 'true' AND "destroyedAt" IS NULL;
