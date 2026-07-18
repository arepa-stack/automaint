import { Elysia, t } from 'elysia'
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { expenses, maintenanceItems } from '../db/schema'
import { authed } from '../shared/auth'
import { notFound } from '../shared/errors'
import { saveFile, fileUrl } from '../shared/storage'
import { getOwnedVehicle } from './vehicles'
import { completeItem } from './maintenance-engine'

const EXPENSE_TYPES = ['mantenimiento', 'reparacion', 'combustible', 'seguro', 'impuestos', 'estacionamiento', 'multas', 'repuestos', 'otros'] as const

export const expensesModule = new Elysia({ prefix: '/expenses', tags: ['expenses'] })
  .use(authed)

  .post('/', async ({ user, body }) => {
    const vehicle = await getOwnedVehicle(user, body.vehicleId)
    const [expense] = await db.insert(expenses).values({ ...body, userId: user.id }).returning()

    // asociado a un item del plan → lo marca como realizado (HU-007)
    if (body.maintenanceItemId) {
      const item = await db.query.maintenanceItems.findFirst({ where: eq(maintenanceItems.id, body.maintenanceItemId) })
      if (item && item.vehicleId === vehicle.id)
        await completeItem(item, body.odometerKm ?? vehicle.currentKm, new Date(body.date))
    }
    return expense
  }, {
    body: t.Object({
      vehicleId: t.String({ format: 'uuid' }),
      type: t.Union(EXPENSE_TYPES.map(x => t.Literal(x))),
      amount: t.String(),
      currency: t.Optional(t.String()),
      date: t.String({ format: 'date' }),
      vendor: t.Optional(t.String()),
      description: t.Optional(t.String()),
      odometerKm: t.Optional(t.Integer({ minimum: 0 })),
      maintenanceItemId: t.Optional(t.String({ format: 'uuid' })),
    }),
  })

  .get('/', async ({ user, query }) => {
    const filters = [eq(expenses.userId, user.id)]
    if (query.vehicleId) filters.push(eq(expenses.vehicleId, query.vehicleId))
    if (query.type) filters.push(eq(expenses.type, query.type as typeof EXPENSE_TYPES[number]))
    if (query.from) filters.push(gte(expenses.date, query.from))
    if (query.to) filters.push(lte(expenses.date, query.to))
    const rows = await db.select().from(expenses).where(and(...filters)).orderBy(desc(expenses.date))
    return rows.map(r => ({ ...r, receiptUrl: fileUrl(r.receiptPath) }))
  }, {
    query: t.Object({
      vehicleId: t.Optional(t.String()),
      type: t.Optional(t.String()),
      from: t.Optional(t.String({ format: 'date' })),
      to: t.Optional(t.String({ format: 'date' })),
    }),
  })

  .get('/stats', async ({ user, query }) => {
    const filters = [eq(expenses.userId, user.id)]
    if (query.vehicleId) filters.push(eq(expenses.vehicleId, query.vehicleId))

    const byType = await db.select({
      type: expenses.type,
      total: sql<string>`sum(${expenses.amount})`,
      count: sql<number>`count(*)::int`,
    }).from(expenses).where(and(...filters)).groupBy(expenses.type)

    const byMonth = await db.select({
      month: sql<string>`to_char(${expenses.date}, 'YYYY-MM')`,
      total: sql<string>`sum(${expenses.amount})`,
    }).from(expenses).where(and(...filters))
      .groupBy(sql`to_char(${expenses.date}, 'YYYY-MM')`)
      .orderBy(sql`to_char(${expenses.date}, 'YYYY-MM')`)

    const grand = await db.select({ total: sql<string>`coalesce(sum(${expenses.amount}), 0)` })
      .from(expenses).where(and(...filters))

    return { total: grand[0]!.total, byType, byMonth }
  }, {
    query: t.Object({ vehicleId: t.Optional(t.String()) }),
  })

  .patch('/:id', async ({ user, params, body }) => {
    const row = await db.query.expenses.findFirst({ where: and(eq(expenses.id, params.id), eq(expenses.userId, user.id)) })
    if (!row) throw notFound('Gasto')
    const [updated] = await db.update(expenses).set(body).where(eq(expenses.id, params.id)).returning()
    return updated
  }, {
    body: t.Object({
      type: t.Optional(t.Union(EXPENSE_TYPES.map(x => t.Literal(x)))),
      amount: t.Optional(t.String()),
      date: t.Optional(t.String({ format: 'date' })),
      vendor: t.Optional(t.String()),
      description: t.Optional(t.String()),
      odometerKm: t.Optional(t.Integer({ minimum: 0 })),
    }),
  })

  .delete('/:id', async ({ user, params }) => {
    const row = await db.query.expenses.findFirst({ where: and(eq(expenses.id, params.id), eq(expenses.userId, user.id)) })
    if (!row) throw notFound('Gasto')
    await db.delete(expenses).where(eq(expenses.id, params.id))
    return { ok: true }
  })

  .post('/:id/receipt', async ({ user, params, body }) => {
    const row = await db.query.expenses.findFirst({ where: and(eq(expenses.id, params.id), eq(expenses.userId, user.id)) })
    if (!row) throw notFound('Gasto')
    const path = await saveFile('receipts', body.file)
    await db.update(expenses).set({ receiptPath: path }).where(eq(expenses.id, params.id))
    return { receiptUrl: fileUrl(path) }
  }, {
    body: t.Object({ file: t.File() }),
  })
