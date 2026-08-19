"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  TicketCategory,
  TicketListResult,
  TicketMessage,
} from "./service.types";
import { TICKET_CATEGORIES } from "./service.types";
import { apiFetch } from "@/shared/api/client";
import { SiteHeader } from "@/shared/ui/SiteHeader";

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
