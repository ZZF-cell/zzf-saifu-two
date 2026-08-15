import { CheckoutPage } from "@/features/orders/orders.routes";

// server 组件读 searchParams 传 prop，避免客户端 useSearchParams 的 Suspense 要求；
// ?items= 由购物车勾选去结算携带（逗号分隔的 productId 列表），部分结算过滤依据
export default async function CheckoutPageWrapper({
  searchParams,
}: {
  searchParams: Promise<{ items?: string }>;
}) {
  const { items } = await searchParams;
  return <CheckoutPage initialItems={items ?? ""} />;
}
