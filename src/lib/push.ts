/**
 * Web Push on this device: turn notifications on, check status, send a test.
 * On iPhone this only works in the app opened from its Home Screen icon.
 */
const FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/push`;
const HEADERS = { Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`, "Content-Type": "application/json" };

async function callPush<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(FUNCTION_URL, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

export interface PushSupport {
  /** The browser can do Web Push at all. */
  supported: boolean;
  /** Opened from the Home Screen icon (required on iPhone). */
  standalone: boolean;
  isIos: boolean;
  permission: NotificationPermission | "unsupported";
}

export function pushSupport(): PushSupport {
  const supported = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const nav = navigator as Navigator & { standalone?: boolean };
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || nav.standalone === true;
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return { supported, standalone, isIos, permission: supported ? Notification.permission : "unsupported" };
}

/** Register the service worker (safe to call on every launch). */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

function keyBytes(base64url: string): Uint8Array {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const b64 = (base64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/**
 * Turn notifications on for this device. Call straight from a tap: iPhone only
 * shows the permission prompt in response to one.
 */
export async function enablePush(): Promise<void> {
  const support = pushSupport();
  if (!support.supported) {
    throw new Error(support.isIos && !support.standalone ? "Open Smart Scheduler from its Home Screen icon first — Safari tabs can't get notifications." : "This browser can't receive notifications.");
  }
  // Ask first, while we're still inside the tap.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? "Notifications are blocked — allow them in Settings → Notifications → Scheduler." : "Notifications weren't allowed.");
  const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
  await navigator.serviceWorker.ready;
  const { publicKey } = await callPush<{ publicKey: string }>({ action: "config" });
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource });
  await callPush({ action: "subscribe", subscription: sub.toJSON(), userAgent: navigator.userAgent });
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (sub) {
    await callPush({ action: "unsubscribe", endpoint: sub.endpoint }).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  }
}

export interface PushStatus {
  devices: number;
  thisDevice: boolean;
  lastSuccess: string | null;
  lastError: string | null;
}

export async function pushStatus(): Promise<PushStatus> {
  const sub = await currentSubscription().catch(() => null);
  return callPush<PushStatus>({ action: "status", endpoint: sub?.endpoint ?? null });
}

export async function sendTestPush(): Promise<{ device: string; result: string }[]> {
  const { results } = await callPush<{ results: { device: string; result: string }[] }>({ action: "test" });
  return results;
}
