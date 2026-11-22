// Domain entity for billing.usage_events: one row per Add Usage call.

export const USAGE_TYPES = ["PHONE", "INTERNET"] as const;
export type UsageType = (typeof USAGE_TYPES)[number];

export interface UsageEventRow {
  id: string;
  usage_type: UsageType;
  amount: number;
  created_at: Date;
}

export class UsageEvent {
  constructor(
    readonly id: number,
    readonly type: UsageType,
    readonly amount: number, // minutes for PHONE, MB for INTERNET
    readonly recordedAt: Date,
  ) {}

  static fromRow(row: UsageEventRow): UsageEvent {
    return new UsageEvent(Number(row.id), row.usage_type, row.amount, row.created_at);
  }

  get unit(): "minutes" | "MB" {
    return this.type === "PHONE" ? "minutes" : "MB";
  }
}

// One page of a longer list (offset pagination, course slides 40–42).
export interface Page<T> {
  items: T[];
  offset: number;
  limit: number;
  total: number;
}
