import { call } from "mygo-runtime";
import type { Identity, Space } from "@/api/hub.gen";

export interface Account {
  hub: Identity;
  origin?: string;
  spaces: Space[];
  userId: string;
  deviceId: string;
  sessionId: string;
}
export interface Transport {
  kind: "web" | "host" | "mobile";
  request<T>(path: string, method?: string, body?: unknown): Promise<T>;
}
export const browserTransport: Transport = {
  kind: "web",
  async request<T>(path: string, method = "GET", body?: unknown) {
    const r = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok)
      throw new Error(
        r.status === 401 ? "请登录 Hub" : (await r.text()).trim(),
      );
    return (await r.json()) as T;
  },
};
export const mobileTransport: Transport = {
  kind: "mobile",
  async request<T>(path: string, method = "GET", body?: unknown) {
    const result = await call<string>(
      "Mobile.Request",
      method,
      path,
      body === undefined ? "" : JSON.stringify(body),
    );
    return JSON.parse(result) as T;
  },
};
export function pairPhone(link: string) {
  return call("Mobile.Pair", link);
}
export function deviceLink(origin: string, code: string) {
  const q = new URLSearchParams({ hub: origin, code });
  return "leverdevice://pair?" + q;
}
export function readLocal<T>(key: string, initial: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : initial;
  } catch {
    return initial;
  }
}
export function saveLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage can be full or unavailable in private mode. */
  }
}
export function clearSaved(hub: string, user: string) {
  const prefix = `lever:hub:${hub}:${user}:`;
  for (const key of Object.keys(localStorage))
    if (key.startsWith(prefix)) localStorage.removeItem(key);
}
