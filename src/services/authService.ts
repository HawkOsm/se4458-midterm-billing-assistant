// Login business logic (the teacher's Authenticate()), with hashed passwords from the DB.
import type { Db } from "../db/db";
import * as userDbContext from "../db/userDbContext";
import { DUMMY_HASH, verifyPassword } from "./passwordHasher";
import { issueToken, type IssuedToken } from "./tokenService";

export class AuthService {
  constructor(private readonly db: Db) {}

  // A token for valid credentials, or null. Callers can't tell an unknown username from
  // a wrong password: same result, same work (see DUMMY_HASH).
  async login(username: string, password: string): Promise<IssuedToken | null> {
    const user = await userDbContext.findUserByUsername(this.db, username);
    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) return null;
    return issueToken(user.identity);
  }
}
