import { FastifyInstance } from 'fastify'
import { redis } from '../utils/redis'
import { prisma } from '../utils/prisma'

const trackingClients = new Map<string, Set<any>>()

export async function trackingWS(app: FastifyInstance) {
  app.get('/:servicioId', { websocket: true }, async (connection, request) => {
    const { servicioId } = request.params as { servicioId: string }

    if (!trackingClients.has(servicioId)) {
      trackingClients.set(servicioId, new Set())
    }
    trackingClients.get(servicioId)!.add(connection)

    const posActual = await redis.get(`ubicacion:profesional:${servicioId}`)
    if (posActual) {
      connection.socket.send(JSON.stringify({ type: 'ubicacion', data: JSON.parse(posActual) }))
    }

    connection.on('message', async (msg: Buffer) => {
      try {
        const data = JSON.parse(msg.toString())
        if (data.type === 'ubicacion' && data.lat && data.lng) {
          const payload = { lat: data.lat, lng: data.lng, timestamp: new Date().toISOString() }
          await redis.setex(`ubicacion:profesional:${servicioId}`, 3600, JSON.stringify(payload))
          const servicio = await prisma.servicio.findUnique({ where: { id: servicioId } })
          if (servicio?.profesionalId) {
            await prisma.trackingHistorial.create({
              data: { servicioId, profesionalId: servicio.profesionalId, lat: data.lat, lng: data.lng },
            })
          }
          const clientes = trackingClients.get(servicioId)
          if (clientes) {
            const mensaje = JSON.stringify({ type: 'ubicacion', data: payload })
            for (const cliente of clientes) {
              if (cliente !== connection && cliente.socket.readyState === 1) {
                cliente.socket.send(mensaje)
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
