// 用户 API Route Handlers（需登录）
import { NextResponse } from "next/server";
import { z } from "zod";
import { withValidation, apiError } from "@/shared/utils/api";
import { authenticate } from "@/shared/api/auth";
import { getProfile } from "./user.queries";
import { updateNickname, updateAvatar, changePhone, deleteAccount } from "./user.service";

// ── Schemas ──

const updateProfileSchema = z
  .object({
    nickname: z
      .string()
      .trim()
      .min(1, "昵称不能为空")
      .max(30, "昵称最长 30 个字符")
      .optional(),
    avatarUrl: z.string().trim().max(500, "图片地址过长").optional(),
  })
  .refine((d) => d.nickname !== undefined || d.avatarUrl !== undefined, {
    message: "没有要更新的字段",
  });

// 换绑需旧凭证复验：有密码用户传 oldPassword；纯短信用户（无密码）传 oldPhone+oldCode
const changePhoneSchema = z
  .object({
    newPhone: z.string().regex(/^1[3-9]\d{9}$/, "手机号格式不正确"),
    code: z.string().length(6, "验证码为 6 位数字"),
    oldPassword: z.string().min(6, "密码至少 6 位").optional(),
    oldPhone: z.string().regex(/^1[3-9]\d{9}$/).optional(),
    oldCode: z.string().length(6).optional(),
  })
  .refine((d) => Boolean(d.oldPassword) || Boolean(d.oldPhone && d.oldCode), {
    message: "需提供旧密码或旧手机号验证码",
  });

const deactivateSchema = z.object({
  password: z.string().min(6, "密码至少 6 位").optional(),
  // 必须显式确认（前端双重确认弹窗），防误触/自动化批量注销
  confirm: z.literal(true),
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

/** PATCH /api/user/profile — 修改昵称 / 头像（可只传其一） */
export const updateProfileHandler = withValidation(
  updateProfileSchema,
  async (data, req) => {
    const userId = await authenticate(req);
    const result: { nickname?: string; avatarUrl?: string | null } = {};
    if (data.nickname !== undefined) {
      result.nickname = (await updateNickname(userId, data.nickname)).nickname;
    }
    if (data.avatarUrl !== undefined) {
      result.avatarUrl = (await updateAvatar(userId, data.avatarUrl)).avatarUrl;
    }
    return NextResponse.json(result);
  },
);

/** POST /api/user/change-phone — 换绑手机号（旧凭证复验 + 新号短信验证） */
export const changePhoneHandler = withValidation(
  changePhoneSchema,
  async (data, req) => {
    const userId = await authenticate(req);
    await changePhone(
      userId,
      data.newPhone,
      data.code,
      data.oldPassword,
      data.oldPhone,
      data.oldCode,
    );
    return NextResponse.json({ success: true });
  },
);

/** POST /api/user/deactivate — 自主注销（硬删除，不可逆） */
export const deactivateHandler = withValidation(
  deactivateSchema,
  async (data, req) => {
    const userId = await authenticate(req);
    await deleteAccount(userId, data.password);
    return NextResponse.json({ success: true });
  },
);
