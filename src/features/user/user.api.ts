// 用户 API Route Handlers（需登录）
import { NextResponse } from "next/server";
import { z } from "zod";
import { withValidation, apiError } from "@/shared/utils/api";
import { authenticate } from "@/shared/api/auth";
import { getProfile } from "./user.queries";
import { updateNickname } from "./user.service";

// ── Schemas ──

const updateNicknameSchema = z.object({
  nickname: z.string().trim().min(1, "昵称不能为空").max(30, "昵称最长 30 个字符"),
});

// ── Route Handlers ──

/** GET /api/user/profile — 个人信息 + 订单统计 */
export async function getProfileHandler(req: Request) {
  try {
    const userId = await authenticate(req);
    const profile = await getProfile(userId);
    return NextResponse.json(profile);
  } catch (error) {
    return apiError(error);
  }
}

/** PATCH /api/user/profile — 修改昵称 */
export const updateProfileHandler = withValidation(
  updateNicknameSchema,
  async (data, req) => {
    const userId = await authenticate(req);
    const result = await updateNickname(userId, data.nickname);
    return NextResponse.json(result);
  },
);
