import { NextResponse } from "next/server";
import * as authService from "@/features/auth/auth.service";

export async function POST(req: Request) {
  const cookie = req.headers.get("cookie") || "";
  const token = cookie.match(/access_token=([^;]+)/)?.[1];
  if (!token) return NextResponse.json({ success: false }, { status: 401 });

  const user = await authService.verifyAccessToken(token);
  if (!user) return NextResponse.json({ success: false }, { status: 401 });

  await authService.setAgeVerified(user.userId);
  return NextResponse.json({ success: true });
}
