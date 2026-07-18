import { Elysia, t } from 'elysia'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { maintenanceItems, odometerReadings, vehicleCatalog, vehicles, users } from '../db/schema'
import { authed, type AuthUser } from '../shared/auth'
import { badRequest, notFound } from '../shared/errors'
import { saveFile, fileUrl } from '../shared/storage'
import { computeItemState, instantiatePlan, recalcVehicle, updateAvgKmPerDay } from './maintenance-engine'

export async function getOwnedVehicle(user: AuthUser, vehicleId: string) {
  const v = await db.query.vehicles.findFirst({ where: eq(vehicles.id, vehicleId) })
  if (!v || (v.userId !== user.id && user.role !== 'admin')) throw notFound('Vehículo')
  return v
}

const toDateStr = (d: Date) => d.toISOString().slice(0, 10)

// semáforo: 🔴 overdue > 🟡 upcoming > 🟢 ok
const worstStatus = (statuses: string[]) =>
  statuses.includes('overdue') ? 'overdue' : statuses.includes('upcoming') ? 'upcoming' : 'ok'

export const catalogModule = new Elysia({ prefix: '/catalog', tags: ['catalog'] })
  .get('/makes', async () => {
    const rows = await db.selectDistinct({ make: vehicleCatalog.make }).from(vehicleCatalog).orderBy(asc(vehicleCatalog.make))
    return rows.map(r => r.make)
  })
  .get('/models', async ({ query }) => db.select().from(vehicleCatalog)
    .where(eq(vehicleCatalog.make, query.make)).orderBy(asc(vehicleCatalog.model)), {
    query: t.Object({ make: t.String() }),
  })

export const vehiclesModule = new Elysia({ prefix: '/vehicles', tags: ['vehicles'] })
  .use(authed)

  .post('/', async ({ user, body }) => {
    const [vehicle] = await db.insert(vehicles).values({ ...body, userId: user.id }).returning()
    await db.insert(odometerReadings).values({
      vehicleId: vehicle!.id, km: body.currentKm, readAt: toDateStr(new Date()),
    })
    await instantiatePlan(vehicle!)
    const items = await db.select().from(maintenanceItems).where(eq(maintenanceItems.vehicleId, vehicle!.id))
    return { ...vehicle!, photoUrl: fileUrl(vehicle!.photoPath), maintenanceItems: items }
  }, {
    body: t.Object({
      make: t.String({ minLength: 1 }),
      model: t.String({ minLength: 1 }),
      year: t.Integer({ minimum: 1950, maximum: 2100 }),
      engine: t.Optional(t.String()),
      fuelType: t.Optional(t.String()),
      vin: t.Optional(t.String()),
      plate: t.Optional(t.String()),
      nickname: t.Optional(t.String()),
      purchaseDate: t.Optional(t.String({ format: 'date' })),
      currentKm: t.Integer({ minimum: 0 }),
    }),
  })

  .get('/', async ({ user }) => {
    const list = await db.select().from(vehicles).where(eq(vehicles.userId, user.id)).orderBy(desc(vehicles.createdAt))
    const owner = await db.query.users.findFirst({ where: eq(users.id, user.id) })
    const prefs = { notifyKmBefore: owner?.notifyKmBefore ?? 500, notifyDaysBefore: owner?.notifyDaysBefore ?? 7 }

    return Promise.all(list.map(async v => {
      const items = await db.select().from(maintenanceItems).where(eq(maintenanceItems.vehicleId, v.id))
      const states = items.map(i => ({ item: i, ...computeItemState(i, v, prefs) }))
      const next = states
        .filter(s => s.daysLeft != null)
        .sort((a, b) => (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9))[0]
      return {
        ...v,
        photoUrl: fileUrl(v.photoPath),
        overallStatus: worstStatus(states.map(s => s.status)),
        nextMaintenance: next
          ? { itemId: next.item.id, name: next.item.name, dueKm: next.item.dueKm, kmLeft: next.kmLeft, daysLeft: next.daysLeft, projectedDate: next.projectedDate, status: next.status }
          : null,
      }
    }))
  })

  .get('/:id', async ({ user, params }) => {
    const v = await getOwnedVehicle(user, params.id)
    const items = await recalcVehicle(v, { notify: false })
    return { ...v, photoUrl: fileUrl(v.photoPath), maintenanceItems: items }
  })

  .patch('/:id', async ({ user, params, body }) => {
    await getOwnedVehicle(user, params.id)
    const [updated] = await db.update(vehicles).set(body).where(eq(vehicles.id, params.id)).returning()
    return updated
  }, {
    body: t.Object({
      nickname: t.Optional(t.String()),
      engine: t.Optional(t.String()),
      fuelType: t.Optional(t.String()),
      vin: t.Optional(t.String()),
      plate: t.Optional(t.String()),
      purchaseDate: t.Optional(t.String({ format: 'date' })),
    }),
  })

  .delete('/:id', async ({ user, params }) => {
    await getOwnedVehicle(user, params.id)
    await db.delete(vehicles).where(eq(vehicles.id, params.id))
    return { ok: true }
  })

  .post('/:id/photo', async ({ user, params, body }) => {
    await getOwnedVehicle(user, params.id)
    const path = await saveFile('vehicle-photos', body.file)
    await db.update(vehicles).set({ photoPath: path }).where(eq(vehicles.id, params.id))
    return { photoUrl: fileUrl(path) }
  }, {
    body: t.Object({ file: t.File() }),
  })

  // ── Odómetro ────────────────────────────────────────────────────────────
  .post('/:id/odometer', async ({ user, params, body }) => {
    const v = await getOwnedVehicle(user, params.id)
    if (body.km < v.currentKm)
      throw badRequest(`El kilometraje (${body.km}) es menor al actual (${v.currentKm})`, 'KM_LOWER_THAN_CURRENT')

    await db.insert(odometerReadings).values({
      vehicleId: v.id, km: body.km, readAt: body.readAt ?? toDateStr(new Date()),
    })
    await db.update(vehicles).set({ currentKm: body.km }).where(eq(vehicles.id, v.id))
    await updateAvgKmPerDay(v.id)

    const fresh = (await db.query.vehicles.findFirst({ where: eq(vehicles.id, v.id) }))!
    const items = await recalcVehicle(fresh, { notify: true })
    return { vehicle: fresh, maintenanceItems: items }
  }, {
    body: t.Object({
      km: t.Integer({ minimum: 0 }),
      readAt: t.Optional(t.String({ format: 'date' })),
    }),
  })

  .get('/:id/odometer', async ({ user, params }) => {
    const v = await getOwnedVehicle(user, params.id)
    const readings = await db.select().from(odometerReadings)
      .where(eq(odometerReadings.vehicleId, v.id))
      .orderBy(desc(odometerReadings.readAt), desc(odometerReadings.createdAt))
    return { avgKmPerDay: v.avgKmPerDay, readings }
  })
