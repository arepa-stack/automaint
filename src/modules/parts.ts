import { Elysia, t } from 'elysia'
import { and, desc, eq, ilike, isNull, lte, gte, or, sql, inArray, notInArray } from 'drizzle-orm'
import { db } from '../db/client'
import { partCompatibility, parts, partners } from '../db/schema'
import { authed } from '../shared/auth'
import { notFound } from '../shared/errors'
import { saveFile, fileUrl } from '../shared/storage'
import { getMyPartner } from './partners'

const compatBody = t.Array(t.Object({
  make: t.String({ minLength: 1 }),
  model: t.Optional(t.String()),
  yearFrom: t.Optional(t.Integer()),
  yearTo: t.Optional(t.Integer()),
}))

export const partsModule = new Elysia({ tags: ['parts'] })

  // ── Búsqueda pública con filtro de compatibilidad (HU-016) ──────────────
  .get('/parts', async ({ query }) => {
    const filters = [eq(parts.active, true), eq(partners.status, 'approved')]
    if (query.category) filters.push(eq(parts.category, query.category))
    if (query.partnerId) filters.push(eq(parts.partnerId, query.partnerId))
    if (query.search) filters.push(or(ilike(parts.name, `%${query.search}%`), ilike(parts.description, `%${query.search}%`))!)

    // compatibilidad: repuesto sin filas de compatibilidad = universal
    if (query.make) {
      const compatible = db.select({ id: partCompatibility.partId }).from(partCompatibility).where(and(
        eq(partCompatibility.make, query.make),
        query.model ? or(isNull(partCompatibility.model), eq(partCompatibility.model, query.model)) : undefined,
        query.year ? or(isNull(partCompatibility.yearFrom), lte(partCompatibility.yearFrom, query.year)) : undefined,
        query.year ? or(isNull(partCompatibility.yearTo), gte(partCompatibility.yearTo, query.year)) : undefined,
      ))
      const anyCompat = db.select({ id: partCompatibility.partId }).from(partCompatibility)
      filters.push(or(inArray(parts.id, compatible), notInArray(parts.id, anyCompat))!)
    }

    const rows = await db.select({
      id: parts.id, name: parts.name, category: parts.category, description: parts.description,
      price: parts.price, currency: parts.currency, condition: parts.condition, stock: parts.stock,
      photoPath: parts.photoPath, views: parts.views,
      partnerId: partners.id, partnerName: partners.businessName, partnerCity: partners.city,
      partnerWhatsapp: partners.whatsapp, partnerRating: partners.rating,
    }).from(parts)
      .innerJoin(partners, eq(partners.id, parts.partnerId))
      .where(and(...filters))
      .orderBy(desc(parts.createdAt))
      .limit(query.limit ?? 50)

    return rows.map(r => ({ ...r, photoUrl: fileUrl(r.photoPath) }))
  }, {
    query: t.Object({
      search: t.Optional(t.String()),
      category: t.Optional(t.String()),
      make: t.Optional(t.String()),
      model: t.Optional(t.String()),
      year: t.Optional(t.Integer()),
      partnerId: t.Optional(t.String()),
      limit: t.Optional(t.Integer({ maximum: 100 })),
    }),
  })

  .get('/parts/:id', async ({ params }) => {
    const part = await db.query.parts.findFirst({ where: eq(parts.id, params.id) })
    if (!part || !part.active) throw notFound('Repuesto')
    await db.update(parts).set({ views: sql`${parts.views} + 1` }).where(eq(parts.id, part.id))
    const compat = await db.select().from(partCompatibility).where(eq(partCompatibility.partId, part.id))
    const partner = await db.query.partners.findFirst({ where: eq(partners.id, part.partnerId) })
    return {
      ...part,
      photoUrl: fileUrl(part.photoPath),
      compatibility: compat,
      partner: partner && {
        id: partner.id, businessName: partner.businessName, city: partner.city,
        whatsapp: partner.whatsapp, rating: partner.rating, reviewCount: partner.reviewCount,
      },
    }
  }, {
    params: t.Object({ id: t.String({ format: 'uuid' }) }),
  })

  // clic en "contactar" — métrica para el proveedor
  .post('/parts/:id/click', async ({ params }) => {
    await db.update(parts).set({ clicks: sql`${parts.clicks} + 1` }).where(eq(parts.id, params.id))
    return { ok: true }
  }, {
    params: t.Object({ id: t.String({ format: 'uuid' }) }),
  })

  // ── Gestión del proveedor ───────────────────────────────────────────────
  .use(authed)

  .post('/partners/me/parts', async ({ user, body }) => {
    const p = await getMyPartner(user)
    const { compatibility, ...data } = body
    const [part] = await db.insert(parts).values({ ...data, partnerId: p.id }).returning()
    if (compatibility?.length)
      await db.insert(partCompatibility).values(compatibility.map(c => ({ ...c, partId: part!.id })))
    return part
  }, {
    body: t.Object({
      name: t.String({ minLength: 1 }),
      category: t.String({ minLength: 1 }),
      description: t.Optional(t.String()),
      price: t.String(),
      currency: t.Optional(t.String()),
      condition: t.Optional(t.Union([t.Literal('nuevo'), t.Literal('usado')])),
      stock: t.Optional(t.Integer({ minimum: 0 })),
      compatibility: t.Optional(compatBody),
    }),
  })

  .get('/partners/me/parts', async ({ user }) => {
    const p = await getMyPartner(user)
    const rows = await db.select().from(parts).where(eq(parts.partnerId, p.id)).orderBy(desc(parts.createdAt))
    return rows.map(r => ({ ...r, photoUrl: fileUrl(r.photoPath) }))
  })

  .patch('/partners/me/parts/:id', async ({ user, params, body }) => {
    const p = await getMyPartner(user)
    const { compatibility, ...data } = body
    const [updated] = await db.update(parts).set(data)
      .where(and(eq(parts.id, params.id), eq(parts.partnerId, p.id))).returning()
    if (!updated) throw notFound('Repuesto')
    if (compatibility) {
      await db.delete(partCompatibility).where(eq(partCompatibility.partId, updated.id))
      if (compatibility.length)
        await db.insert(partCompatibility).values(compatibility.map(c => ({ ...c, partId: updated.id })))
    }
    return updated
  }, {
    body: t.Object({
      name: t.Optional(t.String()),
      category: t.Optional(t.String()),
      description: t.Optional(t.String()),
      price: t.Optional(t.String()),
      condition: t.Optional(t.Union([t.Literal('nuevo'), t.Literal('usado')])),
      stock: t.Optional(t.Integer({ minimum: 0 })),
      active: t.Optional(t.Boolean()),
      compatibility: t.Optional(compatBody),
    }),
  })

  .post('/partners/me/parts/:id/photo', async ({ user, params, body }) => {
    const p = await getMyPartner(user)
    const part = await db.query.parts.findFirst({ where: and(eq(parts.id, params.id), eq(parts.partnerId, p.id)) })
    if (!part) throw notFound('Repuesto')
    const path = await saveFile('listings', body.file)
    await db.update(parts).set({ photoPath: path }).where(eq(parts.id, part.id))
    return { photoUrl: fileUrl(path) }
  }, {
    body: t.Object({ file: t.File() }),
  })
