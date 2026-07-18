import { Elysia, t } from 'elysia'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client'
import { notifications } from '../db/schema'
import { authed } from '../shared/auth'
import { notFound } from '../shared/errors'

export const notificationsModule = new Elysia({ prefix: '/me/notifications', tags: ['notifications'] })
  .use(authed)

  .get('/', async ({ user, query }) => {
    const filters = [eq(notifications.userId, user.id)]
    if (query.unread === 'true') filters.push(isNull(notifications.readAt))
    return db.select().from(notifications).where(and(...filters))
      .orderBy(desc(notifications.createdAt)).limit(100)
  }, {
    query: t.Object({ unread: t.Optional(t.String()) }),
  })

  .post('/:id/read', async ({ user, params }) => {
    const [updated] = await db.update(notifications).set({ readAt: new Date() })
      .where(and(eq(notifications.id, params.id), eq(notifications.userId, user.id))).returning()
    if (!updated) throw notFound('Notificación')
    return updated
  })

  .post('/read-all', async ({ user }) => {
    await db.update(notifications).set({ readAt: new Date() })
      .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)))
    return { ok: true }
  })
