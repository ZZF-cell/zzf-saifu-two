import { Suspense } from "react";
import { OrderListPage } from "@/features/orders";

// OrderListPage 使用 useSearchParams（?status= Tab 同步），Next 15 要求外层 Suspense
export default function OrdersPage() {
  return (
    <Suspense fallback={<div className="p-4 text-center text-gray-400">加载中…</div>}>
      <OrderListPage />
    </Suspense>
  );
}
