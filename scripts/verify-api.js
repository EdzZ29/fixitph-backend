/**
 * Boots the compiled Nest application against a real PostgreSQL engine
 * (PGlite, served over TCP) and exercises the HTTP surface end to end:
 * routing, the response envelope, validation, the error shape, auth, the role
 * and ownership guards, cache invalidation, CORS, helmet and rate limiting.
 *
 * Two deliberate accommodations, both noted where they apply:
 *   - PrismaService's least-privilege assertion is stubbed, because PGlite has
 *     a single superuser role and cannot model a separate non-owner one. The
 *     RLS policies are verified against a real role in scripts/verify-security.js.
 *   - Redis is not running, which is itself a test: every cached endpoint has
 *     to keep working and fall back to the database.
 */
const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
const DB_PORT = 54331;
const API_PORT = 54332;
const BASE = `http://127.0.0.1:${API_PORT}`;

process.env.NODE_ENV = 'test';
process.env.PORT = String(API_PORT);
process.env.API_PREFIX = 'api';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres?connection_limit=1&pgbouncer=true&schema=public`;
process.env.DATABASE_APP_URL = process.env.DATABASE_URL;
process.env.REDIS_URL = 'redis://127.0.0.1:6399'; // deliberately unreachable
process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-long-enough-000000';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-that-is-long-enough-00000';
process.env.CORS_ORIGIN = 'http://localhost:3001';

let pass = 0;
const failures = [];

function ok(name) {
  pass++;
  console.log(`  PASS  ${name}`);
}
function fail(name, detail) {
  failures.push(`${name} :: ${detail}`);
  console.log(`  FAIL  ${name}\n        ${detail}`);
}
function check(name, condition, detail) {
  if (condition) ok(name);
  else fail(name, detail === undefined ? 'condition was false' : String(detail));
}

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function startDatabase() {
  const { PGlite } = require(`${BACKEND}/node_modules/@electric-sql/pglite`);
  const { citext } = require(`${BACKEND}/node_modules/@electric-sql/pglite/dist/contrib/citext.cjs`);
  const { PGLiteSocketServer } = require(`${BACKEND}/node_modules/@electric-sql/pglite-socket`);
  const argon2 = require(`${BACKEND}/node_modules/argon2`);

  const db = await PGlite.create({ extensions: { citext } });

  const migDir = path.join(BACKEND, 'prisma/migrations');
  for (const m of fs.readdirSync(migDir).sort()) {
    await db.exec(fs.readFileSync(path.join(migDir, m, 'migration.sql'), 'utf8'));
  }

  // Seeded in-process: PGLiteSocketServer serves one client at a time, so the
  // Nest app has to be the only thing on the wire.
  const hash = await argon2.hash('DevPassword123!', { type: argon2.argon2id });
  await db.exec(`
    INSERT INTO categories (id, name, slug, position) VALUES
      (gen_random_uuid(), 'Plumbing', 'plumbing', 0),
      (gen_random_uuid(), 'Electrical', 'electrical', 1),
      ('ccccccc3-0000-4000-8000-000000000003', 'Aircon', 'aircon', 2),
      (gen_random_uuid(), 'Computer Repair', 'computer-repair', 3),
      (gen_random_uuid(), 'Auto Repair', 'auto-repair', 4),
      (gen_random_uuid(), 'Cleaning', 'cleaning', 5);

    INSERT INTO users (id, email, phone, password_hash, role, status) VALUES
      ('11111111-1111-4111-8111-111111111111', 'customer@fixitph.test', '+639170000001', '${hash}', 'CUSTOMER', 'ACTIVE'),
      ('22222222-2222-4222-8222-222222222222', 'provider@fixitph.test', '+639170000002', '${hash}', 'PROVIDER', 'ACTIVE'),
      ('33333333-3333-4333-8333-333333333333', 'admin@fixitph.test',    NULL,            '${hash}', 'ADMIN',    'ACTIVE');

    INSERT INTO profiles (user_id, first_name, last_name, city, barangay, address_line1) VALUES
      ('11111111-1111-4111-8111-111111111111', 'Ana', 'Reyes', 'Butuan City', 'Ampayon', '12 Narra Street'),
      ('22222222-2222-4222-8222-222222222222', 'Rommel', 'Saavedra', 'Butuan City', NULL, NULL),
      ('33333333-3333-4333-8333-333333333333', 'Ops', 'Admin', NULL, NULL, NULL);

    INSERT INTO providers (id, user_id, business_name, slug, base_city, verification_status, verified_at)
    VALUES ('aaaaaaa1-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222',
            'Saavedra Aircon Services', 'saavedra-aircon-services', 'Butuan City', 'APPROVED', now());
  `);

  const server = new PGLiteSocketServer({ db, port: DB_PORT, host: '127.0.0.1' });
  await server.start();
  return { db, server };
}

(async () => {
  const { db, server } = await startDatabase();
  console.log('== Database ready (migrations applied, seeded) ==');

  const { NestFactory } = require(`${BACKEND}/node_modules/@nestjs/core`);
  const { ValidationPipe } = require(`${BACKEND}/node_modules/@nestjs/common`);
  const cookieParser = require(`${BACKEND}/node_modules/cookie-parser`);
  const helmet = require(`${BACKEND}/node_modules/helmet`);

  const { AppModule } = require(path.join(BACKEND, 'dist/app.module.js'));
  const { PrismaService } = require(path.join(BACKEND, 'dist/prisma/prisma.service.js'));
  const { corsOrigins } = require(path.join(BACKEND, 'dist/config/configuration.js'));

  PrismaService.prototype.assertLeastPrivilege = async function () {};

  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.use(cookieParser());
  app.use(helmet());
  app.set('trust proxy', 1);
  app.enableCors({ origin: corsOrigins(process.env.CORS_ORIGIN), credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
    }),
  );
  await app.listen(API_PORT, '127.0.0.1');

  console.log('\n== Bootstrap ==');
  ok('the Nest dependency graph resolves and the server listens');

  let r, b;

  // -- envelope and routing --------------------------------------------------
  console.log('\n== Response envelope ==');
  r = await fetch(`${BASE}/health`);
  b = await json(r);
  check('GET /health is public and wrapped', r.status === 200 && b.success === true && b.data.status === 'ok', JSON.stringify(b));

  r = await fetch(`${BASE}/api/categories`);
  b = await json(r);
  check(
    'GET /api/categories returns the seeded tree',
    r.status === 200 && b.success === true && Array.isArray(b.data) && b.data.length === 6,
    JSON.stringify(b).slice(0, 220),
  );
  const airconId = Array.isArray(b.data) ? b.data.find((c) => c.slug === 'aircon')?.id : undefined;

  r = await fetch(`${BASE}/api/providers`);
  b = await json(r);
  check(
    'GET /api/providers is public and paginated',
    r.status === 200 && b.success === true && Array.isArray(b.data.items) && typeof b.data.total === 'number',
    JSON.stringify(b).slice(0, 220),
  );
  check(
    'the verified seeded provider is discoverable',
    b.data.items.length === 1 && b.data.items[0].slug === 'saavedra-aircon-services',
    JSON.stringify(b.data.items).slice(0, 220),
  );
  check(
    'the public provider payload carries no user id',
    !JSON.stringify(b.data.items[0]).includes('userId'),
    'userId leaked into the public listing',
  );

  // -- cache degradation -----------------------------------------------------
  console.log('\n== Cache behaviour with Redis unreachable ==');
  const t0 = Date.now();
  r = await fetch(`${BASE}/api/providers?city=Butuan%20City`);
  b = await json(r);
  const elapsed = Date.now() - t0;
  check(
    'a cached endpoint still answers when Redis is down',
    r.status === 200 && b.success === true,
    JSON.stringify(b).slice(0, 150),
  );
  check('it fails fast rather than hanging', elapsed < 3000, `took ${elapsed}ms`);

  // -- error shape -----------------------------------------------------------
  console.log('\n== Error shape ==');
  r = await fetch(`${BASE}/api/providers/not-a-uuid`);
  b = await json(r);
  check(
    'a malformed uuid gives { success:false, message, code }',
    r.status === 400 && b.success === false && typeof b.message === 'string' && typeof b.code === 'string',
    JSON.stringify(b),
  );

  r = await fetch(`${BASE}/api/providers/00000000-0000-4000-8000-000000000000`);
  b = await json(r);
  check('an unknown provider is 404 PROVIDER_NOT_FOUND', r.status === 404 && b.code === 'PROVIDER_NOT_FOUND', JSON.stringify(b));

  r = await fetch(`${BASE}/api/bookings`);
  b = await json(r);
  check('a protected route without a token is 401 UNAUTHENTICATED', r.status === 401 && b.code === 'UNAUTHENTICATED', JSON.stringify(b));

  // -- validation ------------------------------------------------------------
  console.log('\n== Validation ==');
  r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'not-an-email', password: '' }),
  });
  b = await json(r);
  check(
    'invalid input gives VALIDATION_ERROR with an errors array',
    r.status === 400 && b.code === 'VALIDATION_ERROR' && Array.isArray(b.errors),
    JSON.stringify(b),
  );

  r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'customer@fixitph.test', password: 'DevPassword123!', isAdmin: true }),
  });
  b = await json(r);
  check('an unknown field is rejected (forbidNonWhitelisted)', r.status === 400 && b.code === 'VALIDATION_ERROR', JSON.stringify(b));

  r = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'escalate@fixitph.test',
      password: 'StrongPassword123',
      firstName: 'Esc',
      lastName: 'Alate',
      role: 'ADMIN',
    }),
  });
  b = await json(r);
  check(
    'registering as ADMIN is refused (no privilege escalation at signup)',
    r.status === 400 && b.code === 'VALIDATION_ERROR',
    JSON.stringify(b),
  );

  // -- authentication --------------------------------------------------------
  console.log('\n== Authentication ==');
  r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'customer@fixitph.test', password: 'WrongPassword1' }),
  });
  b = await json(r);
  check('a wrong password is 401 INVALID_CREDENTIALS', r.status === 401 && b.code === 'INVALID_CREDENTIALS', JSON.stringify(b));

  r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@fixitph.test', password: 'WrongPassword1' }),
  });
  b = await json(r);
  check(
    'an unknown email answers identically (no account enumeration)',
    r.status === 401 && b.code === 'INVALID_CREDENTIALS',
    JSON.stringify(b),
  );

  r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'customer@fixitph.test', password: 'DevPassword123!' }),
  });
  b = await json(r);
  const setCookie = r.headers.get('set-cookie') || '';
  const customerToken = b && b.data && b.data.accessToken;
  check('a correct password returns an access token', r.status === 200 && !!customerToken, JSON.stringify(b).slice(0, 200));
  check(
    'the refresh token is an httpOnly cookie and is not in the body',
    setCookie.includes('fixitph_rt') && /httponly/i.test(setCookie) && !JSON.stringify(b).includes('refreshToken'),
    setCookie.slice(0, 160),
  );

  r = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${customerToken}` } });
  b = await json(r);
  check(
    'GET /api/auth/me identifies the caller',
    r.status === 200 && b.data.email === 'customer@fixitph.test' && b.data.role === 'CUSTOMER',
    JSON.stringify(b).slice(0, 200),
  );
  check('the me payload never contains the password hash', !JSON.stringify(b).toLowerCase().includes('passwordhash'));

  r = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: 'Bearer forged.token.value' } });
  check('a forged bearer token is rejected', r.status === 401, `status ${r.status}`);

  // -- role guard ------------------------------------------------------------
  console.log('\n== Role guard ==');
  r = await fetch(`${BASE}/api/admin/users`, { headers: { Authorization: `Bearer ${customerToken}` } });
  b = await json(r);
  check('a customer cannot reach /api/admin', r.status === 403 && b.code === 'INSUFFICIENT_ROLE', JSON.stringify(b));

  r = await fetch(`${BASE}/api/quotes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
    body: JSON.stringify({ serviceRequestId: '00000000-0000-4000-8000-000000000000', amount: 100 }),
  });
  b = await json(r);
  check('a customer cannot create a quote', r.status === 403 && b.code === 'INSUFFICIENT_ROLE', JSON.stringify(b));

  r = await fetch(`${BASE}/api/service-requests/feed`, { headers: { Authorization: `Bearer ${customerToken}` } });
  check('a customer cannot read the provider feed', r.status === 403, `status ${r.status}`);

  const adminBody = await json(
    await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@fixitph.test', password: 'DevPassword123!' }),
    }),
  );
  const adminToken = adminBody && adminBody.data && adminBody.data.accessToken;
  r = await fetch(`${BASE}/api/admin/users`, { headers: { Authorization: `Bearer ${adminToken}` } });
  b = await json(r);
  check(
    'an admin can list users',
    r.status === 200 && Array.isArray(b.data.items) && b.data.items.length >= 3,
    JSON.stringify(b).slice(0, 200),
  );

  // -- provider flow ---------------------------------------------------------
  console.log('\n== Provider flow ==');
  const providerBody = await json(
    await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'provider@fixitph.test', password: 'DevPassword123!' }),
    }),
  );
  const providerToken = providerBody && providerBody.data && providerBody.data.accessToken;

  r = await fetch(`${BASE}/api/service-requests/feed`, { headers: { Authorization: `Bearer ${providerToken}` } });
  b = await json(r);
  check('a provider can read the broadcast feed view', r.status === 200 && Array.isArray(b.data.items), JSON.stringify(b).slice(0, 200));

  r = await fetch(`${BASE}/api/services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${providerToken}` },
    body: JSON.stringify({
      categoryId: airconId,
      title: 'Priceless job',
      description: 'A description that is comfortably longer than twenty characters.',
      pricingType: 'FIXED',
    }),
  });
  b = await json(r);
  check('a FIXED service with no price is refused (PRICE_REQUIRED)', r.status === 400 && b.code === 'PRICE_REQUIRED', JSON.stringify(b));

  r = await fetch(`${BASE}/api/services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${providerToken}` },
    body: JSON.stringify({
      categoryId: airconId,
      title: 'Window type aircon cleaning',
      description: 'Cleaning for window type units, including the filter and the drain pan.',
      pricingType: 'PER_UNIT',
      price: 350,
      priceUnit: 'unit',
      status: 'ACTIVE',
    }),
  });
  b = await json(r);
  const serviceId = b && b.data && b.data.id;
  check('a verified provider can publish a service', r.status === 201 && !!serviceId, JSON.stringify(b).slice(0, 250));

  // -- cache invalidation on write ------------------------------------------
  console.log('\n== Cache invalidation ==');
  b = await json(await fetch(`${BASE}/api/services/${serviceId}`));
  check('the new service reads back at its original price', b.data && b.data.price === '350', JSON.stringify(b.data).slice(0, 150));

  r = await fetch(`${BASE}/api/services/${serviceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${providerToken}` },
    body: JSON.stringify({ price: 400 }),
  });
  b = await json(r);
  check('the owner can update the service', r.status === 200 && b.data.price === '400', JSON.stringify(b).slice(0, 200));

  b = await json(await fetch(`${BASE}/api/services/${serviceId}`));
  check('the updated price is served immediately, not the cached one', b.data && b.data.price === '400', JSON.stringify(b.data).slice(0, 150));

  // -- ownership guard -------------------------------------------------------
  console.log('\n== Ownership guard ==');
  r = await fetch(`${BASE}/api/services/${serviceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
    body: JSON.stringify({ price: 1 }),
  });
  b = await json(r);
  check("a customer cannot edit another account's service", r.status === 403 && b.code === 'NOT_RESOURCE_OWNER', JSON.stringify(b));

  // -- request / quote / booking / review ------------------------------------
  console.log('\n== Request, quote, booking, review ==');
  r = await fetch(`${BASE}/api/service-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
    body: JSON.stringify({
      categoryId: airconId,
      providerId: 'aaaaaaa1-0000-4000-8000-000000000001',
      title: 'Clean two split type units',
      description: 'Both bedroom units have not been cleaned in over a year and smell damp.',
      urgency: 'WITHIN_WEEK',
      city: 'Butuan City',
      barangay: 'Ampayon',
      addressLine1: '12 Narra Street',
    }),
  });
  b = await json(r);
  const requestId = b && b.data && b.data.id;
  check('a customer can post a service request', r.status === 201 && !!requestId, JSON.stringify(b).slice(0, 250));

  r = await fetch(`${BASE}/api/quotes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${providerToken}` },
    body: JSON.stringify({ serviceRequestId: requestId, amount: 900, notes: 'Includes freon top up.' }),
  });
  b = await json(r);
  const quoteId = b && b.data && b.data.id;
  check('the targeted provider can quote it', r.status === 201 && !!quoteId, JSON.stringify(b).slice(0, 250));

  r = await fetch(`${BASE}/api/quotes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${providerToken}` },
    body: JSON.stringify({ serviceRequestId: requestId, amount: 950 }),
  });
  b = await json(r);
  check('a second live quote from the same provider is refused', r.status === 409 && b.code === 'QUOTE_ALREADY_SENT', JSON.stringify(b));

  r = await fetch(`${BASE}/api/quotes/${quoteId}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${providerToken}` },
    body: JSON.stringify({ scheduledStart: new Date(Date.now() + 86400000).toISOString(), paymentMethod: 'GCASH' }),
  });
  b = await json(r);
  check('a provider cannot accept their own quote', r.status === 403, JSON.stringify(b));

  r = await fetch(`${BASE}/api/quotes/${quoteId}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
    body: JSON.stringify({ scheduledStart: new Date(Date.now() + 86400000).toISOString(), paymentMethod: 'GCASH' }),
  });
  b = await json(r);
  const bookingId = b && b.data && b.data.booking && b.data.booking.id;
  check('the customer accepting the quote creates a booking', r.status === 200 && !!bookingId, JSON.stringify(b).slice(0, 250));

  // Contact release, security design item 7.
  r = await fetch(`${BASE}/api/bookings/${bookingId}`, { headers: { Authorization: `Bearer ${providerToken}` } });
  b = await json(r);
  check(
    'before confirmation the provider sees the area but not the address',
    r.status === 200 &&
      b.data.customerContact &&
      b.data.customerContact.city === 'Butuan City' &&
      b.data.customerContact.addressLine1 === null &&
      b.data.customerContact.phone === null,
    JSON.stringify(b.data && b.data.customerContact),
  );

  r = await fetch(`${BASE}/api/bookings/${bookingId}/confirm`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${providerToken}` },
  });
  b = await json(r);
  check('the provider can confirm the booking', r.status === 200 && b.data.status === 'CONFIRMED', JSON.stringify(b).slice(0, 200));

  r = await fetch(`${BASE}/api/bookings/${bookingId}`, { headers: { Authorization: `Bearer ${providerToken}` } });
  b = await json(r);
  check(
    'after confirmation the exact address and phone are released',
    b.data.customerContact &&
      b.data.customerContact.addressLine1 === '12 Narra Street' &&
      b.data.customerContact.phone === '+639170000001',
    JSON.stringify(b.data && b.data.customerContact),
  );

  // Reviewing too early.
  r = await fetch(`${BASE}/api/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
    body: JSON.stringify({ bookingId, rating: 5, comment: 'Great work all round.' }),
  });
  b = await json(r);
  check('a review before completion is refused', r.status === 409 && b.code === 'BOOKING_NOT_COMPLETED', JSON.stringify(b));

  await fetch(`${BASE}/api/bookings/${bookingId}/start`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${providerToken}` },
  });
  r = await fetch(`${BASE}/api/bookings/${bookingId}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${providerToken}` },
    body: JSON.stringify({ finalAmount: 900, notes: 'Both units cleaned.' }),
  });
  b = await json(r);
  check('the provider can complete the booking', r.status === 200 && b.data.status === 'COMPLETED', JSON.stringify(b).slice(0, 200));
  check(
    'completing writes the append-only status history',
    Array.isArray(b.data.statusHistory) && b.data.statusHistory.length >= 4,
    JSON.stringify(b.data && b.data.statusHistory),
  );

  r = await fetch(`${BASE}/api/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
    body: JSON.stringify({ bookingId, rating: 6 }),
  });
  b = await json(r);
  check('a rating of 6 is refused by validation', r.status === 400 && b.code === 'VALIDATION_ERROR', JSON.stringify(b));

  r = await fetch(`${BASE}/api/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
    body: JSON.stringify({ bookingId, rating: 5, comment: 'On time and tidy, cleaned up after.' }),
  });
  b = await json(r);
  const reviewId = b && b.data && b.data.id;
  check('the customer can review the completed booking', r.status === 201 && !!reviewId, JSON.stringify(b).slice(0, 250));

  r = await fetch(`${BASE}/api/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
    body: JSON.stringify({ bookingId, rating: 3 }),
  });
  b = await json(r);
  check('a second review on the same booking is refused', r.status === 409 && b.code === 'REVIEW_ALREADY_EXISTS', JSON.stringify(b));

  r = await fetch(`${BASE}/api/providers/aaaaaaa1-0000-4000-8000-000000000001/reviews`);
  b = await json(r);
  check(
    'the review is publicly visible with a star breakdown',
    r.status === 200 && b.data.items.length === 1 && Array.isArray(b.data.breakdown),
    JSON.stringify(b).slice(0, 220),
  );

  r = await fetch(`${BASE}/api/providers/aaaaaaa1-0000-4000-8000-000000000001`);
  b = await json(r);
  check(
    'the provider rating aggregate was recomputed',
    b.data.ratingCount === 1 && String(b.data.ratingAvg) === '5',
    `count ${b.data && b.data.ratingCount}, avg ${b.data && b.data.ratingAvg}`,
  );

  // Review edit appends to history.
  r = await fetch(`${BASE}/api/reviews/${reviewId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
    body: JSON.stringify({ rating: 4, comment: 'On time and tidy, though he arrived late.' }),
  });
  b = await json(r);
  check('the author can edit their review', r.status === 200, JSON.stringify(b).slice(0, 200));

  const [historyRow] = await db.query(
    `SELECT jsonb_array_length(edit_history) AS n, comment FROM reviews WHERE id = '${reviewId}'`,
  ).then((res) => res.rows);
  check(
    'the previous version was appended to edit_history, not overwritten',
    Number(historyRow.n) === 1 && historyRow.comment.includes('arrived late'),
    JSON.stringify(historyRow),
  );

  r = await fetch(`${BASE}/api/reviews/${reviewId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${providerToken}` },
    body: JSON.stringify({ rating: 5 }),
  });
  b = await json(r);
  check('the provider cannot change the rating they were given', r.status === 403, JSON.stringify(b));

  r = await fetch(`${BASE}/api/reviews/${reviewId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${providerToken}` },
    body: JSON.stringify({ providerResponse: 'Thank you po, sorry for the delay.' }),
  });
  b = await json(r);
  check('the provider can post a response', r.status === 200 && !!b.data.providerResponse, JSON.stringify(b).slice(0, 200));

  // -- admin audit -----------------------------------------------------------
  console.log('\n== Admin audit trail ==');
  r = await fetch(`${BASE}/api/admin/users/11111111-1111-4111-8111-111111111111/suspend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ reason: 'Testing the audit trail end to end.' }),
  });
  b = await json(r);
  check('an admin can suspend a user', r.status === 200 && b.data.status === 'SUSPENDED', JSON.stringify(b).slice(0, 200));

  r = await fetch(`${BASE}/api/admin/audit-log`, { headers: { Authorization: `Bearer ${adminToken}` } });
  b = await json(r);
  check(
    'the suspension wrote a row to admin_actions',
    r.status === 200 && b.data.items.some((a) => a.actionType === 'USER_SUSPEND'),
    JSON.stringify(b).slice(0, 250),
  );

  r = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${customerToken}` } });
  check('a suspended user is rejected immediately, without waiting for the token to expire', r.status === 401, `status ${r.status}`);

  r = await fetch(`${BASE}/api/admin/users/11111111-1111-4111-8111-111111111111/suspend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ reason: 'short' }),
  });
  b = await json(r);
  check('a suspension without a real reason is refused', r.status === 400 && b.code === 'VALIDATION_ERROR', JSON.stringify(b));

  // -- CORS ------------------------------------------------------------------
  console.log('\n== CORS ==');
  r = await fetch(`${BASE}/api/categories`, { headers: { Origin: 'http://localhost:3001' } });
  check(
    'the frontend origin is allowed with credentials',
    r.headers.get('access-control-allow-origin') === 'http://localhost:3001' &&
      r.headers.get('access-control-allow-credentials') === 'true',
    `${r.headers.get('access-control-allow-origin')} / ${r.headers.get('access-control-allow-credentials')}`,
  );

  r = await fetch(`${BASE}/api/categories`, { headers: { Origin: 'https://evil.example.com' } });
  check('an origin outside the allow-list gets no CORS header', !r.headers.get('access-control-allow-origin'), String(r.headers.get('access-control-allow-origin')));

  // -- security headers ------------------------------------------------------
  console.log('\n== Security headers ==');
  r = await fetch(`${BASE}/health`);
  check('X-Content-Type-Options: nosniff', r.headers.get('x-content-type-options') === 'nosniff');
  check('X-Frame-Options is set', !!r.headers.get('x-frame-options'));
  check('X-Powered-By is removed', !r.headers.get('x-powered-by'), String(r.headers.get('x-powered-by')));

  // -- rate limiting ---------------------------------------------------------
  console.log('\n== Rate limiting ==');
  let limited = false;
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `spam${i}@fixitph.test`, password: 'WrongPassword1' }),
    });
    if (res.status === 429) {
      const body = await json(res);
      limited = body.code === 'RATE_LIMIT_EXCEEDED';
      break;
    }
  }
  check('repeated logins are throttled with RATE_LIMIT_EXCEEDED', limited);

  // Closed on a timer, not awaited: PGlite's socket server holds the last
  // connection open and app.close() waits on it forever.
  void app.close();
  void server.stop();

  console.log(`\n${'='.repeat(66)}`);
  console.log(`  ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('  API verified end to end.');
  process.exit(0);
})().catch((e) => {
  console.error('\nHARNESS ERROR:', e);
  process.exit(1);
});
