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

// What one unit of usage records (guide §2.3, §3.3): 10 phone minutes or 1 MB.
export const UNIT_AMOUNT: Record<UsageType, number> = { PHONE: 10, INTERNET: 1 };

// One Add Usage call may report several units at once (an extension of the spec, which
// defines one unit per call; the default stays 1). Without it, 50 MB/s needs 50 calls
// per second per subscriber; see docs/data-model.md "Scaling".
export const MAX_QUANTITY = 10_000;

// A stored event together with the period it belongs to (what Add Usage compares a
// retried request against).
export interface RecordedUsage {
  event: UsageEvent;
  year: number;
  month: number;
  quantity: number;
}
