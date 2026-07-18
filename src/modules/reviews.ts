import { Elysia, t } from 'elysia'
import { desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { partners, reviews, users } from '../db/schema'
import { authed } from '../shared/auth'
import { badRequest, notFound } from '../shared/errors'

export const reviewsModule = new Elysia({ tags: ['reviews'] })

  .get('/partners/:id/reviews', async ({ params }) =>
    db.select({
      id: reviews.id, rating: reviews.rating, comment: reviews.comment,
      createdAt: reviews.createdAt, userName: users.name,
    }).from(reviews)
      .innerJoin(users, eq(users.id, reviews.userId))
      .where(eq(reviews.partnerId, params.id))
      .orderBy(desc(reviews.createdAt)).limit(100), {
    params: t.Object({ id: t.String({ format: 'uuid' }) }),
  })

  .use(authed)

  .post('/partners/:id/reviews', async ({ user, params, body }) => {
    const partner = await db.query.partners.findFirst({ where: eq(partners.id, params.id) })
    if (!partner || partner.status !== 'approved') throw notFound('Partner')
    if (partner.userId === user.id) throw badRequest('No puedes reseñar tu propio negocio')

    const [review] = await db.insert(reviews)
      .values({ partnerId: partner.id, userId: user.id, rating: body.rating, comment: body.comment })
      .onConflictDoUpdate({
        target: [reviews.partnerId, reviews.userId],
        set: { rating: body.rating, comment: body.comment, createdAt: new Date() },
      }).returning()

    // recalcular rating agregado del partner
    const [agg] = await db.select({
      avg: sql<number>`avg(${reviews.rating})::real`,
      count: sql<number>`count(*)::int`,
    }).from(reviews).where(eq(reviews.partnerId, partner.id))
    await db.update(partners).set({ rating: agg!.avg, reviewCount: agg!.count }).where(eq(partners.id, partner.id))

    return review
  }, {
    params: t.Object({ id: t.String({ format: 'uuid' }) }),
    body: t.Object({
      rating: t.Integer({ minimum: 1, maximum: 5 }),
      comment: t.Optional(t.String({ maxLength: 2000 })),
    }),
  })
