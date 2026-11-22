// The agent's way to the billing REST API (through the API Gateway once deployed: the
// base URL is all that changes). Plain HTTP + the subscriber's own JWT; the agent never
// sees the signing key, and the API checks the token on every call.

const RETRY_STATUSES = new Set([502, 503, 504]);

export interface ApiResponse {
  status: number;
  body: unknown;
}

export class BillingApiClient {
  constructor(
    private readonly baseUrl: string, // e.g. http://127.0.0.1:3000/api/v1
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly retryDelayMs = 300,
  ) {}

  async login(username: string, password: string): Promise<ApiResponse> {
    return this.call("POST", "/login", undefined, { username, password });
  }

  // One retry when the request fails on the way (network error, timeout, or the gateway's
  // 502/503/504): the first attempt may or may not have reached the API. Safe for every call
  // the agent makes: GET and PUT (Calculate Bill) are idempotent, login changes nothing, and
  // Pay Bill sends the same transactionId again, so the API replays the first payment
  // instead of making a second one (guide §5.3).
  async call(method: "GET" | "PUT" | "POST", path: string, token?: string, body?: unknown): Promise<ApiResponse> {
    try {
      const first = await this.send(method, path, token, body);
      if (!RETRY_STATUSES.has(first.status)) return first;
    } catch {
      // fall through to the retry
    }
    await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
    return this.send(method, path, token, body);
  }

  private async send(method: string, path: string, token: string | undefined, body: unknown): Promise<ApiResponse> {
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(10_000) };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await this.fetchImpl(this.baseUrl + path, init);
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep the raw text (e.g. a gateway's HTML error page)
    }
    return { status: res.status, body: parsed };
  }
}
