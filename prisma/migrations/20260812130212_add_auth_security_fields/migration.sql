/*
  Warnings:

  - You are about to drop the column `phone` on the `VerificationCode` table. All the data in the column will be lost.
  - Added the required column `phoneHash` to the `VerificationCode` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "VerificationCode_phone_createdAt_idx";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "VerificationCode" DROP COLUMN "phone",
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "phoneHash" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "VerificationCode_phoneHash_createdAt_idx" ON "VerificationCode"("phoneHash", "createdAt");
