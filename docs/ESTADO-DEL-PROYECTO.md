# AutoMaint — Estado del Proyecto

> Última actualización: 2026-07-17

## Resumen

AUTOMAINT es un sistema de recordatorios y mantenimiento preventivo de vehículos con marketplace (talleres, repuestos, venta de carros). Sin pagos in-app: el carrito de repuestos genera un pedido que se envía por **WhatsApp** al proveedor (`wa.me/<phone>?text=<pedido>`), quien gestiona pago y entrega.

Arquitectura de repos separados:

| Repo | Estado | Stack |
|------|--------|-------|
| `automaint-api` (este) | ✅ Iteración 1 completa | Bun + Elysia + Drizzle + Supabase |
| `automaint-app` | ✅ APK Android funcional (MVP) | Kotlin Multiplatform + Compose |
| `automaint-web-partners` | ✅ Portal funcional (taller + proveedor) | React + Vite |
| `automaint-web-admin` | ✅ Panel funcional | React + Vite |

---

## ✅ Lo que se hizo

### Backend (`automaint-api`) — Iteración 1

**Infraestructura**
- Bun + Elysia (TypeScript), validación TypeBox, Swagger UI en `/swagger`.
- PostgreSQL en **Supabase** (proyecto `ajgoqrnwryebcpxkvfpy`, us-east-1) vía Drizzle ORM. 26 tablas, migraciones en `src/db/migrations` (corren solas al arrancar con `RUN_MIGRATIONS=true`).
- **Dockerizado**: `Dockerfile` multi-stage + `docker-compose.yml` (api + postgres local de fallback para dev sin internet).
- Storage con adaptador dual: `local` (disco, servido en `/files`) o `supabase` (Supabase Storage). Buckets: `vehicle-photos`, `receipts`, `listings`, `partner-docs`.
- Jobs in-process con croner: diario 06:00 (recálculo de mantenimientos, expiración de listados a 30 días, alertas de búsqueda) + recordatorios de citas cada hora (24h antes).
- Push FCM y email Resend en **modo log-only** (sin credenciales); las notificaciones siempre se persisten en BD.

**Módulos (14)**
- `auth`: registro/login email+password, JWT (1h) + refresh tokens rotativos (30d), verificación de email, **OAuth Google/Apple MOCK** (`OAUTH_MOCK=true`, acepta `mock:<email>:<nombre>`; contrato final ya definido).
- `users`: perfil, preferencias de notificación (km/días de anticipación), dispositivos FCM.
- `vehicles`: CRUD + foto, catálogo marca/modelo (58 modelos seed, mercado LATAM/VE), odómetro con validación km-menor y promedio km/día.
- `maintenance`: **motor de mantenimiento** — plantillas (15 servicios genéricos seed, overrides por marca/modelo soportados), instanciación automática al crear vehículo, proyección de vencimiento por km y fecha, estados 🟢 ok / 🟡 upcoming / 🔴 overdue (overdue notifica a diario), personalización de intervalos, "ya lo hice" con gasto asociado y reprogramación.
- `expenses`: CRUD por tipo (9 tipos), foto de factura, estadísticas por tipo y por mes.
- `partners`: registro B2B (taller / repuestos / concesionario / servicios), documentos, aprobación por admin, búsqueda geolocalizada (haversine SQL, radio configurable).
- `workshops`: servicios con precio/duración, horario semanal, disponibilidad por slots de 1 hora.
- `appointments`: agendar con anti-colisión de slot, confirmar/completar/cancelar, notificaciones a ambas partes, recordatorio 24h.
- `reviews`: 1 reseña por usuario/partner, rating agregado.
- `offers`: cupones con vigencia y `serviceKey` para publicidad contextual.
- `parts`: catálogo de repuestos con **compatibilidad por marca/modelo/años**, búsqueda filtrada por el vehículo del usuario, métricas de vistas/clics.
- `orders`: carrito (un proveedor por pedido) → `whatsappUrl` con mensaje pre-armado (productos, cantidades, vehículo, total referencial, truncado a ~1800 chars); estados sent → confirmed → delivered / cancelled con push al cliente.
- `listings`: venta de carros desde vehículo registrado (hereda **historial verificado**) o listado nuevo, hasta 10 fotos, moderación admin, expiración 30 días con renovación, destacados, favoritos, alertas de búsqueda guardadas.
- `admin`: métricas globales, aprobación de partners, moderación de listados, gestión de usuarios, audit log.
- `diagnostics` (2026-07-20): diagnóstico IA por síntoma (texto libre) vía Google Gemini (`gemini-flash-lite-latest`, free tier; helper `shared/llm.ts` puro/portable, modo mock sin key). `POST /diagnostics` usa **memoria del vehículo** (mantenimientos + gastos + `vehicle_diagnosis_log`) inyectada al prompt → la IA sabe qué se reparó y no repite. `POST /diagnostics/listing/:id` = comprador evalúa un anuncio con su **historial verificado** (nunca el log privado del dueño) → veredicto + pros/contras + preguntas al vendedor. Guardrails: `authed`, filtro `offtopic`, caché por huella de historial, **cupo diario por usuario y tipo** (`diagnostic_usage.kind`: 3 diagnósticos + 1 pregunta de anuncio, config `FREE_DAILY_*`, atómico contra ráfagas) → base para monetización por suscripción.

**Verificación**
- **27/27 tests E2E pasando contra Supabase real** (`bun run test`, timeout 30s por latencia): flujo completo usuario + proveedor + taller + admin.
- Seed: 15 plantillas + 58 modelos + admin `admin@automaint.app` / `Admin1234!` (cambiar con `ADMIN_PASSWORD`).

**Gotchas descubiertas**
- La conexión directa `db.<ref>.supabase.co:5432` es **IPv6-only** — en redes sin IPv6 usar el session pooler `aws-0-us-east-1.pooler.supabase.com:5432` (así está el `.env`).
- `postgres-js` con `prepare: false` para compatibilidad con el pooler (pgbouncer).

### App móvil (`automaint-app`) — Iteración 2 (MVP)

- Kotlin Multiplatform + Compose Multiplatform. Target **Android** activo; todo el código (UI + API client Ktor) en `commonMain`, listo para agregar iOS desde un Mac.
- Pantallas: Login/Registro (con campo de servidor configurable), Dashboard con semáforo y próximo mantenimiento, Agregar vehículo (catálogo → plan automático), Detalle (plan por urgencia, actualizar km, "ya lo hice" + gasto, pestaña gastos), Notificaciones.
- APK debug: `composeApp/build/outputs/apk/debug/composeApp-debug.apk` (~17 MB).
- Build: AGP 8.11.1, compileSdk 36, minSdk 26. Compose Multiplatform 1.8.1 exige compileSdk ≥ 35.
- Conexión: emulador `http://10.0.2.2:3000`, teléfono físico `http://<IP-PC>:3000` (misma red, abrir puerto 3000 en firewall).

---

## ⬜ Lo que falta

### Corto plazo (completar iteración actual)
- [ ] **Supabase Storage**: pegar `SUPABASE_SERVICE_ROLE_KEY` en `.env`, crear los 4 buckets públicos y cambiar `STORAGE_DRIVER=supabase`.
- [ ] Cambiar password del admin seed en producción (`ADMIN_PASSWORD`).
- [x] Gradle wrapper en `automaint-app` (generado, `.\gradlew :composeApp:assembleDebug`).
- [ ] Limpiar datos de prueba de los tests en Supabase (usuarios `*@test.com`) si estorban.

### Iteración 3 — Webs React
- [x] `automaint-web-partners` (2026-07-19): portal para **taller** (citas confirmar/completar/rechazar + cargar presupuesto, presupuestos enviados, servicios CRUD, horario semanal) y **proveedor** (productos CRUD + foto + compatibilidad, pedidos con cambio de estado, stats de ventas). Registro self-service: crea cuenta → formulario de negocio → queda `pending` hasta aprobación admin (banner visible). Config de servidor en Login/Perfil (localStorage, default `automaint.nibs-tech.com`). Stack: React 18 + Vite 5 + react-router (HashRouter), CSS plano, sin UI libs. `npm install && npm run dev` (puerto 5174) o `npm run build`. Concesionario/servicios: solo Dashboard+Perfil (`ponytail:` vistas propias cuando haga falta).
- [x] `automaint-web-admin` (2026-07-19): panel morado (puerto 5175) — solo acepta login rol `admin` (`admin@automaint.app`). Métricas globales con alerta de pendientes, Partners (filtros por estado + **buscador** nombre/ciudad/email/RIF, detalle con documentos y coordenadas, aprobar/rechazar/suspender con motivo → notifica al partner y queda en audit log), Listados (moderación + destacar + buscador), Usuarios (búsqueda server-side con debounce), Auditoría. Mismo stack y estructura que web-partners.
- [ ] Generar tipos desde OpenAPI (`/swagger/json`) con `openapi-typescript` (la web usa tipos manuales en `src/api.ts`).

### Modo partner (opción C híbrida, 2026-07-19)
Decisión: web para gestión pesada (catálogo/horarios/documentos), APK solo acciones urgentes del partner. WhatsApp sigue siendo canal de cobro.
- **API — endpoints nuevos**: `GET /partners/me/schedules` (leer horario para editarlo), `GET /partners/me/quotes` (presupuestos enviados por el taller, con `scheduledAt` de la cita), `GET /partners/me/stats` (rating, parts total/active/views/clicks, orders por estado con totales, appointments por estado, quotes total/aprobados). Todo lo demás ya existía.
- **APK — modo partner**: login con cuenta rol `partner` → bottom bar cambia según tipo de negocio (`GET /partners/me`): taller → tab **Citas** (`PartnerAppointmentsScreen.kt`: confirmar/rechazar/completar + bottom sheet para cargar presupuesto con items dinámicos) · repuestos → tab **Pedidos** (`PartnerOrdersScreen.kt`: confirmar/entregar/cancelar) · ambos + Perfil. Rol persistido en SharedPreferences (`saveRole/loadRole` en `Storage.android.kt`, patrón igual a token); `Api.role` se setea en login y se limpia en logout. Nuevos DTOs/endpoints partner al final de `Api.kt`.
- ⚠️ **Compilar APK**: `cd automaint-app && .\gradlew :composeApp:assembleDebug` → `composeApp/build/outputs/apk/debug/composeApp-debug.apk`. Probar con usuarios mock partner (`*@automaint.app` / `Proveedor1234!`).
- ⚠️ **Redeploy API pendiente**: los 3 endpoints nuevos + `/quotes` corren solo en local; `automaint.nibs-tech.com` necesita redeploy.

### Iteración 4 — Producción
- [ ] **OAuth real** Google/Apple (validar `id_token`; el endpoint mock ya tiene el contrato final).
- [ ] **Push FCM real** (`firebase-admin` o HTTP v1; hoy log-only) + integración en la app Android.
- [ ] **Email real** (Resend; hoy log-only) — solo falta `RESEND_API_KEY`.
- [ ] Suscripción **Premium** vía Google Play Billing / Apple IAP (evaluar RevenueCat) + gates de features (2 vehículos free, sin ads, export PDF).
- [ ] Publicidad contextual en la app + listados destacados de pago.
- [ ] Export PDF del historial de servicios + compartir.
- [ ] VIN decode (API NHTSA vPIC, gratuita).
- [ ] HTTPS/reverse proxy en el servidor, rate limiting, rotación de `JWT_SECRET`.

### Presupuestos (quotes) — flujo cita → presupuesto → comparador → pedidos (2026-07-18)
- Backend: tabla `quotes` (migración `0001_short_proudstar.sql`, ya aplicada en Supabase) + módulo `src/modules/quotes.ts`:
  - `POST /partners/me/quotes` — taller carga presupuesto sobre cita confirmada (items: name/qty/category), notifica al usuario.
  - `GET /quotes` — presupuestos del usuario. `PATCH /quotes/:id` — aprobar/rechazar.
  - `GET /quotes/:id/options` — comparador: **mejores precios** (item más barato del mercado, agrupado por proveedor — puede repartirse en varios) y **proveedor único** (uno que cubra TODO al mejor total). Matching léxico por tokens de nombre + categoría (`ponytail:` migrar a FTS si crece el catálogo).
- App: card "Presupuesto del taller" en tab Citas → pantalla Comparar precios (toggle Mejores precios / Proveedor único) → "Aprobar" crea 1 pedido por proveedor (`POST /orders`) → botones "Enviar por WhatsApp" por pedido.
- Mock: proveedor **Multirepuestos 360** (cubre los 10 items, ~15% más caro — para que "proveedor único" tenga resultado). Simulación ejecutada: cita real confirmada + presupuesto de 10 repuestos cargado. Smoke test: multi $364/3 proveedores vs único $404.50 ✅.
- ⚠️ **Deploy pendiente**: los endpoints `/quotes` corren solo en el repo local; el server `automaint.nibs-tech.com` necesita redeploy (la migración de BD ya está aplicada porque comparte Supabase).

### App móvil (siguientes pantallas)
- [x] Talleres cercanos + agendar cita (2026-07-18): `WorkshopsScreen.kt` + `WorkshopDetailScreen.kt` — ubicación real del teléfono (LocationManager, fallback Caracas si no hay fix), `/partners/nearby` radio 50→200 km, botón "mapa" abre Google Maps (`geo:` URI, sin SDK), detalle con servicios/fecha/slots → `POST /appointments`, "Mis citas" en bottom sheet. Mock: 5 talleres aprobados (Chacao, Las Mercedes, Los Ruices, La Candelaria, Valencia) con servicios y horario Lun-Sáb 08:00-17:00. WhatsApp de TODOS los partners mock → +584123870654 (número real del dueño para pruebas). Mapa embebido con **osmdroid** (OpenStreetMap, sin API key): toggle Lista/Mapa en Talleres, pins seleccionables → card "Ver y agendar". Navegación con **bottom bar** de 5 tabs (Inicio, Talleres, Market, Citas, Perfil); top bar solo campana de notificaciones. Tab Citas con cancelación; tab Perfil con servidor y logout.
- [x] Marketplace de repuestos con carrito → WhatsApp (2026-07-18): `MarketplaceScreen.kt` — búsqueda con debounce, filtro por vehículo (compatibilidad make/model/year), chips de categoría, carrito de un proveedor, `POST /orders` → abre `whatsappUrl`. Data mock en prod: 3 proveedores aprobados (Lubricantes El Motor/Caracas, AutoPartes Valencia, Baterías y Más/Maracaibo, teléfonos ficticios 58412…/58414…/58416…) + 18 repuestos, usuarios `*@automaint.app` password `Proveedor1234!`.
- [x] Marketplace de carros (2026-07-18): tab Market con toggle Repuestos|Carros (`CarsScreens.kt`). Publicar desde vehículo propio (hereda historial verificado) con precio/descripción/WhatsApp + subir fotos (galería → multipart, `rememberImagePicker` expect/actual). Detalle: fotos, precio, historial verificado (servicios con km/fecha + nº de gastos) y botón **Contactar** → wa.me con mensaje prellenado. Imágenes con `RemoteImage` (Ktor + BitmapFactory, sin Coil; `ponytail:` sin caché). Mock: Corolla 2016 ($8500) y Aveo 2013 ($4200) aprobados. ⚠️ Listados nuevos quedan `pending` — aprobar con `seed-listings.js` (aprueba todos los pendientes) o web admin (iteración 3).
- [x] Rediseño Stitch (2026-07-19): proyecto Stitch `12416696500873340091` (MCP `stitch` configurado en scope user). Tema M3 completo en `App.kt` (paleta extraída del HTML de Stitch: primary #1565C0, fondo #FAF9FC, containers azul claro, shapes 16dp), bottom nav con pill azul, `AmTopBar` (título azul centrado) aplicada en todas las pantallas. Login: ilustración + tabs Entrar/Registrarme + ojo de contraseña + opciones avanzadas colapsables. Dashboard: banner de alerta ámbar + hero azul "Próximo mantenimiento" (más urgente entre vehículos) + cards de vehículo con foto y punto de estado. Detalle vehículo: header con foto + tabs Plan/Gastos + cards con barra lateral de color por estado. Talleres: chip de distancia + estrella ámbar. Perfil: avatar con iniciales + `GET /me` (endpoint ya existía, `Api.me()` nuevo). Pendiente de diseño Stitch sin implementar: fotos en cards de talleres, ilustración real del login (asset), pantalla Market con grid de fotos.
- [ ] Foto del vehículo y facturas (upload).
- [ ] Modo offline (SQLDelight) y refresh automático de token.
- [ ] Target iOS (requiere macOS).

### Deuda técnica marcada en código (`ponytail:`)
- Geo con haversine SQL → migrar a PostGIS si el volumen lo pide (`src/shared/geo.ts`).
- Cron in-process (instancia única) → pg-boss/BullMQ si se escala horizontal (`src/jobs/scheduler.ts`).
- Slots de citas fijos de 1 hora → slots por duración de servicio (`src/modules/workshops.ts`).
- Push log-only → FCM real (`src/shared/push.ts`).
