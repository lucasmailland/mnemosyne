export type CronSchedule =
  | { kind: "interval"; ms: number }
  | { kind: "dailyUtc"; hour: number; minute: number }
  | { kind: "weeklyUtc"; weekday: number; hour: number; minute: number };

export function msUntilNext(schedule: CronSchedule, from: Date = new Date()): number {
  if (schedule.kind === "interval") return schedule.ms;
  const now = from.getTime();
  if (schedule.kind === "dailyUtc") {
    const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), schedule.hour, schedule.minute, 0, 0));
    if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - now;
  }
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), schedule.hour, schedule.minute, 0, 0));
  const dayDelta = (schedule.weekday - next.getUTCDay() + 7) % 7;
  next.setUTCDate(next.getUTCDate() + dayDelta);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 7);
  return next.getTime() - now;
}
