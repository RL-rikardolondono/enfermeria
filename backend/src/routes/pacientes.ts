import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { autenticar, requerirRol } from '../middleware/auth'

export async function pacientesRoutes(app: FastifyInstance) {

  // GET /api/pacientes/:id
  app.get('/:id', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const paciente = await prisma.paciente.findUnique({
      where: { id },
      include: { usuario: { select: { nombreCompleto: true, email: true, telefono: true, fotoUrl: true } } },
    })
    if (!paciente) return reply.status(404).send({ error: 'Paciente no encontrado' })
    return paciente
  })

  // PUT /api/pacientes/:id — Actualizar perfil
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
      latBase: z.number().optional(),
      lngBase: z.number().optional(),
      contactoEmergencia: z.object({
        nombre: z.string(),
        telefono: z.string(),
        parentesco: z.string(),
      }).optional(),
    }).parse(request.body)

    const actualizado = await prisma.paciente.update({
      where: { id },
      data: { ...body, fechaNacimiento: body.fechaNacimiento ? new Date(body.fechaNacimiento) : undefined },
    })
    return actualizado
  })

  // GET /api/pacientes/:id/historia
  app.get('/:id/historia', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const historia = await prisma.historiaClinica.findUnique({ where: { pacienteId: id } })
    if (!historia) {
      // Crear historia vacía si no existe
      return await prisma.historiaClinica.create({ data: { pacienteId: id } })
    }
    return historia
  })

  // PUT /api/pacientes/:id/historia
  app.put('/:id/historia', { preHandler: requerirRol('profesional', 'admin') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({
      antecedentesPersonales: z.any().optional(),
      antecedentesFamiliares: z.any().optional(),
      alergias: z.array(z.string()).optional(),
      diagnosticosActivos: z.any().optional(),
      medicacionCronica: z.any().optional(),
      cirugiasPrevia: z.any().optional(),
      habitos: z.any().optional(),
      notasAdicionales: z.string().optional(),
    }).parse(request.body)

    const historia = await prisma.historiaClinica.upsert({
      where: { pacienteId: id },
      update: { ...body, actualizadoEn: new Date(), actualizadoPor: request.usuario.id },
      create: { pacienteId: id, ...body, actualizadoPor: request.usuario.id },
    })
    return historia
  })

  // GET /api/pacientes/:id/evoluciones — historial de evoluciones
  app.get('/:id/evoluciones', { preHandler: autenticar }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { page = 1, limit = 10 } = z.object({
      page: z.coerce.number().default(1),
      limit: z.coerce.number().max(50).default(10),
    }).parse(request.query)

    const [total, items] = await prisma.$transaction([
      prisma.evolucion.count({ where: { pacienteId: id } }),
      prisma.evolucion.findMany({
        where: { pacienteId: id },
        orderBy: { fechaHora: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          profesional: { include: { usuario: { select: { nombreCompleto: true } } } },
          servicio: { select: { tipo: true, descripcion: true } },
        },
      }),
    ])

    return { total, page, limit, items }
  })
}
