export function count(value: unknown): string { return typeof value === "number" ? new Intl.NumberFormat("zh-CN").format(value) : "暂无数据"; }
export function percent(value: unknown): string { return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "暂无数据"; }
export function duration(value: unknown): string {
  if (typeof value !== "number") return "暂无数据";
  if (value < 1000) return `${value.toFixed(0)} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)} 秒`;
  return `${(value / 60000).toFixed(1)} 分钟`;
}
export function bytes(value: unknown): string {
  if (typeof value !== "number") return "暂无数据";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}
export function datetime(value: unknown): string { return typeof value === "string" ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "暂无数据"; }
export function shortId(value: string): string { return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value; }
export function errorText(error: unknown): string { return error instanceof Error ? error.message : "请求失败"; }
