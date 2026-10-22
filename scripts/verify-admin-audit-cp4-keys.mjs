// Synthetic, in-memory crypto checks only. No packet writes, Docker, SQL or network.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeFiles } from './admin-audit-cp4-compose.mjs';

const readEnv = (files, name) => Object.fromEntries(files[`private/${name}.env`].trim().split('\n')
  .map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));

export function assertCp4KeyContracts(files) {
  let checks = 0;
  const check = (value, label) => { assert.ok(Boolean(value), label); checks++; };
  const auth = readEnv(files, 'auth'), rest = readEnv(files, 'rest');
  const realtime = readEnv(files, 'realtime'), db = readEnv(files, 'db'), client = readEnv(files, 'client');
  const signing = JSON.parse(auth.GOTRUE_JWT_KEYS), jwks = JSON.parse(rest.PGRST_JWT_SECRET);
  check(signing.length === 2 && jwks.keys.length === 2, 'Two existing JWK entries retained');
  const selected = signing.filter(key => key.key_ops?.includes('sign'));
  check(selected.length === 1, 'Exactly one explicitly selectable Auth signing key');
  const privateEc = selected[0], publicEc = jwks.keys.find(key => key.kid === privateEc.kid);
  check(privateEc.key_ops.join(',') === 'sign,verify', 'Private ES256 operations follow Supabase convention');
  check(privateEc.kty === 'EC' && privateEc.alg === 'ES256' && privateEc.crv === 'P-256' &&
    privateEc.use === 'sig' && typeof privateEc.d === 'string', 'Private P-256 signing material retained');
  check(publicEc?.key_ops?.join(',') === 'verify', 'Public ES256 key permits verification only');
  check(['kty', 'alg', 'crv', 'use', 'kid', 'x', 'y'].every(name => publicEc[name] === privateEc[name]),
    'Matching ES256 key identity and public coordinates');
  check(jwks.keys.every(key => ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'].every(name => !Object.hasOwn(key, name))),
    'Verification JWKS never includes asymmetric private material');
  check(Object.keys(publicEc).sort().join(',') === 'alg,crv,key_ops,kid,kty,use,x,y', 'Public EC field allowlist');
  check(new Set(signing.map(key => key.kid)).size === 2 && signing.every(key =>
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(key.kid)), 'Existing unique UUID key IDs retained');

  const privateKey = crypto.createPrivateKey({ key: privateEc, format: 'jwk' });
  const publicKey = crypto.createPublicKey({ key: publicEc, format: 'jwk' });
  const header = { alg: 'ES256', typ: 'JWT', kid: privateEc.kid };
  const body = [header, { sub: 'offline-synthetic-only', role: 'authenticated' }]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  const signature = crypto.sign('sha256', Buffer.from(body), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  check(signature.length === 64 && crypto.verify('sha256', Buffer.from(body),
    { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature), 'Selected signing key produces a verifiable ES256 JWT');
  check(!crypto.verify('sha256', Buffer.from(body + 'tampered'),
    { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature), 'Tampered ES256 payload rejected');
  check(realtime.API_JWT_JWKS === rest.PGRST_JWT_SECRET, 'PostgREST and Realtime share verification JWKS');
  check(auth.GOTRUE_JWT_SECRET === db.JWT_SECRET && realtime.API_JWT_SECRET === db.JWT_SECRET,
    'Cross-service legacy secret remains consistent');
  const legacy = signing.find(key => key.alg === 'HS256');
  const publicLegacy = jwks.keys.find(key => key.kid === legacy?.kid);
  check(legacy?.kty === 'oct' && legacy.use === 'sig' && publicLegacy?.alg === 'HS256', 'Legacy HS256 entry retained');
  check(!Object.hasOwn(legacy, 'key_ops') && !Object.hasOwn(publicLegacy, 'key_ops'), 'Legacy key operations unchanged');
  check(JSON.stringify(legacy) === JSON.stringify(publicLegacy) &&
    Buffer.from(legacy.k, 'base64url').toString() === db.JWT_SECRET, 'Legacy symmetric verification key remains consistent');
  const gateway = JSON.parse(files['private/kong.json']);
  for (const [name, role, index] of [['MC_CP4_ANON_KEY', 'anon', 0], ['MC_CP4_SERVICE_KEY', 'service_role', 1]]) {
    const [encodedHeader, encodedBody, encodedSignature] = client[name].split('.');
    const apiHeader = JSON.parse(Buffer.from(encodedHeader, 'base64url'));
    const payload = JSON.parse(Buffer.from(encodedBody, 'base64url'));
    check(apiHeader.alg === 'HS256' && apiHeader.typ === 'JWT' && payload.iss === 'supabase' && payload.role === role,
      'Existing API-key algorithm, issuer and role preserved');
    check(Number.isInteger(payload.iat) && payload.exp - payload.iat === 86400, 'API-key expiration remains 24 hours');
    const expected = crypto.createHmac('sha256', db.JWT_SECRET).update(`${encodedHeader}.${encodedBody}`).digest();
    const actual = Buffer.from(encodedSignature, 'base64url');
    check(actual.length === expected.length && crypto.timingSafeEqual(actual, expected), 'Legacy API-key signature remains valid');
    check(gateway.consumers[index].keyauth_credentials[0].key === client[name], 'Kong and client API keys remain consistent');
  }
  return checks;
}

const main = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (main) {
  try {
    const files = composeFiles('0123456789abcdef0123456789abcdef', '-- In-memory signing fixture; never execute.', 1700000000).files;
    let checks = assertCp4KeyContracts(files);
    const withJwks = (name, variable, mutate) => {
      const env = readEnv(files, name), value = JSON.parse(env[variable]);
      mutate(value); env[variable] = JSON.stringify(value);
      return { ...files, [`private/${name}.env`]: Object.entries(env).map(([key, item]) => `${key}=${item}`).join('\n') + '\n' };
    };
    for (const broken of [
      withJwks('auth', 'GOTRUE_JWT_KEYS', keys => { delete keys[0].key_ops; }),
      withJwks('auth', 'GOTRUE_JWT_KEYS', keys => { keys[0].key_ops = ['verify']; }),
      withJwks('rest', 'PGRST_JWT_SECRET', jwks => { jwks.keys[0].key_ops = ['sign', 'verify']; }),
      withJwks('rest', 'PGRST_JWT_SECRET', jwks => { jwks.keys[0].d = 'synthetic-forbidden-private-field'; }),
      withJwks('rest', 'PGRST_JWT_SECRET', jwks => { jwks.keys[0].kid = 'mismatched-synthetic-id'; }),
      withJwks('auth', 'GOTRUE_JWT_KEYS', keys => { keys[1].key_ops = ['sign']; }),
    ]) {
      assert.throws(() => assertCp4KeyContracts(broken)); checks++;
    }
    console.log(`PASS: ${checks} CP4 key assertions; 0 failures. Synthetic in-memory keys only; no disk packet, network, Docker or SQL.`);
  } catch (error) {
    console.error(error.code === 'ERR_ASSERTION' ? `FAIL: ${error.message}` : 'FAIL: Offline key contract could not be validated.');
    process.exitCode = 1;
  }
}
