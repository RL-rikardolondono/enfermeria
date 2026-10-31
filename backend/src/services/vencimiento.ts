import { prisma } from '../utils/prisma'
import { marcarCambio } from '../utils/cambios'
import { marcarReembolso, PAGO_OBLIGATORIO } from './liquidacion'
import { cerrarTurnosVencidos } from './presencia'
import { revisarVencimientos } from './catalogo'

// El paciente necesita atención pronto: si en 10 minutos no eligió a ningún profesional
// (porque nadie se ofreció), la solicitud se cierra sola y se le avisa de inmediato.
// Si un profesional se ofrece a último momento, el paciente tiene al menos 3 minutos más para elegir.
export const MINUTOS_BUSQUEDA = 10
export const MINUTOS_EXTRA_OFERTA = 3
export const MOTIVO_SIN_PROFESIONAL = 'Ningún profesional pudo atenderle en este momento. No se le cobró nada; si ya había pagado, se le devuelve el 100 %.'

export const finBusqueda = () => new Date(Date.now() + MINUTOS_BUSQUEDA * 60 * 1000)

// Solicitudes que siguen buscando profesional
export function buscandoVigente(ahora = new Date()) {
  return {
    estado: 'pendiente' as const,
    OR: [
      { buscandoHasta: { gt: ahora } },
      { buscandoHasta: null, fechaSolicitud: { gt: new Date(ahora.getTime() - MINUTOS_BUSQUEDA * 60 * 1000) } },
    ],
  }
}

let ultimaRevision = 0
let ultimaLimpieza = 0

// Borra sesiones vencidas o abandonadas (una vez por hora) para que la tabla no crezca con los años
async function limpiarSesiones() {
  if (Date.now() - ultimaLimpieza < 60 * 60 * 1000) return
  ultimaLimpieza = Date.now()
  await prisma.sesion.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date() } }, { ultimoUso: { lt: new Date(Date.now() - 24 * 3600 * 1000) } }] },
  }).catch(() => {})
}

// Se ejecuta como máximo cada 20 segundos, solo cuando alguien usa la app (no despierta la base por sí sola)
export async function vencerPendientesAntiguas(forzar = false): Promise<void> {
  if (!forzar && Date.now() - ultimaRevision < 20 * 1000) return
  ultimaRevision = Date.now()
  await limpiarSesiones()
  await cerrarTurnosVencidos().catch(() => {})
  await revisarVencimientos().catch((e) => console.error('No se pudieron revisar los vencimientos de documentos', e))
  try {
    const ahora = new Date()
    const viejos = await prisma.servicio.findMany({
      where: {
        estado: 'pendiente',
        OR: [
          { buscandoHasta: { lte: ahora } },
          { buscandoHasta: null, fechaSolicitud: { lte: new Date(ahora.getTime() - MINUTOS_BUSQUEDA * 60 * 1000) } },
        ],
      },
      select: { id: true },
      take: 500,
    })
    // Con pagos activos: si el paciente eligió pero no pagó en 15 minutos, el profesional queda libre
    if (PAGO_OBLIGATORIO) {
      const sinPago = await prisma.servicio.findMany({
        where: { estado: 'asignado', buscandoHasta: { lte: ahora }, OR: [{ pago: { is: null } }, { pago: { is: { estado: { not: 'aprobado' } } } }] },
        select: { id: true }, take: 200,
      })
      for (const s of sinPago) {
        const r = await prisma.$transaction(async (tx: any) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'pago:' + s.id}))::text`
          const u = await tx.servicio.updateMany({
            where: { id: s.id, estado: 'asignado', buscandoHasta: { lte: new Date() }, OR: [{ pago: { is: null } }, { pago: { is: { estado: { not: 'aprobado' } } } }] },
            data: { estado: 'cancelado', notas: 'Se canceló porque el pago no se completó a tiempo. El profesional quedó libre.', buscandoHasta: null },
          })
          if (u.count) await marcarReembolso(s.id, tx)
          return u
        })
        if (r.count) marcarCambio()
      }
    }
    if (!viejos.length) return
    for (const s of viejos) {
      // Mismo candado que la confirmación de pagos: un pago que llega justo ahora queda marcado para devolver
      await prisma.$transaction(async (tx: any) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'pago:' + s.id}))::text`
        const r = await tx.servicio.updateMany({
          where: { id: s.id, estado: 'pendiente' },
          data: { estado: 'cancelado', notas: MOTIVO_SIN_PROFESIONAL, buscandoHasta: null },
        })
        if (r.count) {
          await tx.oferta.updateMany({ where: { servicioId: s.id, estado: 'activa' }, data: { estado: 'vencida' } })
          await marcarReembolso(s.id, tx)
        }
      })
    }
    marcarCambio()
  } catch (e) {
    console.error('No se pudieron cerrar las solicitudes vencidas', e)
  }
}
