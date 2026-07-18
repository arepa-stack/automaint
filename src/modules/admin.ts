import { Elysia, t } from 'elysia'
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { db } from '../db/client'
import {
  adminAuditLog, appointments, carListings, orders, partnerDocuments, partners, users, vehicles,
} from '../db/schema'
import { authed, assertRole } from '../shared/auth'
import { notFound } from '../shared/errors'
import { notifyUser } from '../shared/push'
import { fileUrl } from '../shared/storage'

const count = (table: any, where?: any) =>
  db.select({ n: sql<number>`count(*)::int` }).from(table).where(where).then(r => r[0]!.n)

export const adminModule = new Elysia({ prefix: '/admin', tags: ['admin'] })
  .use(authed)
  .onBeforeHandle(({ user }) => { assertRole(user, 'admin') })

  // ── Métricas (HU-014) ───────────────────────────────────────────────────
  .get('/metrics', async () => ({
    users: await count(users),
    vehicles: await count(vehicles),
    partners: {
      total: await count(partners),
      pending: await count(partners, eq(partners.status, 'pending')),
      approved: await count(partners, eq(partners.status, 'approved')),
    },
    appointments: await count(appointments),
    orders: {
      total: await count(orders),
      delivered: await count(orders, eq(orders.status, 'delivered')),
      volume: (await db.select({ v: sql<string>`coalesce(sum(${orders.total}), 0)` })
        .from(orders).where(eq(orders.status, 'delivered')))[0]!.v,
    },
    listings: {
      total: await count(carListings),
      active: await count(carListings, eq(carListings.status, 'active')),
      pending: await count(carListings, eq(carListings.status, 'pending')),
    },
  }))

  // ── Gestión de partners ─────────────────────────────────────────────────
  .get('/partners', async ({ query }) => {
    const filters = []
    if (query.status) filters.push(eq(partners.status, query.status as any))
    const rows = await db.select().from(partners)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(partners.createdAt)).limit(200)
    return Promise.all(rows.map(async p => ({
      ...p,
      documents: (await db.select().from(partnerDocuments).where(eq(partnerDocuments.partnerId, p.id)))
        .map(d => ({ ...d, fileUrl: fileUrl(d.filePath) })),
    })))
  }, {
    query: t.Object({ status: t.Optional(t.String()) }),
  })

  .patch('/partners/:id', async ({ user, params, body }) => {
    const partner = await db.query.partners.findFirst({ where: eq(partners.id, params.id) })
    if (!partner) throw notFound('Partner')
    const [updated] = await db.update(partners).set({ status: body.status }).where(eq(partners.id, partner.id)).returning()

    await db.insert(adminAuditLog).values({
      adminUserId: user.id, action: `partner_${body.status}`,
      targetType: 'partner', targetId: partner.id, details: { reason: body.reason },
    })
    const msgs: Record<string, string> = {
      approved: `¡Felicidades! ${partner.businessName} fue aprobado en AutoMaint`,
      rejected: `Tu solicitud para ${partner.businessName} fue rechazada${body.reason ? `: ${body.reason}` : ''}`,
      suspended: `${partner.businessName} fue suspendido${body.reason ? `: ${body.reason}` : ''}`,
    }
    if (msgs[body.status])
      await notifyUser(partner.userId, 'partner_status', 'Estado de tu cuenta', msgs[body.status]!)
    return updated
  }, {
    body: t.Object({
      status: t.Union([t.Literal('approved'), t.Literal('rejected'), t.Literal('suspended')]),
      reason: t.Optional(t.String()),
    }),
  })

  // ── Moderación de listados ──────────────────────────────────────────────
  .get('/listings', async ({ query }) =>
    db.select().from(carListings)
      .where(query.status ? eq(carListings.status, query.status as any) : undefined)
      .orderBy(desc(carListings.createdAt)).limit(200), {
    query: t.Object({ status: t.Optional(t.String()) }),
  })

  .patch('/listings/:id', async ({ user, params, body }) => {
    const listing = await db.query.carListings.findFirst({ where: eq(carListings.id, params.id) })
    if (!listing) throw notFound('Listado')
    const patch: Partial<typeof carListings.$inferInsert> = { status: body.status }
    if (body.featured !== undefined) patch.featured = body.featured
    const [updated] = await db.update(carListings).set(patch).where(eq(carListings.id, listing.id)).returning()

    await db.insert(adminAuditLog).values({
      adminUserId: user.id, action: `listing_${body.status}`,
      targetType: 'listing', targetId: listing.id, details: { reason: body.reason },
    })
    if (listing.sellerUserId) {
      const msg = body.status === 'active'
        ? `Tu listado ${listing.make} ${listing.model} ${listing.year} fue aprobado y ya está visible`
        : `Tu listado ${listing.make} ${listing.model} ${listing.year} fue rechazado${body.reason ? `: ${body.reason}` : ''}`
      await notifyUser(listing.sellerUserId, 'listing_status', 'Moderación de listado', msg, { listingId: listing.id })
    }
    return updated
  }, {
    body: t.Object({
      status: t.Union([t.Literal('active'), t.Literal('rejected')]),
      featured: t.Optional(t.Boolean()),
      reason: t.Optional(t.String()),
    }),
  })

  // ── Usuarios ────────────────────────────────────────────────────────────
  .get('/users', async ({ query }) => {
    const rows = await db.select({
      id: users.id, email: users.email, name: users.name, role: users.role,
      city: users.city, isPremium: users.isPremium, createdAt: users.createdAt,
    }).from(users)
      .where(query.search
        ? or(ilike(users.email, `%${query.search}%`), ilike(users.name, `%${query.search}%`))
        : undefined)
      .orderBy(desc(users.createdAt)).limit(200)
    return rows
  }, {
    query: t.Object({ search: t.Optional(t.String()) }),
  })

  .get('/audit-log', async () =>
    db.select().from(adminAuditLog).orderBy(desc(adminAuditLog.createdAt)).limit(200))
