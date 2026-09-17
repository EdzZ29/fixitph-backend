# FixItPH API

NestJS + PostgreSQL + Redis API behind the FixItPH marketplace, a directory of
local service providers for Northern Mindanao and Caraga.

---

## Ports

PostgreSQL on this machine is installed locally and configured on **port
3000**, so the API takes 4000. Two processes cannot share a port, and the
database was there first.

| | Port |
| --- | --- |
| PostgreSQL (local install) | **3000** |
| API | **4000** |
| Next.js frontend | **3001** |
| Redis | 6379, optional |
| MinIO | 9000 / 9001, only for uploads |

Everything below assumes that. If you ever move Postgres to 5432, you can put
the API back on 3000: change `PORT` and the two `DATABASE_` URLs in `.env`, and
`NEXT_PUBLIC_API_URL` in the frontend.

---

## Running it locally

### 1. Environment

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # JWT_ACCESS_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # JWT_REFRESH_SECRET
```

`.env` is gitignored. `.env.example` lists every variable and never holds a
real secret.

### 2. Database role

The API must not connect as a role that owns its tables, because an owner
bypasses row level security silently. Create the runtime role once:

```bash
psql -h localhost -p 3000 -U postgres -d fixitph -f scripts/setup-local-postgres.sql
```

That creates `fixitph_app`: `LOGIN`, `NOBYPASSRLS`, owns nothing, cannot create
tables in `public`. Migrations run as `postgres` (the owner), the API runs as
`fixitph_app`, and the API refuses to boot if that is ever not true.

On Windows, `psql` lives at
`C:\Program Files\PostgreSQL\17\bin\psql.exe` if it is not on your PATH.

<details>
<summary>Using Docker instead of a local Postgres</summary>

`docker-compose.yml` brings up Postgres, Redis and MinIO, and creates the same
role through `docker/postgres/initdb/10-app-role.sh`. It publishes Postgres on
5432, so update the two `DATABASE_` URLs in `.env` before using it. Do not run
it alongside the local install.

```bash
docker compose up -d
```
</details>

### 3. Schema

```bash
npx prisma migrate deploy   # or: npx prisma migrate dev
npm run db:seed             # categories and three test accounts
```

Three migrations run, in order:

| Migration | What it does |
| --- | --- |
| `init_extensions` | `citext`, so `Ana@x.com` and `ana@x.com` collide at the unique index |
| `init` | 23 tables, 21 enums, 44 foreign keys, every unique constraint |
| `security` | RLS policies, CHECK constraints, partial unique indexes, append-only triggers, two least-privilege views, grants |

### 4. The API

```bash
npm run start:dev
```

Live at **http://localhost:4000/api**. A healthy boot says:

```
WARN  [Cache] REDIS_URL is empty, using an in-memory cache...
LOG   [PrismaService] Connected as "fixitph_app" with row level security active on 7 tables
LOG   [Bootstrap] FixItPH API listening on http://localhost:4000/api
```

That middle line is the one that matters. Check it:

```bash
curl http://localhost:4000/health
# {"success":true,"data":{"status":"ok","database":"reachable","latencyMs":6,...}}

curl http://localhost:4000/api/categories
```

### Seeded accounts

| Email | Role | Password |
| --- | --- | --- |
| `admin@fixitph.test` | ADMIN | `DevPassword123!` |
| `provider@fixitph.test` | PROVIDER (verified) | `DevPassword123!` |
| `customer@fixitph.test` | CUSTOMER | `DevPassword123!` |

### Redis is optional

Leave `REDIS_URL` empty and the cache runs in process. That is fine for one
developer with no Docker, and wrong for anything else: the cache is per
process, so two API instances would hold different caches and an invalidation
on one would never reach the other. The API warns about this at boot.

Set `REDIS_URL=redis://localhost:6379` once you have Redis
(`docker compose up -d redis`, or Memurai on Windows).

---

## Frontend

```bash
cd ../fixitph-frontend
npm run dev                # http://localhost:3001
```

It reads `NEXT_PUBLIC_API_URL=http://localhost:4000/api` and talks to the API
through the typed client in `lib/api/client.ts`. `CORS_ORIGIN` on the API is an
explicit allow-list containing exactly `http://localhost:3001`.

---

## Security

Everything here is enforced by a guard, an RLS policy, or a database
constraint. Nothing on this list is only a convention.

### Row level security

RLS is enabled on `bookings`, `service_requests`, `quotes`, `messages`,
`reviews`, `provider_documents`, `admin_actions`, and also
`booking_status_history`. A customer sees only their own rows, a provider only
rows tied to their `provider_id`, and admins bypass via a role check.

Identity reaches the policies as transaction-local session variables, set by
`PrismaService.withUser()`:

```sql
SELECT set_config('app.current_user_id', $1, true);
SELECT set_config('app.current_role',    $2, true);
```

The `true` is load-bearing. Session-level settings would leak one request's
identity into the next request on a pooled connection.

**A table's owner bypasses RLS.** If the API connected as the owner every
policy would be skipped silently, with no error anywhere. So migrations run as
the owner (`DATABASE_URL`) and the API runs as `fixitph_app`
(`DATABASE_APP_URL`), which owns nothing and is `NOBYPASSRLS`. The API checks
this at boot and refuses to start otherwise.

### Least-privilege data exposure

`booking_contact_for_provider` gives a provider the customer's city and
barangay from the start, and the street address, coordinates and phone number
only once `contact_released_at` is stamped on confirmation.

`open_service_request_feed` lets providers browse broadcast jobs without ever
selecting `customer_id`, `address_line1`, `latitude` or `longitude`.

Both views are owned by the migration role and secure themselves in their own
`WHERE` clause, which is what lets them show a provider strictly less than the
base table would.

### The rest

- **Auth**: Argon2id (64 MiB, 3 passes), 15 minute access tokens, rotating
  refresh tokens stored only as SHA-256 digests. Presenting an already-rotated
  token revokes the whole family, because the only ways that happens are theft
  or replay. Lockout after `LOGIN_MAX_ATTEMPTS` failures.
- **Guards**: `JwtAuthGuard` is global, so authentication is opt-out via
  `@Public()` rather than opt-in. `RolesGuard` for CUSTOMER / PROVIDER / ADMIN,
  `OwnershipGuard` for per-resource ownership, checked before any service code
  runs.
- **Validation**: `whitelist` and `forbidNonWhitelisted`, so an unknown field
  is a 400 rather than something silently ignored.
- **Rate limiting**: named throttler buckets on auth, service-request creation
  and messaging.
- **Uploads**: the declared Content-Type and the filename are treated as hints
  from an attacker; only the leading bytes decide the type. Stored in a private
  bucket under a generated key, served only through signed URLs that expire in
  five minutes. SVG is deliberately not accepted.
- **Headers**: helmet, with a CSP of `default-src 'none'` because this is a
  JSON API that never serves a document.
- **Audit**: every admin action writes to `admin_actions` inside the same
  transaction as the change. The table has `UPDATE` and `DELETE` revoked from
  the API role and a trigger that refuses both.

---

## Business rules, and where each one is actually enforced

No written rules document existed in this repository, so these ten are derived
from the security and lifecycle requirements the API was built to. Each is
covered by an automated check.

| # | Rule | Enforced by |
| --- | --- | --- |
| 1 | A service needs a price unless it is quote-only, and only a verified provider can publish one | `services_price_required_unless_quote` CHECK, `services_unit_named_when_needed` CHECK, verification check in `ServicesService.create` |
| 2 | Requests only go to verified, unsuspended, open providers | `RequestsService.create`, plus the unique keys on `users.email`, `providers.user_id`, `providers.slug`, `services (provider_id, slug)` |
| 3 | One live quote per provider per request | `quotes_one_live_per_provider_per_request` partial unique index |
| 4 | One accepted quote per request, producing exactly one booking | `quotes_one_accepted_per_request` partial unique index and the unique `bookings.quote_id` |
| 5 | The exact address reaches a provider only after confirmation | `bookings_contact_release_requires_confirmation` CHECK and the `booking_contact_for_provider` view |
| 6 | Every booking status change is logged, and the log is immutable | `bookings_record_status_*` triggers write it; `booking_status_history_no_update` / `_no_delete` triggers plus revoked grants keep it |
| 7 | A review requires your own COMPLETED booking, rated 1 to 5, once | `reviews_guard_insert` trigger, `reviews_rating_range` CHECK, unique `reviews.booking_id` |
| 8 | Editing a review appends to history and never overwrites | `reviews_guard_update` trigger |
| 9 | users, services, bookings and reviews are never hard deleted | `*_no_hard_delete` triggers and `REVOKE DELETE` from the API role |
| 10 | Every admin action is audited in the same transaction | `AdminService.audit()` inside the transaction; `admin_actions_no_update` / `_no_delete` triggers |

---

## Verifying it

```bash
npm run verify:security   # 70 database-level assertions
npm run build
npm run verify:api        # 62 HTTP-level assertions
```

Neither needs Docker. Both spin up a real PostgreSQL engine in-process
(PGlite), apply the actual migration files, and assert against them.

`verify:security` runs as a genuine non-owner role and checks that a customer
sees only their own rows, a provider only theirs, an anonymous caller none, and
that every CHECK, trigger and revoked privilege behaves.

`verify:api` boots the compiled application and exercises the HTTP surface:
auth, guards, the response envelope, validation, cache invalidation, CORS,
helmet and throttling. It deliberately runs with Redis unreachable, to confirm
cached endpoints degrade to the database instead of hanging.

---

## API shape

Every response:

```jsonc
{ "success": true,  "data": ... }
{ "success": false, "message": "...", "code": "SOME_CODE" }
{ "success": false, "message": "Validation failed", "code": "VALIDATION_ERROR", "errors": ["..."] }
```

| Area | Routes |
| --- | --- |
| Auth | `POST /auth/register` `login` `logout` `refresh` `forgot-password` `reset-password`, `GET /auth/me` |
| Providers | `GET /providers` (search, filter, paginate), `GET /providers/:id`, `POST /providers`, `PATCH /providers/:id`, `DELETE /providers/:id`, `GET /providers/:id/reviews` |
| Services | `GET /services`, `GET /services/:id`, `POST /services`, `PATCH /services/:id`, `DELETE /services/:id` |
| Requests | `POST /service-requests`, `GET /service-requests`, `GET /service-requests/feed`, `GET /service-requests/:id`, `PATCH /service-requests/:id/status` |
| Quotes | `POST /quotes`, `GET /quotes/:id`, `PATCH /quotes/:id`, `POST /quotes/:id/accept`, `POST /quotes/:id/reject` |
| Bookings | `GET /bookings`, `GET /bookings/:id`, `POST /bookings`, `PATCH /bookings/:id`, `POST /bookings/:id/confirm` `start` `cancel` `complete` |
| Reviews | `POST /reviews`, `PATCH /reviews/:id`, `POST /reviews/:id/report` |
| Other | `/categories` `/favorites` `/messages` `/notifications` `/reports` `/disputes` `/uploads` |
| Admin | `/admin/users` `/admin/verification/pending` `/admin/providers/:id/verification` `/admin/documents/:id/review` `/admin/disputes/:id/resolve` `/admin/reports/:id/resolve` `/admin/categories` `/admin/audit-log` |

### Caching

| Endpoint | TTL | Invalidated by |
| --- | --- | --- |
| `GET /providers` | 60s | any provider or service write |
| `GET /providers/:id` | 5 min | `PATCH` / `DELETE` of that provider |
| `GET /services` | 60s | any service or category write |
| `GET /services/:id` | 5 min | `PATCH` / `DELETE` of that service |
| `GET /categories` | 1 hour | any admin category mutation |

Nothing under `/bookings`, `/service-requests`, `/quotes`, `/messages` or
`/notifications` is cached. Those are auth-scoped and have to be correct.

List keys embed a namespace version counter. Bumping the counter orphans every
cached listing in one write, which is how a key built from an arbitrary query
string gets invalidated without scanning Redis for a pattern. Single resources
are dropped by exact key with `del()`.

---

## Deliberate deviations from the brief

Two, both because the named thing would not have worked:

1. **`cache-manager-redis-store` → `@keyv/redis`.** The named package targets
   cache-manager v5. `@nestjs/cache-manager` v12 requires cache-manager >= 6
   and Keyv >= 5, so the two cannot be installed together. `@keyv/redis` is the
   maintained store for that combination and plugs into the same `CacheModule`
   API, so the caching strategy is unchanged.

2. **Prisma pinned to 6.19.3.** Prisma 7 removed `url` from the `datasource`
   block; connection strings move to a `prisma.config.ts` and the client needs
   a driver adapter. Pinning to 6 keeps `prisma/schema.prisma` and
   `npx prisma migrate dev` working exactly as the brief describes.

Two additions the brief did not list but the features it asked for require:
`refresh_tokens` and `password_reset_tokens`, without which rotating hashed
refresh tokens and password reset cannot exist. `providers` also carries
`deleted_at`, because `DELETE /api/providers/:id` must not hard-delete a row
that bookings reference.
