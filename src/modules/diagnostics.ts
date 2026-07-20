import { Elysia, t } from 'elysia'
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { db } from '../db/client'
import { config } from '../config'
import { carListings, diagnostics, diagnosticUsage, expenses, maintenanceItems, vehicleDiagnosisLog } from '../db/schema'
import { authed } from '../shared/auth'
import { badRequest, notFound, tooManyRequests } from '../shared/errors'
import { getOwnedVehicle } from './vehicles'
import { diagnose, evaluateListing, normalizeSymptom } from '../shared/llm'

// Arma el historial del vehículo (mantenimientos hechos + gastos/reparaciones + diagnósticos previos)
// para inyectarlo al prompt: así la IA "recuerda" el carro sin que el usuario repita el cuento.
async function buildVehicleContext(vehicleId: string, currentKm: number): Promise<string> {
  const [done, exps, dx] = await Promise.all([
    db.select({ name: maintenanceItems.name, date: maintenanceItems.lastServiceDate, km: maintenanceItems.lastServiceKm })
      .from(maintenanceItems)
      .where(and(eq(maintenanceItems.vehicleId, vehicleId), isNotNull(maintenanceItems.lastCompletedAt)))
      .orderBy(desc(maintenanceItems.lastCompletedAt)).limit(8),
    db.select({ type: expenses.type, date: expenses.date, desc: expenses.description, vendor: expenses.vendor, amount: expenses.amount })
      .from(expenses)
      .where(and(eq(expenses.vehicleId, vehicleId), inArray(expenses.type, ['reparacion', 'mantenimiento'])))
      .orderBy(desc(expenses.date)).limit(8),
    db.select({ symptom: vehicleDiagnosisLog.symptom, result: vehicleDiagnosisLog.result })
      .from(vehicleDiagnosisLog)
      .where(eq(vehicleDiagnosisLog.vehicleId, vehicleId))
      .orderBy(desc(vehicleDiagnosisLog.createdAt)).limit(5),
  ])

  const lines: string[] = [`Kilometraje actual: ${currentKm} km.`]
  if (done.length) {
    lines.push('Mantenimientos ya realizados:')
    for (const d of done) lines.push(`- ${d.name}${d.date ? ` (${d.date}${d.km ? `, ${d.km} km` : ''})` : ''}`)
  }
  if (exps.length) {
    lines.push('Reparaciones/gastos:')
    for (const e of exps) lines.push(`- ${e.date}: ${e.type}${e.desc ? ` — ${e.desc}` : ''}${e.vendor ? ` (${e.vendor})` : ''} $${e.amount}`)
  }
  if (dx.length) {
    lines.push('Diagnósticos previos:')
    for (const d of dx) lines.push(`- "${d.symptom}" → ${d.result.summary}`)
  }
  return lines.join('\n')
}

// Historial verificado del anuncio para el comprador: SOLO datos ya públicos (servicios completados +
// nº de registros de mantenimiento). NUNCA el log de diagnósticos del dueño (privado).
async function buildListingContext(listing: typeof carListings.$inferSelect): Promise<string> {
  const lines = [
    `Anuncio: ${listing.make} ${listing.model} ${listing.year}, ${listing.km} km, precio ${listing.price} ${listing.currency}.`,
    listing.city ? `Ciudad: ${listing.city}.` : '',
  ].filter(Boolean)

  if (!listing.vehicleId) {
    lines.push('Historial verificado: NINGUNO (el vendedor no llevó el mantenimiento en AutoMaint).')
    return lines.join('\n')
  }
  const [services, cnt] = await Promise.all([
    db.select({ name: maintenanceItems.name, km: maintenanceItems.lastServiceKm, date: maintenanceItems.lastServiceDate })
      .from(maintenanceItems)
      .where(and(eq(maintenanceItems.vehicleId, listing.vehicleId), isNotNull(maintenanceItems.lastCompletedAt)))
      .orderBy(desc(maintenanceItems.lastServiceDate)).limit(20),
    db.select({ n: sql<number>`count(*)::int` })
      .from(expenses).where(and(eq(expenses.vehicleId, listing.vehicleId), eq(expenses.type, 'mantenimiento'))),
  ])
  lines.push(`Historial verificado en AutoMaint: ${cnt[0]!.n} registros de mantenimiento.`)
  if (services.length) {
    lines.push('Servicios completados documentados:')
    for (const s of services) lines.push(`- ${s.name}${s.date ? ` (${s.date}${s.km ? `, ${s.km} km` : ''})` : ''}`)
  }
  return lines.join('\n')
}

// Consume 1 del cupo diario (por tipo) de forma atómica; false si ya se alcanzó el límite.
// setWhere evita pasarse el cupo aunque entren muchas requests a la vez.
// ponytail: hoy el límite es un número global (config). Mañana = limitForUser(user) según su plan.
async function consumeQuota(userId: string, kind: string, limit: number): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10) // día UTC; resetea a medianoche UTC
  const rows = await db.insert(diagnosticUsage)
    .values({ userId, day: today, kind, count: 1 })
    .onConflictDoUpdate({
      target: [diagnosticUsage.userId, diagnosticUsage.day, diagnosticUsage.kind],
      set: { count: sql`${diagnosticUsage.count} + 1` },
      setWhere: sql`${diagnosticUsage.count} < ${limit}`,
    })
    .returning({ count: diagnosticUsage.count })
  return rows.length > 0
}

export const diagnosticsModule = new Elysia({ prefix: '/diagnostics', tags: ['diagnostics'] })
  .use(authed)
  .post('/', async ({ user, body }) => {
    const v = await getOwnedVehicle(user, body.vehicleId)
    const context = await buildVehicleContext(v.id, v.currentKm)
    // La clave incluye la huella del historial: si el carro tiene nuevo mantenimiento/dx, la respuesta
    // cacheada deja de aplicar y se recalcula. ponytail: con contexto el caché casi no comparte entre
    // usuarios; el cupo diario es lo que protege el costo, el caché solo evita el doble-submit inmediato.
    const key = createHash('sha1').update(`${v.id}|${normalizeSymptom(body.symptom)}|${context}`).digest('hex')

    // Cache-hit = gratis, no consume cupo ni llama al LLM
    const cached = await db.query.diagnostics.findFirst({ where: eq(diagnostics.cacheKey, key) })
    if (cached) {
      await db.update(diagnostics).set({ hits: sql`${diagnostics.hits} + 1` }).where(eq(diagnostics.id, cached.id))
      if (cached.result.offtopic) throw badRequest('Solo puedo diagnosticar problemas de tu vehículo.', 'OFFTOPIC')
      return { ...cached.result, cached: true }
    }

    // Cache-miss → va a costar una llamada al LLM: cobra cupo antes de llamar (protege la cuota de Gemini)
    if (!(await consumeQuota(user.id, 'diagnosis', config.freeDailyDiagnostics)))
      throw tooManyRequests(`Alcanzaste tu límite de ${config.freeDailyDiagnostics} diagnósticos por hoy. Vuelve mañana.`)

    const { result, source } = await diagnose(v.make, v.model, v.year, body.symptom, context)
    if (source === 'llm') {
      // Cachear (offtopic incluido, para no reprocesar spam). No cacheamos el mock por falta de key/error.
      await db.insert(diagnostics)
        .values({ cacheKey: key, make: v.make, model: v.model, year: v.year, symptom: body.symptom, result, source })
        .onConflictDoNothing()
      // Solo los diagnósticos reales entran al historial del vehículo (offtopic no).
      if (!result.offtopic)
        await db.insert(vehicleDiagnosisLog).values({ vehicleId: v.id, userId: user.id, symptom: body.symptom, result })
    }
    if (result.offtopic) throw badRequest('Solo puedo diagnosticar problemas de tu vehículo.', 'OFFTOPIC')
    return { ...result, cached: false }
  }, {
    body: t.Object({ vehicleId: t.String(), symptom: t.String({ minLength: 3, maxLength: 500 }) }),
  })

  // Comprador pregunta a la IA sobre un anuncio, usando su historial verificado. Cupo aparte (1/día).
  // Sin caché: cupo 1/día ya acota el costo y las preguntas libres sobre distintos anuncios casi no cachean.
  .post('/listing/:id', async ({ user, params, body }) => {
    const listing = await db.query.carListings.findFirst({ where: eq(carListings.id, params.id) })
    if (!listing || !['active', 'sold'].includes(listing.status)) throw notFound('Listado')

    if (!(await consumeQuota(user.id, 'listing_q', config.freeDailyListingQuestions)))
      throw tooManyRequests(`Alcanzaste tu límite de ${config.freeDailyListingQuestions} pregunta(s) sobre anuncios por hoy. Vuelve mañana.`)

    const context = await buildListingContext(listing)
    const { result } = await evaluateListing(context, body.question)
    if (result.offtopic) throw badRequest('Solo puedo evaluar la compra de este vehículo.', 'OFFTOPIC')
    return result
  }, {
    params: t.Object({ id: t.String({ format: 'uuid' }) }),
    body: t.Object({ question: t.String({ minLength: 3, maxLength: 500 }) }),
  })
