import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { autenticar, requerirRol } from '../middleware/auth'
import { calcularTarifa } from '../services/tarifas'
import { notificarProfesionalesDisponibles } from './push'
import { liberarPago, marcarReembolso, PAGO_OBLIGATORIO } from '../services/liquidacion'
import { APP_URL } from '../utils/config'

export async function serviciosRoutes(app: FastifyInstance) {

  // POST /api/servicios — crear solicitud
  app.post('/', { preHandler: autenticar }, async (request, reply) => {
    const body = z.object({
      tipo: z.string().min(1),
      descripcion: z.string().min(1).max(500),
      direccion: z.string().min(1),
      lat: z.number().optional(),
      lng: z.number().optional(),
      pacienteId: z.string().uuid().optional(),
    }).parse(request.body)

    // Paciente elegido (debe pertenecer a la cuenta) o, si no se indica, el titular
    const paciente = await prisma.paciente.findFirst({
      where: body.pacienteId
        ? { id: body.pacienteId, usuarioId: request.usuario.id, activo: true }
        : { usuarioId: request.usuario.id, activo: true },
      orderBy: [{ esTitular: 'desc' }, { createdAt: 'asc' }],
      include: { usuario: { select: { nombreCompleto: true } } },
    })
    if (!paciente) return reply.status(404).send({ error: 'Paciente no encontrado en su cuenta' })

    const monto = await calcularTarifa(body.tipo)

    const servicio = await prisma.servicio.create({
      data: {
        pacienteId: paciente.id,
        tipo: body.tipo as any,
        descripcion: body.descripcion,
        direccion: body.direccion,
        lat: body.lat,
        lng: body.lng,
        monto,
        estado: 'pendiente',
      },
    })

    // Notificar a profesionales aprobados via push (sin bloquear respuesta)
    // Notificar en segundo plano sin bloquear
    setImmediate(() => {
      notificarProfesionalesDisponibles({
        titulo: '🏥 Nueva solicitud de servicio',
        cuerpo: (paciente.nombreCompleto || paciente.usuario?.nombreCompleto || 'Un paciente') + ' solicita ' + body.tipo + ' en ' + body.direccion,
        url: `${APP_URL}/app-enfermero.html`,
      }).catch(() => {})
    })

    return reply.status(201).send({
      id: servicio.id,
      estado: servicio.estado,
      monto: servicio.monto,
      mensaje: 'Solicitud creada. Buscando profesional disponible...',
    })
  })

  // GET /api/servicios — listar servicios del usuario
  app.get('/', { preHandler: autenticar }, async (request) => {
    const { page = 1, limit = 10 } = z.object({
      page: z.coerce.number().default(1),
      limit: z.coerce.number().max(50).default(10),
    }).parse(request.query)

    const usuario = request.usuario
    let where: any = {}

    if (usuario.rol === 'paciente') {
      where = { paciente: { usuarioId: usuario.id } }
    } else if (usuario.rol === 'profesional') {
      const profesional = await prisma.profesional.findUnique({ where: { usuarioId: usuario.id } })
      if (profesional) where = { profesionalId: profesional.id }
    } else if (usuario.rol === 'admin') {
      where = {}
    }

    const [total, items] = await prisma.$transaction([
      prisma.servicio.count({ where }),
      prisma.servicio.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          paciente: {
            include: { usuario: { select: { nombreCompleto: true, telefono: true } } },
          },
          profesional: {
            include: { usuario: { select: { nombreCompleto: true, telefono: true } } },
          },
          pago: true,
        },
      }),
    ])

    return { total, page, limit, items }
  })

  // GET /api/servicios/pendientes — solo profesionales APROBADOS
  app.get('/pendientes', { preHandler: requerirRol('profesional', 'admin') }, async (request, reply) => {
    if (request.usuario.rol === 'profesional') {
      const profesional = await prisma.profesional.findUnique({
        where: { usuarioId: request.usuario.id },
      })
      if (!profesional || profesional.estadoVerificacion !== 'aprobado') {
        return reply.status(403).send({
          error: 'Su cuenta aún no ha sido verificada por Reina Elizabeth IPS.',
        })
      }
    }

    const { page = 1, limit = 20 } = z.object({
      page: z.coerce.number().default(1),
      limit: z.coerce.number().max(50).default(20),
    }).parse(request.query)

    const wherePendientes: any = PAGO_OBLIGATORIO
      ? { estado: 'pendiente', pago: { is: { estado: 'aprobado' } } }
      : { estado: 'pendiente' }

    const [total, items] = await prisma.$transaction([
      prisma.servicio.count({ where: wherePendientes }),
      prisma.servicio.findMany({
        where: wherePendientes,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          paciente: {
            include: { usuario: { select: { nombreCompleto: true, telefono: true } } },
          },
        },
      }),
    ])

    return { total, page, limit, items }
  })

  // GET /api/servicios/:id
  app.get('/:id', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const servicio = await prisma.servicio.findUnique({
      where: { id },
      include: {
        paciente: {
          include: { usuario: { select: { nombreCompleto: true, telefono: true } } },
        },
        profesional: {
          include: { usuario: { select: { nombreCompleto: true, telefono: true } } },
        },
        evoluciones: true,
        pago: true,
      },
    })
    if (!servicio) return reply.status(404).send({ error: 'Servicio no encontrado' })
    return servicio
  })

  // PUT /api/servicios/:id/estado
  app.put('/:id/estado', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { estado } = z.object({
      estado: z.enum(['asignado', 'en_camino', 'en_curso', 'completado', 'cancelado']),
    }).parse(request.body)
    const { rol, id: usuarioId } = request.usuario

    const servicio = await prisma.servicio.findUnique({
      where: { id },
      include: { pago: true, paciente: { select: { usuarioId: true } }, _count: { select: { evoluciones: true } } },
    })
    if (!servicio) return reply.status(404).send({ error: 'Servicio no encontrado' })
    if (['completado', 'cancelado'].includes(servicio.estado)) {
      return reply.status(400).send({ error: 'El servicio ya está cerrado' })
    }

    const profesional = rol === 'profesional'
      ? await prisma.profesional.findUnique({ where: { usuarioId } })
      : null
    const esSuProfesional = !!profesional && servicio.profesionalId === profesional.id

    // ── Profesional ──────────────────────────────────────────────
    if (rol === 'profesional') {
      if (!profesional || profesional.estadoVerificacion !== 'aprobado') {
        return reply.status(403).send({ error: 'Su cuenta no está verificada.' })
      }

      if (estado === 'asignado') {
        if (PAGO_OBLIGATORIO && servicio.pago?.estado !== 'aprobado') {
          return reply.status(409).send({ error: 'El paciente aún no ha pagado este servicio' })
        }
        // Solo uno puede tomarlo: se asigna si sigue pendiente
        const r = await prisma.servicio.updateMany({
          where: { id, estado: 'pendiente' },
          data: { estado: 'asignado', profesionalId: profesional.id },
        })
        if (r.count === 0) return reply.status(409).send({ error: 'Otro profesional ya tomó este servicio' })
        return prisma.servicio.findUnique({ where: { id } })
      }

      if (estado === 'cancelado') {
        // Rechazar una solicitud pendiente no la cancela para el paciente
        if (servicio.estado === 'pendiente') return { ok: true, mensaje: 'Solicitud descartada' }
        if (!esSuProfesional) return reply.status(403).send({ error: 'Este servicio no está asignado a usted' })
        // Si el profesional asignado desiste, el servicio vuelve a quedar disponible
        return prisma.servicio.update({ where: { id }, data: { estado: 'pendiente', profesionalId: null } })
      }

      if (!esSuProfesional) return reply.status(403).send({ error: 'Este servicio no está asignado a usted' })
      if (estado === 'completado' && servicio._count.evoluciones === 0) {
        return reply.status(400).send({ error: 'Registre la nota clínica antes de finalizar el servicio' })
      }
    }

    // ── Paciente: solo puede cancelar sus propios servicios antes de la visita ──
    if (rol === 'paciente') {
      if (servicio.paciente?.usuarioId !== usuarioId) return reply.status(404).send({ error: 'Servicio no encontrado' })
      if (estado !== 'cancelado') return reply.status(403).send({ error: 'Acción no permitida' })
      if (['en_curso'].includes(servicio.estado)) {
        return reply.status(400).send({ error: 'La visita ya comenzó; comuníquese con la IPS' })
      }
    }

    if (rol === 'admin' && estado === 'completado' && servicio._count.evoluciones === 0) {
      return reply.status(400).send({ error: 'El servicio no tiene nota clínica registrada' })
    }

    const actualizado = await prisma.servicio.update({
      where: { id },
      data: {
        estado,
        fechaInicio: estado === 'en_curso' ? new Date() : undefined,
        fechaFin: estado === 'completado' ? new Date() : undefined,
      },
    })

    // Pago retenido: se libera al completar con nota clínica; se marca para reembolso si se cancela
    if (estado === 'completado') await liberarPago(id)
    if (estado === 'cancelado') await marcarReembolso(id)

    return actualizado
  })

  // POST /api/servicios/:id/evolucion
  app.post('/:id/evolucion', { preHandler: requerirRol('profesional', 'admin') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({
      tensionSistolica: z.number().optional(),
      tensionDiastolica: z.number().optional(),
      frecuenciaCardiaca: z.number().optional(),
      temperatura: z.number().optional(),
      saturacionOxigeno: z.number().optional(),
      glucemia: z.number().optional(),
      observaciones: z.string().optional(),
      procedimientos: z.string().optional(),
    }).parse(request.body)

    const profesional = await prisma.profesional.findUnique({
      where: { usuarioId: request.usuario.id },
    })
    if (request.usuario.rol === 'profesional') {
      const servicio = await prisma.servicio.findUnique({ where: { id }, select: { profesionalId: true } })
      if (!servicio || !profesional || servicio.profesionalId !== profesional.id) {
        return reply.status(403).send({ error: 'Este servicio no está asignado a usted' })
      }
    }

    const evolucion = await prisma.evolucion.create({
      data: {
        servicioId: id,
        profesionalId: profesional?.id,
        ...body,
      },
    })
    return reply.status(201).send(evolucion)
  })

  // GET /api/servicios/admin/todos
  app.get('/admin/todos', { preHandler: requerirRol('admin') }, async (request) => {
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

  // POST /api/servicios/:id/calificar
  app.post('/:id/calificar', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { puntuacion, comentario } = z.object({
      puntuacion: z.number().min(1).max(5),
      comentario: z.string().optional(),
    }).parse(request.body)

    const servicio = await prisma.servicio.findUnique({ where: { id } })
    if (!servicio) return reply.status(404).send({ error: 'Servicio no encontrado' })

    const actualizado = await prisma.servicio.update({
      where: { id },
      data: { calificacion: puntuacion, comentarioCalificacion: comentario },
    })
    return actualizado
  })
}
