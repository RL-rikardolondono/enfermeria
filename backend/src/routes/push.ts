import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { autenticar, requerirRol } from '../middleware/auth'
import { APP_URL } from '../utils/config'

// Claves de los avisos al celular (VAPID). Si no están en Render, el servidor las crea una sola vez y las
// guarda en su base de datos: así nadie tiene que generarlas ni pegarlas, y no cambian entre reinicios.
let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || ''
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || ''

export async function prepararVapid(log: { info: (o: any, m?: string) => void; error: (o: any, m?: string) => void }) {
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) return
  try {
    const guardada = await prisma.ajuste.findUnique({ where: { clave: 'vapid' } })
    if (guardada) {
      const k = JSON.parse(guardada.valor)
      VAPID_PUBLIC_KEY = k.publicKey; VAPID_PRIVATE_KEY = k.privateKey
      return
    }
    const webpush = await import('web-push')
    const k = webpush.default.generateVAPIDKeys()
    // createMany con skipDuplicates: si dos arranques se cruzan, gana la primera y ambos usan esa
    await prisma.ajuste.createMany({ data: [{ clave: 'vapid', valor: JSON.stringify(k) }], skipDuplicates: true })
    const final = await prisma.ajuste.findUnique({ where: { clave: 'vapid' } })
    const f = JSON.parse(final!.valor)
    VAPID_PUBLIC_KEY = f.publicKey; VAPID_PRIVATE_KEY = f.privateKey
    log.info({}, 'Avisos al celular: claves creadas y guardadas en la base de datos')
  } catch (e) {
    log.error(e, 'No se pudieron preparar las claves de avisos al celular')
  }
}

// Función para enviar notificación push a una suscripción
// Devuelve 'ok', 'borrar' (la suscripción ya no existe) o 'error' (fallo pasajero: se conserva)
async function enviarNotificacionPush(suscripcion: any, payload: object): Promise<'ok' | 'borrar' | 'error'> {
  try {
    const webpush = await import('web-push')
    webpush.default.setVapidDetails(
      'mailto:saludencasa@skynetgenesis.com',
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    )
    await webpush.default.sendNotification(suscripcion, JSON.stringify(payload))
    return 'ok'
  } catch (error: any) {
    if ([400, 403, 404, 410].includes(error?.statusCode)) return 'borrar'
    return 'error'
  }
}

// Solo servicios de avisos reales de los navegadores (evita que el servidor llame a direcciones arbitrarias)
const HOSTS_PUSH = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com|android\.googleapis\.com)$/i
export function endpointValido(u: string) {
  try { const x = new URL(u); return x.protocol === 'https:' && HOSTS_PUSH.test(x.hostname) } catch { return false }
}

export const pushConfigurado = () => !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY)

export async function pushRoutes(app: FastifyInstance) {

  // GET /api/push/vapid-public-key — devuelve la clave pública para el cliente
  app.get('/vapid-public-key', async () => {
    return { publicKey: VAPID_PUBLIC_KEY }
  })

  // POST /api/push/suscribir — guardar suscripción del profesional
  app.post('/suscribir', { preHandler: requerirRol('profesional') }, async (request, reply) => {
    const body = z.object({
      endpoint: z.string().url().max(1000),
      keys: z.object({
        p256dh: z.string().max(300),
        auth: z.string().max(300),
      }),
    }).parse(request.body)
    if (!endpointValido(body.endpoint)) return reply.status(400).send({ error: 'Este navegador no ofrece avisos compatibles. Use Chrome, Safari o Firefox actualizados.' })

    // Evita suscripciones repetidas del mismo dispositivo (causan avisos duplicados)
    // El mismo dispositivo solo queda ligado al profesional que ingresó ahora (celulares compartidos)
    await prisma.notificacion.deleteMany({
      where: { tipo: 'push_subscription', cuerpo: { startsWith: JSON.stringify({ endpoint: body.endpoint }).slice(0, -1) + ',' } },
    })

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
  excluir?: string[] // profesionales bloqueados por ese paciente
  solo?: string[]    // si se indica, solo a estos profesionales
}) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return // avisos push no configurados
  try {
    // Buscar profesionales aprobados y disponibles con suscripción push
    const profesionalesAprobados = await prisma.profesional.findMany({
      where: { estadoVerificacion: 'aprobado', activo: true, disponible: true, usuario: { estado: 'activo' }, ...(payload.solo ? { id: { in: payload.solo } } : {}), ...(payload.excluir?.length ? { id: { notIn: payload.excluir } } : {}) },
      select: { usuarioId: true },
    })

    const usuarioIds = profesionalesAprobados.map((p: { usuarioId: string }) => p.usuarioId)

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
            icon: `${APP_URL}/icon-192.png`,
            url: payload.url || `${APP_URL}/app-enfermero.html`,
          })
          // Si la suscripción es inválida, eliminarla
          if (exito === 'borrar') {
            await prisma.notificacion.delete({ where: { id: sub.id } }).catch(() => {})
          }
        }
      } catch (e) {}
    }
  } catch (e) {
    console.error('Error enviando notificaciones push:', e)
  }
}

// Aviso a una sola persona (por ejemplo, al profesional que el paciente eligió)
export async function notificarUsuario(usuarioId: string, payload: { titulo: string; cuerpo: string; url?: string }) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return
  try {
    const suscripciones = await prisma.notificacion.findMany({ where: { usuarioId, tipo: 'push_subscription' } })
    for (const sub of suscripciones) {
      const datos = JSON.parse(sub.cuerpo || '{}')
      if (!datos.endpoint) continue
      const r = await enviarNotificacionPush(datos, {
        title: payload.titulo, body: payload.cuerpo, icon: `${APP_URL}/icon-192.png`,
        url: payload.url || `${APP_URL}/app-enfermero.html`,
      })
      if (r === 'borrar') await prisma.notificacion.delete({ where: { id: sub.id } }).catch(() => {})
    }
  } catch (e) {
    console.error('Error enviando aviso push:', e)
  }
}
