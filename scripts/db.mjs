// Database commands that would otherwise need psql.
//
//   node --env-file=.env scripts/db.mjs bootstrap          roles + database (run once, as a server admin)
//   node --env-file=.env scripts/db.mjs test               db/tests/invariants.sql (as a server admin, rolled back)
//   node --env-file=.env scripts/db.mjs ensure-partitions  upcoming partitions (as the migrator)
//   node --env-file=.env scripts/db.mjs maintain           nightly maintenance (as vrcpage_maintenance)
//
// Migrations themselves run through dbmate: npm run db:migrate.
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const LOGIN_ROLES = {
  vrcpage_migrator: 'VRCPAGE_MIGRATOR_PASSWORD',
  vrcpage_api: 'VRCPAGE_API_PASSWORD',
  vrcpage_auth: 'VRCPAGE_AUTH_PASSWORD',
  vrcpage_maintenance: 'VRCPAGE_MAINTENANCE_PASSWORD',
  vrcpage_readonly: 'VRCPAGE_READONLY_PASSWORD',
};

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. See .env.example.`);
  return value;
}

const databaseName = () => process.env.VRCPAGE_DATABASE || 'vrcpage';

function onDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function withClient(connectionString, work) {
  const client = new pg.Client({ connectionString });
  client.on('notice', (notice) => console.log(`  ${notice.message}`));
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function bootstrap() {
  const adminUrl = env('ADMIN_DATABASE_URL');
  const database = databaseName();

  await withClient(adminUrl, async (db) => {
    const roleExists = async (role) =>
      (await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount > 0;

    if (!(await roleExists('vrcpage_owner'))) await db.query('CREATE ROLE vrcpage_owner NOLOGIN');
    for (const [role, passwordVar] of Object.entries(LOGIN_ROLES)) {
      const verb = (await roleExists(role)) ? 'ALTER' : 'CREATE';
      await db.query(`${verb} ROLE ${role} LOGIN PASSWORD ${db.escapeLiteral(env(passwordVar))}`);
    }
    // The migrator works as the owner, so everything it creates is owned by vrcpage_owner.
    await db.query('GRANT vrcpage_owner TO vrcpage_migrator');
    await db.query("ALTER ROLE vrcpage_migrator SET role = 'vrcpage_owner'");

    const exists = (await db.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rowCount > 0;
    if (exists) {
      console.log(`Database ${database} already exists; leaving it in place.`);
    } else {
      await db.query(`CREATE DATABASE ${db.escapeIdentifier(database)} OWNER vrcpage_owner`);
      console.log(`Created database ${database}.`);
    }
  });

  await withClient(onDatabase(adminUrl, database), async (db) => {
    const name = db.escapeIdentifier(database);
    await db.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await db.query(
      `GRANT CONNECT ON DATABASE ${name} TO vrcpage_migrator, vrcpage_api, vrcpage_auth, vrcpage_maintenance, vrcpage_readonly`,
    );
    await db.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    // Better Auth writes unqualified table names; its role only ever sees the auth schema.
    await db.query(`ALTER ROLE vrcpage_auth IN DATABASE ${name} SET search_path = auth`);
  });

  console.log('Roles and database are ready. Next: npm run db:migrate');
}

async function test() {
  const sql = await readFile(new URL('../db/tests/invariants.sql', import.meta.url), 'utf8');
  await withClient(onDatabase(env('ADMIN_DATABASE_URL'), databaseName()), (db) => db.query(sql));
  console.log('All invariant checks passed.');
}

async function ensurePartitions() {
  await withClient(env('DATABASE_URL'), async (db) => {
    const { rows } = await db.query('SELECT internal.ensure_partitions() AS created');
    console.log(`Partitions created: ${rows[0].created}`);
  });
}

async function maintain() {
  await withClient(env('MAINTENANCE_DATABASE_URL'), async (db) => {
    const { rows } = await db.query('SELECT internal.run_maintenance() AS summary');
    console.log(JSON.stringify(rows[0].summary, null, 2));
  });
}

const commands = { bootstrap, test, 'ensure-partitions': ensurePartitions, maintain };
const command = commands[process.argv[2]];
if (!command) {
  console.error(`Usage: node scripts/db.mjs <${Object.keys(commands).join('|')}>`);
  process.exit(1);
}
command().catch((error) => {
  console.error(error.message);
  if (error.where) console.error(error.where);
  process.exit(1);
});
