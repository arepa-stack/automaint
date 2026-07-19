import { Elysia, t } from 'elysia'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { appointments, orders, partnerDocuments, partners, parts, quotes, users, workshopSchedules, workshopServices } from '../db/schema'
import { authed, type AuthUser } from '../shared/auth'
import { badRequest, notFound } from '../shared/errors'
import { saveFile, fileUrl } from '../shared/storage'
import { distanceKm } from '../shared/geo'

export const PARTNER_TYPES = ['taller', 'repuestos', 'concesionario', 'servicios'] as const

export async function getMyPartner(user: AuthUser) {
  const p = await db.query.partners.findFirst({ where: eq(partners.userId, user.id) })
  if (!p) throw notFound('Perfil de partner')
  return p
}

const partnerBody = t.Object({
  type: t.Union(PARTNER_TYPES.map(x => t.Literal(x))),
  serviceCategory: t.Optional(t.String()), // grua, lavado, cerrajero, seguros, tramites
  businessName: t.String({ minLength: 1 }),
  taxId: t.String({ minLength: 1 }),
  whatsapp: t.String({ minLength: 8 }),
  phone: t.Optional(t.String()),
  email: t.Optional(t.String()),
  address: t.Optional(t.String()),
  city: t.Optional(t.String()),
  lat: t.Optional(t.Number()),
  lng: t.Optional(t.Number()),
  description: t.Optional(t.String()),
})

export const partnersModule = new Elysia({ prefix: '/partners', tags: ['partners'] })

  // ── Público / usuarios ──────────────────────────────────────────────────
  .get('/nearby', async ({ query }) => {
    const dist = distanceKm(query.lat, query.lng)
    const filters = [eq(partners.status, 'approved'), sql`partners.lat is not null`]
    if (query.type) filters.push(eq(partners.type, query.type as typeof PARTNER_TYPES[number]))
    if (query.serviceCategory) filters.push(eq(partners.serviceCategory, query.serviceCategory))

    return db.select({
      id: partners.id, type: partners.type, serviceCategory: partners.serviceCategory,
      businessName: partners.businessName, whatsapp: partners.whatsapp, phone: partners.phone,
      address: partners.address, city: partners.city, lat: partners.lat, lng: partners.lng,
      rating: partners.rating, reviewCount: partners.reviewCount,
      distanceKm: dist,
    }).from(partners)
      .where(and(...filters, sql`${dist} <= ${query.radiusKm ?? 25}`))
      .orderBy(asc(dist))
      .limit(query.limit ?? 20)
  }, {
    query: t.Object({
      lat: t.Number(),
      lng: t.Number(),
      radiusKm: t.Optional(t.Number({ maximum: 200 })),
      type: t.Optional(t.String()),
      serviceCategory: t.Optional(t.String()),
      limit: t.Optional(t.Integer({ maximum: 50 })),
    }),
  })

  .get('/:id', async ({ params }) => {
    const p = await db.query.partners.findFirst({ where: and(eq(partners.id, params.id), eq(partners.status, 'approved')) })
    if (!p) throw notFound('Partner')
    const services = await db.select().from(workshopServices)
      .where(and(eq(workshopServices.partnerId, p.id), eq(workshopServices.active, true)))
    const schedules = await db.select().from(workshopSchedules)
      .where(eq(workshopSchedules.partnerId, p.id)).orderBy(asc(workshopSchedules.weekday))
    const { taxId, ...pub } = p
    return { ...pub, services, schedules }
  }, {
    params: t.Object({ id: t.String({ format: 'uuid' }) }),
  })

  // ── Registro y gestión (requiere auth) ─────────────────────────────────
  .use(authed)

  .post('/', async ({ user, body }) => {
    const existing = await db.query.partners.findFirst({ where: eq(partners.userId, user.id) })
    if (existing) throw badRequest('Ya tienes un perfil de partner', 'PARTNER_EXISTS')
    if (body.type === 'servicios' && !body.serviceCategory)
      throw badRequest('serviceCategory es requerido para type=servicios')

    const [partner] = await db.insert(partners).values({ ...body, userId: user.id }).returning()
    await db.update(users).set({ role: 'partner' }).where(and(eq(users.id, user.id), eq(users.role, 'user')))
    return partner // status=pending hasta aprobación del admin
  }, { body: partnerBody })

  .get('/me', async ({ user }) => {
    const p = await getMyPartner(user)
    const documents = await db.select().from(partnerDocuments).where(eq(partnerDocuments.partnerId, p.id))
    return { ...p, documents: documents.map(d => ({ ...d, fileUrl: fileUrl(d.filePath) })) }
  })

  .patch('/me', async ({ user, body }) => {
    const p = await getMyPartner(user)
    const [updated] = await db.update(partners).set(body).where(eq(partners.id, p.id)).returning()
    return updated
  }, { body: t.Partial(partnerBody) })

  // Métricas del partner: proveedor (productos/pedidos) y taller (citas/presupuestos)
  .get('/me/stats', async ({ user }) => {
    const p = await getMyPartner(user)

    const [partStats] = await db.select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where active)::int`,
      views: sql<number>`coalesce(sum(views), 0)::int`,
      clicks: sql<number>`coalesce(sum(clicks), 0)::int`,
    }).from(parts).where(eq(parts.partnerId, p.id))

    const orderRows = await db.select({
      status: orders.status,
      count: sql<number>`count(*)::int`,
      total: sql<string>`coalesce(sum(total), 0)::text`,
    }).from(orders).where(eq(orders.partnerId, p.id)).groupBy(orders.status)

    const apptRows = await db.select({
      status: appointments.status,
      count: sql<number>`count(*)::int`,
    }).from(appointments).where(eq(appointments.partnerId, p.id)).groupBy(appointments.status)

    const [quoteStats] = await db.select({
      total: sql<number>`count(*)::int`,
      approved: sql<number>`count(*) filter (where status = 'approved')::int`,
    }).from(quotes).where(eq(quotes.partnerId, p.id))

    return {
      rating: p.rating,
      reviewCount: p.reviewCount,
      parts: partStats,
      orders: Object.fromEntries(orderRows.map(r => [r.status, { count: r.count, total: r.total }])),
      appointments: Object.fromEntries(apptRows.map(r => [r.status, r.count])),
      quotes: quoteStats,
    }
  })

  .post('/me/documents', async ({ user, body }) => {
    const p = await getMyPartner(user)
    const path = await saveFile('partner-docs', body.file)
    const [doc] = await db.insert(partnerDocuments)
      .values({ partnerId: p.id, name: body.name, filePath: path }).returning()
    return { ...doc!, fileUrl: fileUrl(path) }
  }, {
    body: t.Object({ file: t.File(), name: t.String({ minLength: 1 }) }),
  })
