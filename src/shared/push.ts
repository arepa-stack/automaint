import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { devices, notifications } from '../db/schema'

// ponytail: sin credenciales FCM el push es log-only; la notificación siempre se
// persiste en BD para que el cliente la vea. FCM real (firebase-admin) en it. 4.
export async function notifyUser(
  userId: string,
  type: string,
  title: string,
  body: string,
  data?: Record<string, string>,
) {
  const [row] = await db.insert(notifications)
    .values({ userId, type, title, body, data })
    .returning()

  const tokens = await db.select().from(devices).where(eq(devices.userId, userId))
  console.log(`[push] → user=${userId} devices=${tokens.length} [${type}] ${title}: ${body}`)
  return row!
}
