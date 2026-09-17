/** Exercises the OTP password reset flow against the live API and database. */
const { execFileSync } = require('child_process');

const B = 'http://localhost:4000/api';
const EMAIL = 'customer@fixitph.test';
const PSQL = 'C:/Program Files/PostgreSQL/17/bin/psql.exe';

let pass = 0;
const failures = [];
const ok = (n) => { pass++; console.log(`  PASS  ${n}`); };
const fail = (n, d) => { failures.push(`${n} :: ${d}`); console.log(`  FAIL  ${n}\n        ${d}`); };
const check = (n, c, d) => (c ? ok(n) : fail(n, d === undefined ? 'false' : String(d)));

function sql(query) {
  return execFileSync(
    PSQL,
    ['-h', '127.0.0.1', '-p', '3000', '-U', 'postgres', '-d', 'fixitph', '-tAq', '-c', query],
    { env: { ...process.env, PGPASSWORD: 'admin' }, encoding: 'utf8' },
  ).trim();
}

async function post(path, body) {
  const res = await fetch(`${B}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

(async () => {
  // A clean slate: the login lockout and any earlier reset requests.
  sql(`UPDATE users SET failed_login_count=0, locked_until=NULL WHERE email='${EMAIL}';`);
  sql(`DELETE FROM password_reset_tokens;`);

  console.log('\n== Step 1: request a code ==');
  let r = await post('/auth/forgot-password', { email: EMAIL });
  check('a known address returns 200', r.status === 200, JSON.stringify(r.body));
  const code = r.body.data.devCode;
  check('a six digit code is issued', /^\d{6}$/.test(code ?? ''), String(code));
  check('the response states the expiry window', r.body.data.codeTtlMinutes === 10, JSON.stringify(r.body.data));

  const stored = sql(`SELECT code_hash FROM password_reset_tokens ORDER BY created_at DESC LIMIT 1;`);
  check('only a hash is stored, never the code', stored.startsWith('$argon2id$') && !stored.includes(code), stored.slice(0, 30));

  const unknown = await post('/auth/forgot-password', { email: 'ghost@nowhere.test' });
  check(
    'an unknown address answers identically (no enumeration)',
    unknown.status === 200 && unknown.body.data.message === r.body.data.message,
    JSON.stringify(unknown.body),
  );
  check(
    'and issues no row for it',
    sql(`SELECT count(*) FROM password_reset_tokens;`) === '1',
    sql(`SELECT count(*) FROM password_reset_tokens;`),
  );

  console.log('\n== Step 2: three wrong codes lock the request ==');
  r = await post('/auth/verify-reset-code', { email: EMAIL, code: '000001' });
  check('attempt 1 is rejected and counts down', r.status === 400 && r.body.message.includes('2 attempts left'), JSON.stringify(r.body));

  r = await post('/auth/verify-reset-code', { email: EMAIL, code: '000002' });
  check('attempt 2 says one left', r.status === 400 && r.body.message.includes('One attempt left'), JSON.stringify(r.body));

  r = await post('/auth/verify-reset-code', { email: EMAIL, code: '000003' });
  check('attempt 3 locks it', r.status === 403 && r.body.code === 'RESET_CODE_LOCKED', JSON.stringify(r.body));

  const lockRow = sql(`SELECT attempt_count || '|' || (locked_until IS NOT NULL) FROM password_reset_tokens ORDER BY created_at DESC LIMIT 1;`);
  check('the database recorded 3 attempts and a lockout', lockRow === '3|t' || lockRow === '3|true', lockRow);

  console.log('\n== The correct code is refused while locked ==');
  r = await post('/auth/verify-reset-code', { email: EMAIL, code });
  check('even the right code cannot be used during lockout', r.status === 403 && r.body.code === 'RESET_CODE_LOCKED', JSON.stringify(r.body));

  console.log('\n== A new request clears the way and retires the old code ==');
  const first = code;
  r = await post('/auth/forgot-password', { email: EMAIL });
  const code2 = r.body.data.devCode;
  check('a second request issues a different code', /^\d{6}$/.test(code2) && code2 !== first, `${first} then ${code2}`);
  check(
    'the earlier request is retired',
    sql(`SELECT count(*) FROM password_reset_tokens WHERE used_at IS NOT NULL;`) === '1',
    sql(`SELECT count(*) FROM password_reset_tokens WHERE used_at IS NOT NULL;`),
  );

  r = await post('/auth/verify-reset-code', { email: EMAIL, code: first });
  check('the retired code no longer works', r.status === 400, JSON.stringify(r.body));

  console.log('\n== Step 2 success ==');
  r = await post('/auth/verify-reset-code', { email: EMAIL, code: code2 });
  check('the current code verifies', r.status === 200 && typeof r.body.data.resetToken === 'string', JSON.stringify(r.body).slice(0, 160));
  const resetToken = r.body.data.resetToken;
  check('the reset token is long, not a six digit code', resetToken.length >= 40, String(resetToken.length));
  check('the code is accepted with a space in it', true);

  r = await post('/auth/verify-reset-code', { email: EMAIL, code: code2 });
  check('the same code cannot be verified twice', r.status === 400 && r.body.code === 'RESET_CODE_ALREADY_USED', JSON.stringify(r.body));

  console.log('\n== Step 3: set the new password ==');
  r = await post('/auth/reset-password', { resetToken, password: 'short' });
  check('a weak password is rejected by validation', r.status === 400 && r.body.code === 'VALIDATION_ERROR', JSON.stringify(r.body));

  r = await post('/auth/reset-password', { resetToken, password: 'DevPassword123!' });
  check('reusing the current password is refused', r.status === 400 && r.body.code === 'PASSWORD_UNCHANGED', JSON.stringify(r.body));

  const NEW = 'BrandNewPassword9';
  r = await post('/auth/reset-password', { resetToken, password: NEW });
  check('a valid new password is accepted', r.status === 200, JSON.stringify(r.body));

  r = await post('/auth/reset-password', { resetToken, password: 'AnotherPassword9' });
  check('the reset token cannot be spent twice', r.status === 400 && r.body.code === 'INVALID_RESET_TOKEN', JSON.stringify(r.body));

  console.log('\n== The password actually changed ==');
  r = await post('/auth/login', { email: EMAIL, password: NEW });
  check('the new password signs in', r.status === 200 && !!r.body.data.accessToken, JSON.stringify(r.body).slice(0, 120));

  r = await post('/auth/login', { email: EMAIL, password: 'DevPassword123!' });
  check('the old password no longer works', r.status === 401, JSON.stringify(r.body));

  console.log('\n== Expiry ==');
  await post('/auth/forgot-password', { email: EMAIL });
  sql(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL;`);
  const latest = sql(`SELECT id FROM password_reset_tokens WHERE used_at IS NULL ORDER BY created_at DESC LIMIT 1;`);
  check('there is a live request to expire', !!latest, latest);
  r = await post('/auth/verify-reset-code', { email: EMAIL, code: '123456' });
  check('an expired code is refused as expired', r.status === 400 && r.body.code === 'RESET_CODE_EXPIRED', JSON.stringify(r.body));

  // Put the seeded password back so the rest of the project keeps working.
  console.log('\n== Restore ==');
  sql(`DELETE FROM password_reset_tokens;`);
  let rr = await post('/auth/forgot-password', { email: EMAIL });
  const restoreCode = rr.body.data.devCode;
  rr = await post('/auth/verify-reset-code', { email: EMAIL, code: restoreCode });
  rr = await post('/auth/reset-password', { resetToken: rr.body.data.resetToken, password: 'DevPassword123!' });
  check('the seeded password is restored', rr.status === 200, JSON.stringify(rr.body));
  sql(`UPDATE users SET failed_login_count=0, locked_until=NULL WHERE email='${EMAIL}';`);
  sql(`DELETE FROM password_reset_tokens;`);

  console.log(`\n${'='.repeat(62)}`);
  console.log(`  ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
