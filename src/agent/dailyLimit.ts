// A spending cap for the hosted demo. The demo logins are public, so without a limit anyone
// could run up the Claude bill. Every message and every confirmation (both call Claude)
// takes one unit: up to `perUser` a day per subscriber and `total` a day for everyone.
// Kept in memory, which is enough for the one agent task the demo runs; it restarts at
// 00:00 UTC (and when the task restarts, which only ever makes it more generous once).
export class DailyLimit {
  private day = "";
  private total = 0;
  private readonly perSubscriber = new Map<string, number>();

  constructor(
    private readonly limits: { perUser: number; total: number },
    private readonly now: () => Date = () => new Date(),
  ) {}

  // Takes one unit for `subscriberNo`, or returns why it can't (nothing is taken then).
  take(subscriberNo: string): { ok: true } | { ok: false; reason: string } {
    const today = this.now().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.total = 0;
      this.perSubscriber.clear();
    }
    const used = this.perSubscriber.get(subscriberNo) ?? 0;
    if (used >= this.limits.perUser) {
      return { ok: false, reason: `Daily limit reached (${this.limits.perUser} messages per subscriber). Please try again tomorrow.` };
    }
    if (this.total >= this.limits.total) {
      return { ok: false, reason: "The assistant has reached its daily limit for everyone. Please try again tomorrow." };
    }
    this.perSubscriber.set(subscriberNo, used + 1);
    this.total++;
    return { ok: true };
  }
}
