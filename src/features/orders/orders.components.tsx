"use client";

import Link from "next/link";
import { fenToYuan } from "@/shared/utils/money";

// ── 状态标签 ──

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  PENDING: { label: "待支付", color: "text-yellow-600 bg-yellow-50" },
  PAID: { label: "已支付", color: "text-blue-600 bg-blue-50" },
  SHIPPED: { label: "已发货", color: "text-indigo-600 bg-indigo-50" },
  DELIVERED: { label: "已送达", color: "text-green-600 bg-green-50" },
  COMPLETED: { label: "已完成", color: "text-gray-600 bg-gray-100" },
  CANCELLED: { label: "已取消", color: "text-gray-500 bg-gray-100" },
  REFUND_REQUESTED: { label: "退款中", color: "text-orange-600 bg-orange-50" },
  REFUNDED: { label: "已退款", color: "text-green-600 bg-green-50" },
};

export function OrderStatusBadge({ status }: { status: string }) {
  const s = STATUS_LABELS[status] || { label: status, color: "text-gray-500" };
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${s.color}`}>
      {s.label}
    </span>
  );
}

// ── 订单卡片（列表用） ──

interface OrderCardProps {
  id: string;
  total: number;
  status: string;
  firstItemName: string;
  createdAt: Date;
  isDestroyed: boolean;
}

export function OrderCard({ id, total, status, firstItemName, createdAt, isDestroyed }: OrderCardProps) {
  return (
    <Link
      href={`/orders/${id}`}
      className="block rounded-xl border border-gray-100 p-4 transition hover:shadow-sm"
    >
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">
            {isDestroyed ? "已销毁的订单" : firstItemName}
          </p>
          <p className="mt-0.5 text-xs text-gray-400">
            {new Date(createdAt).toLocaleDateString("zh-CN")}
          </p>
        </div>
        <div className="ml-3 flex flex-col items-end gap-1.5">
          <OrderStatusBadge status={status} />
          <span className="text-sm font-bold text-primary">
            ¥{fenToYuan(total)}
          </span>
        </div>
      </div>
    </Link>
  );
}

// ── 状态时间线 ──

interface TimelineEvent {
  label: string;
  date: Date | null;
  active: boolean;
}

export function OrderTimeline({ events }: { events: TimelineEvent[] }) {
  return (
    <div className="space-y-0">
      {events.map((e, i) => (
        <div key={i} className="flex gap-3">
          <div className="flex flex-col items-center">
            <div
              className={`h-2.5 w-2.5 rounded-full mt-1.5 ${
                e.active ? "bg-primary" : "bg-gray-200"
              }`}
            />
            {i < events.length - 1 && (
              <div
                className={`w-0.5 flex-1 ${
                  e.active && events[i + 1]?.active ? "bg-primary/30" : "bg-gray-100"
                }`}
              />
            )}
          </div>
          <div className="pb-4">
            <p className={`text-sm ${e.active ? "font-medium text-gray-900" : "text-gray-400"}`}>
              {e.label}
            </p>
            {e.date && (
              <p className="text-xs text-gray-400">
                {new Date(e.date).toLocaleString("zh-CN")}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── 收货地址表单 ──

interface AddressFormProps {
  value: {
    name: string;
    phone: string;
    province: string;
    city: string;
    district: string;
    detail: string;
    zipCode?: string;
  };
  onChange: (addr: AddressFormProps["value"]) => void;
}

export function AddressForm({ value, onChange }: AddressFormProps) {
  const field = (key: string, placeholder: string, span = "col-span-1") => (
    <input
      key={key}
      type="text"
      value={(value as Record<string, string | undefined>)[key] || ""}
      onChange={(e) => onChange({ ...value, [key]: e.target.value })}
      placeholder={placeholder}
      className={`${span} rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary`}
    />
  );

  return (
    <div className="grid grid-cols-2 gap-3">
      {field("name", "收货人姓名")}
      {field("phone", "手机号")}
      {field("province", "省份")}
      {field("city", "城市")}
      {field("district", "区/县")}
      {field("detail", "详细地址", "col-span-2")}
      {field("zipCode", "邮政编码（选填）", "col-span-2")}
    </div>
  );
}
