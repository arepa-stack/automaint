import {
  pgTable, uuid, text, integer, real, boolean, timestamp, date, numeric,
  jsonb, serial, uniqueIndex, index,
} from 'drizzle-orm/pg-core'

// ── Usuarios y sesiones ────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'), // null para cuentas OAuth
  name: text('name').notNull(),
  phone: text('phone'),
  city: text('city'),
  role: text('role', { enum: ['user', 'partner', 'admin'] }).notNull().default('user'),
  emailVerified: boolean('email_verified').notNull().default(false),
  emailVerifyToken: text('email_verify_token'),
  oauthProvider: text('oauth_provider'), // 'google' | 'apple'
  isPremium: boolean('is_premium').notNull().default(false),
  notifyKmBefore: integer('notify_km_before').notNull().default(500),
  notifyDaysBefore: integer('notify_days_before').notNull().default(7),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  fcmToken: text('fcm_token').notNull().unique(),
  platform: text('platform', { enum: ['android', 'ios', 'web'] }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// ── Vehículos ──────────────────────────────────────────────────────────────

export const vehicleCatalog = pgTable('vehicle_catalog', {
  id: serial('id').primaryKey(),
  make: text('make').notNull(),
  model: text('model').notNull(),
  yearFrom: integer('year_from').notNull(),
  yearTo: integer('year_to'),
  fuelType: text('fuel_type', { enum: ['gasolina', 'diesel', 'hibrido', 'electrico', 'gas'] }).notNull().default('gasolina'),
}, t => [index('vehicle_catalog_make_idx').on(t.make)])

export const vehicles = pgTable('vehicles', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  make: text('make').notNull(),
  model: text('model').notNull(),
  year: integer('year').notNull(),
  engine: text('engine'),
  fuelType: text('fuel_type').notNull().default('gasolina'),
  vin: text('vin'),
  plate: text('plate'),
  nickname: text('nickname'),
  purchaseDate: date('purchase_date'),
  photoPath: text('photo_path'),
  currentKm: integer('current_km').notNull().default(0),
  avgKmPerDay: real('avg_km_per_day').notNull().default(30),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const odometerReadings = pgTable('odometer_readings', {
  id: uuid('id').primaryKey().defaultRandom(),
  vehicleId: uuid('vehicle_id').notNull().references(() => vehicles.id, { onDelete: 'cascade' }),
  km: integer('km').notNull(),
  readAt: date('read_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [index('odometer_vehicle_idx').on(t.vehicleId)])

// ── Mantenimiento ──────────────────────────────────────────────────────────

// Plantillas: make/model null = genérica; la más específica gana por serviceKey
export const maintenancePlanTemplates = pgTable('maintenance_plan_templates', {
  id: serial('id').primaryKey(),
  make: text('make'),
  model: text('model'),
  serviceKey: text('service_key').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  intervalKm: integer('interval_km'),
  intervalMonths: integer('interval_months'),
})

export const maintenanceItems = pgTable('maintenance_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  vehicleId: uuid('vehicle_id').notNull().references(() => vehicles.id, { onDelete: 'cascade' }),
  serviceKey: text('service_key').notNull(),
  name: text('name').notNull(),
  intervalKm: integer('interval_km'),
  intervalMonths: integer('interval_months'),
  lastServiceKm: integer('last_service_km'),
  lastServiceDate: date('last_service_date'),
  dueKm: integer('due_km'),
  dueDate: date('due_date'),
  status: text('status', { enum: ['ok', 'upcoming', 'overdue'] }).notNull().default('ok'),
  notifiedUpcomingAt: timestamp('notified_upcoming_at'),
  notifiedOverdueAt: timestamp('notified_overdue_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [index('maintenance_vehicle_idx').on(t.vehicleId)])

// ── Gastos ─────────────────────────────────────────────────────────────────

export const expenses = pgTable('expenses', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  vehicleId: uuid('vehicle_id').notNull().references(() => vehicles.id, { onDelete: 'cascade' }),
  type: text('type', {
    enum: ['mantenimiento', 'reparacion', 'combustible', 'seguro', 'impuestos', 'estacionamiento', 'multas', 'repuestos', 'otros'],
  }).notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  currency: text('currency').notNull().default('USD'),
  date: date('date').notNull(),
  vendor: text('vendor'),
  description: text('description'),
  receiptPath: text('receipt_path'),
  odometerKm: integer('odometer_km'),
  maintenanceItemId: uuid('maintenance_item_id').references(() => maintenanceItems.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [index('expenses_vehicle_idx').on(t.vehicleId)])

// ── Partners (talleres, proveedores de repuestos, concesionarios, servicios) ──

export const partners = pgTable('partners', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  type: text('type', { enum: ['taller', 'repuestos', 'concesionario', 'servicios'] }).notNull(),
  serviceCategory: text('service_category'), // para type=servicios: grua, lavado, cerrajero, seguros, tramites
  businessName: text('business_name').notNull(),
  taxId: text('tax_id').notNull(),
  whatsapp: text('whatsapp').notNull(), // E.164 sin '+', ej: 584121234567
  phone: text('phone'),
  email: text('email'),
  address: text('address'),
  city: text('city'),
  lat: real('lat'),
  lng: real('lng'),
  description: text('description'),
  status: text('status', { enum: ['pending', 'approved', 'rejected', 'suspended'] }).notNull().default('pending'),
  rating: real('rating').notNull().default(0),
  reviewCount: integer('review_count').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const partnerDocuments = pgTable('partner_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  filePath: text('file_path').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const workshopServices = pgTable('workshop_services', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  serviceKey: text('service_key'), // enlaza con maintenance serviceKey para ofertas contextuales
  price: numeric('price', { precision: 12, scale: 2 }),
  durationMin: integer('duration_min').notNull().default(60),
  active: boolean('active').notNull().default(true),
})

export const workshopSchedules = pgTable('workshop_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  weekday: integer('weekday').notNull(), // 0=domingo .. 6=sábado
  openTime: text('open_time').notNull(),  // 'HH:MM'
  closeTime: text('close_time').notNull(),
})

export const appointments = pgTable('appointments', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  vehicleId: uuid('vehicle_id').references(() => vehicles.id, { onDelete: 'set null' }),
  services: jsonb('services').$type<{ id: string; name: string; price: string | null }[]>().notNull(),
  scheduledAt: timestamp('scheduled_at').notNull(),
  status: text('status', { enum: ['pending', 'confirmed', 'completed', 'cancelled'] }).notNull().default('pending'),
  notes: text('notes'),
  reminderSentAt: timestamp('reminder_sent_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [index('appointments_partner_idx').on(t.partnerId), index('appointments_user_idx').on(t.userId)])

// Presupuesto que el taller carga tras revisar el vehículo en una cita
export const quotes = pgTable('quotes', {
  id: uuid('id').primaryKey().defaultRandom(),
  appointmentId: uuid('appointment_id').notNull().references(() => appointments.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['sent', 'approved', 'rejected'] }).notNull().default('sent'),
  // repuestos que el taller indica que hacen falta
  items: jsonb('items').$type<{ name: string; qty: number; category?: string; refPrice?: string }[]>().notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [index('quotes_user_idx').on(t.userId), index('quotes_partner_idx').on(t.partnerId)])

export const reviews = pgTable('reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  rating: integer('rating').notNull(), // 1..5
  comment: text('comment'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [uniqueIndex('reviews_partner_user_uq').on(t.partnerId, t.userId)])

// ── Marketplace: repuestos ─────────────────────────────────────────────────

export const parts = pgTable('parts', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  category: text('category').notNull(), // filtros, frenos, baterias, aceites, neumaticos, suspension, electricos, otros
  description: text('description'),
  price: numeric('price', { precision: 12, scale: 2 }).notNull(),
  currency: text('currency').notNull().default('USD'),
  condition: text('condition', { enum: ['nuevo', 'usado'] }).notNull().default('nuevo'),
  stock: integer('stock'),
  photoPath: text('photo_path'),
  active: boolean('active').notNull().default(true),
  views: integer('views').notNull().default(0),
  clicks: integer('clicks').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [index('parts_partner_idx').on(t.partnerId), index('parts_category_idx').on(t.category)])

// make/model/años null = compatible con cualquiera
export const partCompatibility = pgTable('part_compatibility', {
  id: uuid('id').primaryKey().defaultRandom(),
  partId: uuid('part_id').notNull().references(() => parts.id, { onDelete: 'cascade' }),
  make: text('make').notNull(),
  model: text('model'),
  yearFrom: integer('year_from'),
  yearTo: integer('year_to'),
}, t => [index('part_compat_part_idx').on(t.partId)])

// ── Pedidos (carrito → WhatsApp) ───────────────────────────────────────────

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  vehicleId: uuid('vehicle_id').references(() => vehicles.id, { onDelete: 'set null' }),
  status: text('status', { enum: ['sent', 'confirmed', 'delivered', 'cancelled'] }).notNull().default('sent'),
  total: numeric('total', { precision: 12, scale: 2 }).notNull(),
  currency: text('currency').notNull().default('USD'),
  message: text('message').notNull(), // texto enviado por WhatsApp
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, t => [index('orders_user_idx').on(t.userId), index('orders_partner_idx').on(t.partnerId)])

export const orderItems = pgTable('order_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  partId: uuid('part_id').references(() => parts.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  qty: integer('qty').notNull(),
  price: numeric('price', { precision: 12, scale: 2 }).notNull(),
})

// ── Marketplace: venta de carros ───────────────────────────────────────────

export const carListings = pgTable('car_listings', {
  id: uuid('id').primaryKey().defaultRandom(),
  sellerUserId: uuid('seller_user_id').references(() => users.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
  vehicleId: uuid('vehicle_id').references(() => vehicles.id, { onDelete: 'set null' }), // != null → historial verificado
  make: text('make').notNull(),
  model: text('model').notNull(),
  year: integer('year').notNull(),
  km: integer('km').notNull(),
  price: numeric('price', { precision: 12, scale: 2 }).notNull(),
  currency: text('currency').notNull().default('USD'),
  description: text('description'),
  city: text('city'),
  contactWhatsapp: text('contact_whatsapp').notNull(),
  status: text('status', { enum: ['pending', 'active', 'sold', 'expired', 'rejected'] }).notNull().default('pending'),
  featured: boolean('featured').notNull().default(false),
  views: integer('views').notNull().default(0),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [index('listings_status_idx').on(t.status)])

export const listingPhotos = pgTable('listing_photos', {
  id: uuid('id').primaryKey().defaultRandom(),
  listingId: uuid('listing_id').notNull().references(() => carListings.id, { onDelete: 'cascade' }),
  filePath: text('file_path').notNull(),
  position: integer('position').notNull().default(0),
})

export const favorites = pgTable('favorites', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  listingId: uuid('listing_id').notNull().references(() => carListings.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [uniqueIndex('favorites_user_listing_uq').on(t.userId, t.listingId)])

export const searchAlerts = pgTable('search_alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  filters: jsonb('filters').$type<{
    make?: string; model?: string; yearFrom?: number; yearTo?: number
    priceMax?: number; kmMax?: number; city?: string
  }>().notNull(),
  lastNotifiedAt: timestamp('last_notified_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// ── Ofertas / cupones ──────────────────────────────────────────────────────

export const offers = pgTable('offers', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  discountPct: integer('discount_pct'),
  serviceKey: text('service_key'), // para publicidad contextual por mantenimiento
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// ── Notificaciones ─────────────────────────────────────────────────────────

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // maintenance_upcoming, maintenance_overdue, appointment_reminder, order_status, listing_alert, ...
  title: text('title').notNull(),
  body: text('body').notNull(),
  data: jsonb('data').$type<Record<string, string>>(),
  readAt: timestamp('read_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [index('notifications_user_idx').on(t.userId)])

// ── Admin ──────────────────────────────────────────────────────────────────

export const adminAuditLog = pgTable('admin_audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  adminUserId: uuid('admin_user_id').notNull().references(() => users.id),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  details: jsonb('details'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
