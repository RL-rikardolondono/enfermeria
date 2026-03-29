import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import multipart from '@fastify/multipart'

import { authRoutes } from './routes/auth'
import { pacientesRoutes } from './routes/pacientes'
import { profesionalesRoutes } from './routes/profesionales'
import { serviciosRoutes } from './routes/servicios'
import { adminRoutes } from './routes/admin'
import { trackingWS } from './websocket/tracking'
import { notificacionesWS } from './websocket/notificaciones'
import { prisma } from './utils/prisma'
import { redis } from './utils/redis'

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
})

async function bootstrap() {
  // Seguridad
  await app.register(helmet, { contentSecurityPolicy: false })
  await app.register(cors, {
    origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3001'],
    credentials: true,
  })
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    redis,
  })

  // Auth
  await app.register(jwt, {
    secret: process.env.JWT_SECRET!,
    sign: { expiresIn: '15m' },
  })

  // Archivos y WebSocket
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } })
  await app.register(websocket)

  // Health check
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  }))

  // Rutas REST
  await app.register(authRoutes,          { prefix: '/api/auth' })
  await app.register(pacientesRoutes,     { prefix: '/api/pacientes' })
  await app.register(profesionalesRoutes, { prefix: '/api/profesionales' })
  await app.register(serviciosRoutes,     { prefix: '/api/servicios' })
  await app.register(adminRoutes,         { prefix: '/api/admin' })

  // WebSocket
  await app.register(trackingWS,         { prefix: '/ws/tracking' })
  await app.register(notificacionesWS,   { prefix: '/ws/notificaciones' })

  // Error handler global
  app.setErrorHandler((error, request, reply) => {
    app.log.error(error)
    if (error.statusCode) {
      return reply.status(error.statusCode).send({ error: error.message })
    }
    return reply.status(500).send({ error: 'Error interno del servidor' })
  })

  // Graceful shutdown
  const shutdown = async () => {
    await app.close()
    await prisma.$disconnect()
    redis.disconnect()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  const port = parseInt(process.env.PORT || '3000')
  await app.listen({ port, host: '0.0.0.0' })
  app.log.info(`Servidor escuchando en puerto ${port}`)
}

bootstrap().catch((err) => {
  console.error(err)
  process.exit(1)
})
