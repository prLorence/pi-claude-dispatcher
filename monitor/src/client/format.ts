import type { LaneState } from "../shared/types";

function whole(value: number): string {
  return String(Math.round(value));
}

function trimmed(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

export function formatElapsed(s: number | null): string {
  if (s === null) return "-";
  const total = Math.max(0, Math.floor(s));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h ${String(rest).padStart(2, "0")}m`;
}

export function formatCost(n: number | null): string {
  if (n === null) return "-";
  if (n === 0) return "free";
  return `$${n.toFixed(4)}`;
}

export function formatTokens(n: number | null): string {
  if (n === null) return "-";
  if (n < 1000) return whole(n);
  if (n < 1_000_000) return `${trimmed(n / 1000)}k`;
  return `${trimmed(n / 1_000_000)}M`;
}

export function stateLabel(s: LaneState): string {
  return s;
}

export function formatClock(iso: string | null): string {
  if (iso === null) return "-";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatAgo(iso: string | null, nowIso: string | null): string {
  if (iso === null) return "-";
  const at = Date.parse(iso);
  const now = nowIso === null ? Date.now() : Date.parse(nowIso);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return "-";
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
