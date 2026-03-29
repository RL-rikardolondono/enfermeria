import { FastifyInstance } from 'fastify'
import { redis } from '../utils/redis'
import { prisma } from '../utils/prisma'

// Mapa en memoria: servicioId → Set de WebSocket clients
const trackingClients = new Map<string, Set<any>>()

export async function trackingWS(app: FastifyInstance) {
  // ws://api/tracking/:servicioId
  app.get('/:servicioId', { websocket: true }, async (connection, request) => {
    const { servicioId } = request.params as { servicioId: string }

    // Registrar cliente
    if (!trackingClients.has(servicioId)) {
      trackingClients.set(servicioId, new Set())
    }
    trackingClients.get(servicioId)!.add(connection)

    // Enviar posición actual si existe
    const posActual = await redis.get(`ubicacion:profesional:${servicioId}`)
    if (posActual) {
      connection.send(JSON.stringify({ type: 'ubicacion', data: JSON.parse(posActual) }))
    }

    connection.on('message', async (msg: Buffer) => {
      try {
        const data = JSON.parse(msg.toString())

        if (data.type === 'ubicacion' && data.lat && data.lng) {
          const payload = {
            lat: data.lat,
            lng: data.lng,
            timestamp: new Date().toISOString(),
          }

          // Guardar en Redis (TTL 1 hora)
          await redis.setex(
            `ubicacion:profesional:${servicioId}`,
            3600,
            JSON.stringify(payload)
          )

          // Guardar historial en DB
          const servicio = await prisma.servicio.findUnique({ where: { id: servicioId } })
          if (servicio?.profesionalId) {
            await prisma.trackingHistorial.create({
              data: {
                servicioId,
                profesionalId: servicio.profesionalId,
                lat: data.lat,
                lng: data.lng,
              },
            })
          }

          // Broadcast a todos los clientes observando este servicio
          const clientes = trackingClients.get(servicioId)
          if (clientes) {
            const mensaje = JSON.stringify({ type: 'ubicacion', data: payload })
            for (const cliente of clientes) {
              if (cliente !== connection && cliente.readyState === 1) {
                cliente.send(mensaje)
              }
            }
          }
        }
      } catch (err) {
        app.log.error(err, 'Error procesando mensaje WebSocket')
      }
    })

    connection.on('close', () => {
      trackingClients.get(servicioId)?.delete(connection)
      if (trackingClients.get(servicioId)?.size === 0) {
        trackingClients.delete(servicioId)
      }
    })
  })
}
