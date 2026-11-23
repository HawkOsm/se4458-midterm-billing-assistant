// Slows down password guessing: after 3 wrong passwords in a row for a username, logins for
// that username are refused for 30 seconds; after that there are 3 new tries.
// Counted per username (not per IP: behind the gateway every caller has the gateway's
// address), for unknown usernames too, so the answer doesn't reveal which names exist.
// Kept in memory, which is enough for the one API task the demo runs; a restart forgets it.
// Trade-off: someone can keep another user's login blocked by guessing wrong on purpose.
export const MAX_FAILED_LOGINS = 3;
export const LOGIN_LOCK_SECONDS = 30;
const MAX_TRACKED_USERNAMES = 10_000;

export class LoginLimiter {
  private readonly entries = new Map<string, { failures: number; lockedUntil: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  // Seconds until this username may try again; 0 when it isn't locked.
  retryAfterSeconds(username: string): number {
    const entry = this.entries.get(key(username));
    if (!entry || entry.lockedUntil === 0) return 0;
    const left = entry.lockedUntil - this.now();
    if (left > 0) return Math.ceil(left / 1000);
    this.entries.delete(key(username)); // the lock is over: 3 new tries
    return 0;
  }

  recordFailure(username: string): void {
    const entry = this.entries.get(key(username)) ?? { failures: 0, lockedUntil: 0 };
    entry.failures++;
    if (entry.failures >= MAX_FAILED_LOGINS) entry.lockedUntil = this.now() + LOGIN_LOCK_SECONDS * 1000;
    if (this.entries.size >= MAX_TRACKED_USERNAMES) this.entries.clear(); // never grows without limit
    this.entries.set(key(username), entry);
  }

  recordSuccess(username: string): void {
    this.entries.delete(key(username));
  }
}

// The same username in any case is one account (logins match case-insensitively).
function key(username: string): string {
  return username.trim().toLowerCase();
}
