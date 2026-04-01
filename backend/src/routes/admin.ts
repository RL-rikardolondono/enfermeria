import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { requerirRol } from '../middleware/auth'

export async function adminRoutes(app: FastifyInstance) {
  const preHandler = requerirRol('admin')

  // GET /api/admin/dashboard
  app.get('/dashboard', { preHandler }, async () => {
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0)

    const [serviciosHoy, serviciosActivos, profesionalesDisponibles, pendientesVerificacion, ingresosMes] = await prisma.$transaction([
      prisma.servicio.count({ where: { createdAt: { gte: hoy } } }),
      prisma.servicio.count({ where: { estado: { in: ['asignado', 'en_camino', 'en_curso'] } } }),
      prisma.profesional.count({ where: { disponible: true, estadoVerificacion: 'aprobado' } }),
      prisma.profesional.count({ where: { estadoVerificacion: 'pendiente' } }),
      prisma.pago.aggregate({
        where: { estado: 'aprobado', createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } },
        _sum: { monto: true },
      }),
    ])

    return { serviciosHoy, serviciosActivos, profesionalesDisponibles, pendientesVerificacion, ingresosMes: ingresosMes._sum.monto ?? 0 }
  })

  // GET /api/admin/usuarios
  app.get('/usuarios', { preHandler }, async (request) => {
    const { page = 1, limit = 20, rol } = z.object({
      page: z.coerce.number().default(1),
      limit: z.coerce.number().max(100).default(20),
      rol: z.string().optional(),
    }).parse(request.query)

    const where: any = rol ? { rol } : {}

    const [total, items] = await prisma.$transaction([
      prisma.usuario.count({ where }),
      prisma.usuario.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, nombreCompleto: true, email: true,
          telefono: true, rol: true, estado: true, createdAt: true,
        },
      }),
    ])

    return { total, page, limit, items }
  })

  // GET /api/admin/profesionales
  app.get('/profesionales', { preHandler }, async (request) => {
    const { page = 1, limit = 20, estado } = z.object({
      page: z.coerce.number().default(1),
      limit: z.coerce.number().max(100).default(20),
      estado: z.string().optional(),
    }).parse(request.query)

    const where: any = estado ? { estadoVerificacion: estado } : {}

    const [total, items] = await prisma.$transaction([
      prisma.profesional.count({ where }),
      prisma.profesional.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          usuario: { select: { nombreCompleto: true, email: true, telefono: true } },
          documentos: true,
        },
      }),
    ])

    return { total, page, limit, items }
  })

  // PUT /api/admin/profesionales/:id/verificar
  app.put('/profesionales/:id/verificar', { preHandler }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { estado } = z.object({
      estado: z.enum(['aprobado', 'rechazado']),
    }).parse(request.body)

    const actualizado = await prisma.profesional.update({
      where: { id },
      data: { estadoVerificacion: estado, verificadoEn: new Date() },
    })
    return actualizado
  })

  // GET /api/admin/servicios
  app.get('/servicios', { preHandler }, async (request) => {
    const { page = 1, limit = 20, estado } = z.object({
      page: z.coerce.number().default(1),
      limit: z.coerce.number().max(100).default(20),
      estado: z.string().optional(),
    }).parse(request.query)

    const where: any = estado ? { estado } : {}

    const [total, items] = await prisma.$transaction([
      prisma.servicio.count({ where }),
      prisma.servicio.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          paciente: { include: { usuario: { select: { nombreCompleto: true } } } },
          profesional: { include: { usuario: { select: { nombreCompleto: true } } } },
        },
      }),
    ])

    return { total, page, limit, items }
  })

  // PUT /api/admin/usuarios/:id/estado
  app.put('/usuarios/:id/estado', { preHandler }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { estado } = z.object({
      estado: z.enum(['activo', 'suspendido']),
    }).parse(request.body)

    const actualizado = await prisma.usuario.update({
      where: { id },
      data: { estado },
    })
    return actualizado
  })
}
