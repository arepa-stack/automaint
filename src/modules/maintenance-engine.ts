import { and, asc, eq, isNull, or } from 'drizzle-orm'
import { db } from '../db/client'
import {
  maintenanceItems, maintenancePlanTemplates, odometerReadings, users, vehicles,
} from '../db/schema'
import { notifyUser } from '../shared/push'

type Vehicle = typeof vehicles.$inferSelect
type Item = typeof maintenanceItems.$inferSelect

const DAY_MS = 86400_000
const toDateStr = (d: Date) => d.toISOString().slice(0, 10)
const addMonths = (d: Date, months: number) => { const r = new Date(d); r.setMonth(r.getMonth() + months); return r }

/** Instancia el plan de mantenimiento de un vehículo desde las plantillas.
 *  La plantilla más específica (make+model > make > genérica) gana por serviceKey. */
export async function instantiatePlan(vehicle: Vehicle) {
  const templates = await db.select().from(maintenancePlanTemplates).where(or(
    isNull(maintenancePlanTemplates.make),
    eq(maintenancePlanTemplates.make, vehicle.make),
  ))

  const byKey = new Map<string, typeof maintenancePlanTemplates.$inferSelect>()
  const specificity = (t: { make: string | null; model: string | null }) =>
    (t.make ? 1 : 0) + (t.model ? 1 : 0)
  for (const tpl of templates) {
    if (tpl.model && tpl.model !== vehicle.model) continue
    const current = byKey.get(tpl.serviceKey)
    if (!current || specificity(tpl) > specificity(current)) byKey.set(tpl.serviceKey, tpl)
  }

  const now = new Date()
  const values = [...byKey.values()].map(tpl => ({
    vehicleId: vehicle.id,
    serviceKey: tpl.serviceKey,
    name: tpl.name,
    intervalKm: tpl.intervalKm,
    intervalMonths: tpl.intervalMonths,
    lastServiceKm: vehicle.currentKm,
    lastServiceDate: toDateStr(now),
    dueKm: tpl.intervalKm ? vehicle.currentKm + tpl.intervalKm : null,
    dueDate: tpl.intervalMonths ? toDateStr(addMonths(now, tpl.intervalMonths)) : null,
  }))
  if (values.length) await db.insert(maintenanceItems).values(values)
}

/** Recalcula km/día promedio con la primera y última lectura del odómetro. */
export async function updateAvgKmPerDay(vehicleId: string) {
  const readings = await db.select().from(odometerReadings)
    .where(eq(odometerReadings.vehicleId, vehicleId))
    .orderBy(asc(odometerReadings.readAt), asc(odometerReadings.createdAt))
  if (readings.length < 2) return

  const first = readings[0]!, last = readings[readings.length - 1]!
  const days = Math.max(1, (new Date(last.readAt).getTime() - new Date(first.readAt).getTime()) / DAY_MS)
  const avg = Math.min(1000, Math.max(1, (last.km - first.km) / days))
  await db.update(vehicles).set({ avgKmPerDay: avg }).where(eq(vehicles.id, vehicleId))
}

export function computeItemState(item: Item, vehicle: Vehicle, prefs: { notifyKmBefore: number; notifyDaysBefore: number }) {
  const today = new Date(toDateStr(new Date()))
  const kmLeft = item.dueKm != null ? item.dueKm - vehicle.currentKm : null
  const daysByDate = item.dueDate != null
    ? Math.floor((new Date(item.dueDate).getTime() - today.getTime()) / DAY_MS)
    : null
  const daysByKm = kmLeft != null ? Math.floor(kmLeft / Math.max(1, vehicle.avgKmPerDay)) : null
  const daysLeft = daysByDate != null && daysByKm != null
    ? Math.min(daysByDate, daysByKm)
    : daysByDate ?? daysByKm

  let status: Item['status'] = 'ok'
  if ((kmLeft != null && kmLeft <= 0) || (daysByDate != null && daysByDate <= 0)) status = 'overdue'
  else if ((kmLeft != null && kmLeft <= prefs.notifyKmBefore) || (daysLeft != null && daysLeft <= prefs.notifyDaysBefore)) status = 'upcoming'

  const projectedDate = daysLeft != null ? toDateStr(new Date(today.getTime() + Math.max(0, daysLeft) * DAY_MS)) : null
  return { status, kmLeft, daysLeft, projectedDate }
}

/** Recalcula estados de los items de un vehículo; opcionalmente notifica transiciones. */
export async function recalcVehicle(vehicle: Vehicle, opts: { notify: boolean }) {
  const owner = await db.query.users.findFirst({ where: eq(users.id, vehicle.userId) })
  if (!owner) return []
  const prefs = { notifyKmBefore: owner.notifyKmBefore, notifyDaysBefore: owner.notifyDaysBefore }
  const items = await db.select().from(maintenanceItems).where(eq(maintenanceItems.vehicleId, vehicle.id))
  const now = new Date()
  const startOfToday = new Date(toDateStr(now))
  const results = []

  for (const item of items) {
    const state = computeItemState(item, vehicle, prefs)
    const patch: Partial<typeof maintenanceItems.$inferInsert> = { status: state.status }

    if (opts.notify && state.status === 'upcoming' && !item.notifiedUpcomingAt) {
      patch.notifiedUpcomingAt = now
      await notifyUser(vehicle.userId, 'maintenance_upcoming',
        `Próximo: ${item.name}`,
        `${vehicleLabel(vehicle)}: ${item.name} ${state.kmLeft != null && state.kmLeft > 0 ? `en ~${state.kmLeft} km` : `vence pronto`}`,
        { vehicleId: vehicle.id, itemId: item.id })
    }
    if (opts.notify && state.status === 'overdue' && (!item.notifiedOverdueAt || item.notifiedOverdueAt < startOfToday)) {
      patch.notifiedOverdueAt = now
      await notifyUser(vehicle.userId, 'maintenance_overdue',
        `Vencido: ${item.name}`,
        `${vehicleLabel(vehicle)}: ${item.name} está vencido. Agenda tu servicio.`,
        { vehicleId: vehicle.id, itemId: item.id })
    }
    if (state.status === 'ok' && item.status !== 'ok') {
      patch.notifiedUpcomingAt = null
      patch.notifiedOverdueAt = null
    }

    if (patch.status !== item.status || patch.notifiedUpcomingAt !== undefined || patch.notifiedOverdueAt !== undefined)
      await db.update(maintenanceItems).set(patch).where(eq(maintenanceItems.id, item.id))
    results.push({ ...item, ...state })
  }
  return results
}

/** Marca un servicio como realizado y reprograma el siguiente ciclo. */
export async function completeItem(item: Item, doneKm: number, doneDate: Date) {
  const [updated] = await db.update(maintenanceItems).set({
    lastServiceKm: doneKm,
    lastServiceDate: toDateStr(doneDate),
    dueKm: item.intervalKm ? doneKm + item.intervalKm : null,
    dueDate: item.intervalMonths ? toDateStr(addMonths(doneDate, item.intervalMonths)) : null,
    status: 'ok',
    notifiedUpcomingAt: null,
    notifiedOverdueAt: null,
  }).where(eq(maintenanceItems.id, item.id)).returning()
  return updated!
}

const vehicleLabel = (v: Vehicle) => v.nickname ?? `${v.make} ${v.model} ${v.year}`

/** Job diario: recalcula todos los vehículos y dispara notificaciones. */
export async function recalcAllVehicles() {
  const all = await db.select().from(vehicles)
  for (const v of all) await recalcVehicle(v, { notify: true })
  console.log(`[jobs] mantenimiento recalculado para ${all.length} vehículos`)
}
