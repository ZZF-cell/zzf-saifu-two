// Invite 模块 API Route Handlers — 品牌入驻激活（需登录）
// 邀请码激活只校验登录（ownerId 非空），不限定角色 —— 角色守卫在 service 层
import { NextResponse } from "next/server";
import { z } from "zod";
import { withValidation } from "@/shared/utils/api";
import { authenticateUser } from "@/shared/api/auth";
import { ossImageUrlSchema } from "@/shared/validation/schemas";
import { activateInviteCode } from "./invite.service";

const activateInviteSchema = z.object({
  code: z.string().trim().min(1, "请输入邀请码").max(50),
  name: z.string().trim().min(1, "请输入品牌名称").max(50),
  logo: ossImageUrlSchema.optional(),
});

/** POST /api/invite/activate — 激活邀请码创建品牌（单事务消耗码 + 建 PENDING 品牌） */
export const activateInvite = withValidation(
  activateInviteSchema,
  async (data, req) => {
    const user = await authenticateUser(req);
    const result = await activateInviteCode(data, user.userId);
    return NextResponse.json({ success: true, brandId: result.brandId });
  },
);
