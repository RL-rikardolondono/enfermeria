import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { autenticar } from '../middleware/auth'

export async function pacientesRoutes(app: FastifyInstance) {

  // GET /api/pacientes/:id
  app.get('/:id', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const paciente = await prisma.paciente.findUnique({
      where: { id },
      include: {
        usuario: {
          select: {
            nombreCompleto: true,
            email: true,
            telefono: true,
            fotoUrl: true,
          },
        },
      },
    })
    if (!paciente) return reply.status(404).send({ error: 'Paciente no encontrado' })
    return paciente
  })

  // PUT /api/pacientes/:id
  app.put('/:id', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({
      documentoTipo: z.string().optional(),
      documentoNumero: z.string().optional(),
      fechaNacimiento: z.string().optional(),
      tipoSangre: z.string().optional(),
      eps: z.string().optional(),
      regimen: z.string().optional(),
      direccionBase: z.string().optional(),
      ciudad: z.string().optional(),
      barrio: z.string().optional(),
      latBase: z.number().optional(),
      lngBase: z.number().optional(),
      contactoEmergenciaNombre: z.string().optional(),
      contactoEmergenciaTelefono: z.string().optional(),
      contactoEmergenciaRelacion: z.string().optional(),
      alergias: z.string().optional(),
      antecedentes: z.string().optional(),
      observaciones: z.string().optional(),
    }).parse(request.body)

    const actualizado = await prisma.paciente.update({
      where: { id },
      data: {
        ...body,
        fechaNacimiento: body.fechaNacimiento ? new Date(body.fechaNacimiento) : undefined,
      },
    })
    return actualizado
  })

  // GET /api/pacientes/:id/evoluciones
  app.get('/:id/evoluciones', { preHandler: autenticar }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { page = 1, limit = 10 } = z.object({
      page: z.coerce.number().default(1),
      limit: z.coerce.number().max(50).default(10),
    }).parse(request.query)

    const [total, items] = await prisma.$transaction([
      prisma.evolucion.count({ where: { servicioId: id } }),
      prisma.evolucion.findMany({
        where: { servicioId: id },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          profesional: {
            include: {
              usuario: { select: { nombreCompleto: true } },
            },
          },
          servicio: { select: { tipo: true, descripcion: true } },
        },
      }),
    ])

    return { total, page, limit, items }
  })
}
