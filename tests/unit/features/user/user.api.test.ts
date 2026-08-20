// user.api 单元测试 — 资料/改手机号/注销端点
// mock 系统边界：authenticate（鉴权）+ user.service / user.queries（业务）
// 核心契约：
// - PATCH profile：nickname/avatarUrl 可只传其一，缺字段时不得调用对应 service
// - change-phone：非法手机号/验证码 → 422，不调 service
// - deactivate：confirm 必须为 true（缺 → 422，杜绝误触/自动化批量注销）

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/shared/api/auth", () => ({
  authenticate: vi.fn(),
}));

vi.mock("@/features/user/user.service", () => ({
  updateNickname: vi.fn(),
  updateAvatar: vi.fn(),
  changePhone: vi.fn(),
  deleteAccount: vi.fn(),
}));

vi.mock("@/features/user/user.queries", () => ({
  getProfile: vi.fn(),
}));

import {
  getProfileHandler,
  updateProfileHandler,
  changePhoneHandler,
  deactivateHandler,
} from "@/features/user/user.api";
import * as auth from "@/shared/api/auth";
import * as userService from "@/features/user/user.service";
import * as userQueries from "@/features/user/user.queries";

const authenticateMock = vi.mocked(auth.authenticate);
const updateNicknameMock = vi.mocked(userService.updateNickname);
const updateAvatarMock = vi.mocked(userService.updateAvatar);
const changePhoneMock = vi.mocked(userService.changePhone);
const deleteAccountMock = vi.mocked(userService.deleteAccount);
const getProfileMock = vi.mocked(userQueries.getProfile);

function makeRequest(url: string, body?: unknown, method = "GET"): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticateMock.mockResolvedValue("user-1");
  getProfileMock.mockResolvedValue({ nickname: "小赛夫" } as never);
  updateNicknameMock.mockResolvedValue({ nickname: "小赛夫" } as never);
  updateAvatarMock.mockResolvedValue({ avatarUrl: null } as never);
  changePhoneMock.mockResolvedValue(undefined);
  deleteAccountMock.mockResolvedValue(undefined);
});

describe("GET /api/user/profile", () => {
  it("返回个人信息", async () => {
    const res = await getProfileHandler(makeRequest("http://localhost/api/user/profile"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nickname: "小赛夫" });
    expect(authenticateMock).toHaveBeenCalledWith(expect.anything());
    expect(getProfileMock).toHaveBeenCalledWith("user-1");
  });
});

describe("PATCH /api/user/profile — 昵称/头像", () => {
  it("只传 nickname → 仅调 updateNickname", async () => {
    const res = await updateProfileHandler(
      makeRequest("http://localhost/api/user/profile", { nickname: "新名" }, "PATCH"),
    );

    expect(res.status).toBe(200);
    expect(updateNicknameMock).toHaveBeenCalledWith("user-1", "新名");
    expect(updateAvatarMock).not.toHaveBeenCalled();
  });

  it("只传 avatarUrl → 仅调 updateAvatar", async () => {
    const res = await updateProfileHandler(
      makeRequest("http://localhost/api/user/profile", { avatarUrl: "https://x" }, "PATCH"),
    );

    expect(res.status).toBe(200);
    expect(updateAvatarMock).toHaveBeenCalledWith("user-1", "https://x");
    expect(updateNicknameMock).not.toHaveBeenCalled();
  });

  it("两个字段都传 → 依次调用两个 service", async () => {
    await updateProfileHandler(
      makeRequest("http://localhost/api/user/profile", { nickname: "新名", avatarUrl: "https://x" }, "PATCH"),
    );

    expect(updateNicknameMock).toHaveBeenCalledWith("user-1", "新名");
    expect(updateAvatarMock).toHaveBeenCalledWith("user-1", "https://x");
  });

  it("空字段（都不传）→ 422，不调 service", async () => {
    const res = await updateProfileHandler(
      makeRequest("http://localhost/api/user/profile", {}, "PATCH"),
    );

    expect(res.status).toBe(422);
    expect(updateNicknameMock).not.toHaveBeenCalled();
    expect(updateAvatarMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/user/change-phone", () => {
  it("有密码用户：带 oldPassword → 透传 userId/newPhone/code/oldPassword 到 changePhone", async () => {
    const res = await changePhoneHandler(
      makeRequest("http://localhost/api/user/change-phone", { newPhone: "13900000001", code: "123456", oldPassword: "pass-123456" }, "POST"),
    );

    expect(res.status).toBe(200);
    expect(changePhoneMock).toHaveBeenCalledWith(
      "user-1",
      "13900000001",
      "123456",
      "pass-123456",
      undefined,
      undefined,
    );
  });

  it("纯短信用户：带 oldPhone+oldCode → 透传换绑参数", async () => {
    const res = await changePhoneHandler(
      makeRequest("http://localhost/api/user/change-phone", { newPhone: "13900000001", code: "123456", oldPhone: "13800000001", oldCode: "654321" }, "POST"),
    );

    expect(res.status).toBe(200);
    expect(changePhoneMock).toHaveBeenCalledWith(
      "user-1",
      "13900000001",
      "123456",
      undefined,
      "13800000001",
      "654321",
    );
  });

  it("缺旧凭证（无 oldPassword / 无 oldPhone+oldCode）→ 422，不调 service", async () => {
    const res = await changePhoneHandler(
      makeRequest("http://localhost/api/user/change-phone", { newPhone: "13900000001", code: "123456" }, "POST"),
    );

    expect(res.status).toBe(422);
    expect(changePhoneMock).not.toHaveBeenCalled();
  });

  it("非法手机号 → 422，不调 service", async () => {
    const res = await changePhoneHandler(
      makeRequest("http://localhost/api/user/change-phone", { newPhone: "123", code: "123456" }, "POST"),
    );

    expect(res.status).toBe(422);
    expect(changePhoneMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/user/deactivate", () => {
  it("confirm:true + 密码 → deleteAccount 收到密码", async () => {
    const res = await deactivateHandler(
      makeRequest("http://localhost/api/user/deactivate", { confirm: true, password: "pass-123" }, "POST"),
    );

    expect(res.status).toBe(200);
    expect(deleteAccountMock).toHaveBeenCalledWith("user-1", "pass-123");
  });

  it("confirm:true 无密码（纯短信用户）→ deleteAccount 收到 undefined", async () => {
    await deactivateHandler(
      makeRequest("http://localhost/api/user/deactivate", { confirm: true }, "POST"),
    );

    expect(deleteAccountMock).toHaveBeenCalledWith("user-1", undefined);
  });

  it("confirm 缺失/非 true → 422，不调 service（杜绝误触）", async () => {
    const res = await deactivateHandler(
      makeRequest("http://localhost/api/user/deactivate", { confirm: false }, "POST"),
    );

    expect(res.status).toBe(422);
    expect(deleteAccountMock).not.toHaveBeenCalled();
  });
});
