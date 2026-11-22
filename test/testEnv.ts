// Imported FIRST by test/helpers.ts, before anything reads the config (src/config.ts parses
// process.env once at import). Defaults match compose.yaml; the database name is forced
// to billing_test so tests can never touch dev data. No .env file is needed.
process.env["POSTGRES_HOST"] ??= "127.0.0.1";
process.env["POSTGRES_PORT"] ??= "5432";
process.env["POSTGRES_USER"] ??= "billing";
process.env["POSTGRES_PASSWORD"] ??= "billing_local_dev";
process.env["POSTGRES_DB"] = "billing_test";
