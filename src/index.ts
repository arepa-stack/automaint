import { Elysia } from 'elysia'
import { swagger } from '@elysiajs/swagger'
import { cors } from '@elysiajs/cors'
import { config } from './config'
import { ApiError } from './shared/errors'
import { runMigrations } from './db/migrate'
import { startJobs } from './jobs/scheduler'

import { authModule } from './modules/auth'
import { usersModule } from './modules/users'
import { catalogModule, vehiclesModule } from './modules/vehicles'
import { maintenanceModule } from './modules/maintenance'
import { expensesModule } from './modules/expenses'
import { notificationsModule } from './modules/notifications'
import { partnersModule } from './modules/partners'
import { workshopAdminModule, availabilityModule } from './modules/workshops'
import { appointmentsModule } from './modules/appointments'
import { reviewsModule } from './modules/reviews'
import { offersModule } from './modules/offers'
import { partsModule } from './modules/parts'
import { ordersModule } from './modules/orders'
import { quotesModule } from './modules/quotes'
import { listingsModule } from './modules/listings'
import { adminModule } from './modules/admin'

if (config.runMigrations) await runMigrations()

export const app = new Elysia()
  .use(cors())
  .use(swagger({
    path: '/swagger',
    documentation: {
      info: { title: 'AutoMaint API', version: '0.1.0', description: 'Mantenimiento preventivo de vehículos + marketplace' },
    },
  }))
  .error({ API_ERROR: ApiError })
  .onError(({ error, code, set }) => {
    if (error instanceof ApiError) {
      set.status = error.statusCode
      return { error: error.message, code: error.code }
    }
    if (code === 'VALIDATION') return // respuesta 422 por defecto de Elysia
    if (code === 'NOT_FOUND') { set.status = 404; return { error: 'Ruta no encontrada' } }
    console.error('[error]', error)
    set.status = 500
    return { error: 'Error interno' }
  })
  .get('/health', () => ({ ok: true, ts: new Date().toISOString() }))
  // archivos locales (STORAGE_DRIVER=local); con Supabase Storage las URLs son públicas directas
  .get('/files/*', ({ params, set }) => {
    const file = Bun.file(`${config.uploadDir}/${params['*']}`)
    return file.exists().then(exists => {
      if (!exists) { set.status = 404; return { error: 'Archivo no encontrado' } }
      return file
    })
  })
  .use(authModule)
  .use(usersModule)
  .use(notificationsModule)
  .use(catalogModule)
  .use(vehiclesModule)
  .use(maintenanceModule)
  .use(expensesModule)
  .use(partnersModule)
  .use(workshopAdminModule)
  .use(availabilityModule)
  .use(appointmentsModule)
  .use(reviewsModule)
  .use(offersModule)
  .use(partsModule)
  .use(ordersModule)
  .use(quotesModule)
  .use(listingsModule)
  .use(adminModule)

if (import.meta.main) {
  app.listen(config.port)
  if (config.enableJobs) startJobs()
  console.log(`🚗 AutoMaint API en http://localhost:${config.port} — Swagger en /swagger`)
}
