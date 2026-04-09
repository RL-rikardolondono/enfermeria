import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { autenticar, requerirRol } from '../middleware/auth'

// VAPID keys - estas deben estar en variables de entorno
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || ''
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || ''

// Función para enviar notificación push a una suscripción
async function enviarNotificacionPush(suscripcion: any, payload: object): Promise<boolean> {
  try {
    const webpush = await import('web-push')
    webpush.default.setVapidDetails(
      'mailto:admin@reinaelizabeth.com',
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    )
    await webpush.default.sendNotification(suscripcion, JSON.stringify(payload))
    return true
  } catch (error: any) {
    // Si el endpoint ya no es válido (410 Gone), eliminar la suscripción
    if (error.statusCode === 410 || error.statusCode === 404) {
      return false
    }
    return false
  }
}

export async function pushRoutes(app: FastifyInstance) {

  // GET /api/push/vapid-public-key — devuelve la clave pública para el cliente
  app.get('/vapid-public-key', async () => {
    return { publicKey: VAPID_PUBLIC_KEY }
  })

  // POST /api/push/suscribir — guardar suscripción del profesional
  app.post('/suscribir', { preHandler: autenticar }, async (request, reply) => {
    const body = z.object({
      endpoint: z.string().url(),
      keys: z.object({
        p256dh: z.string(),
        auth: z.string(),
      }),
    }).parse(request.body)

    // Guardar suscripción en la tabla de notificaciones como JSON
    await prisma.notificacion.create({
      data: {
        usuarioId: request.usuario.id,
        tipo: 'push_subscription',
        titulo: 'Suscripción push',
        cuerpo: JSON.stringify({
          endpoint: body.endpoint,
          keys: body.keys,
        }),
        leida: true,
      },
    })

    return { ok: true, mensaje: 'Suscripción guardada' }
  })

  // DELETE /api/push/desuscribir — eliminar suscripción
  app.delete('/desuscribir', { preHandler: autenticar }, async (request) => {
    await prisma.notificacion.deleteMany({
      where: {
        usuarioId: request.usuario.id,
        tipo: 'push_subscription',
      },
    })
    return { ok: true }
  })

  // POST /api/push/notificar-profesionales — enviar push a todos los profesionales aprobados
  // Se llama internamente cuando se crea un servicio
  app.post('/notificar-profesionales', { preHandler: requerirRol('admin') }, async (request, reply) => {
    const { titulo, cuerpo, url } = z.object({
      titulo: z.string().default('Nueva solicitud'),
      cuerpo: z.string().default('Hay una nueva solicitud de servicio disponible'),
      url: z.string().optional(),
    }).parse(request.body)

    await notificarProfesionalesDisponibles({ titulo, cuerpo, url })
    return { ok: true }
  })
}

// Función exportable para llamar desde servicios.ts al crear un servicio
export async function notificarProfesionalesDisponibles(payload: {
  titulo: string
  cuerpo: string
  url?: string
}) {
  try {
    // Buscar profesionales aprobados y disponibles con suscripción push
    const profesionalesAprobados = await prisma.profesional.findMany({
      where: { estadoVerificacion: 'aprobado', activo: true },
      select: { usuarioId: true },
    })

    const usuarioIds = profesionalesAprobados.map(p => p.usuarioId)

    // Buscar suscripciones push de esos profesionales
    const suscripciones = await prisma.notificacion.findMany({
      where: {
        usuarioId: { in: usuarioIds },
        tipo: 'push_subscription',
      },
    })

    // Enviar notificación a cada suscripción
    for (const sub of suscripciones) {
      try {
        const suscripcionData = JSON.parse(sub.cuerpo || '{}')
        if (suscripcionData.endpoint) {
          const exito = await enviarNotificacionPush(suscripcionData, {
            title: payload.titulo,
            body: payload.cuerpo,
            icon: '/enfermeria/icon-192.png',
            url: payload.url || 'https://rl-rikardolondono.github.io/enfermeria/app-enfermero.html',
          })
          // Si la suscripción es inválida, eliminarla
          if (!exito) {
            await prisma.notificacion.delete({ where: { id: sub.id } }).catch(() => {})
          }
        }
      } catch (e) {}
    }
  } catch (e) {
    console.error('Error enviando notificaciones push:', e)
  }
}
