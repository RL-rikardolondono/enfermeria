import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { autenticar, requerirRol } from '../middleware/auth'
import { calcularTarifa } from '../services/tarifas'
import { notificarProfesionalesDisponibles, notificarUsuario } from './push'
import { liberarPago, marcarReembolso, PAGO_OBLIGATORIO } from '../services/liquidacion'
import { APP_URL } from '../utils/config'
import { marcarCambio } from '../utils/cambios'
import { vencerPendientesAntiguas, buscandoVigente, finBusqueda, MINUTOS_EXTRA_OFERTA } from '../services/vencimiento'
import { enTurno, profesionalRespondio, MAX_IGNORADAS } from '../services/presencia'
import { notificarUsuario as avisarA, pushConfigurado } from './push'
import { opinionesDe, recalcularPromedio } from '../services/opiniones'
import { crearQueja } from '../services/quejas'

const TIPOS = ['curacion', 'medicacion', 'inyeccion', 'control', 'cuidado_basico', 'urgencia'] as const
const ESTADOS = ['pendiente', 'asignado', 'en_camino', 'en_curso', 'completado', 'cancelado'] as const
const ACTIVOS = ['asignado', 'en_camino', 'en_curso'] as const

// Datos del profesional ASIGNADO que puede ver el paciente (nunca datos bancarios)
const PROF_PUBLICO = {
  select: {
    id: true, especialidad: true, calificacionPromedio: true, fotoUrl: true,
    usuario: { select: { nombreCompleto: true } },
  },
} as const

const paginacion = (maxLimit = 50, def = 10) => z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(maxLimit).default(def),
})

// Orden permitido de los estados que maneja el profesional asignado
const SIGUIENTE: Record<string, string[]> = { asignado: ['en_camino'], en_camino: ['en_curso'], en_curso: ['completado'] }

async function perfilProfesional(usuarioId: string) {
  return prisma.profesional.findUnique({
    where: { usuarioId },
    select: { id: true, estadoVerificacion: true, disponible: true, activo: true },
  })
}

// Profesionales que pueden atender a ESTE paciente ahora mismo:
// en turno ("Disponible", con avisos en el celular), aprobados, sin un servicio en curso y que el paciente no haya bloqueado.
async function profesionalesLibresPara(usuarioPacienteId: string): Promise<string[]> {
  const [ocupados, bloqueados, validos] = await prisma.$transaction([
    prisma.servicio.findMany({ where: { profesionalId: { not: null }, estado: { in: [...ACTIVOS] } }, select: { profesionalId: true } }),
    prisma.bloqueo.findMany({ where: { usuarioId: usuarioPacienteId }, select: { profesionalId: true } }),
    // Quien ya dejó pasar 3 solicitudes seguidas no cuenta como disponible
    prisma.profesional.findMany({ where: { ...enTurno(), ignoradas: { lt: MAX_IGNORADAS } }, select: { id: true } }),
  ])
  const fuera = new Set<string>([
    ...ocupados.map((o: { profesionalId: string | null }) => o.profesionalId as string),
    ...bloqueados.map((b: { profesionalId: string }) => b.profesionalId),
  ])
  return validos.map((v: { id: string }) => v.id).filter((id: string) => !fuera.has(id))
}

// Bloqueo corto en la base para que dos solicitudes simultáneas no se pisen (por persona o por profesional)
async function bloquearClave(tx: any, clave: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${clave}))::text`
}

// Antes de ser elegido, el profesional solo ve la zona (sin número de casa) y el primer nombre del paciente
// (nunca la dirección: solo el barrio que el paciente escribió aparte y la ciudad)
function zonaAproximada(direccion: string | null, barrio?: string | null) {
  const partes = (direccion || '').split(',').map((p) => p.trim()).filter(Boolean)
  const ciudad = partes.length > 1 ? partes[partes.length - 1] : ''
  return [barrio ? 'Barrio ' + barrio : '', ciudad].filter(Boolean).join(', ') || 'Zona por confirmar'
}

// Avisar a los profesionales disponibles cuando una solicitud vuelve a buscar profesional
export async function avisarBusquedaReabierta(servicioId: string, excluir: string[] = []) {
  const s = await prisma.servicio.findUnique({ where: { id: servicioId }, select: { tipo: true, paciente: { select: { usuarioId: true } } } })
  if (!s) return
  const bloqueados = s.paciente
    ? (await prisma.bloqueo.findMany({ where: { usuarioId: s.paciente.usuarioId }, select: { profesionalId: true } })).map((b: { profesionalId: string }) => b.profesionalId)
    : []
  await notificarProfesionalesDisponibles({
    titulo: 'Solicitud disponible de nuevo',
    cuerpo: 'Una solicitud de ' + s.tipo.replace('_', ' ') + ' necesita profesional. Ofrézcase si puede ir ya.',
    url: `${APP_URL}/app-enfermero.html`,
    excluir: [...bloqueados, ...excluir],
  }).catch(() => {})
}

export async function serviciosRoutes(app: FastifyInstance) {

  // GET /api/servicios/disponibles — ¿hay profesionales para atenderme ahora? (antes de pedir o pagar)
  app.get('/disponibles', { preHandler: requerirRol('paciente') }, async (request) => {
    await vencerPendientesAntiguas()
    const libres = await profesionalesLibresPara(request.usuario.id)
    return { disponibles: libres.length }
  })

  // POST /api/servicios — crear solicitud (solo cuentas de paciente)
  app.post('/', { preHandler: requerirRol('paciente') }, async (request, reply) => {
    const body = z.object({
      tipo: z.enum(TIPOS),
      descripcion: z.string().trim().min(5).max(500),
      direccion: z.string().trim().min(5).max(500),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      pacienteId: z.string().uuid().optional(),
      barrio: z.string().trim().max(80).optional(),
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

    await vencerPendientesAntiguas(true)

    // Si ya tiene una búsqueda abierta (por ejemplo, la respuesta anterior se perdió), se le muestra esa
    const abierta = await prisma.servicio.findFirst({ where: { ...buscandoVigente(), paciente: { usuarioId: request.usuario.id } }, select: { id: true } })
    if (abierta) return reply.status(409).send({ error: 'Ya tiene una solicitud buscando profesional. Le mostramos los profesionales que se ofrecen.', buscandoId: abierta.id })

    // No se recibe la solicitud (ni se cobra) si nadie puede atenderla ahora
    const libres = await profesionalesLibresPara(request.usuario.id)
    if (!libres.length) {
      return reply.status(409).send({
        error: 'En este momento no hay profesionales disponibles. Intente de nuevo en unos minutos o escríbanos por WhatsApp.',
        sinProfesionales: true,
      })
    }

    const monto = await calcularTarifa(body.tipo)
    // Una búsqueda a la vez por cuenta (también si se pulsa "Confirmar" dos veces seguidas)
    const servicio = await prisma.$transaction(async (tx: any) => {
      await bloquearClave(tx, 'solicitud:' + request.usuario.id)
      const enBusqueda = await tx.servicio.findFirst({ where: { ...buscandoVigente(), paciente: { usuarioId: request.usuario.id } }, select: { id: true } })
      if (enBusqueda) return { yaBuscando: enBusqueda.id }
      return tx.servicio.create({
        data: {
          pacienteId: paciente.id,
          tipo: body.tipo,
          descripcion: body.descripcion,
          direccion: body.direccion,
          barrio: body.barrio || null,
          lat: body.lat,
          lng: body.lng,
          monto,
          estado: 'pendiente',
          buscandoHasta: finBusqueda(),
        },
      })
    })
    if (!servicio || (servicio as any).yaBuscando) return reply.status(409).send({ error: 'Ya tiene una solicitud buscando profesional. Le mostramos los profesionales que se ofrecen.', buscandoId: (servicio as any)?.yaBuscando })

    marcarCambio()
    // Aviso a los profesionales libres (en turno, sin servicio y no bloqueados por este paciente), en segundo plano.
    // Quien ya dejó pasar 3 solicitudes seguidas sin responder sale del turno y se le avisa.
    setImmediate(async () => {
      try {
        const avisar = await profesionalesLibresPara(request.usuario.id)
        if (!avisar.length) return
        // Solo cuenta como "dejó pasar" a quien sí recibe avisos y no está esperando respuesta de otra oferta suya
        if (pushConfigurado()) {
          const conAvisos = await prisma.profesional.findMany({
            where: {
              id: { in: avisar },
              usuario: { notificaciones: { some: { tipo: 'push_subscription' } } },
              ofertas: { none: { estado: 'activa' } },
            },
            select: { id: true },
          })
          const ids = conAvisos.map((c: { id: string }) => c.id)
          {
            // Quien ya dejó pasar 3 solicitudes seguidas sale del turno (esta ya no se le envía)
            // (ya no aparecen entre los libres: se buscan entre todos los que siguen en turno)
            const dormidos = await prisma.profesional.findMany({ where: { ...enTurno(), ignoradas: { gte: MAX_IGNORADAS } }, select: { id: true, usuarioId: true } })
            const fuera = new Set(dormidos.map((d: { id: string }) => d.id))
            const siguen = ids.filter((i: string) => !fuera.has(i))
            if (siguen.length) await prisma.profesional.updateMany({ where: { id: { in: siguen } }, data: { ignoradas: { increment: 1 } } })
            avisar.splice(0, avisar.length, ...avisar.filter((i: string) => !fuera.has(i)))
            if (dormidos.length) {
              await prisma.profesional.updateMany({ where: { id: { in: dormidos.map((d: { id: string }) => d.id) } }, data: { disponible: false, disponibleDesde: null, ignoradas: 0 } })
              await prisma.oferta.updateMany({ where: { profesionalId: { in: dormidos.map((d: { id: string }) => d.id) }, estado: 'activa' }, data: { estado: 'retirada' } })
              marcarCambio()
              for (const d of dormidos) {
                avisarA(d.usuarioId, {
                  titulo: 'Quedó como No disponible',
                  cuerpo: 'Dejó pasar ' + MAX_IGNORADAS + ' solicitudes seguidas sin responder. Cuando pueda atender, vuelva a ponerse en "Disponible".',
                }).catch(() => {})
              }
            }
          }
        }
        if (!avisar.length) return
        await notificarProfesionalesDisponibles({
          titulo: 'Nueva solicitud de servicio',
          cuerpo: 'Hay una nueva solicitud de ' + body.tipo.replace('_', ' ') + '. Ofrézcase si puede ir ya.',
          url: `${APP_URL}/app-enfermero.html`,
          solo: avisar,
        })
      } catch (e) { console.error('No se pudo avisar a los profesionales', e) }
    })

    return reply.status(201).send({
      id: servicio.id,
      estado: servicio.estado,
      monto: servicio.monto,
      buscandoHasta: servicio.buscandoHasta,
      ahora: new Date(),
      mensaje: 'Solicitud enviada. Los profesionales disponibles se están ofreciendo; usted elige.',
    })
  })

  // GET /api/servicios — servicios del usuario
  app.get('/', { preHandler: autenticar }, async (request) => {
    const { page, limit } = paginacion(100, 10).parse(request.query)
    const { activos } = z.object({ activos: z.enum(['1']).optional() }).parse(request.query)
    const usuario = request.usuario

    let where: any
    if (usuario.rol === 'paciente') {
      await vencerPendientesAntiguas()
      where = { paciente: { usuarioId: usuario.id } }
    } else if (usuario.rol === 'profesional') {
      await vencerPendientesAntiguas()
      const profesional = await perfilProfesional(usuario.id)
      if (!profesional) return { total: 0, page, limit, items: [] }
      where = { profesionalId: profesional.id }
    } else if (usuario.rol === 'admin') {
      where = {}
    } else {
      return { total: 0, page, limit, items: [] }
    }
    if (activos) where.estado = { in: [...ACTIVOS] }

    const [total, items] = await prisma.$transaction([
      prisma.servicio.count({ where }),
      prisma.servicio.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          paciente: {
            select: {
              id: true, nombreCompleto: true, parentesco: true, esTitular: true, alergias: true, antecedentes: true,
              usuario: { select: { nombreCompleto: true, telefono: true } },
            },
          },
          profesional: PROF_PUBLICO,
          pago: { select: { estado: true, monto: true, estadoLiquidacion: true } },
          _count: { select: { ofertas: { where: { estado: 'activa' } }, quejas: true } },
        },
      }),
    ])

    // Profesional: nada de calificaciones con nombre ni notas internas; datos clínicos y teléfono solo de
    // servicios activos o completados en los últimos 30 días (Ley 1581)
    if (usuario.rol === 'profesional') {
      const hace30 = Date.now() - 30 * 24 * 3600 * 1000
      const vistos = items.map((s: any) => {
        const { calificacion, comentarioCalificacion, resenaOculta, calificadoEn, ...resto } = s
        const vigente = (ACTIVOS as readonly string[]).includes(s.estado) || (s.estado === 'completado' && s.fechaFin && new Date(s.fechaFin).getTime() > hace30)
        if (!vigente && resto.paciente) {
          resto.paciente = { id: resto.paciente.id, nombreCompleto: resto.paciente.nombreCompleto, parentesco: resto.paciente.parentesco, esTitular: resto.paciente.esTitular, usuario: { nombreCompleto: resto.paciente.usuario?.nombreCompleto } }
          resto.direccion = null; resto.lat = null; resto.lng = null; resto.descripcion = null
        }
        return resto
      })
      return { total, page, limit, items: vistos, ahora: new Date(), pagosEnLinea: PAGO_OBLIGATORIO }
    }
    return { total, page, limit, items, ahora: new Date(), pagosEnLinea: PAGO_OBLIGATORIO }
  })

  // GET /api/servicios/pendientes — solicitudes buscando profesional (solo profesionales APROBADOS)
  app.get('/pendientes', { preHandler: requerirRol('profesional', 'admin') }, async (request, reply) => {
    let profesionalId: string | null = null
    if (request.usuario.rol === 'profesional') {
      const profesional = await perfilProfesional(request.usuario.id)
      if (!profesional || profesional.estadoVerificacion !== 'aprobado') {
        return reply.status(403).send({ error: 'Su cuenta aún no ha sido verificada por la Clínica Reina Elizabeth IPS.' })
      }
      profesionalId = profesional.id
      await vencerPendientesAntiguas()
      // Solo quien está en turno y libre ve las solicitudes. Abrir la lista a mano cuenta como "respondió"
      // (los refrescos automáticos de la app no cuentan).
      const turno = await prisma.profesional.count({ where: { id: profesional.id, ...enTurno() } })
      if (!turno) return { total: 0, page: 1, limit: 0, items: [], motivo: 'no_disponible' }
      if (request.headers['x-segundo-plano'] !== '1') await profesionalRespondio(profesional.id)
      const ocupado = await prisma.servicio.count({ where: { profesionalId: profesional.id, estado: { in: [...ACTIVOS] } } })
      if (ocupado) return { total: 0, page: 1, limit: 0, items: [], motivo: 'ocupado' }
    }
    const { page, limit } = paginacion(50, 20).parse(request.query)
    await vencerPendientesAntiguas()

    const where: any = buscandoVigente()
    if (profesionalId) {
      // No ve las solicitudes de pacientes que lo bloquearon
      const bloqueadores = (await prisma.bloqueo.findMany({ where: { profesionalId }, select: { usuarioId: true } }))
        .map((b: { usuarioId: string }) => b.usuarioId)
      if (bloqueadores.length) where.paciente = { usuarioId: { notIn: bloqueadores } }
    }

    const [total, items] = await prisma.$transaction([
      prisma.servicio.count({ where }),
      prisma.servicio.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, tipo: true, estado: true, descripcion: true, direccion: true, barrio: true, prioridad: true,
          fechaSolicitud: true, createdAt: true, monto: true, buscandoHasta: true,
          paciente: { select: { id: true, nombreCompleto: true, usuario: { select: { nombreCompleto: true } } } },
          ofertas: { where: { profesionalId: profesionalId || '-', estado: 'activa' }, select: { id: true } },
          _count: { select: { ofertas: { where: { estado: 'activa' } } } },
        },
      }),
    ])

    return {
      total, page, limit, ahora: new Date(),
      items: items.map((s: (typeof items)[number]) => {
        const { ofertas, _count, direccion, barrio, paciente, ...resto } = s
        const nombre = paciente?.nombreCompleto || paciente?.usuario?.nombreCompleto || 'Paciente'
        return {
          ...resto,
          direccion: profesionalId ? zonaAproximada(direccion, barrio) : direccion,
          paciente: profesionalId ? { nombreCompleto: nombre.split(' ')[0] } : paciente,
          miOferta: ofertas.length > 0, totalOfertas: _count.ofertas,
        }
      }),
    }
  })

  // POST /api/servicios/:id/ofertas — el profesional se ofrece para atender la solicitud
  app.post('/:id/ofertas', { preHandler: requerirRol('profesional') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const profesional = await perfilProfesional(request.usuario.id)
    if (!profesional || profesional.estadoVerificacion !== 'aprobado') return reply.status(403).send({ error: 'Su cuenta no está verificada.' })
    const turno = await prisma.profesional.count({ where: { id: profesional.id, ...enTurno() } })
    if (!turno) return reply.status(409).send({ error: 'Póngase en "Disponible" para ofrecerse.' })
    await profesionalRespondio(profesional.id)
    await vencerPendientesAntiguas()

    const ocupado = await prisma.servicio.count({ where: { profesionalId: profesional.id, estado: { in: [...ACTIVOS] } } })
    if (ocupado) return reply.status(409).send({ error: 'Termine o libere su servicio activo antes de ofrecerse para otro.' })

    const servicio = await prisma.servicio.findFirst({
      where: { id, ...buscandoVigente() },
      select: { id: true, buscandoHasta: true, paciente: { select: { usuarioId: true } } },
    })
    if (!servicio) return reply.status(409).send({ error: 'Esta solicitud ya no está disponible.' })
    if (servicio.paciente) {
      const bloqueado = await prisma.bloqueo.count({ where: { usuarioId: servicio.paciente.usuarioId, profesionalId: profesional.id } })
      if (bloqueado) return reply.status(409).send({ error: 'Esta solicitud ya no está disponible.' })
    }
    const activas = await prisma.oferta.count({ where: { servicioId: id, estado: 'activa' } })
    if (activas >= 10) return reply.status(409).send({ error: 'Esta solicitud ya tiene suficientes profesionales ofrecidos.' })

    const previa = await prisma.oferta.findUnique({
      where: { servicioId_profesionalId: { servicioId: id, profesionalId: profesional.id } },
      select: { estado: true },
    })
    if (previa?.estado === 'desistio') return reply.status(409).send({ error: 'Usted ya desistió de esta solicitud.' })
    await prisma.oferta.upsert({
      where: { servicioId_profesionalId: { servicioId: id, profesionalId: profesional.id } },
      create: { servicioId: id, profesionalId: profesional.id },
      update: { estado: 'activa' },
    })
    // Si la solicitud se cerró justo en este instante, la oferta no queda viva
    const sigue = await prisma.servicio.count({ where: { id, estado: 'pendiente' } })
    if (!sigue) {
      await prisma.oferta.updateMany({ where: { servicioId: id, profesionalId: profesional.id }, data: { estado: 'vencida' } })
      return reply.status(409).send({ error: 'Esta solicitud ya no está disponible.' })
    }
    // Si se ofrece al final, el paciente tiene al menos 3 minutos para elegir
    const minimo = new Date(Date.now() + MINUTOS_EXTRA_OFERTA * 60 * 1000)
    if (!servicio.buscandoHasta || servicio.buscandoHasta < minimo) {
      await prisma.servicio.updateMany({ where: { id, estado: 'pendiente' }, data: { buscandoHasta: minimo } })
    }
    marcarCambio()
    return reply.status(201).send({ ok: true, mensaje: 'Listo. El paciente verá su oferta y podrá elegirlo.' })
  })

  // DELETE /api/servicios/:id/ofertas — el profesional retira su oferta
  app.delete('/:id/ofertas', { preHandler: requerirRol('profesional') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const profesional = await perfilProfesional(request.usuario.id)
    if (!profesional) return reply.status(403).send({ error: 'Acción no permitida' })
    await prisma.oferta.updateMany({ where: { servicioId: id, profesionalId: profesional.id, estado: 'activa' }, data: { estado: 'retirada' } })
    marcarCambio()
    return { ok: true }
  })

  // GET /api/servicios/:id/ofertas — el paciente ve quiénes se ofrecieron, con sus estrellas y opiniones
  app.get('/:id/ofertas', { preHandler: requerirRol('paciente') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const leer = () => prisma.servicio.findUnique({
      where: { id },
      select: { id: true, estado: true, tipo: true, buscandoHasta: true, fechaSolicitud: true, notas: true, paciente: { select: { usuarioId: true } }, pago: { select: { estado: true } } },
    })
    let servicio = await leer()
    // Si el tiempo de búsqueda ya terminó, se cierra en este momento para avisarle al paciente sin esperas
    if (servicio && servicio.estado === 'pendiente' && servicio.buscandoHasta && servicio.buscandoHasta <= new Date()) {
      await vencerPendientesAntiguas(true)
      servicio = await leer()
    }
    if (!servicio || servicio.paciente?.usuarioId !== request.usuario.id) return reply.status(404).send({ error: 'Servicio no encontrado' })

    const ofertas = servicio.estado === 'pendiente'
      ? await prisma.oferta.findMany({
        where: { servicioId: id, estado: 'activa', profesional: enTurno() },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, createdAt: true,
          profesional: {
            select: {
              id: true, especialidad: true, totalServicios: true, anosExperiencia: true, fotoUrl: true,
              usuario: { select: { nombreCompleto: true } },
            },
          },
        },
      })
      : []
    const items = await Promise.all(ofertas.map(async (o: (typeof ofertas)[number]) => ({
      id: o.id,
      creada: o.createdAt,
      profesional: {
        id: o.profesional.id,
        nombre: o.profesional.usuario.nombreCompleto,
        especialidad: o.profesional.especialidad,
        totalServicios: o.profesional.totalServicios,
        anosExperiencia: o.profesional.anosExperiencia,
        fotoUrl: o.profesional.fotoUrl,
        opiniones: await opinionesDe(o.profesional.id, 3),
      },
    })))
    const { paciente, ...datos } = servicio
    return { servicio: datos, ahora: new Date(), items }
  })

  // POST /api/servicios/:id/elegir — el paciente escoge al profesional que lo atenderá
  app.post('/:id/elegir', { preHandler: requerirRol('paciente') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { ofertaId } = z.object({ ofertaId: z.string().uuid() }).parse(request.body)

    const servicio = await prisma.servicio.findFirst({
      where: { id, ...buscandoVigente(), paciente: { usuarioId: request.usuario.id } },
      select: { id: true, tipo: true },
    })
    if (!servicio) return reply.status(409).send({ error: 'La búsqueda de esta solicitud ya terminó.' })
    const oferta = await prisma.oferta.findFirst({
      where: { id: ofertaId, servicioId: id, estado: 'activa' },
      select: { id: true, profesionalId: true, profesional: { select: { usuarioId: true, estadoVerificacion: true, disponible: true, activo: true, usuario: { select: { estado: true } } } } },
    })
    const noDisponible = { error: 'Ese profesional ya no está disponible. Elija otro.' }
    if (!oferta) return reply.status(409).send(noDisponible)
    const enTurnoAhora = await prisma.profesional.count({ where: { id: oferta.profesionalId, ...enTurno() } })
    if (!enTurnoAhora) {
      await prisma.oferta.updateMany({ where: { id: oferta.id, estado: 'activa' }, data: { estado: 'retirada' } })
      marcarCambio()
      return reply.status(409).send(noDisponible)
    }

    // Con pagos en línea activos, el paciente tiene 15 minutos para pagar después de elegir
    const plazoPago = PAGO_OBLIGATORIO ? new Date(Date.now() + 15 * 60 * 1000) : null
    const resultado = await prisma.$transaction(async (tx: any) => {
      // Un profesional a la vez: dos pacientes no pueden quedarse con el mismo profesional
      await bloquearClave(tx, 'profesional:' + oferta.profesionalId)
      const ocupado = await tx.servicio.count({ where: { profesionalId: oferta.profesionalId, estado: { in: [...ACTIVOS] } } })
      if (ocupado) return 'ocupado'
      const o = await tx.oferta.updateMany({ where: { id: oferta.id, estado: 'activa' }, data: { estado: 'elegida' } })
      if (o.count === 0) return 'oferta'
      // Si ya pagó (el profesional anterior desistió), no hay plazo de pago nuevo
      const yaPago = await tx.pago.findUnique({ where: { servicioId: id }, select: { estado: true } })
      const r = await tx.servicio.updateMany({
        where: { id, estado: 'pendiente' },
        data: { estado: 'asignado', profesionalId: oferta.profesionalId, buscandoHasta: yaPago?.estado === 'aprobado' ? null : plazoPago },
      })
      if (r.count === 0) throw new Error('cambio')
      await tx.oferta.updateMany({ where: { servicioId: id, estado: 'activa' }, data: { estado: 'no_elegida' } })
      // Sus otras ofertas se retiran: atiende un servicio a la vez
      await tx.oferta.updateMany({ where: { profesionalId: oferta.profesionalId, estado: 'activa' }, data: { estado: 'retirada' } })
      return 'ok'
    }).catch(() => 'cambio')
    if (resultado === 'ocupado') return reply.status(409).send({ error: 'Ese profesional acaba de tomar otro servicio. Elija otro.' })
    if (resultado === 'oferta') return reply.status(409).send(noDisponible)
    if (resultado !== 'ok') return reply.status(409).send({ error: 'La solicitud cambió de estado; recargue.' })
    marcarCambio()

    setImmediate(() => {
      notificarUsuario(oferta.profesional.usuarioId, {
        titulo: '¡El paciente lo eligió!',
        cuerpo: 'Tiene un servicio de ' + servicio.tipo.replace('_', ' ') + '. Abra la app para ver la dirección.',
      }).catch(() => {})
    })
    return prisma.servicio.findUnique({ where: { id }, include: { profesional: PROF_PUBLICO, pago: { select: { estado: true } } } })
  })

  // GET /api/servicios/:id — solo el paciente dueño, el profesional asignado o el admin
  app.get('/:id', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const servicio = await prisma.servicio.findUnique({
      where: { id },
      include: {
        paciente: {
          include: { usuario: { select: { nombreCompleto: true, telefono: true } } },
        },
        profesional: PROF_PUBLICO,
        evoluciones: { orderBy: { createdAt: 'asc' } },
        pago: { select: { estado: true, monto: true, estadoLiquidacion: true } },
      },
    })
    if (!servicio) return reply.status(404).send({ error: 'Servicio no encontrado' })

    const { rol, id: usuarioId } = request.usuario
    let permitido = rol === 'admin'
    if (rol === 'paciente') permitido = servicio.paciente?.usuarioId === usuarioId
    // El profesional ve sus servicios solo desde la lista (con los datos limitados por la Ley 1581)
    if (!permitido) return reply.status(404).send({ error: 'Servicio no encontrado' })
    return servicio
  })

  // PUT /api/servicios/:id/estado
  app.put('/:id/estado', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { estado, firma } = z.object({
      estado: z.enum(['asignado', 'en_camino', 'en_curso', 'completado', 'cancelado']),
      // Recibido del servicio: firma manuscrita del paciente o acudiente, o el motivo por el que no pudo firmar
      firma: z.object({
        imagen: z.string().max(250000).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/, 'Firma no válida').optional(),
        nombre: z.string().trim().min(3).max(200).optional(),
        motivo: z.string().trim().min(5).max(300).optional(),
      }).optional(),
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

    // ── Profesional ──────────────────────────────────────────────
    if (rol === 'profesional') {
      const profesional = await perfilProfesional(usuarioId)
      if (!profesional || profesional.estadoVerificacion !== 'aprobado') {
        return reply.status(403).send({ error: 'Su cuenta no está verificada.' })
      }
      const esSuProfesional = servicio.profesionalId === profesional.id

      // Ahora el paciente escoge entre los que se ofrecen: ya no se "toma" directamente
      if (estado === 'asignado') {
        return reply.status(400).send({ error: 'Ahora el paciente elige al profesional. Pulse "Ofrecerme" en la solicitud.' })
      }

      if (estado === 'cancelado') {
        // Descartar una solicitud pendiente no la cancela para el paciente (solo se oculta para este profesional)
        if (servicio.estado === 'pendiente') {
          await profesionalRespondio(profesional.id)
          await prisma.oferta.updateMany({ where: { servicioId: id, profesionalId: profesional.id, estado: 'activa' }, data: { estado: 'retirada' } })
          return { ok: true, mensaje: 'Solicitud descartada' }
        }
        if (!esSuProfesional) return reply.status(403).send({ error: 'Este servicio no está asignado a usted' })
        if (!['asignado', 'en_camino'].includes(servicio.estado)) {
          return reply.status(400).send({ error: 'La visita ya comenzó; comuníquese con la IPS' })
        }
        // El profesional desiste antes de la visita: la solicitud vuelve a buscar profesional por 10 minutos
        const r = await prisma.$transaction(async (tx: any) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'pago:' + id}))::text`
          return tx.servicio.updateMany({
            where: { id, estado: servicio.estado, profesionalId: profesional.id },
            data: { estado: 'pendiente', profesionalId: null, fechaSolicitud: new Date(), buscandoHasta: finBusqueda() },
          })
        })
        if (r.count === 0) return reply.status(409).send({ error: 'El servicio cambió de estado; recargue' })
        await prisma.oferta.updateMany({ where: { servicioId: id, profesionalId: profesional.id }, data: { estado: 'desistio' } })
        marcarCambio()
        setImmediate(() => { avisarBusquedaReabierta(id, [profesional.id]).catch(() => {}) })
        return prisma.servicio.findUnique({ where: { id } })
      }

      if (!esSuProfesional) return reply.status(403).send({ error: 'Este servicio no está asignado a usted' })
      if (!SIGUIENTE[servicio.estado]?.includes(estado)) {
        return reply.status(400).send({ error: 'Cambio de estado no permitido' })
      }
      // Con pagos en línea activos, el profesional sale solo cuando el paciente ya pagó
      if (estado === 'en_camino' && PAGO_OBLIGATORIO && servicio.pago?.estado !== 'aprobado') {
        return reply.status(409).send({ error: 'El paciente aún no ha pagado este servicio. Espere el aviso de pago.' })
      }
      if (estado === 'completado') {
        // Debe existir una nota clínica de ESTE profesional
        const notas = await prisma.evolucion.count({ where: { servicioId: id, profesionalId: profesional.id } })
        if (notas === 0) return reply.status(400).send({ error: 'Registre la nota clínica antes de finalizar el servicio' })
        // Y el recibido: firma del paciente o acudiente con su nombre, o el motivo por el que no firmó
        const conFirma = !!(firma?.imagen && firma?.nombre)
        if (!conFirma && !firma?.motivo) return reply.status(400).send({ error: 'Pida la firma del paciente o acudiente (o escriba por qué no pudo firmar) antes de completar' })
      }
    }

    // ── Paciente: solo puede cancelar sus propios servicios antes de la visita ──
    if (rol === 'paciente') {
      if (servicio.paciente?.usuarioId !== usuarioId) return reply.status(404).send({ error: 'Servicio no encontrado' })
      if (estado !== 'cancelado') return reply.status(403).send({ error: 'Acción no permitida' })
      if (servicio.estado === 'en_curso') {
        return reply.status(400).send({ error: 'La visita ya comenzó; comuníquese con la IPS' })
      }
    }

    // ── IPS: solo cancela o cierra ──
    if (rol === 'admin') {
      if (!['cancelado', 'completado'].includes(estado)) return reply.status(400).send({ error: 'Cambio no permitido' })
      if (estado === 'completado' && servicio._count.evoluciones === 0) {
        return reply.status(400).send({ error: 'El servicio no tiene nota clínica registrada' })
      }
    }

    // Actualización atómica: si el estado cambió mientras tanto, no se pisa.
    // Usa el mismo candado que la confirmación de pagos, para que un pago y una cancelación no se crucen.
    const r = await prisma.$transaction(async (tx: any) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'pago:' + id}))::text`
      const u = await tx.servicio.updateMany({
      // El profesional solo mueve el servicio si sigue siendo suyo (una pestaña vieja no toca el de otro)
      where: { id, estado: servicio.estado, ...(rol === 'profesional' ? { profesionalId: servicio.profesionalId } : {}) },
      data: {
        estado,
        buscandoHasta: estado === 'cancelado' ? null : undefined,
        notas: estado === 'cancelado' && rol === 'paciente' ? 'Cancelado por el paciente' : estado === 'cancelado' && rol === 'admin' ? 'Cancelado por la IPS' : undefined,
        fechaInicio: estado === 'en_curso' ? new Date() : undefined,
        fechaFin: estado === 'completado' ? new Date() : undefined,

      },
    })
      // La firma de recibido se guarda en la misma operación: no queda un servicio completado sin recibido
      if (u.count > 0 && estado === 'completado' && rol === 'profesional' && firma) {
        const conFirma = !!(firma.imagen && firma.nombre)
        const datos = { firma: conFirma ? firma.imagen : null, nombre: conFirma ? firma.nombre : null, motivo: conFirma ? null : (firma.motivo || null) }
        await tx.recibido.upsert({ where: { servicioId: id }, create: { servicioId: id, ...datos }, update: datos })
      }
      return u
    })
    if (r.count === 0) return reply.status(409).send({ error: 'El servicio cambió de estado; recargue' })
    if (estado === 'cancelado') {
      await prisma.oferta.updateMany({ where: { servicioId: id, estado: 'activa' }, data: { estado: 'vencida' } })
    }
    marcarCambio()

    // Pago retenido: se libera al completar con nota clínica; se marca para reembolso si se cancela
    if (estado === 'completado') {
      await liberarPago(id)
      if (servicio.profesionalId) {
        await prisma.profesional.update({ where: { id: servicio.profesionalId }, data: { totalServicios: { increment: 1 } } })
      }
    }
    if (estado === 'cancelado') await marcarReembolso(id)

    return prisma.servicio.findUnique({ where: { id } })
  })

  // POST /api/servicios/:id/evolucion — nota clínica del profesional asignado durante la visita
  app.post('/:id/evolucion', { preHandler: requerirRol('profesional', 'admin') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({
      tensionSistolica: z.number().int().min(40).max(300).optional(),
      tensionDiastolica: z.number().int().min(20).max(200).optional(),
      frecuenciaCardiaca: z.number().int().min(20).max(250).optional(),
      temperatura: z.number().min(30).max(45).optional(),
      saturacionOxigeno: z.number().int().min(0).max(100).optional(),
      glucemia: z.number().int().min(10).max(1000).optional(),
      observaciones: z.string().trim().max(5000).optional(),
      procedimientos: z.string().trim().max(5000).optional(),
      impresionDiagnostica: z.string().trim().max(1000).optional(),
      recomendaciones: z.string().trim().max(3000).optional(),
    }).parse(request.body)
    if (!body.observaciones && !body.procedimientos) {
      return reply.status(400).send({ error: 'Escriba las observaciones o los procedimientos realizados' })
    }

    const servicio = await prisma.servicio.findUnique({ where: { id }, select: { profesionalId: true, estado: true } })
    if (!servicio) return reply.status(404).send({ error: 'Servicio no encontrado' })
    if (!['en_camino', 'en_curso'].includes(servicio.estado)) {
      return reply.status(400).send({ error: 'La nota clínica se registra durante la visita' })
    }

    let profesionalId: string | undefined
    if (request.usuario.rol === 'profesional') {
      const profesional = await perfilProfesional(request.usuario.id)
      if (!profesional || profesional.estadoVerificacion !== 'aprobado' || servicio.profesionalId !== profesional.id) {
        return reply.status(403).send({ error: 'Este servicio no está asignado a usted' })
      }
      profesionalId = profesional.id
    }

    // Doble clic en "Guardar nota": la misma nota en el último minuto no se repite
    const evolucion = await prisma.$transaction(async (tx: any) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'evolucion:' + id}))::text`
      const reciente = await tx.evolucion.findFirst({
        where: { servicioId: id, profesionalId: profesionalId ?? null, createdAt: { gte: new Date(Date.now() - 60 * 1000) }, observaciones: body.observaciones ?? null, procedimientos: body.procedimientos ?? null },
        orderBy: { createdAt: 'desc' },
      })
      if (reciente) return reciente
      return tx.evolucion.create({ data: { servicioId: id, profesionalId, ...body } })
    })
    marcarCambio()
    return reply.status(201).send(evolucion)
  })

  // GET /api/servicios/admin/todos
  app.get('/admin/todos', { preHandler: requerirRol('admin') }, async (request) => {
    const { page, limit } = paginacion(100, 20).parse(request.query)
    const { estado } = z.object({ estado: z.enum(ESTADOS).optional() }).parse(request.query)
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
          profesional: PROF_PUBLICO,
        },
      }),
    ])

    return { total, page, limit, items }
  })

  // POST /api/servicios/:id/calificar — estrellas, comentario, queja opcional y bloqueo opcional
  app.post('/:id/calificar', { preHandler: requerirRol('paciente') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { puntuacion, comentario, queja, bloquear } = z.object({
      puntuacion: z.number().int().min(1).max(5),
      comentario: z.string().trim().max(1000).optional(),
      queja: z.string().trim().min(10, 'Cuéntenos qué pasó (mínimo 10 letras)').max(2000).optional(),
      bloquear: z.boolean().optional(),
    }).parse(request.body)

    const servicio = await prisma.servicio.findUnique({
      where: { id },
      select: { estado: true, profesionalId: true, paciente: { select: { usuarioId: true } } },
    })
    if (!servicio || servicio.paciente?.usuarioId !== request.usuario.id) {
      return reply.status(404).send({ error: 'Servicio no encontrado' })
    }
    if (servicio.estado !== 'completado') return reply.status(400).send({ error: 'Solo se califican servicios completados' })

    const r = await prisma.servicio.updateMany({
      where: { id, calificacion: null },
      data: { calificacion: puntuacion, comentarioCalificacion: comentario || null, calificadoEn: new Date() },
    })
    if (r.count === 0) return reply.status(409).send({ error: 'Ya calificó este servicio' })

    if (servicio.profesionalId) {
      await recalcularPromedio(servicio.profesionalId)
      if (bloquear) {
        await prisma.bloqueo.upsert({
          where: { usuarioId_profesionalId: { usuarioId: request.usuario.id, profesionalId: servicio.profesionalId } },
          create: { usuarioId: request.usuario.id, profesionalId: servicio.profesionalId },
          update: {},
        })
      }
    }
    if (queja) await crearQueja({ servicioId: id, usuarioId: request.usuario.id, profesionalId: servicio.profesionalId, texto: queja })
    marcarCambio()
    return { ok: true }
  })

  // POST /api/servicios/:id/queja — queja a la IPS sobre un servicio (por ejemplo, el profesional no llegó)
  app.post('/:id/queja', { preHandler: requerirRol('paciente') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { texto, bloquear } = z.object({
      texto: z.string().trim().min(10, 'Cuéntenos qué pasó (mínimo 10 letras)').max(2000),
      bloquear: z.boolean().optional(),
    }).parse(request.body)

    const servicio = await prisma.servicio.findUnique({
      where: { id },
      select: { profesionalId: true, paciente: { select: { usuarioId: true } }, _count: { select: { quejas: { where: { usuarioId: { not: 'sistema' } } } } } },
    })
    if (!servicio || servicio.paciente?.usuarioId !== request.usuario.id) return reply.status(404).send({ error: 'Servicio no encontrado' })
    if (servicio._count.quejas >= 3) return reply.status(409).send({ error: 'Ya registró varias quejas sobre este servicio; la IPS las está revisando.' })

    // Si el profesional desistió, la queja queda ligada al último que se le asignó
    let profesionalId = servicio.profesionalId
    if (!profesionalId) {
      const ultima = await prisma.oferta.findFirst({ where: { servicioId: id, estado: { in: ['elegida', 'desistio'] } }, orderBy: { updatedAt: 'desc' }, select: { profesionalId: true } })
      profesionalId = ultima?.profesionalId || null
    }
    await crearQueja({ servicioId: id, usuarioId: request.usuario.id, profesionalId, texto })
    if (bloquear && profesionalId) {
      await prisma.bloqueo.upsert({
        where: { usuarioId_profesionalId: { usuarioId: request.usuario.id, profesionalId } },
        create: { usuarioId: request.usuario.id, profesionalId },
        update: {},
      })
    }
    return reply.status(201).send({ ok: true, mensaje: 'Recibimos su queja. La IPS la revisará y se comunicará con usted.' })
  })
}

