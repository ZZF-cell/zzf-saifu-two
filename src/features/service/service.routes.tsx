"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  TicketCategory,
  TicketDetail,
  TicketListResult,
  TicketMessage,
  TicketStatus,
  TicketSummary,
} from "./service.types";
import { TICKET_CATEGORIES } from "./service.types";
import { apiFetch } from "@/shared/api/client";
import { SiteHeader } from "@/shared/ui/SiteHeader";
import { WorkbenchHeader } from "@/shared/ui/WorkbenchHeader";
import { fenToYuan } from "@/shared/utils/money";
import { StatusBadge, STATUS_LABEL } from "@/shared/ui/StatusBadge";

// ── helpers ──

async function apiCall(method: string, url: string, body?: Record<string, unknown>) {
  const res = await apiFetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "请求失败");
  return data;
}

const CATEGORY_LABEL: Record<string, string> = {
  PRESALE: "售前咨询",
  AFTERSALE: "售后问题",
  OTHER: "其他",
};

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  OPEN: { label: "待处理", cls: "bg-yellow-50 text-yellow-700" },
  PROCESSING: { label: "处理中", cls: "bg-blue-50 text-blue-600" },
  RESOLVED: { label: "已解决", cls: "bg-green-50 text-green-600" },
  CLOSED: { label: "已关闭", cls: "bg-gray-100 text-gray-500" },
};

// 客服侧发言角色（区别于客户 USER 的消息，用于气泡左右对齐）
function isStaffMessage(senderRole: string): boolean {
  return (
    senderRole === "CUSTOMER_SERVICE" ||
    senderRole === "ADMIN" ||
    senderRole === "SUPER"
  );
}

function fmt(d: Date | string): string {
  return new Date(d).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── 我的咨询列表页（/tickets） ──

export function TicketsPage() {
  const router = useRouter();
  const [items, setItems] = useState<TicketListResult["items"]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // 新建表单
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<TicketCategory>("PRESALE");
  const [orderId, setOrderId] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  const fetchTickets = useCallback(async () => {
    try {
      const data = await apiCall("GET", "/api/tickets");
      setItems(data.items ?? []);
    } catch {
      setError("咨询列表加载失败，请刷新重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTickets(); }, [fetchTickets]);

  const handleSubmit = async () => {
    if (!title.trim()) { setFormError("请填写咨询主题"); return; }
    if (!content.trim()) { setFormError("请填写咨询内容"); return; }
    setSubmitting(true);
    setFormError("");
    try {
      const result = await apiCall("POST", "/api/tickets", {
        title: title.trim(),
        category,
        content: content.trim(),
        orderId: orderId.trim() || undefined,
      });
      router.push(`/tickets/${result.id}`);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : "提交失败，请重试");
      setSubmitting(false);
    }
  };

  return (
    <main className="mx-auto min-h-screen max-w-6xl bg-white pb-24">
      <SiteHeader />
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 pt-4">
        <h1 className="text-xl font-bold text-gray-900">我的咨询</h1>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
        >
          {showForm ? "收起表单" : "发起新咨询"}
        </button>
      </div>

      <div className="mx-auto w-full max-w-3xl p-4 space-y-6">
        {/* 新建咨询表单 */}
        {showForm && (
          <section className="space-y-3 rounded-xl bg-gray-50 p-4">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={60}
              placeholder="咨询主题（如：订单发货进度、退换货问题）"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            />
            <div className="flex gap-2">
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as TicketCategory)}
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary"
              >
                {TICKET_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
                ))}
              </select>
              <input
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
                placeholder="关联订单号（售后选填）"
                className="flex-[2] rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </div>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              maxLength={2000}
              rows={4}
              placeholder="请描述您的问题，我们会尽快回复您"
              className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            />
            {formError && <p className="text-xs text-red-600">{formError}</p>}
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? "提交中..." : "提交咨询"}
            </button>
          </section>
        )}

        {/* 工单列表 */}
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-xl bg-gray-100" />
            ))}
          </div>
        ) : error ? (
          <div className="py-16 text-center text-gray-400">
            <p className="text-lg">{error}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="py-16 text-center text-gray-400">
            <p className="text-lg">暂无咨询记录</p>
            <p className="mt-1 text-sm">遇到问题可发起咨询，客服会尽快回复您</p>
          </div>
        ) : (
          <div className="space-y-3">
            {items.map((t) => {
              const badge = STATUS_BADGE[t.status] ?? STATUS_BADGE.OPEN;
              return (
                <Link
                  key={t.id}
                  href={`/tickets/${t.id}`}
                  className="block rounded-xl border border-gray-100 p-4 transition hover:shadow-sm"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="min-w-0 truncate text-sm font-medium text-gray-900">
                      {t.title}
                    </p>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${badge.cls}`}>
                      {badge.label}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-gray-400">
                    <span>{CATEGORY_LABEL[t.category] ?? t.category}</span>
                    <span>·</span>
                    <span>{fmt(t.updatedAt)}</span>
                  </div>
                  {t.lastMessage && (
                    <p className="mt-2 truncate text-sm text-gray-500">
                      {isStaffMessage(t.lastMessage.senderRole) ? "客服：" : "我："}
                      {t.lastMessage.content}
                    </p>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

// ── 工单详情页（/tickets/[id]） ──

export function TicketDetailPage({ id }: { id: string }) {
  const [ticket, setTicket] = useState<TicketListResult["items"][number] | null>(null);
  const [messages, setMessages] = useState<TicketMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [replyError, setReplyError] = useState("");

  const fetchDetail = useCallback(async () => {
    try {
      const data = await apiCall("GET", `/api/tickets/${id}`);
      setTicket(data);
      setMessages(data.messages ?? []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "工单加载失败");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  const handleReply = async () => {
    const trimmed = reply.trim();
    if (!trimmed) { setReplyError("回复内容不能为空"); return; }
    setSending(true);
    setReplyError("");
    try {
      await apiCall("POST", `/api/tickets/${id}/messages`, { content: trimmed });
      setReply("");
      await fetchDetail();
    } catch (err: unknown) {
      setReplyError(err instanceof Error ? err.message : "回复失败");
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <main className="mx-auto min-h-screen max-w-6xl bg-white">
        <SiteHeader />
        <div className="mx-auto w-full max-w-3xl p-4">
          <div className="h-20 animate-pulse rounded-xl bg-gray-100" />
        </div>
      </main>
    );
  }

  if (!ticket) {
    return (
      <main className="mx-auto min-h-screen max-w-6xl bg-white">
        <SiteHeader />
        <div className="mx-auto w-full max-w-3xl py-20 text-center text-gray-400">
          {error || "工单不存在"}
        </div>
      </main>
    );
  }

  const badge = STATUS_BADGE[ticket.status] ?? STATUS_BADGE.OPEN;
  const closed = ticket.status === "CLOSED";

  return (
    <main className="mx-auto min-h-screen max-w-6xl bg-white pb-24">
      <SiteHeader />
      <div className="mx-auto w-full max-w-3xl p-4 space-y-4">
        <Link href="/tickets" className="inline-block text-sm text-gray-400 hover:text-gray-600">
          ‹ 返回我的咨询
        </Link>

        <section className="rounded-xl border border-gray-100 p-4">
          <div className="flex items-center justify-between gap-3">
            <h1 className="min-w-0 truncate text-base font-bold text-gray-900">{ticket.title}</h1>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${badge.cls}`}>
              {badge.label}
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-400">
            {CATEGORY_LABEL[ticket.category] ?? ticket.category}
            {ticket.orderId && ` · 关联订单 ${ticket.orderId}`}
            {ticket.userName && ` · ${ticket.userName}`}
          </p>
        </section>

        {/* 对话线程 */}
        <section className="space-y-3">
          {messages.map((m) => {
            const staff = isStaffMessage(m.senderRole);
            return (
              <div key={m.id} className={`flex ${staff ? "justify-start" : "justify-end"}`}>
                <div
                  className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${
                    staff ? "bg-gray-100 text-gray-800" : "bg-primary text-white"
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">{m.content}</p>
                  <p className={`mt-1 text-[10px] ${staff ? "text-gray-400" : "text-white/70"}`}>
                    {staff ? "客服" : "我"} · {fmt(m.createdAt)}
                  </p>
                </div>
              </div>
            );
          })}
        </section>

        {/* 回复框 */}
        {closed ? (
          <div className="rounded-xl bg-gray-50 px-4 py-3 text-center text-sm text-gray-400">
            该工单已关闭，如需继续咨询请发起新工单
          </div>
        ) : (
          <section className="space-y-2">
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              maxLength={2000}
              rows={3}
              placeholder="请输入回复内容"
              className="w-full resize-none rounded-xl border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            />
            {replyError && <p className="text-xs text-red-600">{replyError}</p>}
            <button
              onClick={handleReply}
              disabled={sending}
              className="w-full rounded-xl bg-primary py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
            >
              {sending ? "发送中..." : "发送"}
            </button>
          </section>
        )}
      </div>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────
// 客服工作台（/service，仅 CUSTOMER_SERVICE | SUPER 可达，中间件守卫）
// ─────────────────────────────────────────────────────────────

/** 各状态下可执行的客服操作（改状态按钮） */
const STATUS_ACTIONS: Record<string, { status: TicketStatus; label: string }[]> = {
  OPEN: [
    { status: "PROCESSING", label: "开始处理" },
    { status: "RESOLVED", label: "标记解决" },
    { status: "CLOSED", label: "关闭工单" },
  ],
  PROCESSING: [
    { status: "RESOLVED", label: "标记解决" },
    { status: "CLOSED", label: "关闭工单" },
  ],
  RESOLVED: [
    { status: "PROCESSING", label: "重开处理" },
    { status: "CLOSED", label: "关闭工单" },
  ],
  CLOSED: [
    { status: "OPEN", label: "重新打开" },
    { status: "PROCESSING", label: "重新处理" },
  ],
};

export function ServiceCenterPage() {
  const [tab, setTab] = useState<"tickets" | "orders">("tickets");

  return (
    <main className="mx-auto min-h-screen max-w-6xl bg-white pb-24">
      {/* 独立工作台头部：不带主站购物车等导航，工作台内只有主页面/个人中心/退出 */}
      <WorkbenchHeader title="客服中心" />
      <div className="mx-auto w-full max-w-5xl px-4 pt-4">
        <h1 className="text-center text-xl font-bold text-gray-900">客服中心</h1>
      </div>

      <div className="mx-auto w-full max-w-5xl px-4 pt-3">
        <div className="flex gap-1 rounded-xl bg-gray-100 p-1">
          {[
            { key: "tickets", label: "咨询工单" },
            { key: "orders", label: "订单售后" },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key as "tickets" | "orders")}
              className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
                tab === t.key
                  ? "bg-white text-primary shadow-sm"
                  : "text-gray-500 hover:text-gray-900"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mx-auto w-full max-w-5xl p-4">
        {/* 双 workbench 常驻挂载、仅切换显隐：loadedOnce 是组件级 ref，条件卸载会重置 →
            切 tab 时骨架闪烁 + 高度塌缩（用户反馈的抖动）；hidden 保留两份列表状态，切换零重载 */}
        <div className={tab === "tickets" ? "" : "hidden"}><TicketsWorkbench active={tab === "tickets"} /></div>
        <div className={tab === "orders" ? "" : "hidden"}><OrdersWorkbench active={tab === "orders"} /></div>
      </div>
    </main>
  );
}

// ── Tab1 咨询工单 ──

function TicketsWorkbench({ active }: { active?: boolean }) {
  const [items, setItems] = useState<TicketSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [keyword, setKeyword] = useState("");

  // 客户端过滤：首载一次拉全量，之后切状态/类别/关键词即时过滤，零网络往返、零延迟
  const loadedOnce = useRef(false);
  // 请求序号守卫：快速连点筛选时后发先回不覆盖错位数据
  const seqRef = useRef(0);

  // 详情视图（选中工单后替换列表）
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const fetchList = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    const seq = ++seqRef.current;
    try {
      // 筛选由客户端完成：一次拉全量（含 keyword/状态/类别在内存过滤）
      const data = await apiCall("GET", "/api/service/tickets?pageSize=100");
      if (seq !== seqRef.current) return;
      setItems(data.items ?? []);
    } catch {
      if (seq !== seqRef.current) return;
      /* 拉取失败静默，保留上次列表 */
    } finally {
      if (seq !== seqRef.current) return;
      loadedOnce.current = true;
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchList(); }, [fetchList]);
  // 切回本 Tab 时静默刷新（保数据新鲜，不重建骨架）
  useEffect(() => {
    if (active && loadedOnce.current) void fetchList();
  }, [active, fetchList]);

  // 客户端过滤：状态/类别精确匹配 + 关键词模糊匹配主题/工单号（与服务端 listAllTickets 同口径）
  const filteredItems = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return items.filter((t) => {
      if (statusFilter && t.status !== statusFilter) return false;
      if (categoryFilter && t.category !== categoryFilter) return false;
      if (kw && !t.title.toLowerCase().includes(kw) && !t.id.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [items, statusFilter, categoryFilter, keyword]);

  const openDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    setActionError("");
    setReply("");
    try {
      const data = await apiCall("GET", `/api/service/tickets/${id}`);
      setDetail(data);
      await fetchList(); // 打开即已读 → 刷新列表未读角标
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "工单加载失败");
      setSelectedId(null);
    } finally {
      setDetailLoading(false);
    }
  }, [fetchList]);

  const handleReply = async () => {
    const trimmed = reply.trim();
    if (!trimmed || !selectedId) { setActionError("回复内容不能为空"); return; }
    setBusy(true);
    setActionError("");
    try {
      await apiCall("POST", `/api/service/tickets/${selectedId}/messages`, { content: trimmed });
      setReply("");
      await openDetail(selectedId);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "回复失败");
    } finally {
      setBusy(false);
    }
  };

  const handleStatus = async (next: TicketStatus) => {
    if (!selectedId) return;
    setBusy(true);
    setActionError("");
    try {
      await apiCall("PATCH", `/api/service/tickets/${selectedId}`, { status: next });
      await openDetail(selectedId);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  // ── 详情视图 ──
  if (selectedId) {
    return (
      <div className="space-y-4">
        <button
          onClick={() => { setSelectedId(null); setDetail(null); fetchList(); }}
          className="inline-block text-sm text-gray-400 hover:text-gray-600"
        >
          ‹ 返回工单列表
        </button>

        {detailLoading || !detail ? (
          <div className="h-32 animate-pulse rounded-xl bg-gray-100" />
        ) : (
          <>
            <section className="rounded-xl border border-gray-100 p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="min-w-0 truncate text-base font-bold text-gray-900">{detail.title}</h2>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE[detail.status]?.cls ?? "bg-gray-100 text-gray-500"}`}>
                  {STATUS_BADGE[detail.status]?.label ?? detail.status}
                </span>
              </div>
              <p className="mt-1 text-xs text-gray-400">
                {CATEGORY_LABEL[detail.category] ?? detail.category}
                {detail.userName && ` · 提交人：${detail.userName}`}
                {detail.orderId && ` · 订单 ${detail.orderId}`}
                <span className="mx-1">·</span>
                提交于 {fmt(detail.createdAt)}
              </p>
            </section>

            {/* 对话线程 */}
            <section className="space-y-3">
              {detail.messages.map((m) => {
                const staff = isStaffMessage(m.senderRole);
                return (
                  <div key={m.id} className={`flex ${staff ? "justify-start" : "justify-end"}`}>
                    <div
                      className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${
                        staff ? "bg-gray-100 text-gray-800" : "bg-primary text-white"
                      }`}
                    >
                      <p className="whitespace-pre-wrap break-words">{m.content}</p>
                      <p className={`mt-1 text-[10px] ${staff ? "text-gray-400" : "text-white/70"}`}>
                        {staff ? "客服" : "客户"} · {fmt(m.createdAt)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </section>

            {actionError && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{actionError}</div>
            )}

            {/* 状态操作 + 回复 */}
            <section className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {(STATUS_ACTIONS[detail.status] ?? []).map((a) => (
                  <button
                    key={a.status}
                    onClick={() => handleStatus(a.status)}
                    disabled={busy}
                    className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
                  >
                    {a.label}
                  </button>
                ))}
              </div>
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                maxLength={2000}
                rows={3}
                placeholder="回复客户..."
                className="w-full resize-none rounded-xl border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              />
              <button
                onClick={handleReply}
                disabled={busy}
                className="w-full rounded-xl bg-primary py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "提交中..." : "回复客户"}
              </button>
            </section>
          </>
        )}
      </div>
    );
  }

  // ── 列表视图 ──
  return (
    <div className="space-y-3">
      {/* 筛选栏 */}
      <div className="flex flex-wrap gap-2">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary"
        >
          <option value="">全部状态</option>
          {Object.entries(STATUS_BADGE).map(([key, v]) => (
            <option key={key} value={key}>{v.label}</option>
          ))}
        </select>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary"
        >
          <option value="">全部类别</option>
          {TICKET_CATEGORIES.map((c) => (
            <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
          ))}
        </select>
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索主题或工单号"
          className="flex-1 min-w-[160px] rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary"
        />
      </div>

      {/* 列表固定高度 + 内部滚动：切筛选/类别/关键词时页面永不重排 → 消除高度塌缩抖动 */}
      <div className="h-[calc(100vh-14rem)] overflow-y-auto rounded-xl">
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-gray-100" />
          ))}
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="flex min-h-[40vh] items-center justify-center text-center text-gray-400">
          暂无匹配工单
        </div>
      ) : (
        <div className="space-y-3">
          {filteredItems.map((t) => {
          const badge = STATUS_BADGE[t.status] ?? STATUS_BADGE.OPEN;
          return (
            <button
              key={t.id}
              onClick={() => openDetail(t.id)}
              className="block w-full rounded-xl border border-gray-100 p-4 text-left transition hover:shadow-sm"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="flex min-w-0 items-center gap-2">
                  {t.unreadCount > 0 && (
                    <span className="shrink-0 rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      {t.unreadCount}
                    </span>
                  )}
                  <span className="truncate text-sm font-medium text-gray-900">{t.title}</span>
                </p>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${badge.cls}`}>
                  {badge.label}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs text-gray-400">
                <span>{t.userName || "匿名用户"}</span>
                <span>·</span>
                <span>{CATEGORY_LABEL[t.category] ?? t.category}</span>
                <span>·</span>
                <span>{fmt(t.updatedAt)}</span>
              </div>
              {t.lastMessage && (
                <p className="mt-2 truncate text-sm text-gray-500">
                  {isStaffMessage(t.lastMessage.senderRole) ? "客服：" : "客户："}
                  {t.lastMessage.content}
                </p>
              )}
            </button>
          );
          })}
        </div>
      )}
      </div>
    </div>
  );
}

// ── Tab2 订单售后（复用 /api/admin/orders + 发货/送达/完成/退款） ──

/** 售后动作 → 目标状态：动作成功后本地更新订单状态，避免整表重拉（保持零抖动切换） */
const ACTION_STATUS: Record<string, string> = {
  ship: "SHIPPED",
  deliver: "DELIVERED",
  complete: "COMPLETED",
  "refund-confirm": "REFUNDED",
};

interface ServiceOrder {
  id: string;
  buyerNickname: string | null;
  recipient: { name: string; phone: string; city: string } | null;
  total: number;
  status: string;
  createdAt: string;
  firstItemName: string;
  itemCount: number;
  isDestroyed: boolean;
}

function OrdersWorkbench({ active }: { active?: boolean }) {
  const [orders, setOrders] = useState<ServiceOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  // 客户端过滤：首载一次拉全量，之后切状态药丸即时过滤，零网络往返、零延迟
  const loadedOnce = useRef(false);
  // 请求序号守卫：快速连点药丸时后发先回不覆盖错位数据
  const seqRef = useRef(0);

  const fetchOrders = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    const seq = ++seqRef.current;
    try {
      // 筛选由客户端完成：一次拉全量（含 TO_SHIP=PAID+SHIPPED 合并口径在客户端重算）
      const data = await apiCall("GET", "/api/admin/orders?pageSize=100");
      if (seq !== seqRef.current) return;
      setOrders(data.orders || []);
    } catch (err: unknown) {
      if (seq !== seqRef.current) return;
      setError(err instanceof Error ? err.message : "订单加载失败");
    } finally {
      if (seq !== seqRef.current) return;
      loadedOnce.current = true;
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);
  // 切回本 Tab 时静默刷新（保数据新鲜，不重建骨架）
  useEffect(() => {
    if (active && loadedOnce.current) void fetchOrders();
  }, [active, fetchOrders]);

  // 客户端过滤：TO_SHIP = PAID + SHIPPED（与服务端 getAdminOrders 同口径），其余精确匹配
  const filteredOrders = useMemo(() => {
    if (!statusFilter) return orders;
    if (statusFilter === "TO_SHIP") return orders.filter((o) => o.status === "PAID" || o.status === "SHIPPED");
    return orders.filter((o) => o.status === statusFilter);
  }, [orders, statusFilter]);

  // 动作成功 → 本地更新订单状态（发货/送达/完成/退款），列表即时重算，无需重拉全量
  const applyStatus = (orderId: string, next: string) => {
    setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, status: next } : o)));
  };

  const handleAction = async (orderId: string, action: string) => {
    setActing(orderId);
    setError("");
    const next = ACTION_STATUS[action];
    try {
      await apiCall("POST", `/api/admin/orders/${orderId}/${action}`);
      if (next) applyStatus(orderId, next);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setActing(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {["", "TO_SHIP", "PENDING", "PAID", "SHIPPED", "DELIVERED", "REFUND_REQUESTED", "REFUNDED", "COMPLETED", "CANCELLED"].map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`shrink-0 rounded-full px-4 py-2 text-sm transition ${
              statusFilter === s
                ? "bg-primary text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {STATUS_LABEL[s] || "全部"}
          </button>
        ))}
      </div>
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
      {/* 列表固定高度 + 内部滚动：切状态药丸时页面永不重排 → 消除高度塌缩抖动 */}
      <div className="h-[calc(100vh-14rem)] overflow-y-auto rounded-xl">
      {loading ? (
        <div className="h-32 animate-pulse rounded-xl bg-gray-100" />
      ) : filteredOrders.length === 0 ? (
        <div className="flex min-h-[40vh] items-center justify-center text-center text-gray-400">
          {statusFilter ? "该状态下暂无订单" : "暂无订单"}
        </div>
      ) : (
        <div className="space-y-3">
          {filteredOrders.map((o) => (
          <div key={o.id} className="rounded-2xl border border-gray-100 p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-base font-semibold text-gray-900">
                  {o.firstItemName}
                  {o.itemCount > 1 && (
                    <span className="ml-1.5 text-sm font-normal text-gray-400">
                      等 {o.itemCount} 件
                    </span>
                  )}
                </p>
                <p className="mt-1 text-sm text-gray-400">
                  <StatusBadge status={o.status} /> · ¥{fenToYuan(o.total)}
                  {o.isDestroyed && <span className="ml-1 text-red-400">已销毁</span>}
                </p>
              </div>
              <div className="shrink-0 text-right text-sm text-gray-400">
                <p>{fmt(o.createdAt)}</p>
                <p className="mt-0.5 truncate font-mono text-xs">{o.id}</p>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-gray-50 pt-2 text-sm text-gray-500">
              <span>买家：{o.buyerNickname || "—"}</span>
              {o.recipient && (
                <>
                  <span>收货人：{o.recipient.name}</span>
                  <span>{o.recipient.phone}</span>
                  {o.recipient.city && <span>{o.recipient.city}</span>}
                </>
              )}
            </div>
            <div className="mt-3 flex min-h-[40px] flex-wrap items-center gap-2">
              {o.status === "PAID" && (
                <button
                  onClick={() => handleAction(o.id, "ship")}
                  disabled={acting === o.id}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  发货
                </button>
              )}
              {o.status === "SHIPPED" && (
                <button
                  onClick={() => handleAction(o.id, "deliver")}
                  disabled={acting === o.id}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  标记送达
                </button>
              )}
              {o.status === "DELIVERED" && (
                <button
                  onClick={() => handleAction(o.id, "complete")}
                  disabled={acting === o.id}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  完成
                </button>
              )}
              {o.status === "REFUND_REQUESTED" && (
                <button
                  onClick={() => handleAction(o.id, "refund-confirm")}
                  disabled={acting === o.id}
                  className="rounded-lg border border-orange-200 px-4 py-2 text-sm font-medium text-orange-600 transition hover:bg-orange-50 disabled:opacity-50"
                >
                  确认退款
                </button>
              )}
            </div>
          </div>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
