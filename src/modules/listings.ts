import { Elysia, t } from 'elysia'
import { and, asc, desc, eq, gte, ilike, lte, sql } from 'drizzle-orm'
import { db } from '../db/client'
import {
  carListings, expenses, favorites, listingPhotos, maintenanceItems, partners, searchAlerts, users,
} from '../db/schema'
import { authed } from '../shared/auth'
import { badRequest, forbidden, notFound } from '../shared/errors'
import { saveFile, fileUrl } from '../shared/storage'
import { getOwnedVehicle } from './vehicles'

const LISTING_DAYS = 30
const expiryDate = () => new Date(Date.now() + LISTING_DAYS * 86400_000)

async function withPhotos<T extends { id: string }>(rows: T[]) {
  return Promise.all(rows.map(async r => ({
    ...r,
    photos: (await db.select().from(listingPhotos)
      .where(eq(listingPhotos.listingId, r.id)).orderBy(asc(listingPhotos.position)))
      .map(p => ({ id: p.id, url: fileUrl(p.filePath), position: p.position })),
  })))
}

export const listingsModule = new Elysia({ tags: ['listings'] })

  // ── Búsqueda pública (HU-017) ───────────────────────────────────────────
  .get('/listings', async ({ query }) => {
    const filters = [eq(carListings.status, 'active')]
    if (query.make) filters.push(ilike(carListings.make, query.make))
    if (query.model) filters.push(ilike(carListings.model, `%${query.model}%`))
    if (query.yearFrom) filters.push(gte(carListings.year, query.yearFrom))
    if (query.yearTo) filters.push(lte(carListings.year, query.yearTo))
    if (query.priceMax) filters.push(lte(carListings.price, String(query.priceMax)))
    if (query.kmMax) filters.push(lte(carListings.km, query.kmMax))
    if (query.city) filters.push(ilike(carListings.city, `%${query.city}%`))

    const rows = await db.select().from(carListings).where(and(...filters))
      .orderBy(desc(carListings.featured), desc(carListings.createdAt))
      .limit(query.limit ?? 50)
    return withPhotos(rows.map(r => ({ ...r, verifiedHistory: r.vehicleId != null })))
  }, {
    query: t.Object({
      make: t.Optional(t.String()),
      model: t.Optional(t.String()),
      yearFrom: t.Optional(t.Integer()),
      yearTo: t.Optional(t.Integer()),
      priceMax: t.Optional(t.Number()),
      kmMax: t.Optional(t.Integer()),
      city: t.Optional(t.String()),
      limit: t.Optional(t.Integer({ maximum: 100 })),
    }),
  })

  .get('/listings/:id', async ({ params }) => {
    const listing = await db.query.carListings.findFirst({ where: eq(carListings.id, params.id) })
    if (!listing || !['active', 'sold'].includes(listing.status)) throw notFound('Listado')
    await db.update(carListings).set({ views: sql`${carListings.views} + 1` }).where(eq(carListings.id, listing.id))

    // historial verificado: servicios completados registrados en AutoMaint
    let verifiedHistory = null
    if (listing.vehicleId) {
      const services = await db.select({
        name: maintenanceItems.name,
        lastServiceKm: maintenanceItems.lastServiceKm,
        lastServiceDate: maintenanceItems.lastServiceDate,
      }).from(maintenanceItems).where(eq(maintenanceItems.vehicleId, listing.vehicleId))
      const expenseCount = await db.select({ count: sql<number>`count(*)::int` })
        .from(expenses).where(and(eq(expenses.vehicleId, listing.vehicleId), eq(expenses.type, 'mantenimiento')))
      verifiedHistory = { services, maintenanceRecords: expenseCount[0]!.count }
    }
    const [row] = await withPhotos([listing])
    return { ...row, verifiedHistory }
  }, {
    params: t.Object({ id: t.String({ format: 'uuid' }) }),
  })

  .use(authed)

  // ── Publicar (desde vehículo propio o listado nuevo) ────────────────────
  .post('/listings', async ({ user, body }) => {
    let vehicleData = null
    if (body.vehicleId) {
      const v = await getOwnedVehicle(user, body.vehicleId)
      vehicleData = { make: v.make, model: v.model, year: v.year, km: v.currentKm, vehicleId: v.id }
    }
    if (!vehicleData && (!body.make || !body.model || !body.year || body.km == null))
      throw badRequest('Sin vehicleId debes enviar make, model, year y km')

    const me = (await db.query.users.findFirst({ where: eq(users.id, user.id) }))!
    const partner = await db.query.partners.findFirst({ where: eq(partners.userId, user.id) })
    const whatsapp = body.contactWhatsapp ?? partner?.whatsapp ?? me.phone
    if (!whatsapp) throw badRequest('Se requiere contactWhatsapp (o teléfono en tu perfil)')

    const [listing] = await db.insert(carListings).values({
      sellerUserId: user.id,
      partnerId: partner?.type === 'concesionario' ? partner.id : null,
      vehicleId: vehicleData?.vehicleId ?? null,
      make: vehicleData?.make ?? body.make!,
      model: vehicleData?.model ?? body.model!,
      year: vehicleData?.year ?? body.year!,
      km: vehicleData?.km ?? body.km!,
      price: body.price,
      currency: body.currency ?? 'USD',
      description: body.description,
      city: body.city ?? me.city,
      contactWhatsapp: whatsapp,
      expiresAt: expiryDate(),
    }).returning()
    return listing // status=pending hasta moderación del admin
  }, {
    body: t.Object({
      vehicleId: t.Optional(t.String({ format: 'uuid' })),
      make: t.Optional(t.String()),
      model: t.Optional(t.String()),
      year: t.Optional(t.Integer({ minimum: 1950, maximum: 2100 })),
      km: t.Optional(t.Integer({ minimum: 0 })),
      price: t.String(),
      currency: t.Optional(t.String()),
      description: t.Optional(t.String({ maxLength: 5000 })),
      city: t.Optional(t.String()),
      contactWhatsapp: t.Optional(t.String()),
    }),
  })

  .get('/me/listings', async ({ user }) => {
    const rows = await db.select().from(carListings)
      .where(eq(carListings.sellerUserId, user.id)).orderBy(desc(carListings.createdAt))
    return withPhotos(rows)
  })

  // vendido / renovar / editar precio y descripción
  .patch('/listings/:id', async ({ user, params, body }) => {
    const listing = await db.query.carListings.findFirst({ where: eq(carListings.id, params.id) })
    if (!listing) throw notFound('Listado')
    if (listing.sellerUserId !== user.id && user.role !== 'admin') throw forbidden()

    const patch: Partial<typeof carListings.$inferInsert> = {}
    if (body.price) patch.price = body.price
    if (body.description !== undefined) patch.description = body.description
    if (body.action === 'sold') patch.status = 'sold'
    if (body.action === 'renew') {
      if (!['active', 'expired'].includes(listing.status)) throw badRequest('Solo listados activos o expirados se renuevan')
      patch.status = 'active'
      patch.expiresAt = expiryDate()
    }
    const [updated] = await db.update(carListings).set(patch).where(eq(carListings.id, listing.id)).returning()
    return updated
  }, {
    body: t.Object({
      price: t.Optional(t.String()),
      description: t.Optional(t.String()),
      action: t.Optional(t.Union([t.Literal('sold'), t.Literal('renew')])),
    }),
  })

  .post('/listings/:id/photos', async ({ user, params, body }) => {
    const listing = await db.query.carListings.findFirst({ where: eq(carListings.id, params.id) })
    if (!listing || listing.sellerUserId !== user.id) throw notFound('Listado')
    const count = await db.select({ count: sql<number>`count(*)::int` })
      .from(listingPhotos).where(eq(listingPhotos.listingId, listing.id))
    if (count[0]!.count >= 10) throw badRequest('Máximo 10 fotos por listado')

    const path = await saveFile('listings', body.file)
    const [photo] = await db.insert(listingPhotos)
      .values({ listingId: listing.id, filePath: path, position: count[0]!.count }).returning()
    return { ...photo!, url: fileUrl(path) }
  }, {
    body: t.Object({ file: t.File() }),
  })

  // ── Favoritos y alertas ─────────────────────────────────────────────────
  .post('/listings/:id/favorite', async ({ user, params }) => {
    const listing = await db.query.carListings.findFirst({ where: eq(carListings.id, params.id) })
    if (!listing) throw notFound('Listado')
    await db.insert(favorites).values({ userId: user.id, listingId: listing.id }).onConflictDoNothing()
    return { ok: true }
  })

  .delete('/listings/:id/favorite', async ({ user, params }) => {
    await db.delete(favorites).where(and(eq(favorites.userId, user.id), eq(favorites.listingId, params.id)))
    return { ok: true }
  })

  .get('/me/favorites', async ({ user }) => {
    const rows = await db.select({ listing: carListings, favoritedAt: favorites.createdAt })
      .from(favorites)
      .innerJoin(carListings, eq(carListings.id, favorites.listingId))
      .where(eq(favorites.userId, user.id))
      .orderBy(desc(favorites.createdAt))
    return withPhotos(rows.map(r => ({ ...r.listing, favoritedAt: r.favoritedAt })))
  })

  .post('/me/search-alerts', async ({ user, body }) => {
    const [alert] = await db.insert(searchAlerts).values({ userId: user.id, filters: body }).returning()
    return alert
  }, {
    body: t.Object({
      make: t.Optional(t.String()),
      model: t.Optional(t.String()),
      yearFrom: t.Optional(t.Integer()),
      yearTo: t.Optional(t.Integer()),
      priceMax: t.Optional(t.Number()),
      kmMax: t.Optional(t.Integer()),
      city: t.Optional(t.String()),
    }),
  })

  .get('/me/search-alerts', async ({ user }) =>
    db.select().from(searchAlerts).where(eq(searchAlerts.userId, user.id)))

  .delete('/me/search-alerts/:id', async ({ user, params }) => {
    await db.delete(searchAlerts).where(and(eq(searchAlerts.id, params.id), eq(searchAlerts.userId, user.id)))
    return { ok: true }
  })
