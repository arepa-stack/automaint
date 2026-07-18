import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { config } from '../config'
import * as schema from './schema'

// prepare:false → compatible con el pooler de Supabase (pgbouncer, modo transacción)
export const sql = postgres(config.databaseUrl, { prepare: false })
export const db = drizzle(sql, { schema })
