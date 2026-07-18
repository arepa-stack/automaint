import { Elysia, t } from 'elysia'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { users, devices } from '../db/schema'
import { authed } from '../shared/auth'
import { notFound } from '../shared/errors'

export const usersModule = new Elysia({ prefix: '/me', tags: ['users'] })
  .use(authed)

  .get('/', async ({ user }) => {
    const row = await db.query.users.findFirst({ where: eq(users.id, user.id) })
    if (!row) throw notFound('Usuario')
    const { passwordHash, emailVerifyToken, ...rest } = row
    return rest
  })

  .patch('/', async ({ user, body }) => {
    const [updated] = await db.update(users).set(body).where(eq(users.id, user.id)).returning()
    if (!updated) throw notFound('Usuario')
    const { passwordHash, emailVerifyToken, ...rest } = updated
    return rest
  }, {
    body: t.Object({
      name: t.Optional(t.String({ minLength: 1 })),
      phone: t.Optional(t.String()),
      city: t.Optional(t.String()),
      notifyKmBefore: t.Optional(t.Integer({ minimum: 0, maximum: 5000 })),
      notifyDaysBefore: t.Optional(t.Integer({ minimum: 0, maximum: 60 })),
    }),
  })

  .post('/devices', async ({ user, body }) => {
    const [device] = await db.insert(devices)
      .values({ userId: user.id, fcmToken: body.fcmToken, platform: body.platform })
      .onConflictDoUpdate({ target: devices.fcmToken, set: { userId: user.id, platform: body.platform } })
      .returning()
    return device
  }, {
    body: t.Object({
      fcmToken: t.String({ minLength: 1 }),
      platform: t.Union([t.Literal('android'), t.Literal('ios'), t.Literal('web')]),
    }),
  })

  .delete('/devices/:token', async ({ user, params }) => {
    await db.delete(devices).where(and(eq(devices.userId, user.id), eq(devices.fcmToken, params.token)))
    return { ok: true }
  })
