import { FastifyInstance } from 'fastify'

const notifClients = new Map<string, any>()

export async function notificacionesWS(app: FastifyInstance) {
  app.get('/:userId', { websocket: true }, async (connection, request) => {
    const { userId } = request.params as { userId: string }
    notifClients.set(userId, connection)
    connection.socket.send(JSON.stringify({ type: 'connected', message: 'Canal de notificaciones activo' }))
    connection.on('close', () => {
      notifClients.delete(userId)
    })
  })
}

export function enviarNotificacionWS(userId: string, payload: object) {
  const cliente = notifClients.get(userId)
  if (cliente && cliente.socket.readyState === 1) {
    cliente.socket.send(JSON.stringify(payload))
  }
}
