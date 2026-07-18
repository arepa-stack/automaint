import { Elysia } from 'elysia'
import { jwt } from '@elysiajs/jwt'
import { config } from '../config'
import { unauthorized, forbidden } from './errors'

export type Role = 'user' | 'partner' | 'admin'
export interface AuthUser { id: string; role: Role }

export const jwtPlugin = new Elysia({ name: 'jwt-plugin' }).use(
  jwt({ name: 'jwt', secret: config.jwtSecret, exp: config.accessTokenTtl }),
)

// Plugin de autenticación: expone `user` (AuthUser) en el contexto o lanza 401
export const authed = new Elysia({ name: 'authed' })
  .use(jwtPlugin)
  .resolve({ as: 'scoped' }, async ({ jwt, headers }) => {
    const token = headers.authorization?.startsWith('Bearer ')
      ? headers.authorization.slice(7)
      : undefined
    if (!token) throw unauthorized()
    const payload = await jwt.verify(token)
    if (!payload || typeof payload.sub !== 'string') throw unauthorized('Token inválido o expirado')
    return { user: { id: payload.sub, role: (payload as any).role as Role } satisfies AuthUser }
  })

export function assertRole(user: AuthUser, ...roles: Role[]) {
  if (user.role !== 'admin' && !roles.includes(user.role)) throw forbidden()
}
