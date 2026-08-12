// 用户写入操作 — 修改个人信息（CQS：本文件只写不读）
import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";

// ── 修改昵称 ──

export async function updateNickname(
  userId: string,
  nickname: string,
): Promise<{ nickname: string }> {
  const trimmed = nickname.trim();
  if (!trimmed) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "昵称不能为空");
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: { nickname: trimmed },
    select: { nickname: true },
  });

  return { nickname: user.nickname ?? "" };
}
