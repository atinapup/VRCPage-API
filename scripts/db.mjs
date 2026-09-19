// Database commands. Every connection is built from the DB_* values in
// .env.development, or .env.production when --prod is given.
//
//   npm run db:bootstrap   create the roles, logins and database (as the admin)
//   npm run db:migrate     apply pending migrations, then create upcoming partitions
//   npm run db:rollback    undo the latest migration             (development only)
//   npm run db:status      list applied and pending migrations
//   npm run db:test        run db/tests/invariants.sql, rolled back (development only)
//   npm run db:maintain    run the nightly maintenance once, by hand
//   npm run db:types       generate the API's Kysely types from the database (development only)
//
// Each has a :prod twin (db:migrate:prod, ...) except the development-only ones.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { resolveBinary } from 'dbmate';
import pg from 'pg';

const [commandName, ...flags] = process.argv.slice(2);
const environment = flags.includes('--prod') ? 'production' : 'development';
const envFile = `.env.${environment}`;

// Production only moves forward: a rollback drops tables with their data, and
// the tests are for trying things out. Types come from development, which is
// always at least as far along as production.
const DEVELOPMENT_ONLY = new Set(['rollback', 'test', 'types']);

// The migrations grant permissions to these roles. The roles never log in;
// each environment has its own logins that are members of them, and each
// database only lets its own environment's logins connect.
const LOGINS = {
  migrator: { role: 'vrcpage_owner', key: 'MIGRATOR' },
  api: { role: 'vrcpage_api', key: 'API' },
  auth: { role: 'vrcpage_auth', key: 'AUTH' },
  maintenance: { role: 'vrcpage_maintenance', key: 'MAINTENANCE' },
  readonly: { role: 'vrcpage_readonly', key: 'READONLY' },
};

const SSL_MODES = {
  disable: false,
  require: { rejectUnauthorized: false },
  'verify-full': true,
};

function env(name, fallback) {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`${name} is not set in ${envFile} (see ${envFile}.example).`);
  return value;
}

function sslMode() {
  const mode = env('DB_SSL_MODE', 'disable');
  if (!(mode in SSL_MODES)) {
    throw new Error(`DB_SSL_MODE is "${mode}"; use one of: ${Object.keys(SSL_MODES).join(', ')}.`);
  }
  return mode;
}

// Connection settings for 'admin' or one of LOGINS, on DB_NAME unless told otherwise.
function connection(login, database = env('DB_NAME')) {
  const prefix = login === 'admin' ? 'DB_ADMIN' : `DB_${LOGINS[login].key}`;
  return {
    host: env('DB_HOST'),
    port: Number(env('DB_PORT', '5432')),
    database,
    user: env(`${prefix}_USER`),
    password: env(`${prefix}_PASSWORD`),
    ssl: SSL_MODES[sslMode()],
  };
}

// dbmate takes a single URL. encodeURIComponent, not the URL class: the URL
// class leaves "%" alone, which dbmate then reads as a broken escape.
function connectionUrl({ host, port, database, user, password }) {
  const credentials = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return `postgres://${credentials}@${host}:${port}/${encodeURIComponent(database)}?sslmode=${sslMode()}`;
}

async function withClient(settings, work) {
  const client = new pg.Client(settings);
  client.on('notice', (notice) => console.log(`  ${notice.message}`));
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

// Runs dbmate as the migrator. The URL travels in the environment, so the
// password never shows up in a process list.
function dbmate(...args) {
  const result = spawnSync(resolveBinary(), ['--no-dump-schema', '--env-file', envFile, ...args], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: connectionUrl(connection('migrator')) },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Everything bootstrap will do is checked here first, so a mistake in the
// settings stops it before the server is touched.
function checkLogins() {
  const shortName = environment === 'production' ? 'prod' : 'dev';
  const logins = Object.values(LOGINS).map(({ role, key }) => {
    const user = env(`DB_${key}_USER`);
    env(`DB_${key}_PASSWORD`);
    if (user === role) {
      throw new Error(`DB_${key}_USER cannot be "${role}": that role is shared by every environment. Use e.g. vrcpage_${shortName}_${key.toLowerCase()}.`);
    }
    return { user, key };
  });

  const seen = new Map();
  for (const { user, key } of logins) {
    if (seen.has(user)) throw new Error(`DB_${seen.get(user)}_USER and DB_${key}_USER are both "${user}"; each login needs its own name.`);
    seen.set(user, key);
  }

  // The other environment must not share a login or the database, or the
  // separation between them is gone.
  const otherFile = `.env.${environment === 'production' ? 'development' : 'production'}`;
  if (existsSync(otherFile)) {
    const other = parseEnv(readFileSync(otherFile, 'utf8'));
    if (other.DB_NAME === env('DB_NAME') && (other.DB_HOST || '') === env('DB_HOST')) {
      throw new Error(`${envFile} and ${otherFile} both use database ${other.DB_NAME} on ${other.DB_HOST}.`);
    }
    for (const { user, key } of logins) {
      const clash = Object.values(LOGINS).find(({ key: k }) => other[`DB_${k}_USER`] === user);
      if (clash) throw new Error(`DB_${key}_USER "${user}" is also a login in ${otherFile}; each environment needs its own logins.`);
    }
  }
}

async function bootstrap() {
  checkLogins();
  const database = env('DB_NAME');

  await withClient(connection('admin', env('DB_ADMIN_DATABASE', 'postgres')), async (db) => {
    const roleExists = async (name) =>
      (await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])).rowCount > 0;
    const isMember = async (user, role) =>
      (await db.query(
        `SELECT 1 FROM pg_auth_members m
           JOIN pg_roles r ON r.oid = m.roleid
           JOIN pg_roles u ON u.oid = m.member
          WHERE r.rolname = $1 AND u.rolname = $2`,
        [role, user],
      )).rowCount > 0;

    for (const { role, key } of Object.values(LOGINS)) {
      const user = env(`DB_${key}_USER`);
      const password = db.escapeLiteral(env(`DB_${key}_PASSWORD`));
      const login = db.escapeIdentifier(user);

      if (!(await roleExists(role))) await db.query(`CREATE ROLE ${role}`);
      await db.query(`ALTER ROLE ${role} NOLOGIN PASSWORD NULL`);

      await db.query(`${(await roleExists(user)) ? 'ALTER' : 'CREATE'} ROLE ${login} LOGIN PASSWORD ${password}`);
      if (role === 'vrcpage_owner') {
        // The migrator reaches the owner only by switching to it (SET ROLE), never
        // by inheriting its rights, so it can't use the owner's rights to open
        // another environment's database. Re-granting makes the membership pick
        // up NOINHERIT.
        await db.query(`ALTER ROLE ${login} NOINHERIT`);
        if (await isMember(user, role)) await db.query(`REVOKE ${role} FROM ${login}`);
      }
      if (!(await isMember(user, role))) await db.query(`GRANT ${role} TO ${login}`);
      console.log(`Login ${user} acts as ${role}.`);
    }

    // The migrator works as the owner, so everything it creates is owned by vrcpage_owner.
    const migrator = db.escapeIdentifier(env('DB_MIGRATOR_USER'));
    await db.query(`ALTER ROLE ${migrator} SET role = 'vrcpage_owner'`);

    const exists = (await db.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rowCount > 0;
    if (exists) {
      console.log(`Database ${database} already exists; leaving it in place.`);
    } else {
      await db.query(`CREATE DATABASE ${db.escapeIdentifier(database)} OWNER vrcpage_owner`);
      console.log(`Created database ${database}.`);
    }
  });

  await withClient(connection('admin'), async (db) => {
    const name = db.escapeIdentifier(database);
    const logins = Object.values(LOGINS).map(({ key }) => db.escapeIdentifier(env(`DB_${key}_USER`)));
    await db.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    // Only this environment's logins may connect; the shared roles may not, or
    // every environment's logins would inherit the way in.
    await db.query(`REVOKE CONNECT ON DATABASE ${name} FROM vrcpage_api, vrcpage_auth, vrcpage_maintenance, vrcpage_readonly`);
    await db.query(`GRANT CONNECT ON DATABASE ${name} TO ${logins.join(', ')}`);
    await db.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    // Better Auth writes unqualified table names; its login only ever sees the auth schema.
    await db.query(`ALTER ROLE ${db.escapeIdentifier(env('DB_AUTH_USER'))} IN DATABASE ${name} SET search_path = auth`);
  });

  console.log(`Roles, logins and database are ready. Next: npm run db:migrate${environment === 'production' ? ':prod' : ''}`);
}

async function migrate() {
  dbmate('migrate');
  await withClient(connection('migrator'), async (db) => {
    const { rows } = await db.query('SELECT internal.ensure_partitions() AS created');
    console.log(`Partitions created: ${rows[0].created}`);
  });
}

async function test() {
  const sql = await readFile(new URL('../db/tests/invariants.sql', import.meta.url), 'utf8');
  await withClient(connection('admin'), (db) => db.query(sql));
  console.log('All invariant checks passed.');
}

// src/database/database.types.ts, read as the migrator (the owner sees every
// table). Partitions are left out; with --check it only verifies the file.
function types() {
  const args = [
    'node_modules/kysely-codegen/dist/cli/bin.js',
    '--dialect', 'postgres',
    '--camel-case',
    '--exclude-pattern', 'public.schema_migrations',
    '--out-file', 'src/database/database.types.ts',
    ...(flags.includes('--check') ? ['--verify'] : []),
  ];
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: connectionUrl(connection('migrator')) },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function maintain() {
  await withClient(connection('maintenance'), async (db) => {
    const { rows } = await db.query('SELECT internal.run_maintenance() AS summary');
    console.log(JSON.stringify(rows[0].summary, null, 2));
  });
}

const commands = {
  bootstrap,
  migrate,
  rollback: async () => dbmate('rollback'),
  status: async () => dbmate('status'),
  test,
  maintain,
  types: async () => types(),
};
const command = commands[commandName];
if (!command) {
  console.error(`Usage: node scripts/db.mjs <${Object.keys(commands).join('|')}> [--prod]`);
  process.exit(1);
}
if (environment === 'production' && DEVELOPMENT_ONLY.has(commandName)) {
  console.error(`${commandName} is development-only. Production only moves forward: write a new migration instead.`);
  process.exit(1);
}
if (!existsSync(envFile)) {
  console.error(`${envFile} not found. Copy ${envFile}.example to ${envFile} and fill it in.`);
  process.exit(1);
}
process.loadEnvFile(envFile);
console.log(`[${environment}] ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

command().catch((error) => {
  console.error(error.message);
  if (error.where) console.error(error.where);
  process.exit(1);
});
