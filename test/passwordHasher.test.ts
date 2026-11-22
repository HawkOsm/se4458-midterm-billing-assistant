import assert from "node:assert/strict";
import { test } from "node:test";
import { DUMMY_HASH, hashPassword, verifyPassword } from "../src/services/passwordHasher";

test("a hashed password verifies, a different one does not", async () => {
  const stored = await hashPassword("s3cret!");

  assert.equal(await verifyPassword("s3cret!", stored), true);
  assert.equal(await verifyPassword("s3cret", stored), false);
});

test("the same password hashes differently each time (random salt)", async () => {
  assert.notEqual(await hashPassword("same"), await hashPassword("same"));
});

test("malformed stored values never verify", async () => {
  for (const bad of ["", "plaintext", "bcrypt$1$2$3$a$b", "scrypt$16384$8$5$salt"]) {
    assert.equal(await verifyPassword("anything", bad), false);
  }
});

test("nothing verifies against the dummy hash used for unknown users", async () => {
  assert.equal(await verifyPassword("", DUMMY_HASH), false);
  assert.equal(await verifyPassword("password", DUMMY_HASH), false);
});
