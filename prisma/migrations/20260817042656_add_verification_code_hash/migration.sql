/*
  Warnings:

  - You are about to drop the column `code` on the `VerificationCode` table. All the data in the column will be lost.
  - Added the required column `codeHash` to the `VerificationCode` table without a default value. This is not possible if the table is not empty.

*/
-- E4 验证码哈希存储：DB 只存 SHA-256(code)，不再存明文。
-- 存量验证码为 5min 短生命周期数据，部署瞬间作废（安全实践：机制变更使存量失效，用户重发即可）；
-- 否则 ADD COLUMN NOT NULL 在非空表上失败。
DELETE FROM "VerificationCode";
-- AlterTable
ALTER TABLE "VerificationCode" DROP COLUMN "code",
ADD COLUMN     "codeHash" TEXT NOT NULL;
