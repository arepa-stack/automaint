import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { config } from '../config'

export async function runMigrations() {
  // conexión dedicada (max 1) para migraciones; usar conexión directa a Supabase (5432), no el pooler
  const migrationClient = postgres(config.databaseUrl, { max: 1, prepare: false })
  await migrate(drizzle(migrationClient), { migrationsFolder: './src/db/migrations' })
  await migrationClient.end()
  console.log('[db] migraciones aplicadas')
}

if (import.meta.main) {
  await runMigrations()
  process.exit(0)
}
