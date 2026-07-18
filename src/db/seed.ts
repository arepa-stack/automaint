import { sql as rawSql } from 'drizzle-orm'
import { db, sql } from './client'
import { maintenancePlanTemplates, users, vehicleCatalog } from './schema'

// ── Plantilla genérica de mantenimiento (aplica a todo vehículo) ────────────
const GENERIC_PLAN: { serviceKey: string; name: string; intervalKm: number | null; intervalMonths: number | null }[] = [
  { serviceKey: 'aceite_motor', name: 'Cambio de aceite y filtro de aceite', intervalKm: 5000, intervalMonths: 6 },
  { serviceKey: 'filtro_aire', name: 'Filtro de aire del motor', intervalKm: 10000, intervalMonths: 12 },
  { serviceKey: 'filtro_combustible', name: 'Filtro de combustible', intervalKm: 20000, intervalMonths: 24 },
  { serviceKey: 'filtro_cabina', name: 'Filtro de aire acondicionado (cabina)', intervalKm: 15000, intervalMonths: 12 },
  { serviceKey: 'frenos_pastillas', name: 'Revisión/cambio de pastillas de freno', intervalKm: 20000, intervalMonths: 24 },
  { serviceKey: 'frenos_liquido', name: 'Líquido de frenos', intervalKm: 40000, intervalMonths: 24 },
  { serviceKey: 'neumaticos_rotacion', name: 'Rotación y balanceo de neumáticos', intervalKm: 10000, intervalMonths: 12 },
  { serviceKey: 'neumaticos_cambio', name: 'Cambio de neumáticos', intervalKm: 50000, intervalMonths: 60 },
  { serviceKey: 'alineacion', name: 'Alineación', intervalKm: 10000, intervalMonths: 12 },
  { serviceKey: 'bateria', name: 'Revisión/cambio de batería', intervalKm: 40000, intervalMonths: 36 },
  { serviceKey: 'refrigerante', name: 'Refrigerante del motor', intervalKm: 40000, intervalMonths: 24 },
  { serviceKey: 'transmision', name: 'Aceite de transmisión', intervalKm: 60000, intervalMonths: 48 },
  { serviceKey: 'correa_distribucion', name: 'Correa de distribución', intervalKm: 60000, intervalMonths: 60 },
  { serviceKey: 'bujias', name: 'Bujías', intervalKm: 40000, intervalMonths: 36 },
  { serviceKey: 'aire_acondicionado', name: 'Servicio de aire acondicionado', intervalKm: 20000, intervalMonths: 12 },
]

// ── Catálogo de vehículos (mercado LATAM/Venezuela) ─────────────────────────
const CATALOG: [make: string, model: string, yearFrom: number, yearTo: number | null][] = [
  ['Toyota', 'Corolla', 1990, null], ['Toyota', 'Hilux', 1990, null], ['Toyota', '4Runner', 1990, null],
  ['Toyota', 'Yaris', 2000, null], ['Toyota', 'Fortuner', 2005, null], ['Toyota', 'Camry', 1992, null],
  ['Chevrolet', 'Aveo', 2004, 2017], ['Chevrolet', 'Spark', 2004, null], ['Chevrolet', 'Cruze', 2009, null],
  ['Chevrolet', 'Optra', 2004, 2012], ['Chevrolet', 'Silverado', 1999, null], ['Chevrolet', 'Tahoe', 1995, null],
  ['Ford', 'Fiesta', 1996, null], ['Ford', 'Focus', 2000, null], ['Ford', 'Explorer', 1991, null],
  ['Ford', 'F-150', 1990, null], ['Ford', 'EcoSport', 2003, null], ['Ford', 'Ranger', 1998, null],
  ['Hyundai', 'Elantra', 1991, null], ['Hyundai', 'Accent', 1995, null], ['Hyundai', 'Tucson', 2004, null],
  ['Hyundai', 'Santa Fe', 2001, null], ['Kia', 'Rio', 2000, null], ['Kia', 'Sportage', 1995, null],
  ['Kia', 'Picanto', 2004, null], ['Kia', 'Cerato', 2004, null],
  ['Nissan', 'Sentra', 1990, null], ['Nissan', 'Versa', 2006, null], ['Nissan', 'Frontier', 1998, null],
  ['Nissan', 'Pathfinder', 1990, null],
  ['Renault', 'Logan', 2005, null], ['Renault', 'Duster', 2010, null], ['Renault', 'Sandero', 2008, null],
  ['Volkswagen', 'Gol', 1990, null], ['Volkswagen', 'Jetta', 1990, null], ['Volkswagen', 'Polo', 1995, null],
  ['Honda', 'Civic', 1990, null], ['Honda', 'CR-V', 1997, null], ['Honda', 'Accord', 1990, null],
  ['Mazda', '3', 2004, null], ['Mazda', '6', 2003, null], ['Mazda', 'CX-5', 2012, null],
  ['Jeep', 'Grand Cherokee', 1993, null], ['Jeep', 'Cherokee', 1990, null], ['Jeep', 'Wrangler', 1990, null],
  ['Mitsubishi', 'Lancer', 1990, null], ['Mitsubishi', 'Montero', 1990, null], ['Mitsubishi', 'L200', 1996, null],
  ['Chery', 'Arauca', 2011, null], ['Chery', 'Orinoco', 2011, null], ['Chery', 'Tiggo', 2006, null],
  ['Suzuki', 'Swift', 1990, null], ['Suzuki', 'Grand Vitara', 1998, null],
  ['Fiat', 'Palio', 1996, null], ['Fiat', 'Uno', 1990, null],
  ['Dodge', 'Ram', 1994, null], ['Peugeot', '206', 1998, 2012], ['Peugeot', '307', 2001, 2011],
]

export async function seed() {
  const existing = await db.select().from(maintenancePlanTemplates).limit(1)
  if (existing.length) { console.log('[seed] ya ejecutado, omitiendo'); return }

  await db.insert(maintenancePlanTemplates).values(GENERIC_PLAN.map(p => ({ ...p, make: null, model: null })))
  await db.insert(vehicleCatalog).values(CATALOG.map(([make, model, yearFrom, yearTo]) => ({ make, model, yearFrom, yearTo })))

  // admin inicial (cambiar password en producción)
  await db.insert(users).values({
    email: 'admin@automaint.app',
    passwordHash: await Bun.password.hash(process.env.ADMIN_PASSWORD ?? 'Admin1234!'),
    name: 'Admin',
    role: 'admin',
    emailVerified: true,
  }).onConflictDoNothing()

  console.log(`[seed] ${GENERIC_PLAN.length} plantillas, ${CATALOG.length} modelos de catálogo, admin@automaint.app creado`)
}

if (import.meta.main) {
  await seed()
  await sql.end()
  process.exit(0)
}
