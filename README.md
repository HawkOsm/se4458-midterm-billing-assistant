# Mobile Provider Billing Assistant

SE4458 Midterm, Group 2 (AI Billing Support Assistant). A billing REST API for a fictitious mobile
provider: the provider records usage and calculates monthly bills; subscribers log in to see their
bill, its breakdown and the month so far, and pay it.
It is the backend the AI agent will call through an API Gateway; the agent, the MCP documentation
server and the cloud deployment are the next parts (see [Not done yet](#not-done-yet)).
Built with TypeScript, Express and PostgreSQL.

- **Source code:** https://github.com/HawkOsm/se4458-midterm-billing-assistant
- **Swagger page (local):** http://localhost:3000/api-docs/ (raw spec: `/openapi.json`)
- **Data model, decisions and business rules:** [docs/data-model.md](docs/data-model.md)

Run locally (Node 24 and Docker):

```
docker compose up -d        # PostgreSQL 17 (and Redis) on localhost
cp .env.example .env        # works as it is for a local run
npm install
npm run migrate             # creates the tables (migrations/*.sql)
npm run seed                # demo logins + usage and bills for Sep/Oct 2026
npm run dev                 # http://localhost:3000
```

Other commands: `npm test`, `npm run typecheck`, `npm run build` and `npm start` (the compiled app).

## Demo accounts

Fictitious test data created by `npm run seed`. The passwords and the key are public on purpose and
come from `.env.example`.

| Username | Password | Subscriber No |
| --- | --- | --- |
| ayse | Demo-Ayse-2025 | 5551234 |
| mehmet | Demo-Mehmet-2025 | 5559999 |

The provider's systems don't log in: they send an API key. The demo key (named `provider-demo`) is
`pk_demo-provider-key-public-do-not-deploy-7f3c2a91`.

The seed also records usage and calculates bills for the assignment's example questions
("What is my October bill?", "Why is my October bill higher?"): Ayse September 2026 **$50**
(800 min, 15 GB) and October 2026 **$80** (1,350 min, 35 GB: one extra phone block and two extra
internet blocks), Mehmet October 2026 **$70**. Running the seed again adds nothing.

## Endpoints

All routes are under `/api/v1`. Two kinds of caller. A **subscriber** logs in (`POST /login`,
then `Authorization: Bearer <token>`) and acts only on their own number (another subscriber's gets
403); the AI agent always works as the subscriber who logged in. The **provider's systems** (the
network's usage collector, the billing run) send `X-API-Key: <key>`: they record usage and can
calculate or read any subscriber's bill, but can't pay for one. Errors are always
`{ "error": "message" }`.
Every bill response has `estimate`: `true` while the month is still running, so the total is only
the amount so far and can't be paid yet.

| Operation | Route | Who | Success | Errors |
| --- | --- | --- | --- | --- |
| Log in | `POST /login` | anyone | 200 token (15 min) | 400, 401 |
| Query Bill | `GET /subscribers/{no}/bills/{year}/{month}` | anyone (assignment: no auth) | 200 | 400, 404 |
| Query Bill Detailed | `GET /subscribers/{no}/bills/{year}/{month}/details?offset=0&limit=20` | own subscriber, provider key | 200 | 400, 401, 403, 404 |
| Calculate Bill | `PUT /subscribers/{no}/bills/{year}/{month}` | own subscriber, provider key | 201 created, 200 recalculated | 400, 401, 403, 404, 409, 422 |
| Add Usage | `POST /subscribers/{no}/usage` + `Idempotency-Key` header | provider key | 201 | 400, 401, 403, 404, 409 |
| Pay Bill | `POST /subscribers/{no}/bills/{year}/{month}/payments` | own subscriber | 201 | 400, 401, 403, 404, 409, 422 |

The assignment lists each operation with its parameters; here the subscriber, year and month are
part of the URL (the bill is a resource of its subscriber) and the rest is the JSON body.

A whole month, end to end (copy into a terminal while `npm run dev` runs). Run it once on a freshly
seeded database: after the payment, April 2025 is locked, so a second run gets 409s.

```
API=http://localhost:3000/api/v1
login() { curl -s -X POST $API/login -H "Content-Type: application/json" \
  -d "{\"username\":\"$1\",\"password\":\"$2\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken'; }
PROVIDER="X-API-Key: pk_demo-provider-key-public-do-not-deploy-7f3c2a91"
AYSE="Authorization: Bearer $(login ayse Demo-Ayse-2025)"
KEY() { node -e 'console.log(crypto.randomUUID())'; }

# 1) the provider's systems record April 2025: 1,350 minutes and 35 GB (the guide's worked example)
curl -s -X POST $API/subscribers/5551234/usage -H "$PROVIDER" -H "Idempotency-Key: $(KEY)" \
  -H "Content-Type: application/json" -d '{"year":2025,"month":4,"usageType":"PHONE","quantity":135}'
for MB in 10000 10000 10000 5000; do          # 35,000 MB
  curl -s -X POST $API/subscribers/5551234/usage -H "$PROVIDER" -H "Idempotency-Key: $(KEY)" \
    -H "Content-Type: application/json" -d "{\"year\":2025,\"month\":4,\"usageType\":\"INTERNET\",\"quantity\":$MB}"
done
curl -s -X PUT $API/subscribers/5551234/bills/2025/4 -H "$PROVIDER"        # calculate: total "80.00"

# 2) the subscriber reads and pays
curl -s $API/subscribers/5551234/bills/2025/4                              # query (no login needed)
curl -s "$API/subscribers/5551234/bills/2025/4/details?limit=5" -H "$AYSE"  # breakdown + usage
curl -s -X POST $API/subscribers/5551234/bills/2025/4/payments -H "$AYSE" \
  -H "Content-Type: application/json" -d '{"transactionId":"demo-pay-1","amount":"25.00"}'
```

## Design

The folders follow the instructor's `apiNode` repository, plus `controllers/` from his
`se4458-TodoApi`. Each layer only talks to the one below it:

controller (`src/controllers`, HTTP only: validate, call the service, pick the status code) ->
DTO (`src/dto`, the JSON shapes) -> service (`src/services`, the business rules) -> DB context
(`src/db`, the only place with SQL) -> PostgreSQL. `src/domain` holds the entities, the money
helpers and the tariff (prices).

- **Database:** PostgreSQL with plain SQL through `pg`, as in the instructor's examples, always with
  `$1` parameters (no SQL injection). The schema lives in numbered files in `migrations/` that
  `npm run migrate` applies once each, so the tables can change later without being recreated.
- **Business rules in the database too:** UNIQUE and CHECK constraints (one bill per month, total =
  phone + internet, paid between 0 and the total, a positive payment, ...) reject bad data even
  if the code had a bug. The tests check each constraint by name.
- **Money** is `NUMERIC(10,2)` in the database, whole cents in the code and a string such as
  `"75.00"` in JSON, so there is never a floating-point rounding error.
- **Versioning:** the `/api/v1` prefix is written in one place (`src/app.ts`); each route is declared
  once and is both mounted and added to Swagger from that single declaration.
- **Swagger** is generated from the same zod schemas that validate requests, and a test checks
  that every documented route really answers.
- **Login:** subscribers get a JWT (HS256, 15 minutes) with their subscriber number as its subject;
  passwords are stored as salted scrypt hashes. The token must match the number in the URL, so
  knowing someone's subscriber number is not enough to read or change their data.
- **Provider API keys:** the provider's systems authenticate with a key in `X-API-Key`. The
  database stores only its SHA-256 hash (a fast hash is enough for a long random key, unlike a
  password), and a key can be revoked.
- **Retries are safe:** Add Usage needs an `Idempotency-Key` and Pay Bill a `transactionId`; sending
  the same request again returns the first answer (with `Idempotent-Replayed: true`) and records
  nothing new. Calculate Bill is a `PUT` and safe to repeat by nature.
- **Concurrency:** each write runs in one transaction. Pay Bill locks the bill row
  (`SELECT ... FOR UPDATE`) so two payments can't both pass the balance check; Calculate Bill and
  Add Usage use row locks and `ON CONFLICT` so simultaneous calls can't create two bills or two
  usage rows.
- **Errors:** 400 for invalid input, 401 without a valid token, 403 for another subscriber's data,
  404 for something that doesn't exist, 409 for a conflict with the current state, 422 when a
  payment would break the balance.

## Decisions

The choices made while building it (the full list with reasons is in
[docs/data-model.md](docs/data-model.md#settled-decisions)):

- **Bills are stored**, one per subscriber and month. Calculate Bill creates or recalculates it until
  the first payment; after that the month is locked (no recalculation, no new usage).
- **One row per Add Usage call.** Calculate Bill marks the rows it counted with the bill's id, so
  Query Bill Detailed lists exactly what the stored total is made of.
- **Each bill stores its tariff** (price list), so an old bill is always explained with the prices
  that produced it.
- **Paging** is offset/limit as in the course slides: `?offset=0&limit=20`, newest usage first,
  at most 100 per page.
- **Calculate Bill is `PUT`** on the bill's own URL (the same one Query Bill reads), because
  repeating it gives the same bill.
- **The app refuses unsafe settings:** it won't start without a JWT secret, and it refuses the
  public development key from `.env.example` against any non-local database, including a tunnel to
  Amazon RDS (it asks the database itself after connecting).

## Assumptions

Not stated in the assignment or the billing guide, so decided here:

- **Rounding:** a started block is a full block (1,001 minutes is $10; 20,001 MB is $60, GB is not
  rounded first). Internet's $50 is charged even with zero usage (guide §3.1). 1 GB = 1,000 MB.
- **Identity:** one login per subscriber (people), and API keys for the provider's systems
  (machines). Group 2 defines no admin application, but the assignment says "administrative
  operations must be authorized", and recording a customer's usage is one: it comes from the
  provider's network, so only a provider key can do it. Subscribers can still calculate their own
  bill (to see the month so far) and read and pay it; a provider key can calculate and read any
  bill but never pays for a subscriber. Query Bill needs no login because the assignment says so.
- **Months are UTC.** A month that hasn't started can't get usage or a bill (400), so no
  real-looking $50 bill is made for the future. The current month can be calculated, but its
  bill is marked `estimate: true` until the month ends (guide §4.4: an estimate must not look
  like the confirmed bill).
- **Quantity:** the assignment records one unit per Add Usage call (10 minutes or 1 MB). The API
  also takes an optional `quantity` (default 1, at most 10,000), so heavy usage needs fewer calls.
- **Payments:** simulated, no card processing. An amount is `"25.50"` or `25.5` with at most 2
  decimals. A bill can only be paid **after its month is over**, because a payment locks the month
  and would otherwise refuse the rest of its usage. A bill with usage added after it was
  calculated must be recalculated before it can be paid. A `transactionId` is unique across all
  subscribers.
- **The AI agent** must confirm the subscriber, month and amount with the user before it calls Pay
  Bill (guide §5.2); the API itself can't see that conversation.

## Issues encountered

- **Language switch:** I started in Python (FastAPI, SQLAlchemy, Alembic) and switched to
  TypeScript to build on my earlier `ts-api` project and the instructor's JavaScript examples. The
  data model stayed the same. Before switching I found an Alembic bug worth remembering: the
  database user was called `billing`, so `billing` became the default schema and the migration tool
  compared nothing and wanted to recreate every table.
- **Course material:** the idempotency and pagination slides were images only, and the billing
  guide was embedded inside the assignment's Word file, so I extracted them before I could use them.
- **Claude API key:** an organization-level key was refused (it needs a workspace); a
  workspace-scoped key works.
- **Swagger out of sync:** `/api/v1` was first written in four places, so a version change would have
  moved the routes but not the Swagger paths. Now each route is declared once, and a test calls
  every documented path.
- **Broken JSON got a 500.** A body that isn't valid JSON is the client's mistake, so it is now a 400.
- **Usernames and case:** login ignores case, but the unique constraint didn't, so `Ayse` and
  `ayse` could both exist. Migration 002 adds a case-insensitive unique index.
- **Demo passwords in the build:** the seed script was under `src/`, so its passwords were compiled
  into `dist/` and would have shipped in the Docker image. It moved to `scripts/` and reads the
  passwords from `.env`.
- **The template didn't run:** a fresh copy of `.env.example` had no JWT secret, so nothing started.
  It now has a clearly marked public development key, which the app refuses outside a local
  database (see Decisions).
- **Usage list by timestamp was racy:** the detailed bill first guessed which usage belonged to a
  bill by time, and usage saved at almost the same moment as the calculation could be listed without
  being in the total. Calculate Bill now marks the usage it counts (migration 003); the new index
  also made a page about 5.6 times faster (22.8 ms to 4.0 ms on 40,000 rows).
- **One call per MB doesn't scale:** measured on my laptop, PostgreSQL took about 10,200 single-row
  inserts per second and the whole API about 1,300 requests per second per process, while 5,000
  users at 50 MB/s would send 250,000. Hence the `quantity` field; a queue with batched inserts would
  be the next step ([details](docs/data-model.md#scaling-add-usage-measured-not-assumed)).
- **Overflow:** monthly totals were `INTEGER`, so huge usage could make a month impossible to bill.
  They are `BIGINT` now (migration 005), and an unbillable total gets a clear 422.
- **A helper that didn't always roll back:** the transaction helper only rolled back when it opened
  the transaction itself; a test caught it, and it now uses a savepoint inside an existing one.
- **Paying the current month:** a code review found that paying a bill mid-month locked the month,
  so the rest of its usage would have been refused. Only finished months can be paid now.

## Tests

The tests run against a real PostgreSQL database (`billing_test`, created automatically) in the
local Docker container, and every test is rolled back, so they don't affect each other. They need
no cloud deployment, no LLM and no `.env`: the local Docker database (`docker compose up -d`) is
the only thing that must be running.

```
npm test
```

```
ℹ tests 164
ℹ pass 164
ℹ fail 0
```

Every operation has success and failure tests (`test/auth`, `queryBill`, `queryBillDetailed`,
`calculateBill`, `addUsage` and `payBill`), and the others cover the pricing examples from the
guide, money, months, transactions, configuration, the database constraints and the Swagger
document. To be sure the tests can fail, I broke the code on purpose (for example removed the
balance check, or the ownership check) and confirmed the matching test failed each time.

Concurrency can't be tested with one connection, so it was checked separately against the real
database: 10 simultaneous $10 payments on a $50 bill gave exactly 5 payments and 5 refusals
(paid $50.00); without the row lock the same run reported 10 payments while the bill showed only
$20.00. Ten identical retries of a payment or a usage report always produced one row.

## Not done yet

- **MCP server:** `search_billing_documentation(query)` over the billing guide, one indexed chunk
  per numbered section with PostgreSQL full-text search; tool schema and three retrieval tests.
- **AI agent:** chat that lets Claude choose the billing API, the MCP tool or both; the three
  scenarios (MCP only, API only, combined) and a confirmed payment; LLM cost notes.
- **API Gateway:** gateway URL, route mappings, a protected route, an error example and
  per-subscriber rate limits.
- **Deployment:** AWS (eu-north-1): the API on ECS, PostgreSQL on RDS, steps and URLs.
- **Redis cache** for Query Bill (Redis already runs in `compose.yaml`, unused so far).
- **Demo video** and screenshots.

## References

Instructor examples this project follows: [apiNode](https://github.com/southriver/apiNode)
(layers, Swagger), [se4458-TodoApi](https://github.com/southriver/se4458-TodoApi) (controllers,
JWT login), [MCP](https://github.com/southriver/MCP) (MCP server), and for the next parts
[SE4458-AIAgent](https://github.com/southriver/SE4458-AIAgent),
[ApiGateway2](https://github.com/southriver/ApiGateway2) and
[caching](https://github.com/southriver/caching).

## License

MIT
