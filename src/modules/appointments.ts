import { Elysia, t } from 'elysia'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client'
import { appointments, partners, users, workshopServices } from '../db/schema'
import { authed } from '../shared/auth'
import { badRequest, forbidden, notFound } from '../shared/errors'
import { notifyUser } from '../shared/push'
import { sendEmail } from '../shared/email'
import { getMyPartner } from './partners'
import { getOwnedVehicle } from './vehicles'

export const appointmentsModule = new Elysia({ tags: ['appointments'] })
  .use(authed)

  // Agendar cita (HU-010)
  .post('/appointments', async ({ user, body }) => {
    const partner = await db.query.partners.findFirst({
      where: and(eq(partners.id, body.partnerId), eq(partners.status, 'approved')),
    })
    if (!partner) throw notFound('Taller')
    if (body.vehicleId) await getOwnedVehicle(user, body.vehicleId)

    const services = await db.select().from(workshopServices).where(and(
      inArray(workshopServices.id, body.serviceIds),
      eq(workshopServices.partnerId, partner.id),
    ))
    if (services.length !== body.serviceIds.length) throw badRequest('Algún servicio no pertenece al taller')

    const scheduledAt = new Date(body.scheduledAt)
    if (scheduledAt < new Date()) throw badRequest('La fecha debe ser futura')
    const clash = await db.query.appointments.findFirst({
      where: and(
        eq(appointments.partnerId, partner.id),
        eq(appointments.scheduledAt, scheduledAt),
        inArray(appointments.status, ['pending', 'confirmed']),
      ),
    })
    if (clash) throw badRequest('Ese horario ya está ocupado', 'SLOT_TAKEN')

    const [appt] = await db.insert(appointments).values({
      partnerId: partner.id,
      userId: user.id,
      vehicleId: body.vehicleId,
      services: services.map(s => ({ id: s.id, name: s.name, price: s.price })),
      scheduledAt,
      notes: body.notes,
    }).returning()

    await notifyUser(partner.userId, 'appointment_new', 'Nueva cita',
      `Cita solicitada para ${scheduledAt.toLocaleString('es-VE')}`, { appointmentId: appt!.id })
    const customer = await db.query.users.findFirst({ where: eq(users.id, user.id) })
    if (customer) await sendEmail(customer.email, 'Cita solicitada — AutoMaint',
      `<p>Tu cita en ${partner.businessName} para el ${scheduledAt.toLocaleString('es-VE')} fue registrada. Te avisaremos cuando el taller confirme.</p>`)
    return appt
  }, {
    body: t.Object({
      partnerId: t.String({ format: 'uuid' }),
      vehicleId: t.Optional(t.String({ format: 'uuid' })),
      serviceIds: t.Array(t.String({ format: 'uuid' }), { minItems: 1 }),
      scheduledAt: t.String(), // ISO datetime
      notes: t.Optional(t.String()),
    }),
  })

  // Mis citas (usuario)
  .get('/appointments', async ({ user }) =>
    db.select().from(appointments).where(eq(appointments.userId, user.id)).orderBy(desc(appointments.scheduledAt)))

  // Citas del taller (partner)
  .get('/partners/me/appointments', async ({ user, query }) => {
    const p = await getMyPartner(user)
    const filters = [eq(appointments.partnerId, p.id)]
    if (query.status) filters.push(eq(appointments.status, query.status as any))
    return db.select().from(appointments).where(and(...filters)).orderBy(desc(appointments.scheduledAt))
  }, {
    query: t.Object({ status: t.Optional(t.String()) }),
  })

  // Cambiar estado: taller confirma/completa; usuario cancela; reschedule = cancelar + crear
  .patch('/appointments/:id', async ({ user, params, body }) => {
    const appt = await db.query.appointments.findFirst({ where: eq(appointments.id, params.id) })
    if (!appt) throw notFound('Cita')
    const partner = await db.query.partners.findFirst({ where: eq(partners.id, appt.partnerId) })

    const isCustomer = appt.userId === user.id
    const isOwner = partner?.userId === user.id || user.role === 'admin'
    if (!isCustomer && !isOwner) throw forbidden()
    if (isCustomer && !isOwner && body.status !== 'cancelled')
      throw forbidden('El cliente solo puede cancelar')

    const [updated] = await db.update(appointments).set({ status: body.status })
      .where(eq(appointments.id, appt.id)).returning()

    const statusMsg: Record<string, string> = {
      confirmed: 'Tu cita fue confirmada ✅',
      completed: 'Tu cita fue completada',
      cancelled: 'La cita fue cancelada',
    }
    if (isOwner && statusMsg[body.status])
      await notifyUser(appt.userId, 'appointment_status', 'Cita actualizada', statusMsg[body.status]!, { appointmentId: appt.id })
    if (isCustomer && body.status === 'cancelled' && partner)
      await notifyUser(partner.userId, 'appointment_status', 'Cita cancelada',
        `El cliente canceló la cita del ${appt.scheduledAt.toLocaleString('es-VE')}`, { appointmentId: appt.id })
    return updated
  }, {
    body: t.Object({
      status: t.Union([t.Literal('confirmed'), t.Literal('completed'), t.Literal('cancelled')]),
    }),
  })
