-- Kestrel — shard schema.
--
-- One table per logical shard. The application creates these idempotently at
-- boot (PostgresDriver.init), so this file is the canonical, reviewable
-- statement of the schema and the way to provision a database ahead of deploy.
--
-- Shard count defaults to 4. To provision a different count, change the SET
-- below (or persist it with
--   ALTER DATABASE kestrel SET kestrel.shard_count = '8';
-- ) and keep SHARD_COUNT in the application environment identical.
--
-- Changing the shard count after rows exist re-routes existing codes and is a
-- data migration, not a config change (PRD.md §3.2).

SET kestrel.shard_count = '4';

DO $migrate$
DECLARE
  shard_count INT := current_setting('kestrel.shard_count', true)::int;
  i           INT;
  t           TEXT;
BEGIN
  IF shard_count IS NULL THEN
    shard_count := 4;
  END IF;

  FOR i IN 0..(shard_count - 1) LOOP
    t := format('links_%s', i);

    EXECUTE format($ddl$
      CREATE TABLE IF NOT EXISTS %I (
        id               BIGINT PRIMARY KEY,
        code             TEXT   NOT NULL,
        url              TEXT   NOT NULL,
        created_at       BIGINT NOT NULL,
        expires_at       BIGINT,
        clicks           BIGINT NOT NULL DEFAULT 0,
        last_accessed_at BIGINT
      )
    $ddl$, t);

    -- The redirect lookup — the hot query. UNIQUE also makes two replicas
    -- racing on the same custom alias resolve atomically in the database.
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (code)', t || '_code_uidx', t);

    -- Matches the list ORDER BY exactly, so keyset pagination is a range scan
    -- rather than the sort-and-discard an OFFSET paginator would produce.
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I (created_at DESC, id DESC)', t || '_created_idx', t);

    -- Partial index: expiry reaping touches only rows that can expire, leaving
    -- the permanent-link majority out of the index entirely.
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I (expires_at) WHERE expires_at IS NOT NULL',
      t || '_expires_idx', t);

    RAISE NOTICE 'shard % ready (%)', i, t;
  END LOOP;
END
$migrate$;
