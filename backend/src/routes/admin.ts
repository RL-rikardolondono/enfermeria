import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { requerirRol, requerirPermiso, tienePermiso, olvidarSesionesDe, PERFILES_IPS } from '../middleware/auth'
import { vencerPendientesAntiguas, buscandoVigente } from '../services/vencimiento'
import { enTurno } from '../services/presencia'
import { recalcularPromedio } from '../services/opiniones'
import { liberarServiciosDe } from '../services/profesionalBaja'
import { marcarCambio } from '../utils/cambios'
import { enviarEnlaceClave, SUPERADMIN_CORREO } from '../services/cuentas'
import { PERFIL_IDS, PERFILES, documentosAlDia, textoDocumentos, DOCUMENTOS, sacarDelTurnoSiFaltanDocs } from '../services/catalogo'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'

const pag = (max: number) => ({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(max).default(20),
})
// Inicio del día y del mes en hora de Colombia (UTC-5), aunque el servidor esté en UTC
function inicioColombia(tipo: 'dia' | 'mes') {
  const ahora = new Date(Date.now() - 5 * 3600 * 1000)
  const d = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), tipo === 'dia' ? ahora.getUTCDate() : 1))
  return new Date(d.getTime() + 5 * 3600 * 1000)
}

export async function adminRoutes(app: FastifyInstance) {
  const preHandler = requerirRol('admin')
  const P = (permiso: string) => requerirPermiso(permiso)

  // GET /api/admin/dashboard
  app.get('/dashboard', { preHandler: P('resumen') }, async () => {
    await vencerPendientesAntiguas()
    const hoy = inicioColombia('dia')

    const [serviciosHoy, serviciosActivos, profesionalesDisponibles, pendientesVerificacion, ingresosMes, quejasAbiertas, buscando, enTurnoAhora] = await prisma.$transaction([
      prisma.servicio.count({ where: { createdAt: { gte: hoy } } }),
      prisma.servicio.count({ where: { estado: { in: ['asignado', 'en_camino', 'en_curso'] } } }),
      prisma.profesional.count({ where: { disponible: true, estadoVerificacion: 'aprobado' } }),
      prisma.profesional.count({ where: { estadoVerificacion: 'pendiente' } }),
      prisma.pago.aggregate({
        where: { estado: 'aprobado', estadoLiquidacion: { notIn: ['reembolso', 'revisar'] }, createdAt: { gte: inicioColombia('mes') } },
        _sum: { monto: true },
      }),
      prisma.queja.count({ where: { estado: 'abierta' } }),
      prisma.servicio.count({ where: buscandoVigente() }),
      prisma.profesional.count({ where: enTurno() }),
    ])

    // Espacio de la base de datos (Neon gratis: 512 MB). Se avisa desde el 70 %.
    let baseMB = 0
    try { const r: any[] = await prisma.$queryRaw`SELECT pg_database_size(current_database())::bigint AS b`; baseMB = Math.round(Number(r[0]?.b || 0) / 1048576) } catch { baseMB = 0 }
    const limiteMB = Number(process.env.DB_LIMITE_MB || 512)
    return {
      baseMB, limiteMB,
      serviciosHoy, serviciosActivos, pendientesVerificacion, quejasAbiertas, buscando,
      profesionalesDisponibles, conectadosAhora: enTurnoAhora,
      ingresosMes: ingresosMes._sum.monto ?? 0,
    }
  })

  // GET /api/admin/usuarios
  app.get('/usuarios', { preHandler: P('cuentas') }, async (request) => {
    const { page, limit, rol } = z.object({
      ...pag(100),
      rol: z.enum(['paciente', 'profesional', 'admin']).optional(),
    }).parse(request.query)

    const where: any = rol ? { rol } : {}

    const [total, items] = await prisma.$transaction([
      prisma.usuario.count({ where }),
      prisma.usuario.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
  app.get('/profesionales', { preHandler: P('profesionales') }, async (request) => {
    const { page, limit, estado } = z.object({
      ...pag(100),
      estado: z.enum(['pendiente', 'aprobado', 'rechazado', 'turno']).optional(),
    }).parse(request.query)

    const where: any = estado === 'turno' ? enTurno() : estado ? { estadoVerificacion: estado } : {}

    const [total, items] = await prisma.$transaction([
      prisma.profesional.count({ where }),
      prisma.profesional.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          usuario: { select: { id: true, nombreCompleto: true, email: true, telefono: true, estado: true } },
          _count: { select: { quejas: { where: { estado: 'abierta' } }, bloqueos: true, documentos: { where: { estado: 'pendiente' } } } },
        },
      }),
    ])

    return { total, page, limit, items }
  })

  // PUT /api/admin/profesionales/:id/verificar
  app.put('/profesionales/:id/verificar', { preHandler: P('profesionales') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { estado } = z.object({
      estado: z.enum(['aprobado', 'rechazado', 'pendiente']),
    }).parse(request.body)
    if (estado === 'aprobado') {
      const p = await prisma.profesional.findUnique({ where: { id }, select: { perfil: true } })
      if (!p) return reply.status(404).send({ error: 'Profesional no encontrado' })
      if (!p.perfil) return reply.status(400).send({ error: 'Asígnele primero su perfil (enfermero, auxiliar, médico…): define qué servicios puede atender.' })
      const docs = await documentosAlDia(id)
      if (!docs.ok) return reply.status(400).send({ error: 'No se puede aprobar todavía. ' + textoDocumentos(docs) })
    }

    const actualizado = await prisma.profesional.update({
      where: { id },
      data: { estadoVerificacion: estado, verificadoPor: request.usuario.id, verificadoEn: new Date() },
      select: { id: true, estadoVerificacion: true },
    })
    if (estado !== 'aprobado') await liberarServiciosDe(id)
    else marcarCambio()
    return actualizado
  })

  // GET /api/admin/servicios
  app.get('/servicios', { preHandler: P('servicios') }, async (request) => {
    const { page, limit, estado, hoy } = z.object({
      ...pag(100),
      estado: z.enum(['pendiente', 'asignado', 'en_camino', 'en_curso', 'completado', 'cancelado', 'activos']).optional(),
      hoy: z.enum(['1']).optional(),
    }).parse(request.query)

    const where: any = estado === 'activos' ? { estado: { in: ['asignado', 'en_camino', 'en_curso'] } } : estado ? { estado } : {}
    if (hoy) where.createdAt = { gte: inicioColombia('dia') }

    const [total, items] = await prisma.$transaction([
      prisma.servicio.count({ where }),
      prisma.servicio.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          paciente: { include: { usuario: { select: { nombreCompleto: true } } } },
          profesional: { select: { id: true, especialidad: true, usuario: { select: { nombreCompleto: true } } } },
        },
      }),
    ])

    return { total, page, limit, items }
  })

  // GET /api/admin/pacientes — todos los pacientes (titulares y familiares) con su cuenta
  app.get('/pacientes', { preHandler: P('pacientes') }, async (request) => {
    const { page, limit, q, inactivos } = z.object({
      ...pag(100),
      q: z.string().trim().max(100).optional(),
      inactivos: z.enum(['1']).optional(),
    }).parse(request.query)
    const where: any = { activo: !inactivos }
    if (q) where.OR = [
      { nombreCompleto: { contains: q, mode: 'insensitive' } },
      { documentoNumero: { contains: q } },
      { usuario: { OR: [
        { nombreCompleto: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { telefono: { contains: q } },
      ] } },
    ]
    const [total, items] = await prisma.$transaction([
      prisma.paciente.count({ where }),
      prisma.paciente.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, nombreCompleto: true, parentesco: true, esTitular: true, fechaNacimiento: true, activo: true,
          documentoNumero: true, alergias: true, antecedentes: true, eps: true, createdAt: true,
          usuario: { select: { nombreCompleto: true, email: true, telefono: true } },
        },
      }),
    ])
    return { total, page, limit, items }
  })

  // PUT /api/admin/pacientes/:id/activo — retirar (fallecido, se fue) o reactivar a un paciente; su historia se conserva
  app.put('/pacientes/:id/activo', { preHandler: P('pacientes') }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { activo } = z.object({ activo: z.boolean() }).parse(request.body)
    return prisma.paciente.update({ where: { id }, data: { activo }, select: { id: true, activo: true } })
  })

  // GET /api/admin/quejas — quejas de los pacientes (abiertas primero)
  // ── Seguridad del paciente: eventos adversos e incidentes ──
  app.get('/eventos-seguridad', { preHandler: P('quejas') }, async (request) => {
    const { page, limit } = z.object({ ...pag(100) }).parse(request.query)
    const [total, items, abiertos] = await prisma.$transaction([
      prisma.eventoSeguridad.count(),
      prisma.eventoSeguridad.findMany({
        orderBy: [{ estado: 'desc' }, { createdAt: 'desc' }], skip: (page - 1) * limit, take: limit,
        select: {
          id: true, tipo: true, gravedad: true, descripcion: true, accionInmediata: true, estado: true, clasificacion: true, analisis: true, planMejora: true, createdAt: true, cerradoEn: true,
          servicio: { select: { id: true, tipo: true, profesional: { select: { usuario: { select: { nombreCompleto: true } } } }, paciente: { select: { nombreCompleto: true, usuario: { select: { nombreCompleto: true, telefono: true } } } } } },
        },
      }),
      prisma.eventoSeguridad.count({ where: { estado: { not: 'cerrado' } } }),
    ])
    return { total, page, limit, items, abiertos }
  })

  app.put('/eventos-seguridad/:id', { preHandler: P('quejas') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const b = z.object({
      estado: z.enum(['en_analisis', 'cerrado']),
      clasificacion: z.enum(['incidente', 'evento_prevenible', 'evento_no_prevenible']).optional(),
      analisis: z.string().trim().max(4000).optional(),
      planMejora: z.string().trim().max(3000).optional(),
    }).parse(request.body)
    if (b.estado === 'cerrado' && (!b.clasificacion || !b.analisis || b.analisis.length < 10)) return reply.status(400).send({ error: 'Para cerrar el evento escriba el análisis y elija la clasificación.' })
    if (b.estado === 'cerrado' && b.clasificacion === 'evento_prevenible' && (!b.planMejora || b.planMejora.length < 10)) return reply.status(400).send({ error: 'Un evento prevenible necesita plan de mejora.' })
    const r = await prisma.eventoSeguridad.updateMany({ where: { id }, data: { ...b, revisadoPor: request.usuario.id, cerradoEn: b.estado === 'cerrado' ? new Date() : null } })
    if (!r.count) return reply.status(404).send({ error: 'Evento no encontrado' })
    await prisma.bitacora.create({ data: { actorId: request.usuario.id, usuarioId: request.usuario.id, accion: 'evento_seguridad_' + b.estado, detalle: id } }).catch(() => {})
    return { ok: true }
  })

  app.get('/quejas', { preHandler: P('quejas') }, async (request) => {
    const { page, limit, estado } = z.object({ ...pag(100), estado: z.enum(['abierta', 'revisada']).optional() }).parse(request.query)
    const where: any = estado ? { estado } : {}
    const [total, items] = await prisma.$transaction([
      prisma.queja.count({ where }),
      prisma.queja.findMany({
        where,
        orderBy: [{ estado: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, texto: true, estado: true, respuesta: true, createdAt: true, revisadaEn: true,
          profesional: { select: { id: true, usuario: { select: { nombreCompleto: true } } } },
          servicio: {
            select: {
              id: true, tipo: true, estado: true, createdAt: true, calificacion: true,
              paciente: { select: { nombreCompleto: true, usuario: { select: { nombreCompleto: true, telefono: true } } } },
            },
          },
        },
      }),
    ])
    return { total, page, limit, items }
  })

  // PUT /api/admin/quejas/:id — la IPS marca la queja como revisada y deja una nota
  app.put('/quejas/:id', { preHandler: P('quejas') }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { respuesta } = z.object({ respuesta: z.string().trim().min(3).max(2000) }).parse(request.body)
    const r = await prisma.queja.update({ where: { id }, data: { estado: 'revisada', respuesta, revisadaEn: new Date() }, select: { id: true, estado: true } })
    marcarCambio()
    return r
  })

  // GET /api/admin/opiniones — últimas calificaciones con comentario
  app.get('/opiniones', { preHandler: P('quejas') }, async (request) => {
    const { page, limit } = z.object({ ...pag(100) }).parse(request.query)
    const where = { calificacion: { not: null } }
    const [total, items] = await prisma.$transaction([
      prisma.servicio.count({ where }),
      prisma.servicio.findMany({
        where,
        orderBy: [{ calificadoEn: { sort: 'desc', nulls: 'last' } }, { fechaFin: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, calificacion: true, comentarioCalificacion: true, resenaOculta: true, calificadoEn: true, fechaFin: true, tipo: true,
          profesional: { select: { id: true, usuario: { select: { nombreCompleto: true } } } },
          paciente: { select: { nombreCompleto: true, usuario: { select: { nombreCompleto: true } } } },
        },
      }),
    ])
    return { total, page, limit, items }
  })

  // PUT /api/admin/opiniones/:servicioId — ocultar o volver a mostrar un comentario (las estrellas siguen contando)
  app.put('/opiniones/:servicioId', { preHandler: P('quejas') }, async (request) => {
    const { servicioId } = z.object({ servicioId: z.string().uuid() }).parse(request.params)
    const { oculta } = z.object({ oculta: z.boolean() }).parse(request.body)
    const r = await prisma.servicio.update({ where: { id: servicioId }, data: { resenaOculta: oculta }, select: { id: true, resenaOculta: true, profesionalId: true } })
    if (r.profesionalId) await recalcularPromedio(r.profesionalId)
    return { id: r.id, resenaOculta: r.resenaOculta }
  })

  // PUT /api/admin/usuarios/:id/estado
  app.put('/usuarios/:id/estado', { preHandler }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { estado, motivo } = z.object({
      estado: z.enum(['activo', 'suspendido']),
      motivo: z.string().trim().max(400).optional(),
    }).parse(request.body)
    if (id === request.usuario.id) return reply.status(400).send({ error: 'No puede bloquear su propia cuenta.' })
    const objetivo = await prisma.usuario.findUnique({ where: { id }, select: { rol: true, email: true } })
    if (!objetivo) return reply.status(404).send({ error: 'Cuenta no encontrada' })
    const permitido = tienePermiso(request.usuario, 'cuentas') || (objetivo.rol === 'profesional' && tienePermiso(request.usuario, 'profesionales'))
    if (!permitido) return reply.status(403).send({ error: 'Su perfil en la IPS no tiene permiso para esto.' })
    if (objetivo.email === SUPERADMIN_CORREO) return reply.status(400).send({ error: 'La cuenta del Superadministrador no se bloquea desde aquí.' })

    const actualizado = await prisma.usuario.update({
      where: { id },
      data: { estado },
      select: { id: true, nombreCompleto: true, email: true, rol: true, estado: true },
    })
    // Suspender cierra todas sus sesiones de inmediato
    if (estado === 'suspendido') {
      await prisma.sesion.deleteMany({ where: { usuarioId: id } })
      olvidarSesionesDe(id)
      const prof = await prisma.profesional.findUnique({ where: { usuarioId: id }, select: { id: true } })
      if (prof) await liberarServiciosDe(prof.id)
    }
    await prisma.bitacora.create({ data: { actorId: request.usuario.id, usuarioId: id, accion: estado === 'suspendido' ? 'bloquear' : 'reactivar', detalle: motivo || null } }).catch(() => {})
    return actualizado
  })

  // GET /api/admin/cuentas — «Cuentas y accesos»: todas las cuentas con perfil, si ya creó contraseña y su último ingreso.
  // Las contraseñas están cifradas: nadie puede verlas (Ley 1581); se envía un enlace para crearlas o cambiarlas.
  app.get('/cuentas', { preHandler: P('cuentas') }, async (request) => {
    const { page, limit, q, rol, todo } = z.object({
      ...pag(500),
      q: z.string().trim().max(100).optional(),
      rol: z.enum(['paciente', 'profesional', 'admin']).optional(),
      todo: z.enum(['1']).optional(),
    }).parse(request.query)
    const where: any = {}
    if (rol) where.rol = rol
    if (q) where.OR = [
      { nombreCompleto: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { telefono: { contains: q } },
    ]
    const tam = todo ? 5000 : limit
    const [total, items] = await prisma.$transaction([
      prisma.usuario.count({ where }),
      prisma.usuario.findMany({
        where,
        orderBy: [{ rol: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
        skip: todo ? 0 : (page - 1) * limit,
        take: tam,
        select: {
          id: true, nombreCompleto: true, email: true, telefono: true, rol: true, estado: true,
          claveCreada: true, ultimoIngreso: true, createdAt: true, rolIps: true,
          profesional: { select: { especialidad: true, estadoVerificacion: true } },
        },
      }),
    ])
    return { total, page, limit: tam, items, superadmin: SUPERADMIN_CORREO }
  })

  // POST /api/admin/cuentas/:id/enlace — envía el enlace para crear o cambiar la contraseña
  app.post('/cuentas/:id/enlace', { preHandler: P('cuentas'), config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const u = await prisma.usuario.findUnique({ where: { id }, select: { id: true, email: true, rol: true, rolIps: true, nombreCompleto: true, estado: true } })
    if (!u) return reply.status(404).send({ error: 'Cuenta no encontrada' })
    if (u.estado !== 'activo') return reply.status(409).send({ error: 'La cuenta está bloqueada. Reactívela antes de enviar el enlace.' })
    const para = await enviarEnlaceClave(u, 'ips')
    await prisma.bitacora.create({ data: { actorId: request.usuario.id, usuarioId: id, accion: 'enlace_clave', detalle: 'Enviado a ' + para } }).catch(() => {})
    return { ok: true, para }
  })

  // GET /api/admin/cuentas/:id/bitacora — qué se ha hecho con esta cuenta
  app.get('/cuentas/:id/bitacora', { preHandler: P('cuentas') }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const items = await prisma.bitacora.findMany({ where: { usuarioId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50 })
    return { items }
  })

  // ── Perfil y documentos de cada profesional ──
  // PUT /api/admin/profesionales/:id/perfil — define qué servicios puede atender
  app.put('/profesionales/:id/perfil', { preHandler: P('profesionales') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { perfil } = z.object({ perfil: z.enum(PERFIL_IDS) }).parse(request.body)
    const p = await prisma.profesional.update({ where: { id }, data: { perfil, especialidad: PERFILES[perfil] }, select: { id: true, perfil: true, usuarioId: true } }).catch(() => null)
    if (!p) return reply.status(404).send({ error: 'Profesional no encontrado' })
    await prisma.bitacora.create({ data: { actorId: request.usuario.id, usuarioId: p.usuarioId, accion: 'perfil_profesional', detalle: PERFILES[perfil] } }).catch(() => {})
    marcarCambio()
    return { ok: true, perfil }
  })

  // GET /api/admin/profesionales/:id/documentos — documentos subidos (sin el archivo; se ve aparte)
  app.get('/profesionales/:id/documentos', { preHandler: P('profesionales') }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const items = await prisma.documentoProfesional.findMany({
      where: { profesionalId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 60,
      select: { id: true, tipo: true, estado: true, vence: true, nota: true, archivoId: true, createdAt: true, revisadoEn: true },
    })
    const alDia = await documentosAlDia(id)
    return { items, requeridos: DOCUMENTOS, alDia }
  })

  // PUT /api/admin/documentos/:id — aprobar o rechazar un documento (con nota si se rechaza)
  app.put('/documentos/:id', { preHandler: P('profesionales') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { estado, nota, vence } = z.object({
      estado: z.enum(['aprobado', 'rechazado']),
      nota: z.string().trim().max(300).optional(),
      vence: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).parse(request.body)
    if (estado === 'rechazado' && (!nota || nota.length < 5)) return reply.status(400).send({ error: 'Escriba por qué se rechaza (el profesional lo verá).' })
    const doc = await prisma.documentoProfesional.findUnique({ where: { id }, select: { id: true, tipo: true, vence: true, profesionalId: true, profesional: { select: { usuarioId: true, estadoVerificacion: true } } } })
    if (!doc) return reply.status(404).send({ error: 'Documento no encontrado' })
    const def = DOCUMENTOS.find((d) => d.tipo === doc.tipo)
    const fechaVence = vence ? new Date(vence + 'T23:59:59-05:00') : doc.vence
    if (estado === 'aprobado' && def?.vence && (!fechaVence || fechaVence.getTime() < Date.now())) return reply.status(400).send({ error: 'Indique una fecha de vencimiento vigente para aprobar este documento.' })
    await prisma.documentoProfesional.update({ where: { id }, data: { estado, nota: nota || null, vence: fechaVence, revisadoPor: request.usuario.id, revisadoEn: new Date() } })
    await prisma.bitacora.create({ data: { actorId: request.usuario.id, usuarioId: doc.profesional.usuarioId, accion: 'documento_' + estado, detalle: (def?.nombre || doc.tipo) + (nota ? ': ' + nota : '') } }).catch(() => {})
    // Un profesional aprobado con un documento obligatorio rechazado sale del turno
    if (estado === 'rechazado' && def?.obligatorio && doc.profesional.estadoVerificacion === 'aprobado') {
      await sacarDelTurnoSiFaltanDocs(doc.profesionalId)
    }
    marcarCambio()
    return { ok: true }
  })

  // ── Cuentas de la IPS (coordinación, tesorería): solo el Superadministrador ──
  // POST /api/admin/cuentas/ips — crea la cuenta y le envía el enlace para crear su contraseña
  app.post('/cuentas/ips', { preHandler: P('cuentas'), config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const body = z.object({
      nombreCompleto: z.string().trim().min(3).max(200),
      email: z.string().trim().toLowerCase().email().max(150),
      rolIps: z.enum(['coordinador', 'tesoreria']),
    }).parse(request.body)
    const existe = await prisma.usuario.findUnique({ where: { email: body.email }, select: { id: true } })
    if (existe) return reply.status(409).send({ error: 'Ese correo ya tiene una cuenta en Salud en Casa.' })
    const azar = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12)
    const u = await prisma.usuario.create({
      data: { email: body.email, nombreCompleto: body.nombreCompleto, rol: 'admin', rolIps: body.rolIps, passwordHash: azar, claveCreada: false, estado: 'activo' },
      select: { id: true, email: true, rol: true, rolIps: true, nombreCompleto: true },
    })
    const para = await enviarEnlaceClave(u, 'ips')
    await prisma.bitacora.create({ data: { actorId: request.usuario.id, usuarioId: u.id, accion: 'crear_cuenta_ips', detalle: PERFILES_IPS[body.rolIps] + ' · enlace a ' + para } }).catch(() => {})
    return { ok: true, id: u.id, para }
  })

  // PUT /api/admin/cuentas/:id/perfil-ips — cambia el perfil de una cuenta de la IPS
  app.put('/cuentas/:id/perfil-ips', { preHandler: P('cuentas') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { rolIps } = z.object({ rolIps: z.enum(['coordinador', 'tesoreria']) }).parse(request.body)
    if (id === request.usuario.id) return reply.status(400).send({ error: 'No puede cambiar su propio perfil.' })
    const u = await prisma.usuario.findUnique({ where: { id }, select: { rol: true, email: true } })
    if (!u || u.rol !== 'admin' || u.email === SUPERADMIN_CORREO) return reply.status(400).send({ error: 'Solo se cambia el perfil de cuentas de coordinación o tesorería.' })
    await prisma.usuario.update({ where: { id }, data: { rolIps } })
    await prisma.sesion.deleteMany({ where: { usuarioId: id } })
    olvidarSesionesDe(id)
    await prisma.bitacora.create({ data: { actorId: request.usuario.id, usuarioId: id, accion: 'perfil_ips', detalle: PERFILES_IPS[rolIps] } }).catch(() => {})
    return { ok: true }
  })
}
