# 🚗 AutoMaint API

Backend de AutoMaint — recordatorios y mantenimiento preventivo de vehículos, con marketplace de talleres, repuestos y venta de carros.

**Stack:** Bun + Elysia + Drizzle ORM + PostgreSQL (Supabase) + Supabase Storage.

## Arranque rápido (local, sin credenciales)

```bash
cp .env.example .env
docker compose up -d          # API + Postgres local
# o en desarrollo:
docker compose up -d postgres
bun install
bun run db:seed               # catálogo + plantillas + admin
bun run dev
```

- API: http://localhost:3000 — Swagger: http://localhost:3000/swagger
- Admin seed: `admin@automaint.app` / `Admin1234!` (cambiar con `ADMIN_PASSWORD`)
- Las migraciones corren solas al arrancar (`RUN_MIGRATIONS=true`).

## Conectar a Supabase

En `.env`:

```env
# runtime → pooler (6543); migraciones → conexión directa (5432)
DATABASE_URL=postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
STORAGE_DRIVER=supabase
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

Crear en Supabase Storage los buckets **públicos**: `vehicle-photos`, `receipts`, `listings`, `partner-docs`.
Luego: `bun run db:migrate && bun run db:seed`.

## Auth

- Email + password con JWT (access 1h) + refresh tokens rotativos (30 días).
- OAuth Google/Apple: **mock** (`OAUTH_MOCK=true`). `POST /auth/oauth/google` con `{"idToken": "mock:correo@x.com:Nombre"}`. El contrato no cambia cuando se implemente el OAuth real.
- Roles: `user`, `partner`, `admin`.

## Módulos

| Área | Endpoints clave |
|------|-----------------|
| Auth | `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/oauth/{google,apple}` |
| Perfil | `/me`, `/me/devices`, `/me/notifications` |
| Vehículos | `/vehicles`, `/vehicles/:id/odometer`, `/catalog/makes`, `/catalog/models` |
| Mantenimiento | `/maintenance/:id` (intervalos), `/maintenance/:id/complete` |
| Gastos | `/expenses`, `/expenses/stats`, `/expenses/:id/receipt` |
| Partners | `/partners` (registro), `/partners/nearby`, `/partners/me/*` |
| Talleres | `/partners/me/services`, `/partners/me/schedules`, `/partners/:id/availability` |
| Citas | `/appointments`, `/partners/me/appointments` |
| Repuestos | `/parts?make=&model=&year=` (compatibilidad), `/partners/me/parts` |
| Pedidos | `POST /orders` → devuelve `whatsappUrl` (carrito → WhatsApp del proveedor) |
| Carros | `/listings`, `/me/favorites`, `/me/search-alerts` |
| Ofertas | `/offers?serviceKey=` (publicidad contextual) |
| Admin | `/admin/metrics`, `/admin/partners`, `/admin/listings`, `/admin/audit-log` |

## Motor de mantenimiento

Al crear un vehículo se instancia su plan desde plantillas (genéricas u overrides por marca/modelo). Cada lectura de odómetro recalcula el promedio km/día y proyecta la fecha de cada servicio. Estados: 🟢 `ok` / 🟡 `upcoming` (≤500 km o ≤7 días, configurable por usuario) / 🔴 `overdue` (notifica a diario). Job diario 06:00 + recordatorios de citas cada hora (croner, in-process).

## Pedidos por WhatsApp

No hay pagos in-app. `POST /orders` registra el pedido y devuelve `https://wa.me/<proveedor>?text=<pedido>` con productos, cantidades, vehículo y total referencial. El proveedor gestiona pago/entrega y actualiza el estado (`confirmed`/`delivered`) desde su panel → push al cliente.

## Tests

```bash
docker compose up -d postgres
bun test        # E2E: registro → vehículo → plan → odómetro → notificación →
                # gasto → proveedor → pedido WhatsApp → taller → cita → listado → admin
```

## Pendiente (iteraciones futuras)

OAuth real Google/Apple · FCM push real (hoy log-only) · Premium (IAP) · export PDF · VIN decode (NHTSA vPIC) · PostGIS si el volumen lo pide.
