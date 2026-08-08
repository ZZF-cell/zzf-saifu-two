import { NextResponse } from "next/server";
import { ERROR_CODES, AppError } from "@/shared/errors/errors";
import { apiError } from "@/shared/utils/api";
import * as authService from "@/features/auth/auth.service";

export async function POST(req: Request) {
  try {
    const cookie = req.headers.get("cookie") || "";
    const token = cookie.match(/access_token=([^;]+)/)?.[1];
    if (!token) throw new AppError(ERROR_CODES.UNAUTHORIZED, "请先登录");

    const user = await authService.verifyAccessToken(token);
    if (!user) throw new AppError(ERROR_CODES.TOKEN_EXPIRED, "登录已过期");

    await authService.setAgeVerified(user.userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}
