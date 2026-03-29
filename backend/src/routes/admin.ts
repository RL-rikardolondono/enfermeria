import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { requerirRol } from '../middleware/auth'
import { notificarUsuario } from '../utils/notificaciones'

export async function adminRoutes(app: FastifyInstance) {
  const preHandler = requerirRol('admin')

  // GET /api/admin/dashboard
  app.get('/dashboard', { preHandler }, async () => {
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0)
    const [
      serviciosHoy, serviciosActivos, profesionalesDisponibles,
      pendientesVerificacion, ingresosMes
    ] = await prisma.$transaction([
      prisma.servicio.count({ where: { createdAt: { gte: hoy } } }),
      prisma.servicio.count({ where: { estado: { in: ['asignado', 'en_camino', 'en_curso'] } } }),
      prisma.profesional.count({ where: { disponible: true, estadoVerificacion: 'aprobado' } }),
      prisma.profesional.count({ where: { estadoVerificacion: 'pendiente' } }),
      prisma.pago.aggregate({
        where: { estado: 'aprobado', createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } },
        _sum: { monto: true },
      }),
    ])

    return {
      serviciosHoy,
      serviciosActivos,
      profesionalesDisponibles,
      pendientesVerificacion,
      ingresosMes: ingresosMes._sum.monto ?? 0,
    }
  })

  // GET /api/admin/servicios
  app.get('/servicios', { preHandler }, async (request) => {
    const { estado, page = 1, limit = 30 } = z.object({
      estado: z.string().optional(),
      page: z.coerce.number().default(1),
      limit: z.coerce.number().max(100).default(30),
    }).parse(request.query)

    const where = estado ? { estado: estado as any } : {}
    const [total, items] = await prisma.$transaction([
      prisma.servicio.count({ where }),
      prisma.servicio.findMany({
        where, orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit, take: limit,
        include: {
          paciente: { include: { usuario: { select: { nombreCompleto: true, telefono: true } } } },
          profesional: { include: { usuario: { select: { nombreCompleto: true } } } },
        },
      }),
    ])
    return { total, page, limit, items }
  })

  // GET /api/admin/profesionales/verificacion
  app.get('/profesionales/verificacion', { preHandler }, async () => {
    return prisma.profesional.findMany({
      where: { estadoVerificacion: 'pendiente' },
      include: {
        usuario: { select: { nombreCompleto: true, email: true, telefono: true } },
        documentos: true,
      },
      orderBy: { createdAt: 'asc' },
    })
  })

  // POST /api/admin/profesionales/:id/aprobar
  app.post('/profesionales/:id/aprobar', { preHandler }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { aprobado, motivo } = z.object({
      aprobado: z.boolean(),
      motivo: z.string().optional(),
    }).parse(request.body)

    const profesional = await prisma.profesional.update({
      where: { id },
      data: {
        estadoVerificacion: aprobado ? 'aprobado' : 'rechazado',
        verificadoPor: request.usuario.id,
        verificadoEn: new Date(),
      },
      include: { usuario: true },
    })

    await notificarUsuario(profesional.usuarioId, {
      tipo: aprobado ? 'verificacion_aprobada' : 'verificacion_rechazada',
      titulo: aprobado ? 'Verificación aprobada' : 'Verificación rechazada',
      cuerpo: aprobado
        ? 'Tu perfil ha sido verificado. Ya puedes recibir solicitudes.'
        : `Tu verificación fue rechazada. ${motivo ?? ''}`,
      datos: { motivo },
    })

    return profesional
  })

  // GET /api/admin/reportes
  app.get('/reportes', { preHandler }, async (request) => {
    const { desde, hasta } = z.object({
      desde: z.string().default(() => {
        const d = new Date(); d.setMonth(d.getMonth() - 1); return d.toISOString()
      }),
      hasta: z.string().default(() => new Date().toISOString()),
    }).parse(request.query)

    const rango = { gte: new Date(desde), lte: new Date(hasta) }

    const [porEstado, porTipo, pagos, topProfesionales] = await prisma.$transaction([
      prisma.servicio.groupBy({
        by: ['estado'], where: { createdAt: rango }, _count: true,
      }),
      prisma.servicio.groupBy({
        by: ['tipo'], where: { createdAt: rango }, _count: true,
      }),
      prisma.pago.aggregate({
        where: { createdAt: rango, estado: 'aprobado' },
        _sum: { monto: true }, _count: true, _avg: { monto: true },
      }),
      prisma.profesional.findMany({
        where: { estadoVerificacion: 'aprobado' },
        orderByX: { totalServicios: 'desc' },
        take: 10,
        include: { usuario: { select: { nombreCompleto: true } } },
        select: {
          id: true, calificacionPromedio: true, totalServicios: true,
          usuario: { select: { nombreCompleto: true } },
        },
      }),
    ])

    return { porEstado, porTipo, pagos, topProfesionales, rango: { desde, hasta } }
  })
}
