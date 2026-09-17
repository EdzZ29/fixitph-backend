/**
 * Applies the FixItPH migrations to an in-process PostgreSQL (PGlite) and
 * asserts that each business rule is enforced by the database itself.
 */
const fs = require('fs');
const path = require('path');
const BACKEND = path.resolve(__dirname, '..');
const { PGlite } = require(BACKEND + '/node_modules/@electric-sql/pglite');
const { citext } = require(BACKEND + '/node_modules/@electric-sql/pglite/dist/contrib/citext.cjs');

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

/** Assert the statement is rejected, optionally matching the error text. */
async function expectReject(db, name, sql, match) {
  try {
    await db.exec(sql);
    fail(name, 'statement was ACCEPTED but should have been rejected');
  } catch (e) {
    const msg = String(e.message || e);
    if (match && !msg.toLowerCase().includes(match.toLowerCase())) {
      fail(name, `rejected, but for the wrong reason: ${msg}`);
    } else {
      ok(name);
    }
  }
}

/** Assert the statement succeeds. */
async function expectAccept(db, name, sql) {
  try {
    await db.exec(sql);
    ok(name);
  } catch (e) {
    fail(name, `should have been accepted: ${e.message}`);
  }
}

async function expectRows(db, name, sql, expected) {
  try {
    const r = await db.query(sql);
    const got = Number(r.rows[0][Object.keys(r.rows[0])[0]]);
    if (got === expected) ok(`${name} (got ${got})`);
    else fail(name, `expected ${expected}, got ${got}`);
  } catch (e) {
    fail(name, `query errored: ${e.message}`);
  }
}

(async () => {
  const db = await PGlite.create({ extensions: { citext } });

  // ---- apply migrations -------------------------------------------------
  const migDir = path.join(BACKEND, 'prisma/migrations');
  const migrations = fs.readdirSync(migDir).filter((d) => !d.startsWith('.')).sort();
  console.log('\n== Applying migrations ==');
  for (const m of migrations) {
    const sql = fs.readFileSync(path.join(migDir, m, 'migration.sql'), 'utf8');
    try {
      await db.exec(sql);
      console.log(`  OK    ${m}`);
    } catch (e) {
      console.error(`  ERROR ${m}\n        ${e.message}`);
      process.exit(1);
    }
  }

  // ---- seed -------------------------------------------------------------
  console.log('\n== Seeding ==');
  await db.exec(`
    INSERT INTO users (id, email, phone, password_hash, role, status) VALUES
      ('11111111-1111-1111-1111-111111111111','customer@fixitph.test','+639170000001','x','CUSTOMER','ACTIVE'),
      ('22222222-2222-2222-2222-222222222222','provider@fixitph.test','+639170000002','x','PROVIDER','ACTIVE'),
      ('33333333-3333-3333-3333-333333333333','admin@fixitph.test','+639170000003','x','ADMIN','ACTIVE'),
      ('44444444-4444-4444-4444-444444444444','nosy@fixitph.test','+639170000004','x','CUSTOMER','ACTIVE');

    INSERT INTO profiles (user_id, first_name, last_name, city, barangay)
    VALUES ('11111111-1111-1111-1111-111111111111','Ana','Reyes','Butuan City','Ampayon');

    INSERT INTO providers (id, user_id, business_name, slug, base_city, verification_status, verified_at)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222',
            'Saavedra Aircon','saavedra-aircon','Butuan City','APPROVED', now());

    INSERT INTO categories (id, name, slug) VALUES
      ('cccccccc-0000-0000-0000-000000000001','Aircon','aircon');

    INSERT INTO services (id, provider_id, category_id, title, slug, description, pricing_type, price, price_unit, status)
    VALUES ('55555555-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',
            'cccccccc-0000-0000-0000-000000000001','Aircon cleaning','aircon-cleaning','Split type',
            'PER_UNIT', 450, 'unit', 'ACTIVE');

    INSERT INTO service_requests (id, customer_id, provider_id, category_id, title, description, city, barangay, address_line1, latitude, longitude, status)
    VALUES ('66666666-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
            'aaaaaaaa-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001',
            'Clean 2 units','Both bedrooms','Butuan City','Ampayon','12 Narra St', 8.947500, 125.540600, 'OPEN');

    INSERT INTO users (id, email, password_hash, role, status) VALUES
      ('55555555-5555-5555-5555-555555555555','rival@fixitph.test','x','PROVIDER','ACTIVE');
    INSERT INTO providers (id, user_id, business_name, slug, base_city)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000002','55555555-5555-5555-5555-555555555555',
            'Rival Aircon','rival-aircon','Butuan City');

    INSERT INTO quotes (id, service_request_id, provider_id, amount, status)
    VALUES ('77777777-0000-0000-0000-000000000001','66666666-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-000000000001', 900, 'PENDING');
  `);
  console.log('  OK    seed data');

  // =======================================================================
  console.log('\n== Rule 1: a service needs a price unless it is quote-only ==');
  await expectReject(
    db,
    'FIXED pricing with NULL price is rejected',
    `INSERT INTO services (provider_id, category_id, title, slug, description, pricing_type, price)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001','No price','no-price','x','FIXED',NULL);`,
    'services_price_required_unless_quote',
  );
  await expectAccept(
    db,
    'QUOTE_REQUIRED with NULL price is accepted',
    `INSERT INTO services (provider_id, category_id, title, slug, description, pricing_type, price)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001','Quoted job','quoted-job','x','QUOTE_REQUIRED',NULL);`,
  );
  await expectReject(
    db,
    'HOURLY pricing without a named unit is rejected',
    `INSERT INTO services (provider_id, category_id, title, slug, description, pricing_type, price)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001','Hourly','hourly','x','HOURLY',500);`,
    'services_unit_named_when_needed',
  );

  console.log('\n== Rule 2: unique keys the design depends on ==');
  await expectReject(db, 'users.email is unique and case-insensitive',
    `INSERT INTO users (email, password_hash) VALUES ('CUSTOMER@fixitph.test','x');`, 'users_email_key');
  await expectReject(db, 'providers.user_id is unique (one provider per user)',
    `INSERT INTO providers (user_id, business_name, slug, base_city)
     VALUES ('22222222-2222-2222-2222-222222222222','Second shop','second-shop','Butuan City');`, 'providers_user_id_key');
  await expectReject(db, 'providers.slug is unique, case-insensitively',
    `INSERT INTO providers (user_id, business_name, slug, base_city)
     VALUES ('11111111-1111-1111-1111-111111111111','Clash','Saavedra-Aircon','Butuan City');`, 'providers_slug_lower_unique');
  await expectReject(db, 'services (provider_id, slug) is unique',
    `INSERT INTO services (provider_id, category_id, title, slug, description, pricing_type, price, price_unit)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001','Dup','aircon-cleaning','x','PER_UNIT',1,'unit');`,
    'services_provider_id_slug_key');

  console.log('\n== Rule 3: one live quote per provider per request ==');
  await expectReject(db, 'a second PENDING quote from the same provider is rejected',
    `INSERT INTO quotes (service_request_id, provider_id, amount, status)
     VALUES ('66666666-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001', 950, 'PENDING');`,
    'quotes_one_live_per_provider_per_request');
  await expectAccept(db, 'a WITHDRAWN quote does not block re-quoting',
    `INSERT INTO quotes (id, service_request_id, provider_id, amount, status, responded_at)
     VALUES ('77777777-0000-0000-0000-00000000000f','66666666-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001', 960, 'WITHDRAWN', now());`);

  console.log('\n== Rule 4: one accepted quote per request, one booking per quote ==');
  await db.exec(`UPDATE quotes SET status='ACCEPTED', responded_at=now() WHERE id='77777777-0000-0000-0000-000000000001';`);
  // A DIFFERENT provider, so quotes_one_live_per_provider_per_request cannot be
  // the index that fires and we are genuinely testing the per-request one.
  await db.exec(`INSERT INTO quotes (id, service_request_id, provider_id, amount, status, responded_at)
     VALUES ('77777777-0000-0000-0000-000000000002','66666666-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000002', 800, 'REJECTED', now());`);
  await expectReject(db, 'a second ACCEPTED quote on the same request is rejected',
    `UPDATE quotes SET status='ACCEPTED' WHERE id='77777777-0000-0000-0000-000000000002';`,
    'quotes_one_accepted_per_request');

  await db.exec(`INSERT INTO bookings (id, quote_id, service_request_id, customer_id, provider_id, scheduled_start, total_amount)
    VALUES ('88888888-0000-0000-0000-000000000001','77777777-0000-0000-0000-000000000001','66666666-0000-0000-0000-000000000001',
            '11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001', now() + interval '2 days', 900);`);
  await expectReject(db, 'a quote cannot produce a second booking',
    `INSERT INTO bookings (quote_id, service_request_id, customer_id, provider_id, scheduled_start, total_amount)
     VALUES ('77777777-0000-0000-0000-000000000001','66666666-0000-0000-0000-000000000001',
             '11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001', now() + interval '3 days', 900);`,
    'bookings_quote_id_key');

  console.log('\n== Rule 5: the exact address is released only on confirmation ==');
  await expectReject(db, 'contact cannot be released while PENDING_CONFIRMATION',
    `UPDATE bookings SET contact_released_at = now() WHERE id='88888888-0000-0000-0000-000000000001';`,
    'bookings_contact_release_requires_confirmation');

  await db.exec(`SELECT set_config('app.current_user_id','22222222-2222-2222-2222-222222222222', false);
                 SELECT set_config('app.current_role','PROVIDER', false);`);
  await expectRows(db, 'before confirmation the view hides the street address',
    `SELECT count(*) FROM booking_contact_for_provider
      WHERE booking_id='88888888-0000-0000-0000-000000000001'
        AND customer_address_line1 IS NULL AND customer_phone IS NULL
        AND customer_city = 'Butuan City' AND customer_barangay = 'Ampayon';`, 1);

  await db.exec(`UPDATE bookings SET status='CONFIRMED', contact_released_at = now() WHERE id='88888888-0000-0000-0000-000000000001';`);
  await expectRows(db, 'after confirmation the view reveals address, phone and coordinates',
    `SELECT count(*) FROM booking_contact_for_provider
      WHERE booking_id='88888888-0000-0000-0000-000000000001'
        AND customer_address_line1 = '12 Narra St'
        AND customer_phone = '+639170000001'
        AND customer_latitude IS NOT NULL;`, 1);
  await expectRows(db, 'the feed view exposes no customer identity or address columns',
    `SELECT count(*) FROM information_schema.columns
      WHERE table_name='open_service_request_feed'
        AND column_name IN ('customer_id','address_line1','latitude','longitude');`, 0);

  console.log('\n== Rule 6: the booking status trail is written and immutable ==');
  await expectRows(db, 'INSERT and the CONFIRMED update both logged',
    `SELECT count(*) FROM booking_status_history WHERE booking_id='88888888-0000-0000-0000-000000000001';`, 2);
  await expectRows(db, 'the transition recorded from_status and to_status',
    `SELECT count(*) FROM booking_status_history
      WHERE booking_id='88888888-0000-0000-0000-000000000001'
        AND from_status='PENDING_CONFIRMATION' AND to_status='CONFIRMED';`, 1);
  await expectReject(db, 'history rows cannot be updated',
    `UPDATE booking_status_history SET reason='rewritten';`, 'append only');
  await expectReject(db, 'history rows cannot be deleted',
    `DELETE FROM booking_status_history;`, 'append only');

  console.log('\n== Rule 7: reviews only on your own completed booking, 1 to 5 ==');
  await expectReject(db, 'a review on a booking that is not COMPLETED is rejected',
    `INSERT INTO reviews (booking_id, author_id, provider_id, rating)
     VALUES ('88888888-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',5);`,
    'COMPLETED');

  await db.exec(`UPDATE bookings SET status='COMPLETED', completed_at=now() WHERE id='88888888-0000-0000-0000-000000000001';`);
  await expectReject(db, 'rating 6 is rejected',
    `INSERT INTO reviews (booking_id, author_id, provider_id, rating)
     VALUES ('88888888-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',6);`,
    'reviews_rating_range');
  await expectReject(db, 'rating 0 is rejected',
    `INSERT INTO reviews (booking_id, author_id, provider_id, rating)
     VALUES ('88888888-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',0);`,
    'reviews_rating_range');
  await expectReject(db, 'a stranger cannot review someone else\'s booking',
    `INSERT INTO reviews (booking_id, author_id, provider_id, rating)
     VALUES ('88888888-0000-0000-0000-000000000001','44444444-4444-4444-4444-444444444444','aaaaaaaa-0000-0000-0000-000000000001',1);`,
    'only the booking customer');
  await expectAccept(db, 'the customer can review their own completed booking',
    `INSERT INTO reviews (id, booking_id, author_id, provider_id, rating, comment)
     VALUES ('99999999-0000-0000-0000-000000000001','88888888-0000-0000-0000-000000000001',
             '11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',5,'On time and tidy');`);
  await expectReject(db, 'a second review on the same booking is rejected',
    `INSERT INTO reviews (booking_id, author_id, provider_id, rating)
     VALUES ('88888888-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',4);`,
    'reviews_booking_id_key');

  console.log('\n== Rule 8: review edits append, they never overwrite ==');
  await db.exec(`SELECT set_config('app.current_user_id','11111111-1111-1111-1111-111111111111', false);
                 SELECT set_config('app.current_role','CUSTOMER', false);`);
  await expectReject(db, 'editing the comment without appending history is rejected',
    `UPDATE reviews SET comment='Actually terrible' WHERE id='99999999-0000-0000-0000-000000000001';`,
    'append');
  await expectAccept(db, 'editing while appending the previous version is accepted',
    `UPDATE reviews
        SET comment='On time, tidy, slightly late',
            edit_history = edit_history || jsonb_build_object('comment','On time and tidy','rating',5,'editedAt', now())
      WHERE id='99999999-0000-0000-0000-000000000001';`);
  await expectRows(db, 'the original comment is still in edit_history',
    `SELECT count(*) FROM reviews
      WHERE id='99999999-0000-0000-0000-000000000001'
        AND edit_history @> '[{"comment":"On time and tidy"}]'::jsonb;`, 1);
  await expectReject(db, 'edit_history cannot be truncated',
    `UPDATE reviews SET edit_history='[]'::jsonb WHERE id='99999999-0000-0000-0000-000000000001';`,
    'append only');

  await db.exec(`SELECT set_config('app.current_user_id','22222222-2222-2222-2222-222222222222', false);
                 SELECT set_config('app.current_role','PROVIDER', false);`);
  await expectReject(db, 'the provider cannot change the rating they were given',
    `UPDATE reviews SET rating=1 WHERE id='99999999-0000-0000-0000-000000000001';`,
    'only the review author');
  await expectAccept(db, 'the provider can add a response',
    `UPDATE reviews SET provider_response='Thank you po', provider_responded_at=now()
      WHERE id='99999999-0000-0000-0000-000000000001';`);

  console.log('\n== Rule 9: soft delete only ==');
  for (const t of ['users', 'services', 'bookings', 'reviews']) {
    await expectReject(db, `hard DELETE on ${t} is refused by trigger`,
      `DELETE FROM ${t} WHERE id IS NOT NULL;`, 'set deleted_at instead');
  }

  console.log('\n== Rule 10: the admin audit log only grows ==');
  await db.exec(`SELECT set_config('app.current_user_id','33333333-3333-3333-3333-333333333333', false);
                 SELECT set_config('app.current_role','ADMIN', false);`);
  await expectAccept(db, 'an admin action can be inserted',
    `INSERT INTO admin_actions (id, admin_id, action_type, target_type, target_id, reason)
     VALUES ('abababab-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333',
             'PROVIDER_VERIFICATION_APPROVE','PROVIDER','aaaaaaaa-0000-0000-0000-000000000001','docs checked');`);
  await expectReject(db, 'an admin action cannot be updated', `UPDATE admin_actions SET reason='changed';`, 'append only');
  await expectReject(db, 'an admin action cannot be deleted', `DELETE FROM admin_actions;`, 'append only');

  // =======================================================================
  console.log('\n== Row level security, acting as the runtime role ==');
  // The runtime role is not the owner, so policies are evaluated.
  await db.exec(`GRANT fixitph_app TO CURRENT_USER;`).catch(() => {});

  async function asUser(userId, role, fn) {
    await db.exec(`SET ROLE fixitph_app;
                   SELECT set_config('app.current_user_id','${userId}', false);
                   SELECT set_config('app.current_role','${role}', false);`);
    try {
      await fn();
    } finally {
      await db.exec(`RESET ROLE;`);
    }
  }

  await expectRows(db, 'sanity: the runtime role cannot bypass RLS',
    `SELECT count(*) FROM pg_roles WHERE rolname='fixitph_app' AND rolbypassrls = false AND rolsuper = false;`, 1);
  await expectRows(db, 'sanity: RLS is enabled on all eight protected tables',
    `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relrowsecurity
        AND c.relname IN ('bookings','service_requests','quotes','messages','reviews','provider_documents','admin_actions','booking_status_history');`, 8);

  await asUser('11111111-1111-1111-1111-111111111111', 'CUSTOMER', async () => {
    await expectRows(db, 'the customer sees their own booking', `SELECT count(*) FROM bookings;`, 1);
    await expectRows(db, 'the customer sees their own request', `SELECT count(*) FROM service_requests;`, 1);
    await expectRows(db, 'the customer sees quotes on their request', `SELECT count(*) FROM quotes;`, 3);
    await expectRows(db, 'the customer cannot read the admin log', `SELECT count(*) FROM admin_actions;`, 0);
    await expectRows(db, 'the customer cannot read provider documents', `SELECT count(*) FROM provider_documents;`, 0);
  });

  await asUser('44444444-4444-4444-4444-444444444444', 'CUSTOMER', async () => {
    await expectRows(db, 'an unrelated customer sees no bookings', `SELECT count(*) FROM bookings;`, 0);
    await expectRows(db, 'an unrelated customer sees no requests', `SELECT count(*) FROM service_requests;`, 0);
    await expectRows(db, 'an unrelated customer sees no quotes', `SELECT count(*) FROM quotes;`, 0);
    await expectRows(db, 'an unrelated customer sees no status history', `SELECT count(*) FROM booking_status_history;`, 0);
    await expectRows(db, 'reviews stay publicly readable', `SELECT count(*) FROM reviews;`, 1);
  });

  await asUser('22222222-2222-2222-2222-222222222222', 'PROVIDER', async () => {
    await expectRows(db, 'the provider sees the booking tied to their provider_id', `SELECT count(*) FROM bookings;`, 1);
    // Two of the three quotes on that request are theirs. The rival provider's
    // quote on the same request stays invisible, which is the point.
    await expectRows(db, 'the provider sees only their own quotes', `SELECT count(*) FROM quotes;`, 2);
    await expectRows(db, 'a provider cannot see a rival quote on the same request',
      `SELECT count(*) FROM quotes WHERE provider_id='aaaaaaaa-0000-0000-0000-000000000002';`, 0);
    await expectRows(db, 'the provider sees the status history of their booking', `SELECT count(*) FROM booking_status_history;`, 3);
    await expectRows(db, 'the provider cannot read the admin log', `SELECT count(*) FROM admin_actions;`, 0);
  });

  await asUser('33333333-3333-3333-3333-333333333333', 'ADMIN', async () => {
    await expectRows(db, 'the admin sees every booking', `SELECT count(*) FROM bookings;`, 1);
    await expectRows(db, 'the admin reads the audit log', `SELECT count(*) FROM admin_actions;`, 1);
  });

  // Anonymous: no session variables at all.
  await db.exec(`SET ROLE fixitph_app;
                 SELECT set_config('app.current_user_id','', false);
                 SELECT set_config('app.current_role','', false);`);
  await expectRows(db, 'anonymous sees no bookings', `SELECT count(*) FROM bookings;`, 0);
  await expectRows(db, 'anonymous sees no quotes', `SELECT count(*) FROM quotes;`, 0);
  await expectRows(db, 'anonymous sees no messages', `SELECT count(*) FROM messages;`, 0);
  await expectRows(db, 'anonymous can still read public reviews', `SELECT count(*) FROM reviews;`, 1);
  await db.exec(`RESET ROLE;`);

  console.log('\n== Privilege baseline ==');
  await expectRows(db, 'the runtime role has no DELETE on the soft-delete tables',
    `SELECT count(*) FROM (VALUES ('users'),('services'),('bookings'),('reviews')) t(n)
      WHERE has_table_privilege('fixitph_app', t.n, 'DELETE');`, 0);
  await expectRows(db, 'the runtime role cannot write booking_status_history directly',
    `SELECT count(*) FROM (VALUES ('INSERT'),('UPDATE'),('DELETE')) p(m)
      WHERE has_table_privilege('fixitph_app','booking_status_history', p.m);`, 0);
  await expectRows(db, 'the runtime role cannot mutate admin_actions',
    `SELECT count(*) FROM (VALUES ('UPDATE'),('DELETE')) p(m)
      WHERE has_table_privilege('fixitph_app','admin_actions', p.m);`, 0);
  await expectRows(db, 'the runtime role can still insert admin_actions',
    `SELECT CASE WHEN has_table_privilege('fixitph_app','admin_actions','INSERT') THEN 1 ELSE 0 END;`, 1);

  console.log('\n== Other guarantees ==');
  await expectReject(db, 'a message must hang off exactly one thread anchor',
    `INSERT INTO messages (sender_id, recipient_id, body) VALUES
     ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','hi');`,
    'messages_exactly_one_anchor');
  await expectReject(db, 'a booking cannot end before it starts',
    `UPDATE bookings SET scheduled_end = scheduled_start - interval '1 hour';`, 'bookings_schedule_ordered');
  await expectReject(db, 'a category cannot be its own parent',
    `UPDATE categories SET parent_id = id;`, 'categories_not_own_parent');
  await expectReject(db, 'latitude outside -90..90 is rejected',
    `UPDATE profiles SET latitude = 120;`, 'profiles_latitude_range');
  await expectReject(db, 'a favorite cannot be duplicated (composite PK)',
    `INSERT INTO favorites (customer_id, provider_id) VALUES
      ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001'),
      ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001');`,
    'favorites_pkey');

  // ---- report -----------------------------------------------------------
  console.log(`\n${'='.repeat(64)}`);
  console.log(`  ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('  All database-level guarantees verified.');
  process.exit(0);
})().catch((e) => {
  console.error('\nHARNESS ERROR:', e);
  process.exit(1);
});
