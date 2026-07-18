import { Elysia, t } from 'elysia'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client'
import { orderItems, orders, partners, parts, users, vehicles } from '../db/schema'
import { authed } from '../shared/auth'
import { badRequest, forbidden, notFound } from '../shared/errors'
import { notifyUser } from '../shared/push'
import { getOwnedVehicle } from './vehicles'

const MAX_WA_TEXT = 1800 // margen bajo el límite (~2000) de URL de wa.me

function buildWhatsappMessage(opts: {
  customerName: string
  items: { name: string; qty: number; price: string }[]
  vehicle?: { make: string; model: string; year: number } | null
  total: string
  currency: string
  orderId: string
}) {
  const lines = [
    `🚗 *Pedido AutoMaint* #${opts.orderId.slice(0, 8)}`,
    `Cliente: ${opts.customerName}`,
    ...(opts.vehicle ? [`Vehículo: ${opts.vehicle.make} ${opts.vehicle.model} ${opts.vehicle.year}`] : []),
    '',
    ...opts.items.map(i => `• ${i.qty}x ${i.name} — ${i.price} ${opts.currency}`),
    '',
    `*Total referencial: ${opts.total} ${opts.currency}*`,
    '¿Disponibilidad y forma de pago?',
  ]
  let msg = lines.join('\n')
  if (msg.length > MAX_WA_TEXT) msg = msg.slice(0, MAX_WA_TEXT - 1) + '…'
  return msg
}

export const ordersModule = new Elysia({ tags: ['orders'] })
  .use(authed)

  // Carrito de un proveedor → pedido + link de WhatsApp (HU-016)
  .post('/orders', async ({ user, body }) => {
    const partner = await db.query.partners.findFirst({
      where: and(eq(partners.id, body.partnerId), eq(partners.status, 'approved')),
    })
    if (!partner) throw notFound('Proveedor')

    const vehicle = body.vehicleId ? await getOwnedVehicle(user, body.vehicleId) : null
    const partIds = body.items.map(i => i.partId)
    const partRows = await db.select().from(parts).where(and(
      inArray(parts.id, partIds), eq(parts.partnerId, partner.id), eq(parts.active, true),
    ))
    if (partRows.length !== partIds.length)
      throw badRequest('Algún repuesto no existe o no pertenece a este proveedor')

    const items = body.items.map(i => {
      const part = partRows.find(p => p.id === i.partId)!
      return { partId: part.id, name: part.name, qty: i.qty, price: part.price }
    })
    const total = items.reduce((sum, i) => sum + Number(i.price) * i.qty, 0).toFixed(2)
    const currency = partRows[0]!.currency
    const customer = (await db.query.users.findFirst({ where: eq(users.id, user.id) }))!

    const [order] = await db.insert(orders).values({
      userId: user.id, partnerId: partner.id, vehicleId: vehicle?.id,
      total, currency, message: '',
    }).returning()

    const message = buildWhatsappMessage({
      customerName: customer.name, items, vehicle, total, currency, orderId: order!.id,
    })
    await db.update(orders).set({ message }).where(eq(orders.id, order!.id))
    await db.insert(orderItems).values(items.map(i => ({ ...i, orderId: order!.id })))

    await notifyUser(partner.userId, 'order_new', 'Nuevo pedido',
      `${customer.name} envió un pedido por ${total} ${currency}`, { orderId: order!.id })

    return {
      order: { ...order!, message, items },
      whatsappUrl: `https://wa.me/${partner.whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`,
    }
  }, {
    body: t.Object({
      partnerId: t.String({ format: 'uuid' }),
      vehicleId: t.Optional(t.String({ format: 'uuid' })),
      items: t.Array(t.Object({
        partId: t.String({ format: 'uuid' }),
        qty: t.Integer({ minimum: 1, maximum: 99 }),
      }), { minItems: 1, maxItems: 30 }),
    }),
  })

  // Mis pedidos (usuario)
  .get('/orders', async ({ user }) => {
    const rows = await db.select().from(orders).where(eq(orders.userId, user.id)).orderBy(desc(orders.createdAt))
    return Promise.all(rows.map(async o => ({
      ...o,
      items: await db.select().from(orderItems).where(eq(orderItems.orderId, o.id)),
    })))
  })

  // Pedidos recibidos (proveedor)
  .get('/partners/me/orders', async ({ user, query }) => {
    const partner = await db.query.partners.findFirst({ where: eq(partners.userId, user.id) })
    if (!partner) throw notFound('Perfil de partner')
    const filters = [eq(orders.partnerId, partner.id)]
    if (query.status) filters.push(eq(orders.status, query.status as any))
    const rows = await db.select().from(orders).where(and(...filters)).orderBy(desc(orders.createdAt))
    return Promise.all(rows.map(async o => ({
      ...o,
      items: await db.select().from(orderItems).where(eq(orderItems.orderId, o.id)),
    })))
  }, {
    query: t.Object({ status: t.Optional(t.String()) }),
  })

  // Proveedor actualiza estado; usuario puede cancelar
  .patch('/orders/:id/status', async ({ user, params, body }) => {
    const order = await db.query.orders.findFirst({ where: eq(orders.id, params.id) })
    if (!order) throw notFound('Pedido')
    const partner = await db.query.partners.findFirst({ where: eq(partners.id, order.partnerId) })

    const isCustomer = order.userId === user.id
    const isProvider = partner?.userId === user.id || user.role === 'admin'
    if (!isCustomer && !isProvider) throw forbidden()
    if (isCustomer && !isProvider && body.status !== 'cancelled')
      throw forbidden('El cliente solo puede cancelar')

    const [updated] = await db.update(orders)
      .set({ status: body.status, updatedAt: new Date() })
      .where(eq(orders.id, order.id)).returning()

    const msgs: Record<string, string> = {
      confirmed: 'Tu pedido fue confirmado por el proveedor ✅',
      delivered: 'Tu pedido fue entregado. ¿Quieres registrarlo como gasto del vehículo?',
      cancelled: 'El pedido fue cancelado',
    }
    if (isProvider && msgs[body.status])
      await notifyUser(order.userId, 'order_status', 'Pedido actualizado', msgs[body.status]!,
        { orderId: order.id, suggestExpense: body.status === 'delivered' ? 'true' : 'false' })
    return updated
  }, {
    body: t.Object({
      status: t.Union([t.Literal('confirmed'), t.Literal('delivered'), t.Literal('cancelled')]),
    }),
  })
