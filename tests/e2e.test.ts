import { beforeAll, describe, expect, it } from 'bun:test'
import { app } from '../src/index'
import { seed } from '../src/db/seed'
import { db } from '../src/db/client'
import { maintenanceItems } from '../src/db/schema'
import { eq } from 'drizzle-orm'

const BASE = 'http://test.local'

async function req(method: string, path: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.handle(new Request(BASE + path, {
    method,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }))
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* respuesta no-JSON */ }
  return { status: res.status, json, text }
}

let userToken = ''
let adminToken = ''
let providerToken = ''
let workshopToken = ''
let vehicleId = ''
let oilItemId = ''
let providerPartnerId = ''
let workshopPartnerId = ''
let partId = ''
let listingId = ''

beforeAll(async () => {
  await seed()
  const admin = await req('POST', '/auth/login', {
    body: { email: 'admin@automaint.app', password: process.env.ADMIN_PASSWORD ?? 'Admin1234!' },
  })
  adminToken = admin.json.accessToken
})

const email = `user-${crypto.randomUUID().slice(0, 8)}@test.com`

describe('salud y auth', () => {
  it('healthcheck responde', async () => {
    const r = await req('GET', '/health')
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
  })

  it('registra usuario con email+password', async () => {
    const r = await req('POST', '/auth/register', {
      body: { email, password: 'Password123', name: 'Juan Prueba', city: 'Caracas' },
    })
    expect(r.status).toBe(200)
    expect(r.json.accessToken).toBeTruthy()
    expect(r.json.user.email).toBe(email)
    userToken = r.json.accessToken
  })

  it('rechaza email duplicado', async () => {
    const r = await req('POST', '/auth/register', {
      body: { email, password: 'Password123', name: 'Otro' },
    })
    expect(r.status).toBe(400)
    expect(r.json.code).toBe('EMAIL_TAKEN')
  })

  it('login y refresh funcionan', async () => {
    const login = await req('POST', '/auth/login', { body: { email, password: 'Password123' } })
    expect(login.status).toBe(200)
    const refresh = await req('POST', '/auth/refresh', { body: { refreshToken: login.json.refreshToken } })
    expect(refresh.status).toBe(200)
    expect(refresh.json.accessToken).toBeTruthy()
  })

  it('OAuth mock crea sesión', async () => {
    const r = await req('POST', '/auth/oauth/google', { body: { idToken: 'mock:gmail-user@test.com:María' } })
    expect(r.status).toBe(200)
    expect(r.json.user.emailVerified).toBe(true)
  })

  it('bloquea rutas sin token', async () => {
    const r = await req('GET', '/vehicles')
    expect(r.status).toBe(401)
  })
})

describe('vehículo + plan de mantenimiento', () => {
  it('crea vehículo e instancia el plan automáticamente', async () => {
    const r = await req('POST', '/vehicles', {
      token: userToken,
      body: { make: 'Toyota', model: 'Corolla', year: 2015, currentKm: 50000, fuelType: 'gasolina' },
    })
    expect(r.status).toBe(200)
    vehicleId = r.json.id
    expect(r.json.maintenanceItems.length).toBeGreaterThanOrEqual(10)
    const oil = r.json.maintenanceItems.find((i: any) => i.serviceKey === 'aceite_motor')
    expect(oil.dueKm).toBe(55000)
    oilItemId = oil.id
  })

  it('rechaza kilometraje menor al actual', async () => {
    const r = await req('POST', `/vehicles/${vehicleId}/odometer`, { token: userToken, body: { km: 49000 } })
    expect(r.status).toBe(400)
    expect(r.json.code).toBe('KM_LOWER_THAN_CURRENT')
  })

  it('al acercarse el km, el item pasa a upcoming y notifica', async () => {
    const r = await req('POST', `/vehicles/${vehicleId}/odometer`, { token: userToken, body: { km: 54600 } })
    expect(r.status).toBe(200)
    const oil = r.json.maintenanceItems.find((i: any) => i.serviceKey === 'aceite_motor')
    expect(oil.status).toBe('upcoming') // faltan 400km ≤ umbral 500

    const notifs = await req('GET', '/me/notifications', { token: userToken })
    expect(notifs.json.some((n: any) => n.type === 'maintenance_upcoming')).toBe(true)
  })

  it('dashboard muestra semáforo y próximo mantenimiento', async () => {
    const r = await req('GET', '/vehicles', { token: userToken })
    expect(r.status).toBe(200)
    expect(r.json[0].overallStatus).toBe('upcoming')
    expect(r.json[0].nextMaintenance).toBeTruthy()
  })

  it('completar servicio con gasto reprograma el ciclo', async () => {
    const r = await req('POST', `/maintenance/${oilItemId}/complete`, {
      token: userToken,
      body: { expense: { amount: '45.00', vendor: 'Taller El Rápido' } },
    })
    expect(r.status).toBe(200)
    expect(r.json.item.status).toBe('ok')
    expect(r.json.item.dueKm).toBe(54600 + 5000)
    expect(r.json.expense.type).toBe('mantenimiento')
  })

  it('estadísticas de gastos', async () => {
    const r = await req('GET', `/expenses/stats?vehicleId=${vehicleId}`, { token: userToken })
    expect(r.status).toBe(200)
    expect(Number(r.json.total)).toBeCloseTo(45)
  })
})

describe('partners: proveedor de repuestos + pedido WhatsApp', () => {
  it('registra proveedor (queda pending)', async () => {
    const reg = await req('POST', '/auth/register', {
      body: { email: `prov-${crypto.randomUUID().slice(0, 8)}@test.com`, password: 'Password123', name: 'Repuestos Central' },
    })
    providerToken = reg.json.accessToken
    const r = await req('POST', '/partners', {
      token: providerToken,
      body: {
        type: 'repuestos', businessName: 'Repuestos Central CA', taxId: 'J-12345678-9',
        whatsapp: '584121234567', city: 'Caracas', lat: 10.48, lng: -66.90,
      },
    })
    expect(r.status).toBe(200)
    expect(r.json.status).toBe('pending')
    providerPartnerId = r.json.id
  })

  it('admin aprueba al proveedor', async () => {
    const r = await req('PATCH', `/admin/partners/${providerPartnerId}`, {
      token: adminToken, body: { status: 'approved' },
    })
    expect(r.status).toBe(200)
    expect(r.json.status).toBe('approved')
  })

  it('proveedor publica repuesto con compatibilidad', async () => {
    const r = await req('POST', '/partners/me/parts', {
      token: providerToken,
      body: {
        name: 'Filtro de aceite Toyota', category: 'filtros', price: '8.50', stock: 20,
        compatibility: [{ make: 'Toyota', model: 'Corolla', yearFrom: 2008, yearTo: 2020 }],
      },
    })
    expect(r.status).toBe(200)
    partId = r.json.id
  })

  it('búsqueda filtra por compatibilidad del vehículo', async () => {
    const hit = await req('GET', '/parts?make=Toyota&model=Corolla&year=2015')
    expect(hit.json.some((p: any) => p.id === partId)).toBe(true)
    const miss = await req('GET', '/parts?make=Ford&model=Fiesta&year=2010')
    expect(miss.json.some((p: any) => p.id === partId)).toBe(false)
  })

  it('carrito → pedido genera whatsappUrl con mensaje pre-armado', async () => {
    const r = await req('POST', '/orders', {
      token: userToken,
      body: { partnerId: providerPartnerId, vehicleId, items: [{ partId, qty: 2 }] },
    })
    expect(r.status).toBe(200)
    expect(r.json.whatsappUrl).toStartWith('https://wa.me/584121234567?text=')
    const msg = decodeURIComponent(r.json.whatsappUrl.split('text=')[1])
    expect(msg).toContain('2x Filtro de aceite Toyota')
    expect(msg).toContain('Toyota Corolla 2015')
    expect(msg).toContain('17.00')
    expect(r.json.order.status).toBe('sent')
  })

  it('proveedor confirma pedido → usuario recibe notificación', async () => {
    const myOrders = await req('GET', '/partners/me/orders', { token: providerToken })
    const orderId = myOrders.json[0].id
    const r = await req('PATCH', `/orders/${orderId}/status`, { token: providerToken, body: { status: 'confirmed' } })
    expect(r.json.status).toBe('confirmed')
    const notifs = await req('GET', '/me/notifications', { token: userToken })
    expect(notifs.json.some((n: any) => n.type === 'order_status')).toBe(true)
  })
})

describe('taller: servicios, disponibilidad y cita', () => {
  it('registra y aprueba taller con horario', async () => {
    const reg = await req('POST', '/auth/register', {
      body: { email: `taller-${crypto.randomUUID().slice(0, 8)}@test.com`, password: 'Password123', name: 'Taller Pro' },
    })
    workshopToken = reg.json.accessToken
    const p = await req('POST', '/partners', {
      token: workshopToken,
      body: { type: 'taller', businessName: 'Taller Pro CA', taxId: 'J-98765432-1', whatsapp: '584249876543', lat: 10.5, lng: -66.91 },
    })
    workshopPartnerId = p.json.id
    await req('PATCH', `/admin/partners/${workshopPartnerId}`, { token: adminToken, body: { status: 'approved' } })

    const schedules = [1, 2, 3, 4, 5].map(weekday => ({ weekday, openTime: '08:00', closeTime: '17:00' }))
    const s = await req('PUT', '/partners/me/schedules', { token: workshopToken, body: { schedules } })
    expect(s.json.length).toBe(5)
  })

  it('mapa de cercanos encuentra el taller', async () => {
    const r = await req('GET', '/partners/nearby?lat=10.49&lng=-66.90&type=taller&radiusKm=50')
    expect(r.json.some((p: any) => p.id === workshopPartnerId)).toBe(true)
  })

  it('agenda cita en slot disponible y el taller la confirma', async () => {
    const svc = await req('POST', '/partners/me/services', {
      token: workshopToken, body: { name: 'Cambio de aceite', serviceKey: 'aceite_motor', price: '25.00' },
    })
    // próximo lunes 10:00
    const d = new Date()
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7))
    const dateStr = d.toISOString().slice(0, 10)

    const avail = await req('GET', `/partners/${workshopPartnerId}/availability?date=${dateStr}`)
    expect(avail.json.slots).toContain('10:00')

    const appt = await req('POST', '/appointments', {
      token: userToken,
      body: { partnerId: workshopPartnerId, vehicleId, serviceIds: [svc.json.id], scheduledAt: `${dateStr}T10:00:00` },
    })
    expect(appt.status).toBe(200)

    const after = await req('GET', `/partners/${workshopPartnerId}/availability?date=${dateStr}`)
    expect(after.json.slots).not.toContain('10:00')

    const confirm = await req('PATCH', `/appointments/${appt.json.id}`, { token: workshopToken, body: { status: 'confirmed' } })
    expect(confirm.json.status).toBe('confirmed')
  })

  it('usuario deja reseña y actualiza rating del taller', async () => {
    const r = await req('POST', `/partners/${workshopPartnerId}/reviews`, {
      token: userToken, body: { rating: 5, comment: 'Excelente servicio' },
    })
    expect(r.status).toBe(200)
    const partner = await req('GET', `/partners/${workshopPartnerId}`)
    expect(partner.json.rating).toBe(5)
    expect(partner.json.reviewCount).toBe(1)
  })
})

describe('venta de carros (listados)', () => {
  it('publica desde vehículo propio → pending → admin aprueba', async () => {
    const r = await req('POST', '/listings', {
      token: userToken,
      body: { vehicleId, price: '7500.00', description: 'Único dueño', contactWhatsapp: '584140001122' },
    })
    expect(r.status).toBe(200)
    expect(r.json.status).toBe('pending')
    listingId = r.json.id

    const mod = await req('PATCH', `/admin/listings/${listingId}`, { token: adminToken, body: { status: 'active' } })
    expect(mod.json.status).toBe('active')
  })

  it('búsqueda pública encuentra el listado con historial verificado', async () => {
    const r = await req('GET', '/listings?make=Toyota&priceMax=10000')
    const found = r.json.find((l: any) => l.id === listingId)
    expect(found).toBeTruthy()
    expect(found.verifiedHistory).toBe(true)

    const detail = await req('GET', `/listings/${listingId}`)
    expect(detail.json.verifiedHistory.maintenanceRecords).toBeGreaterThanOrEqual(1)
  })

  it('favoritos funcionan', async () => {
    await req('POST', `/listings/${listingId}/favorite`, { token: userToken })
    const favs = await req('GET', '/me/favorites', { token: userToken })
    expect(favs.json.some((l: any) => l.id === listingId)).toBe(true)
  })
})

describe('admin', () => {
  it('métricas reflejan la actividad', async () => {
    const r = await req('GET', '/admin/metrics', { token: adminToken })
    expect(r.status).toBe(200)
    expect(r.json.users).toBeGreaterThanOrEqual(4)
    expect(r.json.partners.approved).toBeGreaterThanOrEqual(2)
    expect(r.json.orders.total).toBeGreaterThanOrEqual(1)
    expect(r.json.listings.active).toBeGreaterThanOrEqual(1)
  })

  it('usuario normal no accede al admin', async () => {
    const r = await req('GET', '/admin/metrics', { token: userToken })
    expect(r.status).toBe(403)
  })
})
