// 审计日志（写路径通用助手）
// 约定：状态变更与审计在同一 $transaction 内写入，审计失败整体回滚，
// 不留「状态已变但无审计」的账。admin/brand/orders 各 feature 共用同一实现。
import type { Prisma } from "@prisma/client";

export async function writeAuditLog(
  tx: Prisma.TransactionClient,
  targetType: string,
  targetId: string,
  action: string,
  operatorId: string | null,
  snapshot?: unknown,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      targetType,
      targetId,
      action,
      operatorId,
      ...(snapshot !== undefined ? { snapshot: snapshot as object } : {}),
    },
  });
}
