export type DatePreset = "today" | "week" | "month" | "last24h" | "last7" | "last30" | "custom";

export function presetRange(preset: DatePreset, now = new Date()): [Date, Date] | null {
  if (preset === "custom") return null;
  const end = new Date(now);
  if (preset === "today") return [startOfDay(now), end];
  if (preset === "week") {
    const start = startOfDay(now); const weekday = start.getDay() || 7;
    start.setDate(start.getDate() - weekday + 1); return [start, end];
  }
  if (preset === "month") return [new Date(now.getFullYear(), now.getMonth(), 1), end];
  const hours = preset === "last24h" ? 24 : preset === "last7" ? 7 * 24 : 30 * 24;
  return [new Date(now.getTime() - hours * 60 * 60 * 1000), end];
}

function startOfDay(value: Date): Date { const result = new Date(value); result.setHours(0, 0, 0, 0); return result; }
function endOfDay(value: Date): Date { const result = new Date(value); result.setHours(23, 59, 59, 999); return result; }
