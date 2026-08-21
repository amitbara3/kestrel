# Rules — Kestrel

Engineering constraints for anyone (human or AI) writing code in this repository. These are binding. When a rule and a convenience conflict, the rule wins.

---

## 1. Dependencies

### Allowed — runtime

| Package | Purpose |
| --- | --- |
| `fastify` | HTTP server |
| `@fastify/static` | Serve `src/public` |
| `ioredis` | Redis client |
| `pg` | PostgreSQL client |
| `zod` | Validation and config parsing |

### Allowed — development

`typescript`, `tsx`, `vitest`, `@vitest/coverage-v8`, `@types/*`, `autocannon`, `eslint` + `typescript-eslint`, `prettier`.

### Forbidden

| Not allowed | Reason |
| --- | --- |
| Any ORM (Prisma, TypeORM, Drizzle, Sequelize) | Hides the query plan and the shard routing, which are the substance of this project |
| Any rate-limit package (`express-rate-limit`, `rate-limiter-flexible`, `@fastify/rate-limit`) | The algorithm is the deliverable, not a dependency |
| Any cache wrapper (`cache-manager`, `node-cache`, `lru-cache`) | Same reason; L1 and the driver layer are hand-written |
| `express`, `koa`, `hapi` | One HTTP framework only |
| `lodash`, `ramda`, `underscore` | Node 22 has everything needed |
| `moment`, `dayjs` | Milliseconds since epoch and `Intl` are sufficient |
| `axios`, `node-fetch` | Global `fetch` is built in |
| `dotenv` | Node 22 supports `--env-file` natively |
| `uuid` | `crypto.randomUUID()` is built in |
| Anything unmaintained (no release in 18 months) or with a known unpatched advisory | Supply-chain hygiene |

**Adding a dependency requires:** justification in the PR body, a note on what it replaces, and a line added to the table above. Do not add one silently. Prefer the standard library; prefer 30 lines of readable code over a transitive tree.

## 2. Code style

- TypeScript **strict mode**, `noUncheckedIndexedAccess` on. No new `any`. `unknown` plus narrowing instead.
- ESM only. `.js` extensions in relative import specifiers (required by Node's ESM resolver).
- **No default exports.** Named exports only — they refactor and grep cleanly.
- `async`/`await` throughout. No raw `.then()` chains except a deliberate fire-and-forget, which must carry a `.catch()` and a comment.
- Files stay under ~300 lines. A file that outgrows it is doing two jobs; split it.
- Functions stay under ~50 lines and take at most 4 positional parameters; beyond that, take an options object.
- Naming: `camelCase` values, `PascalCase` types and classes, `SCREAMING_SNAKE` module-level constants, `kebab-case` filenames.
- Comments explain **why**, never **what**. A comment restating the code is deleted. Every non-obvious algorithm gets a short doc comment naming the technique and its tradeoff.
- No commented-out code on `main`. Git remembers it.

## 3. Error handling

- All thrown errors derive from `AppError` in `src/core/errors.ts`, which carries a stable machine code, an HTTP status, and a safe public message.
- **Never leak internals.** Stack traces, SQL text, driver messages, and connection strings go to the log; the client gets the public message and a request ID.
- One error envelope for every non-2xx JSON response:
  ```json
  { "error": { "code": "...", "message": "...", "requestId": "...", "details": {} } }
  ```
- Never swallow an error. Either handle it, wrap and rethrow with context, or log it at `error` with the request ID. An empty `catch {}` is a defect.
- **Degrade, don't fail.** A cache or analytics failure must not surface to the user. A database failure on a read path where cache can answer must not surface either. Only an unanswerable request 5xxs.
- Validate at the boundary with Zod. Past the route handler, data is trusted and typed — no defensive re-checking in the service layer.
- No `process.exit()` outside `src/index.ts`'s signal handlers. Libraries throw; the entry point decides to die.

## 4. Async and performance

- Nothing blocking in a request path: no sync `fs`, no `JSON.parse` of megabyte payloads, no unbounded loops over user input.
- Every external call has a timeout. No unbounded `await`.
- Every unbounded collection has an eviction policy. The L1 cache is size-capped, the click buffer is size-capped and flushes when full, and every Redis key written by the app gets a TTL.
- Batch by default: many writes become one round trip. `Promise.all` for independent I/O; sequential `await` only when there is a genuine data dependency.
- Never `await` inside a loop over independent items.

## 5. Security

- **Never log** a full API key (log a prefix), a connection string, a request body on the write path, or an `Authorization` header.
- Validate and normalise every URL before storing it. Reject non-`http(s)` schemes and hosts resolving to loopback, private, link-local, or metadata ranges — an open redirect into `169.254.169.254` is a real attack, not a hypothetical.
- Trust `X-Forwarded-For` **only** from configured trusted proxy CIDRs. Otherwise use the socket address.
- All SQL is parameterised. String-interpolating a value into SQL is an automatic rejection. Table and shard names come from validated integers, never from input.
- Secrets come from the environment. No secret is ever committed; `.env` is gitignored and `.env.example` carries placeholders only.
- Containers run as a non-root user with a read-only root filesystem.
- Redirect responses set `Cache-Control: private, max-age=0` so intermediaries do not cache a link that may be deleted.

## 6. Testing

- Every module in `src/core` has a unit test. Every route has an integration test through Fastify's `inject()` — no real socket needed.
- **The full suite must pass with no external services running.** Tests that require Redis or Postgres live behind an explicit integration flag and are skipped, not failed, when the service is absent.
- Both driver implementations run against the **same** shared contract test suite. This is how the fallback stays honest.
- Test behaviour through the public interface, not private internals. Do not assert on a private field to prove a cache was used — assert that the database was not queried.
- No `sleep`-based tests. Inject a clock. Time-dependent logic takes `now` as a parameter or a `Clock` dependency.
- A bug fix begins with a failing test that reproduces it.

## 7. Configuration

- All configuration is read **once**, at startup, in `src/config.ts`, through a Zod schema with defaults. `process.env` is not read anywhere else.
- Config is immutable after boot.
- Every setting has a safe default that works with zero environment variables set. `npm start` on a clean machine must work.
- On boot the service logs which drivers it selected and which are fallbacks. A degraded configuration is never silent.

## 8. Git and GitHub

- `main` is always green: it typechecks, lints, and passes tests.
- Conventional Commits: `feat:`, `fix:`, `perf:`, `refactor:`, `test:`, `docs:`, `chore:`, `build:`, `ci:`.
- One logical change per commit. A commit that touches six unrelated concerns gets split.
- Feature branches: `feat/<slug>`, `fix/<slug>`. Never commit directly to `main` once CI exists.
- Never commit: `node_modules/`, `dist/`, `.env`, `*.log`, coverage output, editor directories, OS cruft.
- CI must pass before merge. A red build is fixed or reverted, never merged around.

## 9. Documentation

- `Memory.md` is updated **at the end of every phase** — what shipped, what changed, what is next. It is the handoff file; treat it as part of the deliverable.
- A change to the stack, folder layout, or a core algorithm updates `Architecture.md` in the same commit.
- Public API changes update the API table in `PRD.md` and the examples in `README.md` in the same commit.
- Every non-obvious tradeoff is written down where the decision lives, not left in someone's head.

## 10. Rules for AI assistants specifically

**Do:**

- Read `Memory.md` first to learn where the build actually is.
- Work one phase at a time in the order given by `Phases.md`; finish and verify a phase before starting the next.
- Run the tests after each change and report the real result, including failures.
- Follow the existing patterns in neighbouring files — match their naming, error handling, and comment density.
- State assumptions explicitly when a requirement is ambiguous, then proceed.

**Do not:**

- Invent files, functions, endpoints, or benchmark numbers. If a number is not measured, do not print it.
- Refactor code outside the current task's scope.
- Add a dependency that section 1 forbids, or any dependency not listed there, without saying so.
- Delete or rewrite a test to make a build pass. Fix the code.
- Claim something works without having run it. "Tests pass" requires having run the tests.
- Replace a hand-written algorithm from section 1's forbidden list with a library, however tempting.
- Leave `TODO` markers without an accompanying line in `Memory.md`.
