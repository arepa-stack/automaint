import { Elysia, t } from 'elysia'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { expenses, maintenanceItems, vehicles } from '../db/schema'
import { authed, assertRole, type AuthUser } from '../shared/auth'
import { notFound } from '../shared/errors'
import { completeItem, recalcAllVehicles, recalcVehicle } from './maintenance-engine'

const toDateStr = (d: Date) => d.toISOString().slice(0, 10)

async function getOwnedItem(user: AuthUser, itemId: string) {
  const item = await db.query.maintenanceItems.findFirst({ where: eq(maintenanceItems.id, itemId) })
  if (!item) throw notFound('Item de mantenimiento')
  const vehicle = await db.query.vehicles.findFirst({ where: eq(vehicles.id, item.vehicleId) })
  if (!vehicle || (vehicle.userId !== user.id && user.role !== 'admin')) throw notFound('Item de mantenimiento')
  return { item, vehicle }
}

export const maintenanceModule = new Elysia({ prefix: '/maintenance', tags: ['maintenance'] })
  .use(authed)

  // Personalizar intervalos de un servicio (HU-005)
  .patch('/:id', async ({ user, params, body }) => {
    const { item, vehicle } = await getOwnedItem(user, params.id)
    const baseKm = item.lastServiceKm ?? vehicle.currentKm
    const baseDate = item.lastServiceDate ? new Date(item.lastServiceDate) : new Date()
    const intervalKm = body.intervalKm !== undefined ? body.intervalKm : item.intervalKm
    const intervalMonths = body.intervalMonths !== undefined ? body.intervalMonths : item.intervalMonths

    const due = new Date(baseDate)
    if (intervalMonths) due.setMonth(due.getMonth() + intervalMonths)

    const [updated] = await db.update(maintenanceItems).set({
      intervalKm,
      intervalMonths,
      dueKm: intervalKm ? baseKm + intervalKm : null,
      dueDate: intervalMonths ? toDateStr(due) : null,
    }).where(eq(maintenanceItems.id, item.id)).returning()

    await recalcVehicle(vehicle, { notify: false })
    return updated
  }, {
    body: t.Object({
      intervalKm: t.Optional(t.Nullable(t.Integer({ minimum: 100 }))),
      intervalMonths: t.Optional(t.Nullable(t.Integer({ minimum: 1 }))),
    }),
  })

  // "Ya lo hice": marca realizado, opcionalmente registra el gasto (HU-007)
  .post('/:id/complete', async ({ user, params, body }) => {
    const { item, vehicle } = await getOwnedItem(user, params.id)
    const doneKm = body.km ?? vehicle.currentKm
    const doneDate = body.date ? new Date(body.date) : new Date()
    const updated = await completeItem(item, doneKm, doneDate)

    let expense = null
    if (body.expense) {
      const [row] = await db.insert(expenses).values({
        userId: vehicle.userId,
        vehicleId: vehicle.id,
        type: 'mantenimiento',
        amount: body.expense.amount,
        currency: body.expense.currency ?? 'USD',
        date: toDateStr(doneDate),
        vendor: body.expense.vendor,
        description: body.expense.description ?? item.name,
        odometerKm: doneKm,
        maintenanceItemId: item.id,
      }).returning()
      expense = row
    }
    return { item: updated, expense }
  }, {
    body: t.Object({
      km: t.Optional(t.Integer({ minimum: 0 })),
      date: t.Optional(t.String({ format: 'date' })),
      expense: t.Optional(t.Object({
        amount: t.String(),
        currency: t.Optional(t.String()),
        vendor: t.Optional(t.String()),
        description: t.Optional(t.String()),
      })),
    }),
  })

  // Trigger manual del job (admin / pruebas)
  .post('/recalculate', async ({ user }) => {
    assertRole(user, 'admin')
    await recalcAllVehicles()
    return { ok: true }
  })
