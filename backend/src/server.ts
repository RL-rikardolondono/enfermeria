import Fastify from 'fastify'
import cors from '@fastify/cors'
import { ORIGENES_PERMITIDOS } from './utils/config'
import helmet from '@fastify/helmet'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import { ZodError } from 'zod'
import '@fastify/websocket' // solo tipos: así compila aunque en GitHub sigan los archivos viejos de WebSocket (no se usan)
import multipart from '@fastify/multipart'

import { authRoutes } from './routes/auth'
import { pacientesRoutes } from './routes/pacientes'
import { profesionalesRoutes } from './routes/profesionales'
import { serviciosRoutes } from './routes/servicios'
import { adminRoutes } from './routes/admin'
import { pagosRoutes } from './routes/pagos'
import { pushRoutes } from './routes/push'
import { tarifasRoutes } from './routes/tarifas'
import { asegurarCatalogo } from './services/catalogo'
import { asegurarSuperadmin } from './services/cuentas'
import { prepararVapid } from './routes/push'
import { prisma } from './utils/prisma'
import { versionActual } from './utils/cambios'
import { redis, redisReal } from './utils/redis'

// Nombres en español de los campos, para los mensajes de error
const NOMBRES_CAMPO: Record<string, string> = {
  nombreCompleto: 'nombre', telefono: 'teléfono', email: 'correo', password: 'contraseña', aceptaTerminos: 'aceptación de términos',
  especialidad: 'profesión', descripcion: 'descripción', direccion: 'dirección', tipo: 'tipo de servicio', pacienteId: 'paciente',
  fechaNacimiento: 'fecha de nacimiento', documentoNumero: 'documento', parentesco: 'parentesco', alergias: 'alergias', antecedentes: 'antecedentes',
  tensionSistolica: 'tensión sistólica', tensionDiastolica: 'tensión diastólica', frecuenciaCardiaca: 'frecuencia cardiaca', temperatura: 'temperatura',
  saturacionOxigeno: 'saturación de oxígeno', glucemia: 'glucemia', observaciones: 'observaciones', procedimientos: 'procedimientos',
  precio: 'precio', puntuacion: 'calificación', comentario: 'comentario', estado: 'estado', token: 'enlace',
  queja: 'queja (mínimo 10 letras)', texto: 'queja (mínimo 10 letras)', respuesta: 'nota de revisión', ofertaId: 'profesional elegido',
}

const app = Fastify({
  trustProxy: 1, // solo el balanceador de Render: toma la IP que agrega Render, no la que inventa el cliente
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
    origin: ORIGENES_PERMITIDOS,
    credentials: true,
  })
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    ...(redisReal ? { redis: redisReal } : {}),
  })

  // Auth
  await app.register(jwt, {
    secret: process.env.JWT_SECRET!,
    sign: { expiresIn: '24h' },
  })

  // Manejo de errores (debe ir antes de registrar las rutas para que se aplique a todas)
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      const campos = Array.from(new Set(error.issues.map((i) => NOMBRES_CAMPO[String(i.path[i.path.length - 1])] || String(i.path.join('.')) || 'datos')))
      return reply.status(400).send({
        error: 'Revise: ' + campos.join(', '),
        detalles: error.issues.map((i) => ({ campo: i.path.join('.'), mensaje: i.message })),
      })
    }
    const nombre = (error as { name?: string }).name
    const codigo = (error as { code?: string }).code
    if (nombre === 'PrismaClientKnownRequestError') {
      if (codigo === 'P2002') return reply.status(409).send({ error: 'El registro ya existe' })
      if (codigo === 'P2025') return reply.status(404).send({ error: 'Registro no encontrado' })
      if (codigo === 'P2003') return reply.status(400).send({ error: 'Referencia inválida' })
    }
    if (nombre === 'PrismaClientValidationError') {
      return reply.status(400).send({ error: 'Revise los datos enviados' })
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500
    if (status >= 500) request.log.error(error)
    return reply.status(status).send({ error: status >= 500 ? 'Error interno del servidor' : error.message })
  })

  // Archivos
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } })

  // Health check (lo usan Render y el despertador; sin límite de solicitudes)
  app.get('/health', { config: { rateLimit: false } }, async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  }))

  // Ping para el despertador (cron-job.org) — no toca la base de datos
  app.get('/api/ping', { config: { rateLimit: false } }, async () => ({ ok: true }))
  // Versión de cambios: las apps la consultan seguido y solo recargan si cambió (no toca la base de datos)
  app.get('/api/cambios', { config: { rateLimit: false } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return { v: versionActual() }
  })

  // Rutas REST
  await app.register(authRoutes,          { prefix: '/api/auth' })
  await app.register(pacientesRoutes,     { prefix: '/api/pacientes' })
  await app.register(profesionalesRoutes, { prefix: '/api/profesionales' })
  await app.register(serviciosRoutes,     { prefix: '/api/servicios' })
  await app.register(adminRoutes,         { prefix: '/api/admin' })
  await app.register(pagosRoutes,         { prefix: '/api/pagos' })
  await app.register(pushRoutes, { prefix: '/api/push' })
  await app.register(tarifasRoutes,       { prefix: '/api/tarifas' })


  // Graceful shutdown
  const shutdown = async () => {
    await app.close()
    await prisma.$disconnect()
    redis.disconnect()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  // Tarifas iniciales de la IPS (solo crea las que falten)
  await asegurarCatalogo().catch((err) => app.log.error(err, 'No se pudo preparar el catálogo de servicios'))
  // Cuentas creadas antes de permitir varios pacientes: su único paciente es el titular
  await prisma.paciente.updateMany({ where: { nombreCompleto: null, esTitular: false }, data: { esTitular: true, parentesco: 'Titular' } })
    .catch((err: unknown) => app.log.error(err, 'No se pudo marcar a los titulares'))

  // Cuenta propia del Superadministrador (superadmin.saludencasa@) y claves de los avisos al celular
  await asegurarSuperadmin(app.log).catch((err) => app.log.error(err, 'No se pudo preparar el Superadministrador'))
  await prepararVapid(app.log)

  const port = parseInt(process.env.PORT || '3000')
  await app.listen({ port, host: '0.0.0.0' })
  app.log.info(`Servidor escuchando en puerto ${port}`)
}

bootstrap().catch((err) => {
  console.error(err)
  process.exit(1)
})
