import { Elysia, t } from 'elysia'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client'
import { appointments, partners, parts, quotes } from '../db/schema'
import { authed } from '../shared/auth'
import { badRequest, forbidden, notFound } from '../shared/errors'
import { notifyUser } from '../shared/push'
import { getMyPartner } from './partners'

type QuoteItem = { name: string; qty: number; category?: string; refPrice?: string }
type PartRow = typeof parts.$inferSelect & { partnerName: string; partnerCity: string | null; partnerWhatsapp: string }

// Coincidencia por tokens del nombre (+ desempate por precio).
// ponytail: matching léxico simple; si el catálogo crece, migrar a FTS de Postgres.
function tokens(s: string) {
  return s.toLowerCase().split(/[^a-z0-9áéíóúñü-]+/).filter(w => w.length >= 4)
}

function hits(item: QuoteItem, part: PartRow) {
  const name = part.name.toLowerCase()
  let n = tokens(item.name).filter(tk => name.includes(tk)).length
  if (item.category && part.category === item.category) n += 1
  return n
}

// candidatos de un item: solo las mejores coincidencias, ordenadas por precio
function candidates(item: QuoteItem, all: PartRow[]) {
  const scored = all.map(p => ({ p, h: hits(item, p) })).filter(x => x.h > 0)
  if (scored.length === 0) return []
  const max = Math.max(...scored.map(x => x.h))
  return scored.filter(x => x.h === max)
    .sort((a, b) => Number(a.p.price) - Number(b.p.price))
    .map(x => x.p)
}

const partPublic = (p: PartRow) => ({
  id: p.id, name: p.name, price: p.price, currency: p.currency,
  partnerId: p.partnerId, partnerName: p.partnerName, partnerCity: p.partnerCity,
})

export const quotesModule = new Elysia({ tags: ['quotes'] })
  .use(authed)

  // El taller carga el presupuesto de una cita
  .post('/partners/me/quotes', async ({ user, body }) => {
    const p = await getMyPartner(user)
    const appt = await db.query.appointments.findFirst({
      where: and(eq(appointments.id, body.appointmentId), eq(appointments.partnerId, p.id)),
    })
    if (!appt) throw notFound('Cita')
    if (appt.status !== 'confirmed' && appt.status !== 'completed')
      throw badRequest('La cita debe estar confirmada para cargar presupuesto')

    const [quote] = await db.insert(quotes).values({
      appointmentId: appt.id, partnerId: p.id, userId: appt.userId,
      items: body.items, notes: body.notes,
    }).returning()

    await notifyUser(appt.userId, 'quote_new', 'Presupuesto recibido',
      `${p.businessName} cargó un presupuesto con ${body.items.length} repuestos`, { quoteId: quote!.id })
    return quote
  }, {
    body: t.Object({
      appointmentId: t.String({ format: 'uuid' }),
      items: t.Array(t.Object({
        name: t.String({ minLength: 1 }),
        qty: t.Integer({ minimum: 1, maximum: 99 }),
        category: t.Optional(t.String()),
        refPrice: t.Optional(t.String()),
      }), { minItems: 1, maxItems: 50 }),
      notes: t.Optional(t.String()),
    }),
  })

  // Mis presupuestos (usuario)
  .get('/quotes', async ({ user }) => {
    const rows = await db.select({
      id: quotes.id, appointmentId: quotes.appointmentId, status: quotes.status,
      items: quotes.items, notes: quotes.notes, createdAt: quotes.createdAt,
      partnerId: quotes.partnerId, partnerName: partners.businessName,
    }).from(quotes)
      .innerJoin(partners, eq(partners.id, quotes.partnerId))
      .where(eq(quotes.userId, user.id))
      .orderBy(desc(quotes.createdAt))
    return rows
  })

  // Comparador: mejores precios (multi-proveedor) y proveedor único
  .get('/quotes/:id/options', async ({ user, params }) => {
    const quote = await db.query.quotes.findFirst({ where: eq(quotes.id, params.id) })
    if (!quote) throw notFound('Presupuesto')
    if (quote.userId !== user.id && user.role !== 'admin') throw forbidden()

    const all = (await db.select({
      id: parts.id, partnerId: parts.partnerId, name: parts.name, category: parts.category,
      description: parts.description, price: parts.price, currency: parts.currency,
      condition: parts.condition, stock: parts.stock, photoPath: parts.photoPath,
      active: parts.active, views: parts.views, clicks: parts.clicks, createdAt: parts.createdAt,
      partnerName: partners.businessName, partnerCity: partners.city, partnerWhatsapp: partners.whatsapp,
    }).from(parts)
      .innerJoin(partners, eq(partners.id, parts.partnerId))
      .where(and(eq(parts.active, true), eq(partners.status, 'approved')))) as PartRow[]

    const perItem = quote.items.map(item => ({ item, cands: candidates(item, all) }))
    const missing = perItem.filter(x => x.cands.length === 0).map(x => x.item.name)

    // Opción 1: mejor precio por item, sin importar el proveedor
    const groupsMap = new Map<string, { partner: any; items: any[]; subtotal: number }>()
    for (const { item, cands } of perItem) {
      const best = cands[0]
      if (!best) continue
      const g = groupsMap.get(best.partnerId) ?? {
        partner: { id: best.partnerId, businessName: best.partnerName, city: best.partnerCity },
        items: [], subtotal: 0,
      }
      g.items.push({ name: item.name, qty: item.qty, part: partPublic(best) })
      g.subtotal += Number(best.price) * item.qty
      groupsMap.set(best.partnerId, g)
    }
    const groups = [...groupsMap.values()].map(g => ({ ...g, subtotal: g.subtotal.toFixed(2) }))
    const bestTotal = [...groupsMap.values()].reduce((s, g) => s + g.subtotal, 0)

    // Opción 2: un solo proveedor que cubra TODO el presupuesto, al mejor total
    let single: { partner: any; items: any[]; total: string } | null = null
    let singleBest = Infinity
    const partnerIds = new Set(all.map(p => p.partnerId))
    for (const pid of partnerIds) {
      const items: any[] = []
      let total = 0
      let coversAll = true
      for (const { item, cands } of perItem) {
        const own = cands.find(c => c.partnerId === pid)
        if (!own) { coversAll = false; break }
        items.push({ name: item.name, qty: item.qty, part: partPublic(own) })
        total += Number(own.price) * item.qty
      }
      if (coversAll && perItem.length > 0 && total < singleBest) {
        singleBest = total
        const ref = all.find(p => p.partnerId === pid)!
        single = {
          partner: { id: pid, businessName: ref.partnerName, city: ref.partnerCity },
          items, total: total.toFixed(2),
        }
      }
    }

    return {
      quote,
      missing,
      bestPrices: { groups, total: bestTotal.toFixed(2) },
      singleProvider: single,
    }
  }, {
    params: t.Object({ id: t.String({ format: 'uuid' }) }),
  })

  // Usuario aprueba o rechaza (la app crea las órdenes con POST /orders)
  .patch('/quotes/:id', async ({ user, params, body }) => {
    const quote = await db.query.quotes.findFirst({ where: eq(quotes.id, params.id) })
    if (!quote) throw notFound('Presupuesto')
    if (quote.userId !== user.id) throw forbidden()
    const [updated] = await db.update(quotes).set({ status: body.status })
      .where(eq(quotes.id, quote.id)).returning()
    return updated
  }, {
    params: t.Object({ id: t.String({ format: 'uuid' }) }),
    body: t.Object({ status: t.Union([t.Literal('approved'), t.Literal('rejected')]) }),
  })
