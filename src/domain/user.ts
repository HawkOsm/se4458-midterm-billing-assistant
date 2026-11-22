// Domain entity for billing.users: a login identity.
// SUBSCRIBER logins belong to exactly one subscriber; ADMIN logins (the provider's
// operator or billing system) belong to none (migration 006).

export const ROLES = ["SUBSCRIBER", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

// Who a request acts as, carried inside the JWT.
export type AuthIdentity =
  | { role: "SUBSCRIBER"; subscriberNo: string }
  | { role: "ADMIN"; username: string };

// A row from the login query (users LEFT JOIN subscribers: admins have no subscriber).
export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: Role;
  subscriber_no: string | null;
}

export class User {
  constructor(
    readonly id: number,
    readonly username: string,
    readonly passwordHash: string,
    readonly identity: AuthIdentity,
  ) {}

  static fromRow(row: UserRow): User {
    const identity: AuthIdentity =
      row.role === "ADMIN"
        ? { role: "ADMIN", username: row.username }
        : { role: "SUBSCRIBER", subscriberNo: row.subscriber_no ?? "" };
    return new User(Number(row.id), row.username, row.password_hash, identity);
  }
}
