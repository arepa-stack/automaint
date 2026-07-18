const env = (key: string, fallback?: string): string => {
  const v = process.env[key] ?? fallback
  if (v === undefined) throw new Error(`Missing required env var: ${key}`)
  return v
}

export const config = {
  port: Number(env('PORT', '3000')),
  databaseUrl: env('DATABASE_URL', 'postgres://automaint:automaint@localhost:5432/automaint'),
  jwtSecret: env('JWT_SECRET', 'dev-secret-change-me'),
  accessTokenTtl: '1h',
  refreshTokenDays: 30,
  oauthMock: env('OAUTH_MOCK', 'true') === 'true',
  runMigrations: env('RUN_MIGRATIONS', 'true') === 'true',
  enableJobs: env('ENABLE_JOBS', 'true') === 'true',

  // storage: 'local' writes to UPLOAD_DIR and serves from /files, 'supabase' uses Storage buckets
  storageDriver: env('STORAGE_DRIVER', 'local') as 'local' | 'supabase',
  uploadDir: env('UPLOAD_DIR', './uploads'),
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  // bucket único; las categorías (listings, receipts...) van como carpetas internas
  supabaseBucket: env('SUPABASE_BUCKET', 'automaint'),

  // integraciones opcionales: sin credenciales quedan en modo log-only
  resendApiKey: process.env.RESEND_API_KEY,
  emailFrom: env('EMAIL_FROM', 'AutoMaint <no-reply@automaint.app>'),
  appBaseUrl: env('APP_BASE_URL', 'http://localhost:3000'),
}

if (config.jwtSecret === 'dev-secret-change-me')
  console.warn('[config] JWT_SECRET usando valor de desarrollo — configúralo en producción')
