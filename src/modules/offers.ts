import { Elysia, t } from 'elysia'
import { and, desc, eq, gte, lte } from 'drizzle-orm'
import { db } from '../db/client'
import { offers, partners } from '../db/schema'
import { authed } from '../shared/auth'
import { notFound } from '../shared/errors'
import { getMyPartner } from './partners'

const toDateStr = (d: Date) => d.toISOString().slice(0, 10)

export const offersModule = new Elysia({ tags: ['offers'] })

  // Ofertas activas; con serviceKey filtra para publicidad contextual (HU-011)
  .get('/offers', async ({ query }) => {
    const today = toDateStr(new Date())
    const filters = [
      eq(offers.active, true),
      lte(offers.validFrom, today),
      gte(offers.validTo, today),
      eq(partners.status, 'approved'),
    ]
    if (query.serviceKey) filters.push(eq(offers.serviceKey, query.serviceKey))
    if (query.partnerId) filters.push(eq(offers.partnerId, query.partnerId))

    return db.select({
      id: offers.id, title: offers.title, description: offers.description,
      discountPct: offers.discountPct, serviceKey: offers.serviceKey,
      validFrom: offers.validFrom, validTo: offers.validTo,
      partnerId: partners.id, partnerName: partners.businessName,
      partnerCity: partners.city, partnerWhatsapp: partners.whatsapp,
      sponsored: offers.active, // marca "Patrocinado" en el cliente
    }).from(offers)
      .innerJoin(partners, eq(partners.id, offers.partnerId))
      .where(and(...filters))
      .orderBy(desc(offers.createdAt)).limit(50)
  }, {
    query: t.Object({
      serviceKey: t.Optional(t.String()),
      partnerId: t.Optional(t.String()),
    }),
  })

  .use(authed)

  .post('/partners/me/offers', async ({ user, body }) => {
    const p = await getMyPartner(user)
    const [offer] = await db.insert(offers).values({ ...body, partnerId: p.id }).returning()
    return offer
  }, {
    body: t.Object({
      title: t.String({ minLength: 1 }),
      description: t.Optional(t.String()),
      discountPct: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
      serviceKey: t.Optional(t.String()),
      validFrom: t.String({ format: 'date' }),
      validTo: t.String({ format: 'date' }),
    }),
  })

  .get('/partners/me/offers', async ({ user }) => {
    const p = await getMyPartner(user)
    return db.select().from(offers).where(eq(offers.partnerId, p.id)).orderBy(desc(offers.createdAt))
  })

  .patch('/partners/me/offers/:id', async ({ user, params, body }) => {
    const p = await getMyPartner(user)
    const [updated] = await db.update(offers).set(body)
      .where(and(eq(offers.id, params.id), eq(offers.partnerId, p.id))).returning()
    if (!updated) throw notFound('Oferta')
    return updated
  }, {
    body: t.Object({
      title: t.Optional(t.String()),
      description: t.Optional(t.String()),
      discountPct: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
      serviceKey: t.Optional(t.String()),
      validFrom: t.Optional(t.String({ format: 'date' })),
      validTo: t.Optional(t.String({ format: 'date' })),
      active: t.Optional(t.Boolean()),
    }),
  })
