import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { redis } from '../utils/redis'
import { autenticar, requerirRol } from '../middleware/auth'
import { notificarUsuario } from '../utils/notificaciones'
import { calcularTarifa } from '../services/tarifas'

const crearServicioSchema = z.object({
  tipo: z.enum(['rutina', 'urgente', 'emergencia']),
  descripcion: z.string().min(10).max(500),
  latDestino: z.number().min(-90).max(90),
  lngDestino: z.number().min(-180).max(180),
  direccionDestino: z.string().min(5),
  especialidadRequerida: z.string().optional(),
})

const evolucionSchema = z.object({
  signosVitales: z.object({
    presionSistolica: z.number().optional(),
    presionDiastolica: z.number().optional(),
    frecuenciaCardiaca: z.number().optional(),
    frecuenciaRespiratoria: z.number().optional(),
    temperatura: z.number().optional(),
    saturacionO2: z.number().optional(),
    glucemia: z.number().optional(),
  }),
  procedimientos: z.array(z.string()),
  medicamentosAdmin: z.array(z.object({
    nombre: z.string(),
    dosis: z.string(),
    via: z.string(),
    hora: z.string(),
  })).optional(),
  observaciones: z.string().optional(),
})

export async function serviciosRoutes(app: FastifyInstance) {

  // POST /api/servicios — Crear solicitud + motor de asignación
  app.post('/', { preHandler: autenticar }, async (request, reply) => {
    const body = crearServicioSchema.parse(request.body)

    // Obtener paciente
    const paciente = await prisma.paciente.findUnique({
      where: { usuarioId: request.usuario.id },
    })
    if (!paciente) return reply.status(404).send({ error: 'Perfil de paciente no encontrado' })

    // Calcular tarifa
    const tarifa = await calcularTarifa(body.tipo)

    // Crear servicio
    const servicio = await prisma.servicio.create({
      data: {
        pacienteId: paciente.id,
        tipo: body.tipo,
        descripcion: body.descripcion,
        latDestino: body.latDestino,
        lngDestino: body.lngDestino,
        direccionDestino: body.direccionDestino,
        tarifa,
        estado: 'pendiente',
      },
    })

    // Motor de asignación automática (async, no bloquea la respuesta)
    ejecutarMotorAsignacion(servicio.id, body.latDestino, body.lngDestino, body.especialidadRequerida)
      .catch(err => app.log.error(err, 'Error motor asignación'))

    return reply.status(201).send({
      id: servicio.id,
      estado: servicio.estado,
      tarifa: servicio.tarifa,
      mensaje: 'Solicitud creada. Buscando profesional disponible...',
    })
  })

  // GET /api/servicios/:id
  app.get('/:id', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)

    const servicio = await prisma.servicio.findUnique({
      where: { id },
      include: {
        paciente: { include: { usuario: { select: { nombreCompleto: true, telefono: true } } } },
        profesional: {
          include: {
            usuario: { select: { nombreCompleto: true, telefono: true, fotoUrl: true } },
            ubicacion: true,
          },
        },
        evolucion: true,
        pago: true,
      },
    })
    if (!servicio) return reply.status(404).send({ error: 'Servicio no encontrado' })
    return servicio
  })

  // PATCH /api/servicios/:id/aceptar — Profesional acepta
  app.patch('/:id/aceptar', { preHandler: requerirRol('profesional') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)

    const profesional = await prisma.profesional.findUnique({
      where: { usuarioId: request.usuario.id },
    })
    if (!profesional) return reply.status(404).send({ error: 'Perfil profesional no encontrado' })

    const servicio = await prisma.servicio.findUnique({ where: { id } })
    if (!servicio || servicio.estado !== 'asignado' || servicio.profesionalId !== profesional.id) {
      return reply.status(400).send({ error: 'Servicio no disponible para aceptar' })
    }

    const actualizado = await prisma.servicio.update({
      where: { id },
      data: { estado: 'en_camino' },
    })

    // Marcar profesional en servicio
    await prisma.ubicacionProfesional.upsert({
      where: { profesionalId: profesional.id },
      update: { enServicio: true },
      create: { profesionalId: profesional.id, lat: 0, lng: 0, enServicio: true },
    })

    // Notificar al paciente
    const paciente = await prisma.paciente.findUnique({
      where: { id: servicio.pacienteId },
      include: { usuario: true },
    })
    if (paciente) {
      await notificarUsuario(paciente.usuarioId, {
        tipo: 'profesional_en_camino',
        titulo: 'Tu enfermero está en camino',
        cuerpo: `El profesional ha aceptado y se dirige hacia ti.`,
        datos: { servicioId: id },
      })
    }

    return actualizado
  })

  // PATCH /api/servicios/:id/iniciar
  app.patch('/:id/iniciar', { preHandler: requerirRol('profesional') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)

    const profesional = await prisma.profesional.findUnique({
      where: { usuarioId: request.usuario.id },
    })

    const servicio = await prisma.servicio.findUnique({ where: { id } })
    if (!servicio || servicio.estado !== 'en_camino' || servicio.profesionalId !== profesional?.id) {
      return reply.status(400).send({ error: 'Estado inválido para iniciar' })
    }

    const actualizado = await prisma.servicio.update({
      where: { id },
      data: { estado: 'en_curso', iniciadoEn: new Date() },
    })

    // Obtener historia clínica para el profesional
    const historiaClinica = await prisma.historiaClinica.findFirst({
      where: { pacienteId: servicio.pacienteId },
    })

    return { ...actualizado, historiaClinica }
  })

  // PATCH /api/servicios/:id/finalizar
  app.patch('/:id/finalizar', { preHandler: requerirRol('profesional') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { duracionMinutos } = z.object({ duracionMinutos: z.number().int().positive() }).parse(request.body)

    const profesional = await prisma.profesional.findUnique({
      where: { usuarioId: request.usuario.id },
    })

    const servicio = await prisma.servicio.findUnique({ where: { id } })
    if (!servicio || servicio.estado !== 'en_curso' || servicio.profesionalId !== profesional?.id) {
      return reply.status(400).send({ error: 'Estado inválido para finalizar' })
    }

    const [actualizado] = await prisma.$transaction([
      prisma.servicio.update({
        where: { id },
        data: { estado: 'completado', finalizadoEn: new Date(), duracionMinutos },
      }),
      prisma.ubicacionProfesional.update({
        where: { profesionalId: profesional.id },
        data: { enServicio: false },
      }),
    ])

    // Notificar paciente para calificar
    await notificarUsuario(servicio.pacienteId, {
      tipo: 'solicitar_calificacion',
      titulo: 'Servicio finalizado',
      cuerpo: 'Tu atención ha concluido. ¿Cómo calificarías el servicio?',
      datos: { servicioId: id },
    })

    return actualizado
  })

  // POST /api/servicios/:id/evolucion — Registrar durante la atención
  app.post('/:id/evolucion', { preHandler: requerirRol('profesional') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = evolucionSchema.parse(request.body)

    const profesional = await prisma.profesional.findUnique({
      where: { usuarioId: request.usuario.id },
    })
    const servicio = await prisma.servicio.findUnique({ where: { id } })

    if (!servicio || servicio.estado !== 'en_curso' || servicio.profesionalId !== profesional?.id) {
      return reply.status(400).send({ error: 'No puedes registrar evolución en este servicio' })
    }

    // Detectar alertas clínicas automáticas
    const alertas = detectarAlertas(body.signosVitales)

    const evolucion = await prisma.evolucion.upsert({
      where: { servicioId: id },
      update: {
        signosVitales: body.signosVitales,
        procedimientos: body.procedimientos,
        medicamentosAdmin: body.medicamentosAdmin || [],
        observaciones: body.observaciones,
        alertasGeneradas: alertas,
        fechaHora: new Date(),
      },
      create: {
        servicioId: id,
        pacienteId: servicio.pacienteId,
        profesionalId: profesional.id,
        signosVitales: body.signosVitales,
        procedimientos: body.procedimientos,
        medicamentosAdmin: body.medicamentosAdmin || [],
        observaciones: body.observaciones,
        alertasGeneradas: alertas,
      },
    })

    // Si hay alertas críticas, notificar admin
    if (alertas.length > 0) {
      const admins = await prisma.usuario.findMany({ where: { rol: 'admin' } })
      for (const admin of admins) {
        await notificarUsuario(admin.id, {
          tipo: 'alerta_clinica',
          titulo: 'Alerta clínica detectada',
          cuerpo: `Servicio ${id}: ${alertas.map((a: any) => a.mensaje).join(', ')}`,
          datos: { servicioId: id, alertas },
        })
      }
    }

    // Actualizar historia clínica
    await prisma.historiaClinica.upsert({
      where: { pacienteId: servicio.pacienteId },
      update: { actualizadoEn: new Date(), actualizadoPor: profesional.usuarioId },
      create: {
        pacienteId: servicio.pacienteId,
        actualizadoEn: new Date(),
        actualizadoPor: profesional.usuarioId,
      },
    })

    return { ...evolucion, alertas }
  })

  // POST /api/servicios/:id/calificacion
  app.post('/:id/calificacion', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({
      puntuacion: z.number().int().min(1).max(5),
      comentario: z.string().max(500).optional(),
    }).parse(request.body)

    const servicio = await prisma.servicio.findUnique({ where: { id } })
    if (!servicio || servicio.estado !== 'completado') {
      return reply.status(400).send({ error: 'Solo se puede calificar servicios completados' })
    }

    // Determinar destinatario
    const paciente = await prisma.paciente.findUnique({ where: { id: servicio.pacienteId } })
    const profesional = await prisma.profesional.findUnique({ where: { id: servicio.profesionalId! } })

    const esPaciente = paciente?.usuarioId === request.usuario.id
    const destinatarioId = esPaciente ? profesional!.usuarioId : paciente!.usuarioId

    const calificacion = await prisma.calificacion.create({
      data: {
        servicioId: id,
        autorId: request.usuario.id,
        destinatarioId,
        puntuacion: body.puntuacion,
        comentario: body.comentario,
      },
    })

    return calificacion
  })

  // GET /api/servicios (listado para profesional o paciente)
  app.get('/', { preHandler: autenticar }, async (request) => {
    const { page = 1, limit = 20 } = z.object({
      page: z.coerce.number().default(1),
      limit: z.coerce.number().max(50).default(20),
    }).parse(request.query)

    const where: any = {}
    if (request.usuario.rol === 'paciente') {
      const p = await prisma.paciente.findUnique({ where: { usuarioId: request.usuario.id } })
      where.pacienteId = p?.id
    } else if (request.usuario.rol === 'profesional') {
      const p = await prisma.profesional.findUnique({ where: { usuarioId: request.usuario.id } })
      where.profesionalId = p?.id
    }

    const [total, items] = await prisma.$transaction([
      prisma.servicio.count({ where }),
      prisma.servicio.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          paciente: { include: { usuario: { select: { nombreCompleto: true } } } },
          profesional: { include: { usuario: { select: { nombreCompleto: true, fotoUrl: true } } } },
        },
      }),
    ])

    return { total, page, limit, items }
  })
}

// ============================================================
// Motor de asignación
// ============================================================
async function ejecutarMotorAsignacion(
  servicioId: string,
  lat: number,
  lng: number,
  especialidad?: string
) {
  const MAX_RADIO = 20
  const TIMEOUT_ACEPTACION_SEG = 60

  // Buscar profesionales cercanos usando PostGIS
  const cercanos = await prisma.$queryRaw<any[]>`
    SELECT
      p.id AS profesional_id,
      u.id AS usuario_id,
      u.nombre_completo,
      p.calificacion_promedio,
      p.total_servicios,
      ROUND((ST_Distance(
        up.geom,
        ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
      ) / 1000)::DECIMAL, 2) AS distancia_km
    FROM profesionales p
    JOIN usuarios u ON u.id = p.usuario_id
    JOIN ubicacion_profesional up ON up.profesional_id = p.id
    WHERE
      p.estado_verificacion = 'aprobado'
      AND p.disponible = TRUE
      AND up.en_servicio = FALSE
      AND u.estado = 'activo'
      AND (${especialidad ?? null} IS NULL OR ${especialidad ?? null} = ANY(p.especialidades))
      AND ST_DWithin(
        up.geom,
        ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
        ${MAX_RADIO * 1000}
      )
    ORDER BY
      distancia_km ASC,
      p.calificacion_promedio DESC
    LIMIT 5
  `

  if (cercanos.length === 0) {
    await prisma.servicio.update({
      where: { id: servicioId },
      data: { estado: 'cancelado', motivoCancelacion: 'Sin profesionales disponibles en el área' },
    })
    return
  }

  // Asignar al mejor candidato y notificar
  const elegido = cercanos[0]

  await prisma.servicio.update({
    where: { id: servicioId },
    data: {
      profesionalId: elegido.profesional_id,
      estado: 'asignado',
      asignadoEn: new Date(),
    },
  })

  // Guardar en Redis para tracking en tiempo real
  await redis.setex(
    `servicio:${servicioId}:profesional`,
    3600,
    JSON.stringify({ profesionalId: elegido.profesional_id, distanciaKm: elegido.distancia_km })
  )

  // Notificar al profesional
  await notificarUsuario(elegido.usuario_id, {
    tipo: 'nueva_solicitud',
    titulo: 'Nueva solicitud de atención',
    cuerpo: `Tienes ${TIMEOUT_ACEPTACION_SEG}s para aceptar. Distancia: ${elegido.distancia_km}km`,
    datos: { servicioId, distanciaKm: elegido.distancia_km },
  })
}

// ============================================================
// Alertas clínicas automáticas
// ============================================================
function detectarAlertas(signos: any): Array<{ tipo: string; mensaje: string; severidad: string }> {
  const alertas = []

  if (signos.presionSistolica && signos.presionSistolica > 180) {
    alertas.push({ tipo: 'HTA_CRISIS', mensaje: 'Presión sistólica crítica > 180 mmHg', severidad: 'critica' })
  }
  if (signos.presionSistolica && signos.presionSistolica < 90) {
    alertas.push({ tipo: 'HIPOTENSION', mensaje: 'Hipotensión < 90/60 mmHg', severidad: 'alta' })
  }
  if (signos.frecuenciaCardiaca && signos.frecuenciaCardiaca > 120) {
    alertas.push({ tipo: 'TAQUICARDIA', mensaje: 'Taquicardia > 120 lpm', severidad: 'media' })
  }
  if (signos.frecuenciaCardiaca && signos.frecuenciaCardiaca < 50) {
    alertas.push({ tipo: 'BRADICARDIA', mensaje: 'Bradicardia < 50 lpm', severidad: 'alta' })
  }
  if (signos.saturacionO2 && signos.saturacionO2 < 90) {
    alertas.push({ tipo: 'HIPOXIA', mensaje: 'Saturación O2 crítica < 90%', severidad: 'critica' })
  }
  if (signos.temperatura && signos.temperatura > 39) {
    alertas.push({ tipo: 'FIEBRE_ALTA', mensaje: 'Temperatura > 39°C', severidad: 'media' })
  }
  if (signos.glucemia && signos.glucemia > 400) {
    alertas.push({ tipo: 'HIPERGLUCEMIA', mensaje: 'Glucemia > 400 mg/dL', severidad: 'alta' })
  }
  if (signos.glucemia && signos.glucemia < 60) {
    alertas.push({ tipo: 'HIPOGLUCEMIA', mensaje: 'Hipoglucemia < 60 mg/dL', severidad: 'critica' })
  }

  return alertas
}
