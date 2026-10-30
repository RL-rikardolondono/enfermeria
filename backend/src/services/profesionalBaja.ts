import { prisma } from '../utils/prisma'
import { marcarCambio } from '../utils/cambios'
import { finBusqueda } from './vencimiento'

// Cuando un profesional deja de estar aprobado o se suspende su cuenta, sus servicios aún no iniciados
// vuelven a buscar profesional (10 minutos nuevos) y sus ofertas se retiran.
export async function liberarServiciosDe(profesionalId: string) {
  await prisma.profesional.update({ where: { id: profesionalId }, data: { disponible: false, ignoradas: 0 } })
  const reabiertos = await prisma.servicio.findMany({ where: { profesionalId, estado: { in: ['asignado', 'en_camino'] } }, select: { id: true } })
  for (const s of reabiertos) {
    await prisma.$transaction(async (tx: any) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'pago:' + s.id}))::text`
      await tx.servicio.updateMany({
        where: { id: s.id, profesionalId, estado: { in: ['asignado', 'en_camino'] } },
        data: { estado: 'pendiente', profesionalId: null, fechaSolicitud: new Date(), buscandoHasta: finBusqueda() },
      })
    })
  }
  await prisma.oferta.updateMany({ where: { profesionalId, estado: 'activa' }, data: { estado: 'retirada' } })
  await prisma.oferta.updateMany({ where: { profesionalId, estado: 'elegida', servicio: { estado: 'pendiente' } }, data: { estado: 'desistio' } })
  marcarCambio()
  // Un servicio que ya estaba en curso no se puede pasar a otro: la IPS recibe la alerta para cerrarlo
  const enCurso = await prisma.servicio.findMany({ where: { profesionalId, estado: 'en_curso' }, select: { id: true } })
  if (enCurso.length) {
    const { crearQueja } = await import('./quejas')
    for (const s of enCurso) {
      await crearQueja({ servicioId: s.id, usuarioId: 'sistema', profesionalId, texto: 'El profesional fue suspendido o retirado con este servicio EN CURSO. La IPS debe comunicarse con el paciente y cerrarlo (nota clínica y completar).' }).catch(() => {})
    }
  }
  // Avisar a los demás profesionales que esas solicitudes necesitan a alguien
  const { avisarBusquedaReabierta } = await import('../routes/servicios')
  for (const s of reabiertos) setImmediate(() => { avisarBusquedaReabierta(s.id, [profesionalId]).catch(() => {}) })
}
