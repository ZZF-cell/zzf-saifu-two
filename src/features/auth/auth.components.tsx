"use client";

import { useState, useTransition, useEffect, useRef } from "react";

// ── 验证码输入 ──

interface CodeInputProps {
  value: string;
  onChange: (code: string) => void;
}

export function CodeInput({ value, onChange }: CodeInputProps) {
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-gray-700">验证码</label>
      <input
        type="text"
        maxLength={6}
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
        placeholder="请输入 6 位验证码"
        className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
      />
    </div>
  );
}

// ── 密码输入 ──

interface PasswordInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function PasswordInput({ value, onChange, placeholder = "请输入密码" }: PasswordInputProps) {
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-gray-700">密码</label>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
      />
    </div>
  );
}

// ── 验证码登录/注册表单 ──

interface CodeLoginFormProps {
  onSubmit: (phone: string, code: string) => Promise<void>;
  onSendCode: (phone: string) => Promise<void>;
  submitLabel?: string;
}

export function CodeLoginForm({ onSubmit, onSendCode, submitLabel = "登录 / 注册" }: CodeLoginFormProps) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 组件卸载时清理 setInterval
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const handleSend = () => {
    if (!/^1[3-9]\d{9}$/.test(phone)) return;
    startTransition(async () => {
      try {
        await onSendCode(phone);
        setCountdown(60);
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(() => {
          setCountdown((c) => {
            if (c <= 1) {
              if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
              return 0;
            }
            return c - 1;
          });
        }, 1000);
        setError("");
      } catch {
        setError("发送验证码失败，请稍后重试");
      }
    });
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (code.length !== 6) return;
    startTransition(async () => {
      try {
        setError("");
        await onSubmit(phone, code);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "登录失败";
        setError(msg);
      }
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700">手机号</label>
        <div className="flex gap-2">
          <input
            type="tel"
            maxLength={11}
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
            placeholder="请输入手机号"
            className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={countdown > 0 || isPending || phone.length !== 11}
            className="whitespace-nowrap rounded-lg bg-primary px-4 py-2 text-sm text-white transition disabled:opacity-50"
          >
            {countdown > 0 ? `${countdown}s` : "获取验证码"}
          </button>
        </div>
      </div>

      <CodeInput value={code} onChange={setCode} />

      {error && <p className="text-sm text-red-500">{error}</p>}

      <button
        type="submit"
        disabled={code.length !== 6 || isPending}
        className="w-full rounded-lg bg-primary py-2.5 text-sm font-medium text-white transition disabled:opacity-50"
      >
        {isPending ? "处理中..." : submitLabel}
      </button>
    </form>
  );
}

// ── 密码登录表单 ──

interface PasswordLoginFormProps {
  onSubmit: (phone: string, password: string) => Promise<void>;
}

export function PasswordLoginForm({ onSubmit }: PasswordLoginFormProps) {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState("");

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    startTransition(async () => {
      try {
        setError("");
        await onSubmit(phone, password);
        // 重定向由父组件负责（保持一致）
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "登录失败";
        setError(msg);
      }
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700">手机号</label>
        <input
          type="tel"
          maxLength={11}
          value={phone}
          onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
          placeholder="请输入手机号"
          className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
        />
      </div>

      <PasswordInput value={password} onChange={setPassword} />

      {error && <p className="text-sm text-red-500">{error}</p>}

      <button
        type="submit"
        disabled={phone.length !== 11 || password.length < 6 || isPending}
        className="w-full rounded-lg bg-primary py-2.5 text-sm font-medium text-white transition disabled:opacity-50"
      >
        {isPending ? "登录中..." : "密码登录"}
      </button>
    </form>
  );
}
