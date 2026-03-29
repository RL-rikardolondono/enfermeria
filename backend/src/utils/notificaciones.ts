// utils/notificaciones.ts
import { prisma } from './prisma'
import { enviarNotificacionWS } from '../websocket/notificaciones'

interface NotifPayload {
  tipo: string
  titulo: string
  cuerpo: string
  datos?: object
}

export async function notificarUsuario(usuarioId: string, payload: NotifPayload) {
  // Guardar en DB
  await prisma.notificacion.create({
    data: {
      usuarioId,
      tipo: payload.tipo,
      titulo: payload.titulo,
      cuerpo: payload.cuerpo,
      datos: payload.datos ?? {},
    },
  })

  // Enviar por WebSocket si está conectado
  enviarNotificacionWS(usuarioId, { type: 'notificacion', ...payload })

  // Aquí se integraría Firebase Admin para push notifications
  // await firebaseAdmin.messaging().send({ token: fcmToken, notification: {...} })
}
