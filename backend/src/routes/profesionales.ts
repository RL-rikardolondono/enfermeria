import { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { autenticar, requerirRol } from '../middleware/auth'
import { liberarServiciosDe } from '../services/profesionalBaja'
import { marcarCambio } from '../utils/cambios'
import { profesionalRespondio } from '../services/presencia'
import { pushConfigurado } from './push'
import { opinionesDe } from '../services/opiniones'

const paginacion = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

// Solo el propio profesional o la IPS pueden ver o cambiar su perfil
async function esDuenoOAdmin(request: FastifyRequest, profesionalId: string) {
  if (request.usuario.rol === 'admin') return true
  const prof = await prisma.profesional.findUnique({ where: { id: profesionalId }, select: { usuarioId: true } })
  return !!prof && prof.usuarioId === request.usuario.id
}

const PERFIL_SELECT = {
  id: true, especialidad: true, registroProfesional: true, estadoVerificacion: true, disponible: true, disponibleDesde: true,
  calificacionPromedio: true, totalServicios: true, anosExperiencia: true, fotoUrl: true,
  banco: true, cuentaBancaria: true, tipoCuenta: true, activo: true, createdAt: true,
  usuario: { select: { nombreCompleto: true, email: true, telefono: true, fotoUrl: true } },
} as const

export async function profesionalesRoutes(app: FastifyInstance) {

  // GET /api/profesionales/mi-perfil — perfil del profesional que ingresó
  app.get('/mi-perfil', { preHandler: autenticar }, async (request, reply) => {
    const profesional = await prisma.profesional.findUnique({
      where: { usuarioId: request.usuario.id },
      select: PERFIL_SELECT,
    })
    if (!profesional) return reply.status(404).send({ error: 'Perfil no encontrado' })
    return profesional
  })

  // GET /api/profesionales/:id/opiniones — lo que dicen los pacientes (el propio profesional o la IPS)
  app.get('/:id/opiniones', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    if (!(await esDuenoOAdmin(request, id))) return reply.status(404).send({ error: 'Profesional no encontrado' })
    return opinionesDe(id, 20)
  })

  // GET /api/profesionales — listado (solo la IPS)
  app.get('/', { preHandler: requerirRol('admin') }, async (request) => {
    const { page, limit } = paginacion.parse(request.query)
    const [total, items] = await prisma.$transaction([
      prisma.profesional.count({ where: { activo: true } }),
      prisma.profesional.findMany({
        where: { activo: true },
        skip: (page - 1) * limit,
        take: limit,
        select: PERFIL_SELECT,
      }),
    ])
    return { total, page, limit, items }
  })

  // GET /api/profesionales/:id — el propio profesional o la IPS
  app.get('/:id', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    if (!(await esDuenoOAdmin(request, id))) return reply.status(404).send({ error: 'Profesional no encontrado' })
    const profesional = await prisma.profesional.findUnique({
      where: { id },
      select: { ...PERFIL_SELECT, documentos: true },
    })
    if (!profesional) return reply.status(404).send({ error: 'Profesional no encontrado' })
    return profesional
  })

  // PUT /api/profesionales/:id — actualizar perfil (el propio profesional o la IPS)
  app.put('/:id', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    if (!(await esDuenoOAdmin(request, id))) return reply.status(404).send({ error: 'Profesional no encontrado' })
    const body = z.object({
      especialidad: z.string().trim().max(100).optional(),
      registroProfesional: z.string().trim().max(100).optional(),
      anosExperiencia: z.number().int().min(0).max(70).optional(),
      banco: z.string().trim().max(100).optional(),
      cuentaBancaria: z.string().trim().max(50).optional(),
      tipoCuenta: z.string().trim().max(50).optional(),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      // Encender el turno solo por /disponibilidad (revisa avisos y marca la hora); aquí solo se puede apagar
      disponible: z.literal(false).optional(),
    }).parse(request.body)

    // Si el propio profesional cambia su profesión o registro, la IPS debe verificarlo de nuevo
    const cambiaCredencial = request.usuario.rol !== 'admin' &&
      (body.registroProfesional !== undefined || body.especialidad !== undefined)
    if (cambiaCredencial) {
      const activos = await prisma.servicio.count({ where: { profesionalId: id, estado: { in: ['asignado', 'en_camino', 'en_curso'] } } })
      if (activos) return reply.status(409).send({ error: 'Termine su servicio activo antes de cambiar su profesión o registro.' })
    }
    return prisma.profesional.update({
      where: { id },
      data: { ...body, ...(cambiaCredencial ? { estadoVerificacion: 'pendiente', disponible: false } : {}) },
      select: PERFIL_SELECT,
    }).then(async (r: any) => {
      if (cambiaCredencial || body.disponible === false) {
        await prisma.profesional.update({ where: { id }, data: { disponible: false, disponibleDesde: null } })
        await prisma.oferta.updateMany({ where: { profesionalId: id, estado: 'activa' }, data: { estado: 'retirada' } })
        marcarCambio()
      }
      return r
    })
  })

  // PUT /api/profesionales/:id/disponibilidad — el propio profesional
  app.put('/:id/disponibilidad', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    if (!(await esDuenoOAdmin(request, id))) return reply.status(404).send({ error: 'Profesional no encontrado' })
    const { disponible, lat, lng } = z.object({
      disponible: z.boolean(),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
    }).parse(request.body)

    if (disponible) {
      const pr = await prisma.profesional.findUnique({ where: { id }, select: { estadoVerificacion: true, activo: true } })
      if (!pr || pr.estadoVerificacion !== 'aprobado' || !pr.activo) return reply.status(409).send({ error: 'Su cuenta aún no está aprobada por la IPS.' })
    }
    // Para estar en turno debe poder recibir avisos en el celular (si los avisos están configurados en el servidor)
    if (disponible && pushConfigurado()) {
      const prof = await prisma.profesional.findUnique({ where: { id }, select: { usuarioId: true } })
      const avisos = prof ? await prisma.notificacion.count({ where: { usuarioId: prof.usuarioId, tipo: 'push_subscription' } }) : 0
      if (!avisos) return reply.status(409).send({ error: 'Primero active los avisos en este celular (botón "Activar avisos") para que le lleguen las solicitudes.', faltanAvisos: true })
    }
    // Al iniciar el turno, la sesión de este celular dura lo mismo que el turno (12 horas desde ahora)
    let accessToken: string | undefined
    if (disponible && request.usuario.rol === 'profesional') {
      const { sid } = request.user as { sid?: string }
      if (sid) {
        // La sesión dura el turno (12 h desde ahora), pero nunca más de 24 h desde que ingresó
        const ses = await prisma.sesion.findFirst({ where: { id: sid, usuarioId: request.usuario.id }, select: { createdAt: true } })
        const tope = ses ? Math.min(Date.now() + 12 * 3600 * 1000, ses.createdAt.getTime() + 24 * 3600 * 1000) : Date.now()
        const u = await prisma.sesion.updateMany({ where: { id: sid, usuarioId: request.usuario.id, expiresAt: { lt: new Date(tope) } }, data: { expiresAt: new Date(tope) } })
        if (u.count) accessToken = app.jwt.sign({ sub: request.usuario.id, rol: request.usuario.rol, sid, type: 'access' }, { expiresIn: '12h' })
      }
    }
    const r = await prisma.profesional.update({
      where: { id },
      data: { disponible, lat, lng, ignoradas: 0, disponibleDesde: disponible ? new Date() : null },
      select: { id: true, disponible: true, disponibleDesde: true },
    })
    if (!disponible) {
      // Al dejar de estar disponible, retira sus ofertas pendientes
      await prisma.oferta.updateMany({ where: { profesionalId: id, estado: 'activa' }, data: { estado: 'retirada' } })
    }
    marcarCambio()
    return { id: r.id, disponible: r.disponible, disponibleDesde: r.disponibleDesde, accessToken }
  })

  // PUT /api/profesionales/:id/verificar — la IPS aprueba o rechaza
  app.put('/:id/verificar', { preHandler: requerirRol('admin') }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { estado } = z.object({
      estado: z.enum(['aprobado', 'rechazado', 'pendiente']),
    }).parse(request.body)

    const r = await prisma.profesional.update({
      where: { id },
      data: { estadoVerificacion: estado, verificadoPor: request.usuario.id, verificadoEn: new Date() },
      select: { id: true, estadoVerificacion: true },
    })
    if (estado !== 'aprobado') await liberarServiciosDe(id)
    else marcarCambio()
    return r
  })

  // GET /api/profesionales/:id/servicios — el propio profesional o la IPS
  app.get('/:id/servicios', { preHandler: requerirRol('admin') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { page, limit } = paginacion.parse(request.query)

    const [total, items] = await prisma.$transaction([
      prisma.servicio.count({ where: { profesionalId: id } }),
      prisma.servicio.findMany({
        where: { profesionalId: id },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          paciente: { include: { usuario: { select: { nombreCompleto: true, telefono: true } } } },
        },
      }),
    ])
    return { total, page, limit, items }
  })
}
