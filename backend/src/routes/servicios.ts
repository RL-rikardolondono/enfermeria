import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { autenticar, requerirRol } from '../middleware/auth'
import { calcularTarifa } from '../services/tarifas'
import { notificarProfesionalesDisponibles } from './push'

export async function serviciosRoutes(app: FastifyInstance) {

  // POST /api/servicios — crear solicitud
  app.post('/', { preHandler: autenticar }, async (request, reply) => {
    const body = z.object({
      tipo: z.string().min(1),
      descripcion: z.string().min(1).max(500),
      direccion: z.string().min(1),
      lat: z.number().optional(),
      lng: z.number().optional(),
    }).parse(request.body)

    const paciente = await prisma.paciente.findUnique({
      where: { usuarioId: request.usuario.id },
      include: { usuario: { select: { nombreCompleto: true } } },
    })
    if (!paciente) return reply.status(404).send({ error: 'Perfil de paciente no encontrado' })

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
        cuerpo: (paciente.usuario?.nombreCompleto || 'Un paciente') + ' solicita ' + body.tipo + ' en ' + body.direccion,
        url: 'https://rl-rikardolondono.github.io/enfermeria/app-enfermero.html',
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
      const paciente = await prisma.paciente.findUnique({ where: { usuarioId: usuario.id } })
      if (paciente) where = { pacienteId: paciente.id }
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

    const [total, items] = await prisma.$transaction([
      prisma.servicio.count({ where: { estado: 'pendiente' } }),
      prisma.servicio.findMany({
        where: { estado: 'pendiente' },
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

    if (estado === 'asignado' && request.usuario.rol === 'profesional') {
      const profesional = await prisma.profesional.findUnique({
        where: { usuarioId: request.usuario.id },
      })
      if (!profesional || profesional.estadoVerificacion !== 'aprobado') {
        return reply.status(403).send({ error: 'Su cuenta no está verificada.' })
      }
    }

    let profesionalId: string | undefined
    if (estado === 'asignado' && request.usuario.rol === 'profesional') {
      const profesional = await prisma.profesional.findUnique({
        where: { usuarioId: request.usuario.id },
      })
      profesionalId = profesional?.id
    }

    const servicio = await prisma.servicio.update({
      where: { id },
      data: {
        estado,
        ...(profesionalId && { profesionalId }),
        fechaInicio: estado === 'en_curso' ? new Date() : undefined,
        fechaFin: estado === 'completado' ? new Date() : undefined,
      },
    })
    return servicio
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
