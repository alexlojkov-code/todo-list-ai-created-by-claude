/* Создаёт таблицы в базе Neon. Безопасно запускать повторно.
   Запуск: DATABASE_URL=... node scripts/migrate.mjs */
import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
const sql = neon(process.env.DATABASE_URL);

await sql`create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  password_hash text not null,
  name          text not null default '',
  failed_logins int  not null default 0,
  locked_until  timestamptz,
  last_login_at timestamptz,
  created_at    timestamptz not null default now()
)`;

await sql`create table if not exists sessions (
  token_hash text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  user_agent text not null default '',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
)`;
await sql`create index if not exists sessions_user_idx on sessions (user_id)`;

await sql`create table if not exists user_data (
  user_id    uuid primary key references users(id) on delete cascade,
  data       jsonb not null,
  version    int not null default 1,
  updated_at timestamptz not null default now()
)`;

const tables = await sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`;
console.log('tables:', tables.map(t => t.table_name).join(', '));
