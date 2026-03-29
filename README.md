# Plataforma Enfermería Domiciliaria
## Reina Elizabeth IPS — Sistema Digital Completo

---

## Estructura del proyecto

```
enfermeria-app/
├── database/
│   └── schema.sql              # Schema PostgreSQL + PostGIS completo
├── backend/                    # API REST Node.js + Fastify
│   ├── src/
│   │   ├── server.ts           # Entrada principal
│   │   ├── routes/
│   │   │   ├── auth.ts         # Registro, login, refresh, logout
│   │   │   ├── servicios.ts    # Motor de asignación + evolución clínica
│   │   │   ├── pacientes.ts    # Historia clínica, perfil, evoluciones
│   │   │   ├── profesionales.ts# GPS, disponibilidad, verificación
│   │   │   └── admin.ts        # Dashboard, reportes, verificación
│   │   ├── websocket/
│   │   │   ├── tracking.ts     # GPS en tiempo real
│   │   │   └── notificaciones.ts
│   │   ├── middleware/
│   │   │   └── auth.ts         # JWT + control de roles
│   │   ├── services/
│   │   │   └── tarifas.ts
│   │   └── utils/
│   │       ├── prisma.ts
│   │       ├── redis.ts
│   │       └── notificaciones.ts
│   ├── prisma/
│   │   └── schema.prisma       # ORM completo (14 modelos)
│   ├── Dockerfile
│   ├── .env.example
│   └── package.json
├── mobile/                     # App React Native + Expo
│   ├── src/
│   │   ├── screens/
│   │   │   ├── LoginScreen.tsx
│   │   │   ├── SolicitarServicioScreen.tsx  # Mapa + solicitud
│   │   │   ├── TrackingScreen.tsx           # GPS en vivo
│   │   │   └── EvolucionScreen.tsx          # Signos vitales + alertas
│   │   ├── store/
│   │   │   └── authStore.ts    # Zustand + SecureStore
│   │   └── lib/
│   │       └── api.ts          # Axios + refresh token automático
│   └── package.json
├── frontend-admin/             # Panel Next.js (IPS)
│   └── src/app/dashboard/
│       └── page.tsx            # Dashboard + verificaciones + métricas
├── nginx/
│   └── nginx.conf              # Reverse proxy + SSL + WebSocket
├── .github/workflows/
│   └── deploy.yml              # CI/CD GitHub Actions
└── docker-compose.yml          # Stack completo local/producción
```

---

## Inicio rápido (desarrollo local)

### Requisitos
- Docker + Docker Compose
- Node.js 20+

### 1. Clonar y configurar
```bash
git clone <repo>
cd enfermeria-app
cp backend/.env.example backend/.env
# Editar backend/.env con tus valores
```

### 2. Levantar infraestructura
```bash
docker compose up postgres redis -d
```

### 3. Inicializar base de datos
```bash
cd backend
npm install
npx prisma generate
npx prisma migrate dev --name init
# O usar el schema SQL directamente:
# psql -h localhost -U enfermeria -d enfermeria_db -f ../database/schema.sql
```

### 4. Iniciar API
```bash
npm run dev
# API disponible en http://localhost:3000
# Health check: http://localhost:3000/health
```

### 5. Iniciar panel admin
```bash
cd ../frontend-admin
npm install
npm run dev
# Panel en http://localhost:3001
```

### 6. App móvil
```bash
cd ../mobile
npm install
npx expo start
# Escanear QR con Expo Go
```

### Stack completo con Docker
```bash
docker compose up -d
# API:   http://localhost:3000
# Admin: http://localhost:3001
```

---

## Variables de entorno clave

| Variable           | Descripción                                |
|--------------------|--------------------------------------------|
| `DATABASE_URL`     | PostgreSQL con PostGIS                     |
| `JWT_SECRET`       | Secreto para firmar tokens (256 bits)      |
| `REDIS_HOST`       | Redis para caché y WebSocket               |
| `FIREBASE_*`       | Push notifications móviles                 |
| `WOMPI_*`          | Pasarela de pagos Colombia                 |
| `AWS_*`            | S3 para documentos clínicos cifrados       |

---

## Endpoints principales

| Método | Ruta                              | Descripción                          |
|--------|-----------------------------------|--------------------------------------|
| POST   | /api/auth/register                | Registro de usuario                  |
| POST   | /api/auth/login                   | Login → JWT                          |
| POST   | /api/servicios                    | Crear solicitud + motor asignación   |
| PATCH  | /api/servicios/:id/aceptar        | Profesional acepta                   |
| POST   | /api/servicios/:id/evolucion      | Signos vitales + alertas automáticas |
| GET    | /api/profesionales/cercanos       | Profesionales disponibles por GPS    |
| PUT    | /api/profesionales/:id/ubicacion  | Actualizar GPS (cada 5s)             |
| GET    | /api/admin/dashboard              | Métricas en tiempo real              |
| WS     | /ws/tracking/:servicioId          | Tracking GPS en vivo                 |

---

## Cumplimiento legal Colombia

- **Historia clínica**: Resolución 1995/1999 — registros inmutables con timestamp
- **Habilitación IPS**: Decreto 780/2016 — operación bajo Reina Elizabeth IPS
- **Datos personales**: Ley 1581/2012 — cifrado AES-256, acceso por roles
- **RETHUS**: Verificación automática del Registro Único Nacional Talento en Salud
- **Auditoría**: Trazabilidad completa de cada acción clínica

---

## Roadmap técnico

| Fase | Duración | Alcance |
|------|----------|---------|
| 1 — MVP | Meses 1-3 | Auth, servicios, asignación básica, pagos |
| 2 — Clínico | Meses 4-6 | Historia clínica completa, alertas, planes |
| 3 — Escala | Meses 7-12 | Telemedicina, ML, API institucional, BLE |

---

*Reina Elizabeth IPS © 2024 — Todos los derechos reservados*
