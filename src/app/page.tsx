export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 text-center">
      <h1 className="text-3xl font-bold tracking-tight">赛夫严选</h1>
      <p className="mt-3 text-lg text-gray-500">
        成人用品品牌聚合严选电商平台
      </p>
      <p className="mt-2 text-sm text-gray-400">隐私配送 · 正品保障</p>

      <div className="mt-10 grid gap-4 sm:grid-cols-3">
        <a
          href="/products"
          className="rounded-xl border p-6 text-left transition hover:border-primary hover:shadow-sm"
        >
          <h3 className="font-semibold">浏览商品 →</h3>
          <p className="mt-1 text-sm text-gray-500">
            发现严选好物，按品类筛选
          </p>
        </a>
        <a
          href="/cart"
          className="rounded-xl border p-6 text-left transition hover:border-primary hover:shadow-sm"
        >
          <h3 className="font-semibold">购物车 →</h3>
          <p className="mt-1 text-sm text-gray-500">查看已选商品，开始结算</p>
        </a>
        <a
          href="/orders"
          className="rounded-xl border p-6 text-left transition hover:border-primary hover:shadow-sm"
        >
          <h3 className="font-semibold">我的订单 →</h3>
          <p className="mt-1 text-sm text-gray-500">
            追踪物流，管理售后
          </p>
        </a>
      </div>
    </main>
  );
}
