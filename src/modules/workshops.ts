import { Elysia, t } from 'elysia'
import { and, eq, gte, inArray, lt } from 'drizzle-orm'
import { db } from '../db/client'
import { appointments, partners, workshopSchedules, workshopServices } from '../db/schema'
import { authed } from '../shared/auth'
import { notFound } from '../shared/errors'
import { getMyPartner } from './partners'

// ── Gestión del taller (partner autenticado) ────────────────────────────────

export const workshopAdminModule = new Elysia({ prefix: '/partners/me', tags: ['workshops'] })
  .use(authed)

  .post('/services', async ({ user, body }) => {
    const p = await getMyPartner(user)
    const [service] = await db.insert(workshopServices).values({ ...body, partnerId: p.id }).returning()
    return service
  }, {
    body: t.Object({
      name: t.String({ minLength: 1 }),
      serviceKey: t.Optional(t.String()),
      price: t.Optional(t.String()),
      durationMin: t.Optional(t.Integer({ minimum: 15, maximum: 480 })),
    }),
  })

  .get('/services', async ({ user }) => {
    const p = await getMyPartner(user)
    return db.select().from(workshopServices).where(eq(workshopServices.partnerId, p.id))
  })

  .patch('/services/:id', async ({ user, params, body }) => {
    const p = await getMyPartner(user)
    const [updated] = await db.update(workshopServices).set(body)
      .where(and(eq(workshopServices.id, params.id), eq(workshopServices.partnerId, p.id))).returning()
    if (!updated) throw notFound('Servicio')
    return updated
  }, {
    body: t.Object({
      name: t.Optional(t.String()),
      serviceKey: t.Optional(t.String()),
      price: t.Optional(t.String()),
      durationMin: t.Optional(t.Integer({ minimum: 15, maximum: 480 })),
      active: t.Optional(t.Boolean()),
    }),
  })

  .delete('/services/:id', async ({ user, params }) => {
    const p = await getMyPartner(user)
    await db.delete(workshopServices)
      .where(and(eq(workshopServices.id, params.id), eq(workshopServices.partnerId, p.id)))
    return { ok: true }
  })

  // Reemplaza el horario semanal completo de una vez
  .put('/schedules', async ({ user, body }) => {
    const p = await getMyPartner(user)
    await db.delete(workshopSchedules).where(eq(workshopSchedules.partnerId, p.id))
    if (body.schedules.length === 0) return []
    return db.insert(workshopSchedules)
      .values(body.schedules.map(s => ({ ...s, partnerId: p.id }))).returning()
  }, {
    body: t.Object({
      schedules: t.Array(t.Object({
        weekday: t.Integer({ minimum: 0, maximum: 6 }),
        openTime: t.String({ pattern: '^\\d{2}:\\d{2}$' }),
        closeTime: t.String({ pattern: '^\\d{2}:\\d{2}$' }),
      })),
    }),
  })

// ── Disponibilidad pública ──────────────────────────────────────────────────

export const availabilityModule = new Elysia({ tags: ['workshops'] })
  .get('/partners/:id/availability', async ({ params, query }) => {
    const p = await db.query.partners.findFirst({ where: and(eq(partners.id, params.id), eq(partners.status, 'approved')) })
    if (!p) throw notFound('Partner')

    const date = new Date(`${query.date}T00:00:00`)
    const weekday = date.getDay()
    const schedules = await db.select().from(workshopSchedules)
      .where(and(eq(workshopSchedules.partnerId, p.id), eq(workshopSchedules.weekday, weekday)))
    if (schedules.length === 0) return { date: query.date, slots: [] }

    const nextDay = new Date(date.getTime() + 86400_000)
    const dayAppointments = await db.select().from(appointments).where(and(
      eq(appointments.partnerId, p.id),
      gte(appointments.scheduledAt, date),
      lt(appointments.scheduledAt, nextDay),
      inArray(appointments.status, ['pending', 'confirmed']),
    ))
    const taken = new Set(dayAppointments.map(a => a.scheduledAt.getHours()))

    // ponytail: slots de 1 hora; slots por duración de servicio si hace falta después
    const slots: string[] = []
    for (const s of schedules) {
      const open = Number(s.openTime.slice(0, 2))
      const close = Number(s.closeTime.slice(0, 2))
      for (let h = open; h < close; h++)
        if (!taken.has(h)) slots.push(`${String(h).padStart(2, '0')}:00`)
    }
    return { date: query.date, slots: slots.sort() }
  }, {
    params: t.Object({ id: t.String({ format: 'uuid' }) }),
    query: t.Object({ date: t.String({ format: 'date' }) }),
  })
