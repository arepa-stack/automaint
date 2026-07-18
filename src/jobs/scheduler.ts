import { Cron } from 'croner'
import { and, eq, gte, inArray, isNull, lt, lte, or, sql, gt } from 'drizzle-orm'
import { db } from '../db/client'
import { appointments, carListings, searchAlerts } from '../db/schema'
import { notifyUser } from '../shared/push'
import { recalcAllVehicles } from '../modules/maintenance-engine'

// ponytail: cron in-process, válido para instancia única; pg-boss si se escala horizontal

export async function expireListings() {
  const expired = await db.update(carListings)
    .set({ status: 'expired' })
    .where(and(eq(carListings.status, 'active'), lt(carListings.expiresAt, new Date())))
    .returning()
  for (const l of expired) {
    if (l.sellerUserId)
      await notifyUser(l.sellerUserId, 'listing_expired', 'Listado expirado',
        `Tu listado ${l.make} ${l.model} ${l.year} expiró. Puedes renovarlo desde la app.`, { listingId: l.id })
  }
  if (expired.length) console.log(`[jobs] ${expired.length} listados expirados`)
}

export async function sendAppointmentReminders() {
  const now = Date.now()
  const due = await db.select().from(appointments).where(and(
    inArray(appointments.status, ['pending', 'confirmed']),
    isNull(appointments.reminderSentAt),
    gte(appointments.scheduledAt, new Date(now)),
    lte(appointments.scheduledAt, new Date(now + 24 * 3600_000)),
  ))
  for (const a of due) {
    await notifyUser(a.userId, 'appointment_reminder', 'Recordatorio de cita',
      `Tienes una cita mañana: ${a.scheduledAt.toLocaleString('es-VE')}`, { appointmentId: a.id })
    await db.update(appointments).set({ reminderSentAt: new Date() }).where(eq(appointments.id, a.id))
  }
  if (due.length) console.log(`[jobs] ${due.length} recordatorios de cita enviados`)
}

export async function notifySearchAlerts() {
  const alerts = await db.select().from(searchAlerts)
  for (const alert of alerts) {
    const f = alert.filters
    const since = alert.lastNotifiedAt ?? alert.createdAt
    const matches = await db.select().from(carListings).where(and(
      eq(carListings.status, 'active'),
      gt(carListings.createdAt, since),
      f.make ? sql`lower(${carListings.make}) = lower(${f.make})` : undefined,
      f.model ? sql`lower(${carListings.model}) = lower(${f.model})` : undefined,
      f.yearFrom ? gte(carListings.year, f.yearFrom) : undefined,
      f.yearTo ? lte(carListings.year, f.yearTo) : undefined,
      f.priceMax ? lte(carListings.price, String(f.priceMax)) : undefined,
      f.kmMax ? lte(carListings.km, f.kmMax) : undefined,
      f.city ? sql`lower(${carListings.city}) = lower(${f.city})` : undefined,
    ))
    if (matches.length) {
      await notifyUser(alert.userId, 'listing_alert', 'Nuevos carros para ti',
        `${matches.length} listado(s) nuevo(s) coinciden con tu búsqueda guardada`,
        { alertId: alert.id })
      await db.update(searchAlerts).set({ lastNotifiedAt: new Date() }).where(eq(searchAlerts.id, alert.id))
    }
  }
}

export function startJobs() {
  // 06:00 diario: recálculo de mantenimientos + expiración de listados + alertas
  new Cron('0 6 * * *', async () => {
    await recalcAllVehicles().catch(e => console.error('[jobs] recalc:', e))
    await expireListings().catch(e => console.error('[jobs] expire:', e))
    await notifySearchAlerts().catch(e => console.error('[jobs] alerts:', e))
  })
  // cada hora: recordatorios de citas (24h antes)
  new Cron('0 * * * *', () => sendAppointmentReminders().catch(e => console.error('[jobs] reminders:', e)))
  console.log('[jobs] scheduler iniciado (diario 06:00 + recordatorios cada hora)')
}
