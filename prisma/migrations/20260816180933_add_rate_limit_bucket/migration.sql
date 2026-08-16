-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "bucketKey" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateLimitBucket_scope_bucketStart_idx" ON "RateLimitBucket"("scope", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "RateLimitBucket_scope_bucketKey_bucketStart_key" ON "RateLimitBucket"("scope", "bucketKey", "bucketStart");
