import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { autenticar } from '../middleware/auth'

// Datos clínicos y de contacto que el titular puede registrar para cada paciente
const datosPaciente = {
  documentoTipo: z.string().max(50).optional(),
  documentoNumero: z.string().max(50).optional(),
  fechaNacimiento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)')
    .refine((v) => !isNaN(Date.parse(v)) && new Date(v) <= new Date(), 'Fecha inválida').optional(),
  genero: z.string().max(20).optional(),
  tipoSangre: z.string().max(5).optional(),
  eps: z.string().max(100).optional(),
  regimen: z.string().max(50).optional(),
  direccionBase: z.string().max(500).optional(),
  ciudad: z.string().max(100).optional(),
  barrio: z.string().max(100).optional(),
  latBase: z.number().min(-90).max(90).optional(),
  lngBase: z.number().min(-180).max(180).optional(),
  contactoEmergenciaNombre: z.string().max(200).optional(),
  contactoEmergenciaTelefono: z.string().max(20).optional(),
  contactoEmergenciaRelacion: z.string().max(50).optional(),
  alergias: z.string().max(3000).optional(),
  antecedentes: z.string().max(3000).optional(),
  medicamentosActuales: z.string().max(3000).optional(),
  condicionesCronicas: z.string().max(3000).optional(),
  observaciones: z.string().max(3000).optional(),
}

// ¿Puede este usuario ver al paciente? Titular de la cuenta, administrador,
// o profesional que tenga o haya tenido un servicio asignado con él.
async function puedeVer(usuario: { id: string; rol: string }, pacienteId: string, usuarioIdTitular: string) {
  if (usuario.rol === 'admin' || usuario.id === usuarioIdTitular) return true
  if (usuario.rol !== 'profesional') return false
  const asignado = await prisma.servicio.findFirst({
    where: {
      pacienteId,
      profesional: { usuarioId: usuario.id, estadoVerificacion: 'aprobado' },
      OR: [
        { estado: { in: ['asignado', 'en_camino', 'en_curso'] } },
        { fechaFin: { gt: new Date(Date.now() - 30 * 24 * 3600 * 1000) } },
      ],
    },
    select: { id: true },
  })
  return !!asignado
}

export async function pacientesRoutes(app: FastifyInstance) {

  // GET /api/pacientes/bloqueos — profesionales que esta cuenta no quiere que la vuelvan a atender
  app.get('/bloqueos', { preHandler: autenticar }, async (request) => {
    const items = await prisma.bloqueo.findMany({
      where: { usuarioId: request.usuario.id },
      orderBy: { createdAt: 'desc' },
      select: { profesionalId: true, createdAt: true, profesional: { select: { especialidad: true, usuario: { select: { nombreCompleto: true } } } } },
    })
    return {
      items: items.map((b: (typeof items)[number]) => ({
        profesionalId: b.profesionalId, desde: b.createdAt,
        nombre: b.profesional.usuario.nombreCompleto, especialidad: b.profesional.especialidad,
      })),
    }
  })

  // DELETE /api/pacientes/bloqueos/:profesionalId — volver a permitir a ese profesional
  app.delete('/bloqueos/:profesionalId', { preHandler: autenticar }, async (request) => {
    const { profesionalId } = z.object({ profesionalId: z.string().uuid() }).parse(request.params)
    await prisma.bloqueo.deleteMany({ where: { usuarioId: request.usuario.id, profesionalId } })
    return { ok: true }
  })

  // GET /api/pacientes/mios — pacientes que gestiona la cuenta (titular + familiares)
  app.get('/mios', { preHandler: autenticar }, async (request) => {
    const items = await prisma.paciente.findMany({
      where: { usuarioId: request.usuario.id, activo: true },
      orderBy: [{ esTitular: 'desc' }, { createdAt: 'asc' }],
      include: { usuario: { select: { nombreCompleto: true } } },
    })
    return {
      items: items.map((p: (typeof items)[number]) => ({
        ...p,
        nombreCompleto: p.nombreCompleto || p.usuario.nombreCompleto,
      })),
    }
  })

  // POST /api/pacientes — agregar un familiar u otra persona a cargo
  app.post('/', { preHandler: autenticar }, async (request, reply) => {
    if (request.usuario.rol !== 'paciente') {
      return reply.status(403).send({ error: 'Solo las cuentas de pacientes pueden agregar pacientes' })
    }
    const body = z.object({
      nombreCompleto: z.string().min(3).max(200),
      parentesco: z.string().min(2).max(50),
      ...datosPaciente,
    }).parse(request.body)

    const usuarioId = request.usuario.id
    // Conteo y creación juntos para que dos envíos simultáneos no pasen del límite
    const paciente = await prisma.$transaction(async (tx: any) => {
      const total = await tx.paciente.count({ where: { usuarioId, activo: true } })
      if (total >= 10) return null
      return tx.paciente.create({
        data: {
          ...body,
          usuarioId,
          esTitular: false,
          fechaNacimiento: body.fechaNacimiento ? new Date(body.fechaNacimiento) : undefined,
        },
      })
    })
    if (!paciente) return reply.status(400).send({ error: 'Máximo 10 pacientes por cuenta' })
    return reply.status(201).send(paciente)
  })

  // GET /api/pacientes/:id
  app.get('/:id', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const paciente = await prisma.paciente.findUnique({
      where: { id },
      include: {
        usuario: { select: { nombreCompleto: true, email: true, telefono: true, fotoUrl: true } },
      },
    })
    if (!paciente || !(await puedeVer(request.usuario, id, paciente.usuarioId))) {
      return reply.status(404).send({ error: 'Paciente no encontrado' })
    }
    const verCorreo = request.usuario.rol === 'admin' || paciente.usuarioId === request.usuario.id
    return { ...paciente, nombreCompleto: paciente.nombreCompleto || paciente.usuario.nombreCompleto, usuario: { ...paciente.usuario, email: verCorreo ? paciente.usuario.email : undefined } }
  })

  // PUT /api/pacientes/:id — solo el titular de la cuenta o un administrador
  app.put('/:id', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({
      nombreCompleto: z.string().min(3).max(200).optional(),
      parentesco: z.string().min(2).max(50).optional(),
      ...datosPaciente,
    }).parse(request.body)

    const paciente = await prisma.paciente.findUnique({ where: { id }, select: { usuarioId: true } })
    if (!paciente || (request.usuario.rol !== 'admin' && paciente.usuarioId !== request.usuario.id)) {
      return reply.status(404).send({ error: 'Paciente no encontrado' })
    }

    const actualizado = await prisma.paciente.update({
      where: { id },
      data: {
        ...body,
        fechaNacimiento: body.fechaNacimiento ? new Date(body.fechaNacimiento) : undefined,
      },
    })
    return actualizado
  })

  // DELETE /api/pacientes/:id — retira a un familiar de la cuenta (conserva su historia clínica)
  app.delete('/:id', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const paciente = await prisma.paciente.findUnique({ where: { id }, select: { usuarioId: true, esTitular: true } })
    if (!paciente || paciente.usuarioId !== request.usuario.id) {
      return reply.status(404).send({ error: 'Paciente no encontrado' })
    }
    if (paciente.esTitular) return reply.status(400).send({ error: 'No se puede retirar al titular de la cuenta' })
    await prisma.paciente.update({ where: { id }, data: { activo: false } })
    return { ok: true }
  })

  // GET /api/pacientes/:id/evoluciones — :id es el id del servicio
  app.get('/:id/evoluciones', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { page, limit } = z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(50).default(10),
    }).parse(request.query)

    const servicio = await prisma.servicio.findUnique({
      where: { id },
      select: { pacienteId: true, profesionalId: true, paciente: { select: { usuarioId: true } }, recibido: true },
    })
    if (servicio && request.usuario.rol === 'profesional') {
      const yo = await prisma.profesional.findUnique({ where: { usuarioId: request.usuario.id }, select: { id: true } })
      if (!yo || servicio.profesionalId !== yo.id) return reply.status(404).send({ error: 'Servicio no encontrado' })
    }
    if (!servicio || !servicio.pacienteId || !servicio.paciente ||
        !(await puedeVer(request.usuario, servicio.pacienteId, servicio.paciente.usuarioId))) {
      return reply.status(404).send({ error: 'Servicio no encontrado' })
    }

    const [total, items] = await prisma.$transaction([
      prisma.evolucion.count({ where: { servicioId: id } }),
      prisma.evolucion.findMany({
        where: { servicioId: id },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          profesional: { select: { especialidad: true, usuario: { select: { nombreCompleto: true } } } },
          servicio: { select: { tipo: true, descripcion: true } },
        },
      }),
    ])

    const recibido = servicio.recibido
      ? { firma: servicio.recibido.firma, nombre: servicio.recibido.nombre, motivo: servicio.recibido.motivo, fecha: servicio.recibido.createdAt }
      : null
    return { total, page, limit, items, recibido }
  })
}
