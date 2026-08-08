// Auth 查询 — 用户查找
import { prisma } from "@/shared/db/client";
import { hashPhone } from "@/shared/utils/crypto";

export async function getUserByPhone(phone: string) {
  const phoneHash = hashPhone(phone);
  return prisma.user.findUnique({
    where: { phoneHash },
    select: {
      id: true,
      nickname: true,
      role: true,
      ageVerified: true,
      createdAt: true,
    },
  });
}

export async function getUserById(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      phoneHash: true,
      nickname: true,
      role: true,
      ageVerified: true,
      createdAt: true,
    },
  });
}
