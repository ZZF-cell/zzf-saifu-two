// service.api 单元测试 — 客服端端点（SERVICE_ROLES 门禁 + 参数校验）
// mock 系统边界：requireRole（鉴权）+ service.service / service.queries（业务）
// 核心契约：
// - 全部客服端点 requireRole(SERVICE_ROLES)，非客服 → 403
// - 客服回复传递 cs.userId + cs.role（角色快照来源）
// - 详情端点打开即置已读（markTicketRead）
// - PATCH 缺 status → 422，杜绝缺参进 service

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/shared/api/auth", () => ({
  requireRole: vi.fn(),
  SERVICE_ROLES: ["CUSTOMER_SERVICE", "SUPER"],
}));

vi.mock("@/features/service/service.service", () => ({
  createTicket: vi.fn(),
  addUserMessage: vi.fn(),
  addCsMessage: vi.fn(),
  markTicketRead: vi.fn(),
  updateTicketStatus: vi.fn(),
}));

vi.mock("@/features/service/service.queries", () => ({
  listMyTickets: vi.fn(),
  getTicketDetail: vi.fn(),
  listAllTickets: vi.fn(),
  getTicketDetailAdmin: vi.fn(),
}));

import {
  listAllTicketsHandler,
  getTicketDetailAdminHandler,
  addCsMessageHandler,
  updateTicketStatusHandler,
} from "@/features/service/service.api";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import * as auth from "@/shared/api/auth";
import * as serviceService from "@/features/service/service.service";
import * as serviceQueries from "@/features/service/service.queries";

const requireRoleMock = vi.mocked(auth.requireRole);
const addCsMessageMock = vi.mocked(serviceService.addCsMessage);
const markTicketReadMock = vi.mocked(serviceService.markTicketRead);
const updateTicketStatusMock = vi.mocked(serviceService.updateTicketStatus);
const listAllTicketsMock = vi.mocked(serviceQueries.listAllTickets);
const getTicketDetailAdminMock = vi.mocked(serviceQueries.getTicketDetailAdmin);

function makeRequest(url: string, body?: unknown, method = "GET"): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

const ctx = (id = "ticket-1") => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue({
    userId: "cs-1",
    role: "CUSTOMER_SERVICE",
  } as never);
  listAllTicketsMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never);
  getTicketDetailAdminMock.mockResolvedValue({} as never);
  addCsMessageMock.mockResolvedValue(undefined);
  markTicketReadMock.mockResolvedValue(undefined);
  updateTicketStatusMock.mockResolvedValue(undefined);
});

describe("客服端点 — SERVICE_ROLES 门禁", () => {
  it.each([
    ["GET 列表", () => listAllTicketsHandler(makeRequest("http://localhost/api/service/tickets"))],
    ["GET 详情", () => getTicketDetailAdminHandler(makeRequest("http://localhost/api/service/tickets/ticket-1"), ctx())],
    ["POST 回复", () => addCsMessageHandler(makeRequest("http://localhost/api/service/tickets/ticket-1/messages", { content: "hi" }, "POST"), ctx())],
    ["PATCH 状态", () => updateTicketStatusHandler(makeRequest("http://localhost/api/service/tickets/ticket-1", { status: "RESOLVED" }, "PATCH"), ctx())],
  ])("%s 未授权 → 403 透传 requireRole 错误", async (_label, call) => {
    requireRoleMock.mockRejectedValue(
      new AppError(ERROR_CODES.FORBIDDEN, "无权限执行此操作"),
    );

    const res = await call();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: ERROR_CODES.FORBIDDEN.code });
    expect(requireRoleMock).toHaveBeenCalledWith(expect.anything(), ["CUSTOMER_SERVICE", "SUPER"]);
  });

  it("客服身份 → 四个端点全部放行并调用业务", async () => {
    await listAllTicketsHandler(makeRequest("http://localhost/api/service/tickets"));
    await getTicketDetailAdminHandler(makeRequest("http://localhost/api/service/tickets/ticket-1"), ctx());
    await addCsMessageHandler(makeRequest("http://localhost/api/service/tickets/ticket-1/messages", { content: "hi" }, "POST"), ctx());
    await updateTicketStatusHandler(makeRequest("http://localhost/api/service/tickets/ticket-1", { status: "RESOLVED" }, "PATCH"), ctx());

    expect(requireRoleMock).toHaveBeenCalledTimes(4);
  });
});

describe("GET /api/service/tickets — 列表筛选", () => {
  it("透传 status/category/keyword 筛选到 listAllTickets", async () => {
    const url = "http://localhost/api/service/tickets?status=OPEN&category=AFTERSALE&keyword=发";
    const res = await listAllTicketsHandler(makeRequest(url));

    expect(res.status).toBe(200);
    expect(listAllTicketsMock).toHaveBeenCalledWith({
      status: "OPEN",
      category: "AFTERSALE",
      keyword: "发",
      page: 1,
      pageSize: 20,
    });
  });

  it("无筛选 → 参数均为 undefined", async () => {
    await listAllTicketsHandler(makeRequest("http://localhost/api/service/tickets"));

    expect(listAllTicketsMock).toHaveBeenCalledWith({
      status: undefined,
      category: undefined,
      keyword: undefined,
      page: 1,
      pageSize: 20,
    });
  });
});

describe("GET /api/service/tickets/[id] — 详情 + 置已读", () => {
  it("返回详情并调用 markTicketRead（打开即已读）", async () => {
    getTicketDetailAdminMock.mockResolvedValue({ id: "ticket-1" } as never);
    const res = await getTicketDetailAdminHandler(
      makeRequest("http://localhost/api/service/tickets/ticket-1"),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "ticket-1" });
    expect(markTicketReadMock).toHaveBeenCalledWith("ticket-1");
  });
});

describe("POST /api/service/tickets/[id]/messages — 客服回复", () => {
  it("传递 cs.userId + cs.role（角色快照来源）", async () => {
    const res = await addCsMessageHandler(
      makeRequest("http://localhost/api/service/tickets/ticket-1/messages", { content: "您好" }, "POST"),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(addCsMessageMock).toHaveBeenCalledWith("cs-1", "CUSTOMER_SERVICE", "ticket-1", "您好");
  });

  it("缺 content → 422，不调 service", async () => {
    const res = await addCsMessageHandler(
      makeRequest("http://localhost/api/service/tickets/ticket-1/messages", {}, "POST"),
      ctx(),
    );

    expect(res.status).toBe(422);
    expect(addCsMessageMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/service/tickets/[id] — 变更状态", () => {
  it("合法 status → 调 updateTicketStatus", async () => {
    const res = await updateTicketStatusHandler(
      makeRequest("http://localhost/api/service/tickets/ticket-1", { status: "RESOLVED" }, "PATCH"),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(updateTicketStatusMock).toHaveBeenCalledWith("ticket-1", "RESOLVED");
  });

  it("缺 status / 非法 status → 422，不调 service", async () => {
    const res = await updateTicketStatusHandler(
      makeRequest("http://localhost/api/service/tickets/ticket-1", {}, "PATCH"),
      ctx(),
    );

    expect(res.status).toBe(422);
    expect(updateTicketStatusMock).not.toHaveBeenCalled();
  });
});
