// Domain entity for billing.users: a login identity, exactly one per subscriber.

// A row from the login query (users joined with subscribers).
export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  subscriber_no: string;
}

export class User {
  constructor(
    readonly id: number,
    readonly username: string,
    readonly passwordHash: string,
    readonly subscriberNo: string,
  ) {}

  static fromRow(row: UserRow): User {
    return new User(Number(row.id), row.username, row.password_hash, row.subscriber_no);
  }
}
