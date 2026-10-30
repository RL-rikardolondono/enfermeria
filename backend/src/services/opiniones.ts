import { prisma } from '../utils/prisma'

// Solo mes y año, para que la opinión no se pueda ligar a un paciente por la fecha
function mesDe(d: Date | null) { if (!d) return null; const x = new Date(d); return x.getUTCFullYear() + '-' + String(x.getUTCMonth() + 1).padStart(2, '0') }

// Opiniones de los pacientes sobre un profesional (sin nombres de pacientes).
// Los comentarios que la IPS ocultó no se muestran, pero sus estrellas sí cuentan en el promedio.
export async function opinionesDe(profesionalId: string, cuantas = 5) {
  const [agg, items] = await prisma.$transaction([
    prisma.servicio.aggregate({
      where: { profesionalId, calificacion: { not: null } },
      _count: { calificacion: true },
      _avg: { calificacion: true },
    }),
    prisma.servicio.findMany({
      where: { profesionalId, calificacion: { not: null }, resenaOculta: false, comentarioCalificacion: { not: null } },
      orderBy: [{ calificadoEn: { sort: 'desc', nulls: 'last' } }, { fechaFin: 'desc' }],
      take: cuantas,
      select: { calificacion: true, comentarioCalificacion: true, calificadoEn: true, fechaFin: true },
    }),
  ])
  return {
    total: agg._count.calificacion,
    promedio: agg._avg.calificacion == null ? null : Math.round(agg._avg.calificacion * 10) / 10,
    items: items.map((i: (typeof items)[number]) => ({ estrellas: i.calificacion, comentario: i.comentarioCalificacion, fecha: mesDe(i.calificadoEn || i.fechaFin) })),
  }
}

// Recalcula el promedio guardado en el perfil del profesional
export async function recalcularPromedio(profesionalId: string) {
  const agg = await prisma.servicio.aggregate({
    where: { profesionalId, calificacion: { not: null } },
    _avg: { calificacion: true },
  })
  await prisma.profesional.update({
    where: { id: profesionalId },
    data: { calificacionPromedio: agg._avg.calificacion == null ? null : Math.round(agg._avg.calificacion * 100) / 100 },
  })
}
