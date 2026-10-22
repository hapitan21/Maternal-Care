// Pure preparation/validation. This module never invokes Docker or executes SQL.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const assetDir = fileURLToPath(new URL('../docs/rehearsal/admin-audit-cp4/', import.meta.url));
export const sourceProject = 'mc-audit-cp4-strict-3bd79bb163bc401ba28d6be57fc4fd1f';
export const startupHash = '6f995b129657d28b15a97a1c8a957a7c0015a9865880747c25ad00e3b6d7dd86';
export const images = {
  db: 'public.ecr.aws/supabase/postgres@sha256:0450166354dc9c1d25f0322ac8b580774d4fb0184d2b087f6e4fe9499c66cf53',
  kong: 'public.ecr.aws/supabase/kong@sha256:1b53405d8680a09d6f44494b7990bf7da2ea43f84a258c59717d4539abf09f6d',
  auth: 'public.ecr.aws/supabase/gotrue@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b',
  rest: 'public.ecr.aws/supabase/postgrest@sha256:d155c6718ed9a9f990d159a2ab7c0a3f16944dbb6d0a0344557421042acfe0df',
  realtime: 'public.ecr.aws/supabase/realtime@sha256:f66c721c71b576f5854c78f86df0c78a98368d900dcf62e4ddd96c6913139999',
};
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
export function composeDefinition(nonce) {
  assert(nonce === '__CP4_NONCE__' || /^[a-f0-9]{32}$/.test(nonce), 'Invalid Compose nonce');
  const project = `mc-audit-cp4-compose-${nonce}`;
  const service = (name, env, test, aliases = [name]) => ({ image: images[name], pull_policy: 'never', restart: 'no',
    labels: { 'maternal.audit.cp4.nonce': nonce, 'maternal.audit.cp4.synthetic': 'true' },
    networks: { isolated: { aliases } }, environment: env,
    env_file: name === 'kong' ? [] : [{ path: `./private/${name}.env`, format: 'raw' }],
    healthcheck: { test, interval: '5s', timeout: '5s', retries: 12, start_period: '30s' },
    ...(name === 'db' ? {} : { depends_on: { db: { condition: 'service_healthy' } } }) });
  const db = service('db', { POSTGRES_USER: 'supabase_admin', POSTGRES_DB: 'postgres', POSTGRES_HOST: '/var/run/postgresql', PGDATA: '/var/lib/postgresql/data', JWT_EXP: '3600' },
    ['CMD-SHELL', 'pg_isready -U postgres -h 127.0.0.1 -p 5432'], ['db', 'db.supabase.internal']);
  db.entrypoint = ['sh', '/cp4/db-start.sh'];
  db.volumes = [{ type: 'volume', source: 'database', target: '/var/lib/postgresql/data' },
    { type: 'bind', source: './db-start.sh', target: '/cp4/db-start.sh', read_only: true, bind: { create_host_path: false } }];
  const auth = service('auth', { GOTRUE_API_HOST: '0.0.0.0', GOTRUE_API_PORT: '9999', GOTRUE_DB_DRIVER: 'postgres',
    API_EXTERNAL_URL: 'http://127.0.0.1:55421/auth/v1', GOTRUE_SITE_URL: 'http://127.0.0.1:58973',
    GOTRUE_URI_ALLOW_LIST: 'http://127.0.0.1:58973', GOTRUE_JWT_ISSUER: 'http://127.0.0.1:55421/auth/v1',
    GOTRUE_JWT_AUD: 'authenticated', GOTRUE_JWT_ADMIN_ROLES: 'service_role', GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
    GOTRUE_JWT_EXP: '3600', GOTRUE_DISABLE_SIGNUP: 'true', GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true',
    GOTRUE_MAILER_AUTOCONFIRM: 'true', GOTRUE_EXTERNAL_PHONE_ENABLED: 'false', GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: 'false',
    GOTRUE_SMTP_HOST: '', GOTRUE_HOOK_SEND_SMS_ENABLED: 'false', GOTRUE_HOOK_SEND_EMAIL_ENABLED: 'false',
    GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED: 'true' },
  ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://127.0.0.1:9999/health']);
  const rest = service('rest', { PGRST_DB_SCHEMAS: 'public', PGRST_DB_EXTRA_SEARCH_PATH: 'public,extensions',
    PGRST_DB_ANON_ROLE: 'anon', PGRST_DB_MAX_ROWS: '1000', PGRST_ADMIN_SERVER_PORT: '3001', PGRST_SERVER_HOST: '0.0.0.0' },
  ['CMD', '/bin/postgrest', '--ready']);
  const realtime = service('realtime', { DB_HOST: 'db', DB_PORT: '5432', DB_USER: 'supabase_admin', DB_NAME: 'postgres',
    DB_AFTER_CONNECT_QUERY: 'SET search_path TO _realtime', DB_IP_VERSION: 'ipv4', PORT: '4000', APP_NAME: 'realtime',
    SEED_SELF_HOST: 'true', SELF_HOST_TENANT_NAME: 'realtime-dev', RUN_JANITOR: 'true', ERL_AFLAGS: '-proto_dist inet_tcp',
    RLIMIT_NOFILE: '65536' },
  ['CMD-SHELL', 'curl -sSf --head -o /dev/null -H Host:realtime-dev http://127.0.0.1:4000/api/ping'], ['realtime', 'realtime-dev']);
  realtime.ulimits = { nofile: { soft: 65536, hard: 65536 } };
  const kong = service('kong', { KONG_DATABASE: 'off', KONG_DECLARATIVE_CONFIG: '/cp4/kong.json',
    KONG_PLUGINS: 'cors,request-transformer,key-auth', KONG_PROXY_LISTEN: '0.0.0.0:8000', KONG_ADMIN_LISTEN: 'off',
    KONG_NGINX_WORKER_PROCESSES: '1', KONG_DNS_ORDER: 'LAST,A,CNAME', KONG_DNS_NOT_FOUND_TTL: '1' },
  ['CMD', 'kong', 'health'], ['kong', 'api.supabase.internal']);
  kong.depends_on = Object.fromEntries(['auth', 'rest', 'realtime'].map(name => [name, { condition: 'service_healthy' }]));
  kong.networks.gateway = {};
  kong.ports = [{ target: 8000, published: '55421', host_ip: '127.0.0.1', protocol: 'tcp' }];
  kong.volumes = [{ type: 'bind', source: './private/kong.json', target: '/cp4/kong.json', read_only: true, bind: { create_host_path: false } }];
  return { name: project, services: { db, auth, rest, realtime, kong },
    networks: { isolated: { name: `${project}-net`, driver: 'bridge', internal: true,
      labels: { 'maternal.audit.cp4.nonce': nonce },
      driver_opts: { 'com.docker.network.bridge.host_binding_ipv4': '127.0.0.1' } },
    gateway: { name: `${project}-gateway`, driver: 'bridge', internal: false,
      labels: { 'maternal.audit.cp4.nonce': nonce },
      driver_opts: { 'com.docker.network.bridge.host_binding_ipv4': '127.0.0.1' } } },
    volumes: { database: { name: `${project}-db`, labels: { 'maternal.audit.cp4.nonce': nonce } } } };
}
function credentials(now) {
  const secret = crypto.randomBytes(32).toString('hex'), password = crypto.randomBytes(24).toString('hex');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const common = { kid: crypto.randomUUID(), alg: 'ES256', use: 'sig' };
  const legacy = { kty: 'oct', k: Buffer.from(secret).toString('base64url'), alg: 'HS256', kid: crypto.randomUUID(), use: 'sig' };
  const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), ...common, key_ops: ['verify'] }, legacy] };
  const signingKeys = [{ ...privateKey.export({ format: 'jwk' }), ...common, key_ops: ['sign', 'verify'] }, legacy];
  const token = role => {
    const body = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
      Buffer.from(JSON.stringify({ iss: 'supabase', role, iat: now, exp: now + 86400 })).toString('base64url')].join('.');
    return body + '.' + crypto.createHmac('sha256', secret).update(body).digest('base64url');
  };
  return { secret, password, jwks, signingKeys, anon: token('anon'), service: token('service_role') };
}
export function composeFiles(nonce, sql, now = Math.floor(Date.now() / 1000)) {
  assert(/^[a-f0-9]{32}$/.test(nonce), 'A fresh Compose nonce is required');
  const c = composeDefinition(nonce), keys = credentials(now);
  const startup = fs.readFileSync(path.join(assetDir, 'db-start.sh'), 'utf8');
  assert.equal(digest(startup), startupHash, 'Reviewed database startup asset changed');
  const privateEnv = {
    db: { POSTGRES_PASSWORD: keys.password, PGPASSWORD: keys.password, JWT_SECRET: keys.secret },
    auth: { GOTRUE_DB_DATABASE_URL: `postgres://supabase_auth_admin:${keys.password}@db:5432/postgres`, GOTRUE_JWT_SECRET: keys.secret, GOTRUE_JWT_KEYS: JSON.stringify(keys.signingKeys) },
    rest: { PGRST_DB_URI: `postgres://authenticator:${keys.password}@db:5432/postgres`, PGRST_JWT_SECRET: JSON.stringify(keys.jwks) },
    realtime: { DB_PASSWORD: keys.password, API_JWT_SECRET: keys.secret, API_JWT_JWKS: JSON.stringify(keys.jwks),
      METRICS_JWT_SECRET: crypto.randomBytes(32).toString('hex'), DB_ENC_KEY: crypto.randomBytes(8).toString('hex'), SECRET_KEY_BASE: crypto.randomBytes(64).toString('hex') },
  };
  const route = (name, url, prefix) => ({ name, url, routes: [{ name, paths: [prefix], strip_path: true }], plugins: [
    { name: 'cors', config: { origins: ['http://127.0.0.1:58973'], headers: ['Authorization', 'apikey', 'Content-Type', 'Prefer', 'X-Client-Info', 'X-Supabase-Api-Version'], exposed_headers: ['Content-Range'], credentials: true } },
    { name: 'key-auth', config: { key_names: ['apikey'], hide_credentials: false, run_on_preflight: false } },
    // "add" preserves an existing user Authorization header; never replace it with an API-key JWT.
    { name: 'request-transformer', config: { add: { headers: [`Authorization:Bearer ${keys.anon}`] } } },
  ] });
  const gateway = { _format_version: '2.1', _transform: true,
    consumers: [{ username: 'cp4-anon', keyauth_credentials: [{ key: keys.anon }] }, { username: 'cp4-service', keyauth_credentials: [{ key: keys.service }] }],
    services: [route('auth-v1', 'http://auth:9999/', '/auth/v1/'), route('rest-v1', 'http://rest:3000/', '/rest/v1/'),
      route('realtime-ws', 'http://realtime-dev:4000/socket', '/realtime/v1/'), route('realtime-api', 'http://realtime-dev:4000/api', '/realtime/v1/api')] };
  const manifest = { version: 1, runtime: 'docker-compose', syntheticOnly: true, launchApproved: false,
    nonce, project: c.name, sourceProject, apiOrigin: 'http://127.0.0.1:55421', databaseName: 'postgres', postgresVersion: '17.11.0.002',
    images, network: c.networks.isolated.name, gatewayNetwork: c.networks.gateway.name,
    volume: c.volumes.database.name, existingVolumeReuse: false,
    startupHash, requiredPrivateEnvironment: Object.fromEntries(Object.entries(privateEnv).map(([s, e]) => [s, Object.keys(e)])),
    observedRealtimeFailure: 'DB_HOST nxdomain while original DB stopped; exit 1; OOMKilled=false',
    approvals: ['review private-file ACLs and immutable package', 'approve ONLY new resource creation AND upstream service initialization SQL', 'verify runtime/network/WAL/roles/tenant/catalog readiness', 'approve setup.sql', 'approve synthetic identities and authorization tests'],
    protectedResources: ['mc-audit-rehearsal-ab53a2750d8e47fb9bb31b70f79a16ec', 'r139-supabase-restore-v2', 'r139-sql-restore-test', 'lucid_neumann', sourceProject, 'mc-audit-cp4-10ccde5e21c742788858a45dbc7ad88d'],
  };
  const files = { 'compose.json': json(c), 'runtime-manifest.json': json(manifest), 'db-start.sh': startup, 'setup.sql': sql, 'private/kong.json': json(gateway),
    'private/client.env': `MC_CP4_URL=${manifest.apiOrigin}\nMC_CP4_ANON_KEY=${keys.anon}\nMC_CP4_SERVICE_KEY=${keys.service}\n` };
  for (const [name, env] of Object.entries(privateEnv)) files[`private/${name}.env`] = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  return { files, manifest };
}
export function validateComposeFiles(plan, read) {
  assert(plan.version === 2 && plan.runtime === 'docker-compose' && plan.syntheticOnly === true);
  assert(/^[a-f0-9]{32}$/.test(plan.nonce));
  const expected = ['compose.json', 'runtime-manifest.json', 'db-start.sh', 'setup.sql', 'private/kong.json', 'private/client.env', ...['db','auth','rest','realtime'].map(s => `private/${s}.env`)];
  assert.deepEqual(Object.keys(plan.files).sort(), expected.sort(), 'Unexpected or missing sealed runtime files');
  for (const [name, hash] of Object.entries(plan.files)) assert.equal(digest(read(name)), hash, `CP4 artifact changed: ${name}`);
  const c = JSON.parse(read('compose.json')), manifest = JSON.parse(read('runtime-manifest.json'));
  assert.deepEqual(c, composeDefinition(plan.nonce), 'Runtime differs from reviewed Compose contract');
  assert(manifest.nonce === plan.nonce && manifest.project === c.name && manifest.sourceProject === sourceProject && manifest.syntheticOnly === true && manifest.launchApproved === false);
  assert.deepEqual(manifest.images, images); assert.equal(manifest.existingVolumeReuse, false);
  assert.equal(manifest.network, c.networks.isolated.name); assert.equal(manifest.volume, c.volumes.database.name);
  assert.equal(manifest.gatewayNetwork, c.networks.gateway.name);
  assert.equal(manifest.apiOrigin, 'http://127.0.0.1:55421'); assert.equal(digest(read('db-start.sh')), startupHash);
  return manifest;
}
export function assertComposeRuntime(manifest, inspection, workspace) {
  assert.equal(manifest.project, `mc-audit-cp4-compose-${manifest.nonce}`);
  assert.equal(manifest.network, `${manifest.project}-net`);
  assert.equal(manifest.gatewayNetwork, `${manifest.project}-gateway`);
  assert(inspection.localSocket === true && Array.isArray(inspection.networks));
  assert.deepEqual(inspection.resources.containers.slice().sort(), Object.keys(images).map(s => `${manifest.project}-${s}-1`).sort());
  assert.deepEqual(inspection.resources.networks.slice().sort(), [manifest.network, manifest.gatewayNetwork].sort());
  assert.deepEqual(inspection.resources.volumes, [manifest.volume]);
  assert.deepEqual(inspection.networks.map(net => net.Name).sort(), [manifest.network, manifest.gatewayNetwork].sort());
  for (const [name, internal, members] of [
    [manifest.network, true, Object.keys(images).map(s => `${manifest.project}-${s}-1`)],
    [manifest.gatewayNetwork, false, [`${manifest.project}-kong-1`]],
  ]) {
    const net = inspection.networks.find(n => n.Name === name);
    assert(net.Driver === 'bridge' && net.Internal === internal && net.project === manifest.project && net.nonce === manifest.nonce,
      'Wrong network driver, isolation or project ownership');
    assert.deepEqual(net.Containers.slice().sort(), members.sort(), 'Unexpected network members');
  }
  assert(inspection.volume?.Name === manifest.volume && inspection.volume.nonce === manifest.nonce);
  assert.equal(inspection.containers.length, 5);
  for (const [name, image] of Object.entries(images)) {
    const c = inspection.containers.find(c => c.service === name);
    assert(c && c.name === `${manifest.project}-${name}-1` && c.nonce === manifest.nonce && c.image === image && c.running && c.healthy, 'Wrong/unhealthy CP4 container');
    assert.deepEqual(c.networks.slice().sort(), (name === 'kong' ? [manifest.network, manifest.gatewayNetwork] : [manifest.network]).sort());
    assert.deepEqual(c.bindings, name === 'kong' ? [{ host: '127.0.0.1', port: '55421', target: '8000/tcp' }] : []);
    assert.deepEqual(c.volumes, name === 'db' ? [manifest.volume] : [], 'Existing/shared volume refused');
    const expectedBinds = name === 'db' ? [{ source: path.join(workspace, 'db-start.sh'), destination: '/cp4/db-start.sh', readOnly: true }]
      : name === 'kong' ? [{ source: path.join(workspace, 'private/kong.json'), destination: '/cp4/kong.json', readOnly: true }] : [];
    const normalize = list => list.map(b => {
      let source = b.source.replaceAll('\\', '/');
      if (process.platform === 'win32') {
        source = source.replace(/^\/(?:run\/desktop\/mnt\/host|host_mnt)\/([a-z])\//i, '$1:/');
        if (fs.existsSync(source)) source = fs.realpathSync(source).replaceAll('\\', '/');
        source = source.toLowerCase();
      }
      return { ...b, source };
    });
    assert.deepEqual(normalize(c.binds), normalize(expectedBinds), 'Unexpected/writable host bind mount refused');
  }
}
