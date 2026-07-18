import { Elysia, t } from 'elysia'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { users, refreshTokens } from '../db/schema'
import { config } from '../config'
import { jwtPlugin } from '../shared/auth'
import { badRequest, unauthorized } from '../shared/errors'
import { sendEmail } from '../shared/email'

const sha256 = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex')

type JwtSigner = { sign: (payload: Record<string, string | number>) => Promise<string> }

async function issueTokens(jwt: JwtSigner, user: { id: string; role: string }) {
  const accessToken = await jwt.sign({ sub: user.id, role: user.role })
  const refreshToken = crypto.randomUUID() + crypto.randomUUID()
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: sha256(refreshToken),
    expiresAt: new Date(Date.now() + config.refreshTokenDays * 86400_000),
  })
  return { accessToken, refreshToken }
}

const publicUser = (u: typeof users.$inferSelect) => ({
  id: u.id, email: u.email, name: u.name, phone: u.phone, city: u.city,
  role: u.role, emailVerified: u.emailVerified, isPremium: u.isPremium,
})

export const authModule = new Elysia({ prefix: '/auth', tags: ['auth'] })
  .use(jwtPlugin)

  .post('/register', async ({ body, jwt }) => {
    const existing = await db.query.users.findFirst({ where: eq(users.email, body.email.toLowerCase()) })
    if (existing) throw badRequest('El email ya está registrado', 'EMAIL_TAKEN')

    const verifyToken = crypto.randomUUID()
    const [user] = await db.insert(users).values({
      email: body.email.toLowerCase(),
      passwordHash: await Bun.password.hash(body.password),
      name: body.name,
      phone: body.phone,
      city: body.city,
      emailVerifyToken: verifyToken,
    }).returning()

    await sendEmail(user!.email, 'Verifica tu cuenta AutoMaint',
      `<p>Hola ${user!.name}, verifica tu email: <a href="${config.appBaseUrl}/auth/verify-email?token=${verifyToken}">Verificar</a></p>`)

    return { user: publicUser(user!), ...(await issueTokens(jwt, user!)) }
  }, {
    body: t.Object({
      email: t.String({ format: 'email' }),
      password: t.String({ minLength: 8 }),
      name: t.String({ minLength: 1 }),
      phone: t.Optional(t.String()),
      city: t.Optional(t.String()),
    }),
  })

  .post('/login', async ({ body, jwt }) => {
    const user = await db.query.users.findFirst({ where: eq(users.email, body.email.toLowerCase()) })
    if (!user?.passwordHash || !(await Bun.password.verify(body.password, user.passwordHash)))
      throw unauthorized('Credenciales inválidas')
    return { user: publicUser(user), ...(await issueTokens(jwt, user)) }
  }, {
    body: t.Object({ email: t.String(), password: t.String() }),
  })

  .post('/refresh', async ({ body, jwt }) => {
    const hash = sha256(body.refreshToken)
    const stored = await db.query.refreshTokens.findFirst({ where: eq(refreshTokens.tokenHash, hash) })
    if (!stored || stored.expiresAt < new Date()) throw unauthorized('Refresh token inválido o expirado')

    // rotación: el token usado se invalida
    await db.delete(refreshTokens).where(eq(refreshTokens.id, stored.id))
    const user = await db.query.users.findFirst({ where: eq(users.id, stored.userId) })
    if (!user) throw unauthorized()
    return issueTokens(jwt, user)
  }, {
    body: t.Object({ refreshToken: t.String() }),
  })

  .post('/logout', async ({ body }) => {
    await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(body.refreshToken)))
    return { ok: true }
  }, {
    body: t.Object({ refreshToken: t.String() }),
  })

  .get('/verify-email', async ({ query }) => {
    const user = await db.query.users.findFirst({ where: eq(users.emailVerifyToken, query.token) })
    if (!user) throw badRequest('Token de verificación inválido')
    await db.update(users).set({ emailVerified: true, emailVerifyToken: null }).where(eq(users.id, user.id))
    return { ok: true, message: 'Email verificado' }
  }, {
    query: t.Object({ token: t.String() }),
  })

  // ── OAuth MOCK ──────────────────────────────────────────────────────────
  // Contrato final: recibe id_token del proveedor, devuelve sesión JWT.
  // Con OAUTH_MOCK=true acepta tokens con formato "mock:<email>:<nombre>".
  // Implementación real (validar id_token contra Google/Apple) en iteración 4.
  .post('/oauth/:provider', async ({ params, body, jwt }) => {
    if (!config.oauthMock)
      throw badRequest('OAuth real no implementado aún — usar OAUTH_MOCK=true', 'OAUTH_NOT_IMPLEMENTED')

    const [prefix, email, name] = body.idToken.split(':')
    if (prefix !== 'mock' || !email)
      throw unauthorized('Token mock inválido. Formato: mock:<email>:<nombre>')

    let user = await db.query.users.findFirst({ where: eq(users.email, email.toLowerCase()) })
    if (!user) {
      const [created] = await db.insert(users).values({
        email: email.toLowerCase(),
        name: name || email.split('@')[0]!,
        emailVerified: true,
        oauthProvider: params.provider,
      }).returning()
      user = created!
    }
    return { user: publicUser(user), ...(await issueTokens(jwt, user)) }
  }, {
    params: t.Object({ provider: t.Union([t.Literal('google'), t.Literal('apple')]) }),
    body: t.Object({ idToken: t.String() }),
  })
