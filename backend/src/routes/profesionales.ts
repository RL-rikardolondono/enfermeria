import { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { autenticar, requerirRol, requerirPermiso, tienePermiso } from '../middleware/auth'
import { documentosAlDia, textoDocumentos, DOCUMENTOS, TIPOS_DOC, leerDataUrl, guardarArchivo, PERFILES, enTransicion, DIAS_TRANSICION } from '../services/catalogo'
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
  if (request.usuario.rol === 'admin') return tienePermiso(request.usuario, 'profesionales')
  const prof = await prisma.profesional.findUnique({ where: { id: profesionalId }, select: { usuarioId: true } })
  return !!prof && prof.usuarioId === request.usuario.id
}

const PERFIL_SELECT = {
  id: true, especialidad: true, perfil: true, registroProfesional: true, estadoVerificacion: true, disponible: true, disponibleDesde: true,
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
  app.get('/', { preHandler: requerirPermiso('profesionales') }, async (request) => {
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
    // Separación de funciones: la cuenta bancaria la cambia el propio profesional (o el Superadministrador), nunca Coordinación
    if (request.usuario.rol === 'admin' && !tienePermiso(request.usuario, 'cuentas') &&
      (body.banco !== undefined || body.cuentaBancaria !== undefined || body.tipoCuenta !== undefined)) {
      return reply.status(403).send({ error: 'La cuenta bancaria solo la cambia el profesional desde su app (o el Superadministrador).' })
    }

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
      const pr = await prisma.profesional.findUnique({ where: { id }, select: { estadoVerificacion: true, activo: true, perfil: true, createdAt: true } })
      if (!pr || pr.estadoVerificacion !== 'aprobado' || !pr.activo) return reply.status(409).send({ error: 'Su cuenta aún no está aprobada por la IPS.' })
      // Profesionales aprobados antes de este cambio: 30 días de transición para completar perfil y documentos
      const transicion = await enTransicion(pr)
      if (!pr.perfil && !transicion) return reply.status(409).send({ error: 'La IPS aún no le asigna su perfil profesional. Escríbale por WhatsApp.' })
      // Documentos obligatorios aprobados y vigentes (póliza al día)
      const docs = await documentosAlDia(id)
      if (!docs.ok && !transicion) return reply.status(409).send({ error: 'Para iniciar turno debe tener sus documentos al día. ' + textoDocumentos(docs) + ' Revíselos en Perfil → Mis documentos.', faltanDocumentos: true })
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

  // GET /api/profesionales/:id/servicios — el propio profesional o la IPS
  app.get('/:id/servicios', { preHandler: requerirPermiso('profesionales') }, async (request, reply) => {
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

  // ── Documentos del profesional (cédula, título, RETHUS, póliza, vacunas) ──
  // GET /api/profesionales/mis-documentos
  app.get('/mis-documentos', { preHandler: requerirRol('profesional') }, async (request, reply) => {
    const p = await prisma.profesional.findUnique({ where: { usuarioId: request.usuario.id }, select: { id: true, perfil: true, createdAt: true } })
    if (!p) return reply.status(404).send({ error: 'Perfil no encontrado' })
    let transicionHasta: string | null = null
    if (await enTransicion(p)) {
      const a = await prisma.ajuste.findUnique({ where: { clave: 'catalogo_v5' } })
      if (a) transicionHasta = new Date(new Date(a.valor).getTime() + DIAS_TRANSICION * 24 * 3600 * 1000).toISOString()
    }
    const items = await prisma.documentoProfesional.findMany({
      where: { profesionalId: p.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 40,
      select: { id: true, tipo: true, estado: true, vence: true, nota: true, archivoId: true, createdAt: true },
    })
    return { items, requeridos: DOCUMENTOS, alDia: await documentosAlDia(p.id), perfil: p.perfil ? PERFILES[p.perfil] || p.perfil : null, transicionHasta }
  })

  // POST /api/profesionales/mis-documentos — sube (o reemplaza) un documento; queda "en revisión" de la IPS
  app.post('/mis-documentos', { preHandler: requerirRol('profesional'), bodyLimit: 2560 * 1024, config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const body = z.object({
      tipo: z.enum(TIPOS_DOC),
      archivo: z.string().max(2200000),
      vence: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).parse(request.body)
    const p = await prisma.profesional.findUnique({ where: { usuarioId: request.usuario.id }, select: { id: true } })
    if (!p) return reply.status(404).send({ error: 'Perfil no encontrado' })
    const def = DOCUMENTOS.find((d) => d.tipo === body.tipo)!
    const a = leerDataUrl(body.archivo, body.archivo.startsWith('data:application/pdf') ? 1536 * 1024 : 700 * 1024)
    let vence: Date | null = null
    if (def.vence) {
      if (!body.vence) return reply.status(400).send({ error: 'Indique la fecha de vencimiento de ' + def.nombre.toLowerCase() + '.' })
      vence = new Date(body.vence + 'T23:59:59-05:00')
      if (vence.getTime() < Date.now()) return reply.status(400).send({ error: 'Ese documento ya está vencido. Suba el vigente.' })
    }
    // Un documento nuevo por tipo: los anteriores sin revisar se reemplazan (no se acumulan archivos)
    const doc = await prisma.$transaction(async (tx: any) => {
      const viejos = await tx.documentoProfesional.findMany({ where: { profesionalId: p.id, tipo: body.tipo, estado: 'pendiente' }, select: { id: true, archivoId: true } })
      for (const v of viejos) {
        await tx.documentoProfesional.delete({ where: { id: v.id } })
        if (v.archivoId) await tx.archivo.delete({ where: { id: v.archivoId } }).catch(() => {})
      }
      const arch = await guardarArchivo(tx, 'documento', a, request.usuario.id)
      return tx.documentoProfesional.create({
        data: { profesionalId: p.id, tipo: body.tipo, url: 'archivo:' + arch.id, archivoId: arch.id, estado: 'pendiente', vence },
        select: { id: true, tipo: true, estado: true, vence: true, createdAt: true },
      })
    })
    marcarCambio()
    return reply.status(201).send({ ok: true, documento: doc, mensaje: 'Documento recibido. La IPS lo revisará.' })
  })

  // GET /api/profesionales/documentos/:id/archivo — el propio profesional o la IPS (coordinación)
  app.get('/documentos/:id/archivo', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const d = await prisma.documentoProfesional.findUnique({ where: { id }, select: { archivoId: true, profesional: { select: { usuarioId: true } } } })
    const u = request.usuario
    const permitido = !!d && (d.profesional.usuarioId === u.id || (u.rol === 'admin' && tienePermiso(u, 'profesionales')))
    if (!d || !permitido || !d.archivoId) return reply.status(404).send({ error: 'Documento no encontrado' })
    const a = await prisma.archivo.findUnique({ where: { id: d.archivoId }, select: { mime: true, datos: true } })
    if (!a) return reply.status(404).send({ error: 'Documento no encontrado' })
    reply.header('Cache-Control', 'private, no-store').header('Content-Type', a.mime)
    return reply.send(Buffer.from(a.datos))
  })
}
