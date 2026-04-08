import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { autenticar, requerirRol } from '../middleware/auth'

export async function profesionalesRoutes(app: FastifyInstance) {

  // GET /api/profesionales/mi-perfil — perfil del profesional logueado con estado real
  app.get('/mi-perfil', { preHandler: autenticar }, async (request, reply) => {
    const profesional = await prisma.profesional.findUnique({
      where: { usuarioId: request.usuario.id },
      include: {
        usuario: {
          select: { nombreCompleto: true, email: true, telefono: true, fotoUrl: true },
        },
      },
    })
    if (!profesional) return reply.status(404).send({ error: 'Perfil no encontrado' })
    return profesional
  })

  // GET /api/profesionales — listar profesionales activos
  app.get('/', { preHandler: autenticar }, async (request) => {
    const { page = 1, limit = 20 } = z.object({
      page: z.coerce.number().default(1),
      limit: z.coerce.number().max(50).default(20),
    }).parse(request.query)

    const [total, items] = await prisma.$transaction([
      prisma.profesional.count({ where: { activo: true } }),
      prisma.profesional.findMany({
        where: { activo: true },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          usuario: {
            select: { nombreCompleto: true, email: true, telefono: true, fotoUrl: true },
          },
        },
      }),
    ])

    return { total, page, limit, items }
  })

  // GET /api/profesionales/:id
  app.get('/:id', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const profesional = await prisma.profesional.findUnique({
      where: { id },
      include: {
        usuario: {
          select: { nombreCompleto: true, email: true, telefono: true, fotoUrl: true },
        },
        documentos: true,
      },
    })
    if (!profesional) return reply.status(404).send({ error: 'Profesional no encontrado' })
    return profesional
  })

  // PUT /api/profesionales/:id — actualizar perfil
  app.put('/:id', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({
      especialidad: z.string().optional(),
      registroProfesional: z.string().optional(),
      tarifaHora: z.number().optional(),
      anosExperiencia: z.number().optional(),
      banco: z.string().optional(),
      cuentaBancaria: z.string().optional(),
      tipoCuenta: z.string().optional(),
      lat: z.number().optional(),
      lng: z.number().optional(),
      disponible: z.boolean().optional(),
    }).parse(request.body)

    const actualizado = await prisma.profesional.update({
      where: { id },
      data: body,
    })
    return actualizado
  })

  // PUT /api/profesionales/:id/disponibilidad
  app.put('/:id/disponibilidad', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { disponible, lat, lng } = z.object({
      disponible: z.boolean(),
      lat: z.number().optional(),
      lng: z.number().optional(),
    }).parse(request.body)

    const actualizado = await prisma.profesional.update({
      where: { id },
      data: { disponible, lat, lng },
    })
    return actualizado
  })

  // PUT /api/profesionales/:id/verificar — admin aprueba o rechaza
  app.put('/:id/verificar', { preHandler: requerirRol('admin') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { estado } = z.object({
      estado: z.enum(['aprobado', 'rechazado']),
    }).parse(request.body)

    const actualizado = await prisma.profesional.update({
      where: { id },
      data: {
        estadoVerificacion: estado,
        verificadoPor: request.usuario.id,
        verificadoEn: new Date(),
      },
    })
    return actualizado
  })

  // GET /api/profesionales/:id/servicios
  app.get('/:id/servicios', { preHandler: autenticar }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { page = 1, limit = 10 } = z.object({
      page: z.coerce.number().default(1),
      limit: z.coerce.number().max(50).default(10),
    }).parse(request.query)

    const [total, items] = await prisma.$transaction([
      prisma.servicio.count({ where: { profesionalId: id } }),
      prisma.servicio.findMany({
        where: { profesionalId: id },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          paciente: {
            include: {
              usuario: { select: { nombreCompleto: true, telefono: true } },
            },
          },
        },
      }),
    ])

    return { total, page, limit, items }
  })
}
