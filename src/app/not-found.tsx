import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 text-center">
      <h1 className="text-6xl font-bold text-gray-200">404</h1>
      <p className="mt-4 text-lg text-gray-500">页面不存在</p>
      <Link
        href="/"
        className="mt-6 rounded-lg bg-primary px-6 py-2 text-white transition hover:opacity-90"
      >
        返回首页
      </Link>
    </main>
  );
}
