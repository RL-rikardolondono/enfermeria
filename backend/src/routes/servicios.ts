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
import { TIPOS, puedeAtender, perfilEfectivo, leerDataUrl, guardarArchivo } from '../services/catalogo'
import { requerirPermiso, tienePermiso } from '../middleware/auth'
import { plazoPagoCita, ocupadoAhora, finBusquedaProgramada, conflictoAgenda, puedeTrabajar, nuevoCodigo, validarFechaCita, fechaCita, limiteActivacion, MAX_CITAS_POR_CUENTA } from '../services/agenda'

// Quita lo que el profesional no debe ver (el código de llegada lo dice el paciente en la puerta)
function sinCodigo<T extends Record<string, any> | null>(s: T): T {
  if (!s) return s
  const { codigoLlegada, ...resto } = s as any
  return resto as T
}
const avisosOferta = new Map<string, number>()
// Intentos fallidos del código de llegada (por servicio): máximo 5 por hora
const intentosCodigo = new Map<string, { n: number; desde: number }>()

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
    select: { id: true, estadoVerificacion: true, disponible: true, activo: true, perfil: true },
  })
}

// Perfiles que pueden atender un tipo de servicio (vacío = cualquiera)
async function perfilesDe(tipo: string): Promise<string[]> {
  const t = await prisma.tarifa.findUnique({ where: { tipo: tipo as any }, select: { perfiles: true } })
  return t?.perfiles || []
}
// Tipos de servicio que puede atender un perfil
async function tiposPara(perfil: string | null | undefined): Promise<string[]> {
  const ts = await prisma.tarifa.findMany({ select: { tipo: true, perfiles: true } })
  return ts.filter((t: { perfiles: string[] }) => puedeAtender(perfil, t.perfiles)).map((t: { tipo: string }) => t.tipo)
}

// Profesionales que pueden atender a ESTE paciente ahora mismo:
// en turno ("Disponible", con avisos en el celular), aprobados, sin un servicio en curso y que el paciente no haya bloqueado.
async function profesionalesLibresPara(usuarioPacienteId: string, tipo?: string): Promise<string[]> {
  const perfiles = tipo ? await perfilesDe(tipo) : []
  const [ocupados, bloqueados, validos] = await prisma.$transaction([
    prisma.servicio.findMany({ where: { profesionalId: { not: null }, ...ocupadoAhora() }, select: { profesionalId: true } }),
    prisma.bloqueo.findMany({ where: { usuarioId: usuarioPacienteId }, select: { profesionalId: true } }),
    // Quien ya dejó pasar 3 solicitudes seguidas no cuenta como disponible
    prisma.profesional.findMany({ where: { ...enTurno(), ignoradas: { lt: MAX_IGNORADAS } }, select: { id: true, perfil: true } }),
  ])
  const fuera = new Set<string>([
    ...ocupados.map((o: { profesionalId: string | null }) => o.profesionalId as string),
    ...bloqueados.map((b: { profesionalId: string }) => b.profesionalId),
  ])
  // Solo quien tiene el perfil para ESTE servicio (un auxiliar no atiende una consulta médica)
  return validos.filter((v: { id: string; perfil: string | null }) => !fuera.has(v.id) && puedeAtender(v.perfil, perfiles)).map((v: { id: string }) => v.id)
}

// Profesionales que pueden aceptar una CITA PROGRAMADA de este paciente (no hace falta que estén en turno):
// aprobados, con el perfil del servicio, documentos al día y que el paciente no haya bloqueado.
async function profesionalesParaCita(usuarioPacienteId: string, tipo: string, soloId?: string | null): Promise<string[]> {
  const perfiles = await perfilesDe(tipo)
  const [bloqueados, todos] = await prisma.$transaction([
    prisma.bloqueo.findMany({ where: { usuarioId: usuarioPacienteId }, select: { profesionalId: true } }),
    prisma.profesional.findMany({
      where: { estadoVerificacion: 'aprobado', activo: true, usuario: { estado: 'activo' }, ...(soloId ? { id: soloId } : {}) },
      select: { id: true, perfil: true },
    }),
  ])
  const fuera = new Set(bloqueados.map((b: { profesionalId: string }) => b.profesionalId))
  const candidatos = todos.filter((v: { id: string; perfil: string | null }) => !fuera.has(v.id) && puedeAtender(v.perfil, perfiles))
  const ok: string[] = []
  for (const c of candidatos) if (await puedeTrabajar(c.id)) ok.push(c.id)
  return ok
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
  const s = await prisma.servicio.findUnique({ where: { id: servicioId }, select: { tipo: true, programadoPara: true, paciente: { select: { usuarioId: true } } } })
  if (!s || !s.paciente) return
  const pueden = (s.programadoPara ? await profesionalesParaCita(s.paciente.usuarioId, s.tipo) : await profesionalesLibresPara(s.paciente.usuarioId, s.tipo)).filter((id) => !excluir.includes(id))
  if (!pueden.length) return
  await notificarProfesionalesDisponibles({
    solo: pueden,
    fueraDeTurno: !!s.programadoPara,
    titulo: s.programadoPara ? 'Cita disponible de nuevo' : 'Solicitud disponible de nuevo',
    cuerpo: s.programadoPara
      ? 'Una cita de ' + s.tipo.replace(/_/g, ' ') + ' para el ' + fechaCita(s.programadoPara) + ' necesita profesional.'
      : 'Una solicitud de ' + s.tipo.replace(/_/g, ' ') + ' necesita profesional. Ofrézcase si puede ir ya.',
    url: `${APP_URL}/app-enfermero.html`,
  }).catch(() => {})
}

// Asigna el servicio al profesional de la oferta (cuando el paciente lo elige, o cuando el profesional
// acepta una "otra visita" que el paciente le pidió a él). Devuelve 'ok' o el mensaje de error.
async function asignarOferta(id: string, ofertaId: string): Promise<string> {
  const servicio = await prisma.servicio.findFirst({ where: { id, ...buscandoVigente() }, select: { id: true, tipo: true, programadoPara: true, dirigidoA: true, paciente: { select: { usuarioId: true } } } })
  if (!servicio) return 'La búsqueda de esta solicitud ya terminó.'
  const oferta = await prisma.oferta.findFirst({
    where: { id: ofertaId, servicioId: id, estado: 'activa' },
    select: { id: true, profesionalId: true, profesional: { select: { usuarioId: true } } },
  })
  const noDisponible = 'Ese profesional ya no está disponible. Elija otro.'
  if (!oferta) return noDisponible
  const cita = servicio.programadoPara
  // Urgente: debe seguir en turno. Cita: debe seguir habilitado
  const sigue = cita ? await puedeTrabajar(oferta.profesionalId) : !!(await prisma.profesional.count({ where: { id: oferta.profesionalId, ...enTurno() } }))
  if (!sigue) {
    await prisma.oferta.updateMany({ where: { id: oferta.id, estado: 'activa' }, data: { estado: 'retirada' } })
    marcarCambio()
    return noDisponible
  }

  // Con pagos en línea activos, el paciente tiene 15 minutos para pagar después de elegir
  const plazoPago = !PAGO_OBLIGATORIO ? null : cita ? plazoPagoCita(cita, !!servicio.dirigidoA) : new Date(Date.now() + 15 * 60 * 1000)
  const resultado = await prisma.$transaction(async (tx: any) => {
    // Un profesional a la vez: dos pacientes no pueden quedarse con el mismo profesional (o la misma hora)
    await bloquearClave(tx, 'profesional:' + oferta.profesionalId)
    if (cita) {
      const desde = new Date(cita.getTime() - 2 * 3600 * 1000), hasta = new Date(cita.getTime() + 2 * 3600 * 1000)
      const cruce = await tx.servicio.count({ where: { profesionalId: oferta.profesionalId, estado: { in: [...ACTIVOS] }, programadoPara: { gte: desde, lte: hasta } } })
      if (cruce) return 'ocupado'
      // Cita en menos de 4 horas: tampoco si está atendiendo un servicio urgente
      if (cita.getTime() - Date.now() < 4 * 3600 * 1000) {
        const urgente = await tx.servicio.count({ where: { profesionalId: oferta.profesionalId, programadoPara: null, estado: { in: [...ACTIVOS] } } })
        if (urgente) return 'ocupado'
      }
    } else {
      const ocupado = await tx.servicio.count({ where: { profesionalId: oferta.profesionalId, ...ocupadoAhora() } })
      if (ocupado) return 'ocupado'
    }
    const o = await tx.oferta.updateMany({ where: { id: oferta.id, estado: 'activa' }, data: { estado: 'elegida' } })
    if (o.count === 0) return 'oferta'
    // Si ya pagó (el profesional anterior desistió), no hay plazo de pago nuevo
    const yaPago = await tx.pago.findUnique({ where: { servicioId: id }, select: { estado: true } })
    const r = await tx.servicio.updateMany({
      where: { id, estado: 'pendiente' },
      data: { estado: 'asignado', profesionalId: oferta.profesionalId, buscandoHasta: yaPago?.estado === 'aprobado' ? null : plazoPago, codigoLlegada: nuevoCodigo(), asignadoEn: new Date() },
    })
    if (r.count === 0) throw new Error('cambio')
    await tx.oferta.updateMany({ where: { servicioId: id, estado: 'activa' }, data: { estado: 'no_elegida' } })
    // Urgencia: sus otras ofertas urgentes se retiran (atiende un servicio a la vez); las de citas siguen
    if (!cita) await tx.oferta.updateMany({ where: { profesionalId: oferta.profesionalId, estado: 'activa', servicio: { programadoPara: null } }, data: { estado: 'retirada' } })
    return 'ok'
  }).catch(() => 'cambio')
  if (resultado === 'ocupado') return cita ? 'Ese profesional acaba de tomar otra cita a esa hora. Elija otro.' : 'Ese profesional acaba de tomar otro servicio. Elija otro.'
  if (resultado === 'oferta') return noDisponible
  if (resultado !== 'ok') return 'La solicitud cambió de estado; recargue.'
  marcarCambio()

  setImmediate(() => {
    notificarUsuario(oferta.profesional.usuarioId, {
      titulo: cita ? 'Cita confirmada' : '¡El paciente lo eligió!',
      cuerpo: cita
        ? 'Tiene una cita de ' + servicio.tipo.replace(/_/g, ' ') + ' el ' + fechaCita(cita) + '. Véala en "Próximas citas".'
        : 'Tiene un servicio de ' + servicio.tipo.replace(/_/g, ' ') + '. Abra la app para ver la dirección.',
    }).catch(() => {})
  })
  return 'ok'
}

export async function serviciosRoutes(app: FastifyInstance) {

  // GET /api/servicios/disponibles — ¿hay profesionales para atenderme ahora? (antes de pedir o pagar)
  app.get('/disponibles', { preHandler: requerirRol('paciente') }, async (request) => {
    await vencerPendientesAntiguas()
    const { tipo, programado } = z.object({ tipo: z.enum(TIPOS).optional(), programado: z.enum(['1']).optional() }).parse(request.query)
    if (programado && tipo) return { disponibles: (await profesionalesParaCita(request.usuario.id, tipo)).length }
    const libres = await profesionalesLibresPara(request.usuario.id, tipo)
    return { disponibles: libres.length }
  })

  // POST /api/servicios — crear solicitud (solo cuentas de paciente)
  app.post('/', { preHandler: requerirRol('paciente'), bodyLimit: 1536 * 1024, config: { rateLimit: { max: 15, timeWindow: '1 hour' } } }, async (request, reply) => {
    const body = z.object({
      orden: z.string().max(1100000).optional(), // foto de la orden médica (JPEG comprimido en el celular)
      tipo: z.enum(TIPOS),
      descripcion: z.string().trim().min(5).max(500),
      direccion: z.string().trim().min(5).max(500),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      pacienteId: z.string().uuid().optional(),
      barrio: z.string().trim().max(80).optional(),
      programadoPara: z.string().max(40).optional(), // cita programada (fecha y hora); sin esto es para ahora
      profesionalId: z.string().uuid().optional(),   // "otra visita con este profesional" (solo con cita)
    }).parse(request.body)

    // ── Cita programada ──
    let programadoPara: Date | null = null
    if (body.programadoPara) {
      const f = validarFechaCita(body.programadoPara)
      if (typeof f === 'string') return reply.status(400).send({ error: f })
      programadoPara = f
    }
    if (body.profesionalId && !programadoPara) return reply.status(400).send({ error: 'Elija la fecha y hora de la nueva visita.' })
    if (body.profesionalId) {
      // Solo con un profesional que ya atendió a alguien de esta cuenta
      const atendio = await prisma.servicio.count({ where: { profesionalId: body.profesionalId, estado: 'completado', paciente: { usuarioId: request.usuario.id } } })
      if (!atendio) return reply.status(403).send({ error: 'Solo puede pedir otra visita a un profesional que ya le atendió.' })
    }

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
    // (las citas programadas no cuentan: puede tener varias, hasta un máximo)
    if (programadoPara) {
      const citas = await prisma.servicio.count({ where: { estado: { in: ['pendiente', 'asignado'] }, programadoPara: { gt: new Date() }, paciente: { usuarioId: request.usuario.id } } })
      if (citas >= MAX_CITAS_POR_CUENTA) return reply.status(409).send({ error: 'Ya tiene ' + MAX_CITAS_POR_CUENTA + ' citas programadas. Espere a que se cumplan o cancele alguna.' })
    }
    const abierta = programadoPara ? null : await prisma.servicio.findFirst({ where: { ...buscandoVigente(), programadoPara: null, paciente: { usuarioId: request.usuario.id } }, select: { id: true } })
    if (abierta) return reply.status(409).send({ error: 'Ya tiene una solicitud buscando profesional. Le mostramos los profesionales que se ofrecen.', buscandoId: abierta.id })

    // Medicamentos e inyectables: la enfermería solo los administra con orden o fórmula médica
    const tarifaTipo = await prisma.tarifa.findUnique({ where: { tipo: body.tipo as any }, select: { requiereOrden: true } })
    const orden = body.orden ? leerDataUrl(body.orden, 700 * 1024) : null
    if (tarifaTipo?.requiereOrden && !orden) {
      return reply.status(400).send({ error: 'Este servicio necesita la foto de la orden o fórmula médica. Sin ella no podemos administrar el medicamento.', faltaOrden: true })
    }
    if (orden && orden.mime === 'application/pdf') return reply.status(400).send({ error: 'Envíe la orden médica como foto.' })

    // No se recibe la solicitud (ni se cobra) si nadie puede atenderla
    const libres = programadoPara
      ? await profesionalesParaCita(request.usuario.id, body.tipo, body.profesionalId)
      : await profesionalesLibresPara(request.usuario.id, body.tipo)
    if (!libres.length) {
      return reply.status(409).send({
        error: body.profesionalId
          ? 'Ese profesional no está disponible para nuevas citas en este momento. Programe la cita con otro profesional.'
          : programadoPara
            ? 'Por ahora no hay profesionales habilitados para este servicio. Escríbanos por WhatsApp y le ayudamos a programarlo.'
            : 'En este momento no hay profesionales disponibles. Intente de nuevo en unos minutos, programe una cita o escríbanos por WhatsApp.',
        sinProfesionales: true,
      })
    }

    const monto = await calcularTarifa(body.tipo)
    // Una búsqueda a la vez por cuenta (también si se pulsa "Confirmar" dos veces seguidas)
    const servicio = await prisma.$transaction(async (tx: any) => {
      await bloquearClave(tx, 'solicitud:' + request.usuario.id)
      if (!programadoPara) {
        const enBusqueda = await tx.servicio.findFirst({ where: { ...buscandoVigente(), programadoPara: null, paciente: { usuarioId: request.usuario.id } }, select: { id: true } })
        if (enBusqueda) return { yaBuscando: enBusqueda.id }
      }
      const archivo = orden ? await guardarArchivo(tx, 'orden', orden, request.usuario.id) : null
      return tx.servicio.create({
        data: {
          pacienteId: paciente.id,
          tipo: body.tipo,
          descripcion: body.descripcion,
          direccion: body.direccion,
          barrio: body.barrio || null,
          ordenArchivoId: archivo ? archivo.id : null,
          lat: body.lat,
          lng: body.lng,
          monto,
          estado: 'pendiente',
          programadoPara,
          dirigidoA: body.profesionalId || null,
          buscandoHasta: programadoPara ? finBusquedaProgramada(programadoPara) : finBusqueda(),
        },
      })
    })
    if (!servicio || (servicio as any).yaBuscando) return reply.status(409).send({ error: 'Ya tiene una solicitud buscando profesional. Le mostramos los profesionales que se ofrecen.', buscandoId: (servicio as any)?.yaBuscando })

    marcarCambio()
    // Cita programada: se avisa a los profesionales habilitados aunque no estén en turno (o solo al elegido)
    if (programadoPara) {
      const cuando = fechaCita(programadoPara)
      setImmediate(() => {
        notificarProfesionalesDisponibles({
          solo: libres, fueraDeTurno: true,
          titulo: body.profesionalId ? 'Un paciente le pide otra visita' : 'Nueva cita programada',
          cuerpo: (body.profesionalId ? 'Le piden ' : 'Cita de ') + body.tipo.replace(/_/g, ' ') + ' para el ' + cuando + '. Ofrézcase si puede ir.',
          url: `${APP_URL}/app-enfermero.html`,
        }).catch(() => {})
      })
      return reply.status(201).send({
        id: servicio.id, estado: servicio.estado, monto: servicio.monto, buscandoHasta: servicio.buscandoHasta, programadoPara, ahora: new Date(),
        mensaje: body.profesionalId ? 'Solicitud enviada al profesional. Le avisaremos cuando acepte.' : 'Cita enviada. Los profesionales se irán ofreciendo; usted elige.',
      })
    }
    // Aviso a los profesionales libres (en turno, sin servicio y no bloqueados por este paciente), en segundo plano.
    // Quien ya dejó pasar 3 solicitudes seguidas sin responder sale del turno y se le avisa.
    setImmediate(async () => {
      try {
        const avisar = await profesionalesLibresPara(request.usuario.id, body.tipo)
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
              await prisma.oferta.updateMany({ where: { profesionalId: { in: dormidos.map((d: { id: string }) => d.id) }, estado: 'activa', servicio: { programadoPara: null } }, data: { estado: 'retirada' } })
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
    const { activos, programados } = z.object({ activos: z.enum(['1']).optional(), programados: z.enum(['1']).optional() }).parse(request.query)
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
    } else if (usuario.rol === 'admin' && tienePermiso(usuario, 'servicios')) {
      where = {}
    } else {
      return { total: 0, page, limit, items: [] }
    }
    // Activos = lo que se atiende ya (urgentes y citas de las próximas 2 horas); programados = citas más adelante
    if (activos) Object.assign(where, ocupadoAhora())
    if (programados) Object.assign(where, { estado: { in: ['asignado'] }, programadoPara: { gt: limiteActivacion() } })

    const [total, items] = await prisma.$transaction([
      prisma.servicio.count({ where }),
      prisma.servicio.findMany({
        where,
        orderBy: programados ? { programadoPara: 'asc' } : { createdAt: 'desc' },
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
        const { calificacion, comentarioCalificacion, resenaOculta, calificadoEn, codigoLlegada, ...resto } = s
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
    let tiposPermitidos: string[] | null = null
    let soloCitas = false, motivo: string | undefined
    if (request.usuario.rol === 'admin' && !tienePermiso(request.usuario, 'servicios')) return reply.status(403).send({ error: 'Acceso no autorizado' })
    if (request.usuario.rol === 'profesional') {
      const profesional = await perfilProfesional(request.usuario.id)
      if (!profesional || profesional.estadoVerificacion !== 'aprobado') {
        return reply.status(403).send({ error: 'Su cuenta aún no ha sido verificada por la Clínica Reina Elizabeth IPS.' })
      }
      profesionalId = profesional.id
      await vencerPendientesAntiguas()
      // Las urgencias solo las ve quien está en turno y libre; las CITAS programadas las ve todo profesional habilitado.
      // Abrir la lista a mano cuenta como "respondió" (los refrescos automáticos de la app no cuentan).
      const turno = await prisma.profesional.count({ where: { id: profesional.id, ...enTurno() } })
      const ocupado = await prisma.servicio.count({ where: { profesionalId: profesional.id, ...ocupadoAhora() } })
      if (!turno || ocupado) { soloCitas = true; motivo = !turno ? 'no_disponible' : 'ocupado' }
      else if (request.headers['x-segundo-plano'] !== '1') await profesionalRespondio(profesional.id)
      if (soloCitas && !(await puedeTrabajar(profesional.id))) return { total: 0, page: 1, limit: 0, items: [], motivo }
      tiposPermitidos = await tiposPara(profesional.perfil)
    }
    const { page, limit } = paginacion(50, 20).parse(request.query)
    await vencerPendientesAntiguas()

    const where: any = buscandoVigente()
    if (profesionalId) {
      // No ve las solicitudes de pacientes que lo bloquearon
      const bloqueadores = (await prisma.bloqueo.findMany({ where: { profesionalId }, select: { usuarioId: true } }))
        .map((b: { usuarioId: string }) => b.usuarioId)
      if (bloqueadores.length) where.paciente = { usuarioId: { notIn: bloqueadores } }
      where.tipo = { in: tiposPermitidos || [] }
      // Las "otra visita con este profesional" solo las ve ese profesional
      where.AND = [{ OR: [{ dirigidoA: null }, { dirigidoA: profesionalId }] }]
      if (soloCitas) where.programadoPara = { not: null }
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
          fechaSolicitud: true, createdAt: true, monto: true, buscandoHasta: true, ordenArchivoId: true, programadoPara: true, dirigidoA: true,
          paciente: { select: { id: true, nombreCompleto: true, usuario: { select: { nombreCompleto: true } } } },
          ofertas: { where: { profesionalId: profesionalId || '-', estado: 'activa' }, select: { id: true } },
          _count: { select: { ofertas: { where: { estado: 'activa' } } } },
        },
      }),
    ])

    return {
      total, page, limit, ahora: new Date(), motivo,
      items: items.map((s: (typeof items)[number]) => {
        const { ofertas, _count, direccion, barrio, paciente, ordenArchivoId, dirigidoA, ...resto } = s
        const nombre = paciente?.nombreCompleto || paciente?.usuario?.nombreCompleto || 'Paciente'
        return {
          ...resto,
          conOrden: !!ordenArchivoId,
          paraUsted: !!dirigidoA && dirigidoA === profesionalId,
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
    await vencerPendientesAntiguas()
    const servicio = await prisma.servicio.findFirst({
      where: { id, ...buscandoVigente() },
      select: { id: true, tipo: true, buscandoHasta: true, programadoPara: true, dirigidoA: true, paciente: { select: { usuarioId: true } } },
    })
    if (!servicio) return reply.status(409).send({ error: 'Esta solicitud ya no está disponible.' })
    if (servicio.dirigidoA && servicio.dirigidoA !== profesional.id) return reply.status(409).send({ error: 'Esta solicitud ya no está disponible.' })

    if (servicio.programadoPara) {
      // Cita: no hace falta estar en turno, pero sí tener los documentos al día y la agenda libre a esa hora
      if (!(await puedeTrabajar(profesional.id))) return reply.status(409).send({ error: 'Para aceptar citas debe tener su perfil y sus documentos al día. Revíselos en Perfil → Mis documentos.' })
      if (await conflictoAgenda(profesional.id, servicio.programadoPara)) return reply.status(409).send({ error: 'Ya tiene otra cita cerca de esa hora (menos de 2 horas de diferencia).' })
    } else {
      const turno = await prisma.profesional.count({ where: { id: profesional.id, ...enTurno() } })
      if (!turno) return reply.status(409).send({ error: 'Póngase en "Disponible" para ofrecerse.' })
      await profesionalRespondio(profesional.id)
      const ocupado = await prisma.servicio.count({ where: { profesionalId: profesional.id, ...ocupadoAhora() } })
      if (ocupado) return reply.status(409).send({ error: 'Termine o libere su servicio activo antes de ofrecerse para otro.' })
    }
    if (!puedeAtender(profesional.perfil, await perfilesDe(servicio.tipo))) return reply.status(403).send({ error: 'Este servicio lo atiende otro perfil profesional.' })
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
    // "Otra visita con este profesional": al aceptar, queda asignada de una vez (el paciente ya lo eligió)
    if (servicio.dirigidoA === profesional.id) {
      const of = await prisma.oferta.findUnique({ where: { servicioId_profesionalId: { servicioId: id, profesionalId: profesional.id } }, select: { id: true } })
      const r = of ? await asignarOferta(id, of.id) : 'No se pudo aceptar'
      if (r !== 'ok') return reply.status(409).send({ error: r })
      if (servicio.paciente) avisarA(servicio.paciente.usuarioId, { titulo: 'Su profesional aceptó la nueva visita', cuerpo: 'Quedó confirmada para el ' + fechaCita(servicio.programadoPara!) + '.' + (PAGO_OBLIGATORIO ? ' Recuerde pagarla en la app.' : ''), url: `${APP_URL}/app-paciente.html` }).catch(() => {})
      return reply.status(201).send({ ok: true, asignado: true, mensaje: 'Cita aceptada. Quedó en sus "Próximas citas".' })
    }
    marcarCambio()
    // Aviso al paciente (a lo sumo uno cada 2 minutos por solicitud, para no llenarle el celular)
    if (servicio.paciente && previa?.estado !== 'activa') {
      const ult = avisosOferta.get(id) || 0
      if (Date.now() - ult > 2 * 60 * 1000) {
        avisosOferta.set(id, Date.now())
        if (avisosOferta.size > 2000) avisosOferta.clear()
        avisarA(servicio.paciente.usuarioId, { titulo: 'Un profesional se ofreció', cuerpo: 'Abra la app para ver sus estrellas y opiniones, y elegir.', url: `${APP_URL}/app-paciente.html` }).catch(() => {})
      }
    }
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
      select: { id: true, estado: true, tipo: true, buscandoHasta: true, fechaSolicitud: true, notas: true, programadoPara: true, dirigidoA: true, paciente: { select: { usuarioId: true } }, pago: { select: { estado: true } } },
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
        where: { servicioId: id, estado: 'activa', profesional: servicio.programadoPara ? { estadoVerificacion: 'aprobado', activo: true, usuario: { estado: 'activo' } } : enTurno() },
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
    const conFoto = new Set((await prisma.documentoProfesional.findMany({
      where: { tipo: 'foto', estado: 'aprobado', archivoId: { not: null }, profesionalId: { in: ofertas.map((o: (typeof ofertas)[number]) => o.profesional.id) } },
      select: { profesionalId: true },
    })).map((d: { profesionalId: string }) => d.profesionalId))
    const items = await Promise.all(ofertas.map(async (o: (typeof ofertas)[number]) => ({
      id: o.id,
      creada: o.createdAt,
      profesional: {
        id: o.profesional.id,
        tieneFoto: conFoto.has(o.profesional.id),
        nombre: o.profesional.usuario.nombreCompleto,
        especialidad: o.profesional.especialidad,
        totalServicios: o.profesional.totalServicios,
        anosExperiencia: o.profesional.anosExperiencia,
        fotoUrl: o.profesional.fotoUrl,
        opiniones: await opinionesDe(o.profesional.id, 3),
      },
    })))
    const { paciente, dirigidoA, ...datos } = servicio
    return { servicio: { ...datos, dirigido: !!dirigidoA }, ahora: new Date(), items }
  })

  // POST /api/servicios/:id/elegir — el paciente escoge al profesional que lo atenderá
  app.post('/:id/elegir', { preHandler: requerirRol('paciente') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { ofertaId } = z.object({ ofertaId: z.string().uuid() }).parse(request.body)

    const servicio = await prisma.servicio.findFirst({
      where: { id, ...buscandoVigente(), paciente: { usuarioId: request.usuario.id } },
      select: { id: true },
    })
    if (!servicio) return reply.status(409).send({ error: 'La búsqueda de esta solicitud ya terminó.' })
    const r = await asignarOferta(id, ofertaId)
    if (r !== 'ok') return reply.status(409).send({ error: r })
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
    let permitido = rol === 'admin' && tienePermiso(request.usuario, 'servicios')
    if (rol === 'paciente') permitido = servicio.paciente?.usuarioId === usuarioId
    // El profesional ve sus servicios solo desde la lista (con los datos limitados por la Ley 1581)
    if (!permitido) return reply.status(404).send({ error: 'Servicio no encontrado' })
    return servicio
  })

  // PUT /api/servicios/:id/estado
  // GET /api/servicios/:id/orden — la foto de la orden médica: el paciente dueño, el profesional ELEGIDO y la IPS
  app.get('/:id/orden', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const s = await prisma.servicio.findUnique({ where: { id }, select: { ordenArchivoId: true, profesionalId: true, estado: true, fechaFin: true, paciente: { select: { usuarioId: true } } } })
    if (!s || !s.ordenArchivoId) return reply.status(404).send({ error: 'Este servicio no tiene orden médica' })
    const u = request.usuario
    let permitido = u.rol === 'admin' ? tienePermiso(u, 'servicios') : u.rol === 'paciente' && s.paciente?.usuarioId === u.id
    if (u.rol === 'profesional') {
      const p = await perfilProfesional(u.id)
      // Completado: solo durante 30 días (Ley 1581), igual que el resto de datos clínicos
      permitido = !!p && s.profesionalId === p.id && (['asignado', 'en_camino', 'en_curso'].includes(s.estado) ||
        (s.estado === 'completado' && !!s.fechaFin && s.fechaFin.getTime() > Date.now() - 30 * 24 * 3600 * 1000))
    }
    if (!permitido) return reply.status(404).send({ error: 'Este servicio no tiene orden médica' })
    const a = await prisma.archivo.findUnique({ where: { id: s.ordenArchivoId }, select: { mime: true, datos: true } })
    if (!a) return reply.status(404).send({ error: 'No se encontró la orden médica' })
    reply.header('Cache-Control', 'private, no-store').header('Content-Type', a.mime)
    return reply.send(Buffer.from(a.datos))
  })

  // POST /api/servicios/:id/orden-revisada — el profesional elegido confirma que revisó la orden (requisito para salir)
  app.post('/:id/orden-revisada', { preHandler: requerirRol('profesional') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const p = await perfilProfesional(request.usuario.id)
    if (!p) return reply.status(403).send({ error: 'Acceso no autorizado' })
    const r = await prisma.servicio.updateMany({ where: { id, profesionalId: p.id, ordenArchivoId: { not: null }, estado: { in: ['asignado', 'en_camino', 'en_curso'] } }, data: { ordenRevisada: true } })
    if (!r.count) return reply.status(404).send({ error: 'Servicio no encontrado' })
    marcarCambio()
    return { ok: true }
  })

  app.put('/:id/estado', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { estado, firma, codigo, lat, lng } = z.object({
      estado: z.enum(['asignado', 'en_camino', 'en_curso', 'completado', 'cancelado']),
      codigo: z.string().trim().regex(/^\d{4}$/).optional(), // código de llegada que dice el paciente
      lat: z.number().min(-90).max(90).optional(),           // ubicación del profesional al marcar (seguridad)
      lng: z.number().min(-180).max(180).optional(),
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
        if (servicio.estado === 'pendiente' && servicio.dirigidoA === profesional.id) {
          // "Otra visita" que le pidieron a él y no puede: se cierra y se le avisa al paciente para que la pida a otro
          const r = await prisma.servicio.updateMany({ where: { id, estado: 'pendiente', dirigidoA: profesional.id }, data: { estado: 'cancelado', buscandoHasta: null, notas: 'El profesional no puede en esa fecha. Programe la cita para otro día o con otro profesional. No se le cobró nada.' } })
          if (r.count) {
            await marcarReembolso(id)
            marcarCambio()
            if (servicio.paciente) avisarA(servicio.paciente.usuarioId, { titulo: 'Su profesional no puede en esa fecha', cuerpo: 'Pida la visita para otro día o con otro profesional.', url: `${APP_URL}/app-paciente.html` }).catch(() => {})
          }
          return { ok: true, mensaje: 'Le avisamos al paciente que no puede en esa fecha.' }
        }
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
        // (una cita lejana vuelve a recibir ofertas hasta 2 horas antes; si ya es muy pronto, 10 minutos)
        const nuevaBusqueda = servicio.programadoPara ? finBusquedaProgramada(servicio.programadoPara) : finBusqueda()
        const r = await prisma.$transaction(async (tx: any) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'pago:' + id}))::text`
          return tx.servicio.updateMany({
            where: { id, estado: servicio.estado, profesionalId: profesional.id },
            data: { estado: 'pendiente', profesionalId: null, fechaSolicitud: new Date(), buscandoHasta: nuevaBusqueda, codigoLlegada: null, recordadoEn: null, dirigidoA: null, asignadoEn: null },
          })
        })
        if (r.count === 0) return reply.status(409).send({ error: 'El servicio cambió de estado; recargue' })
        await prisma.oferta.updateMany({ where: { servicioId: id, profesionalId: profesional.id }, data: { estado: 'desistio' } })
        marcarCambio()
        setImmediate(() => { avisarBusquedaReabierta(id, [profesional.id]).catch(() => {}) })
        if (servicio.paciente) avisarA(servicio.paciente.usuarioId, { titulo: 'El profesional no podrá ir', cuerpo: 'Su solicitud vuelve a buscar profesional. Abra la app para elegir otro.', url: `${APP_URL}/app-paciente.html` }).catch(() => {})
        return sinCodigo(await prisma.servicio.findUnique({ where: { id } }))
      }

      if (!esSuProfesional) return reply.status(403).send({ error: 'Este servicio no está asignado a usted' })
      if (!SIGUIENTE[servicio.estado]?.includes(estado)) {
        return reply.status(400).send({ error: 'Cambio de estado no permitido' })
      }
      // Con pagos en línea activos, el profesional sale solo cuando el paciente ya pagó
      if (estado === 'en_camino' && servicio.programadoPara && servicio.programadoPara > limiteActivacion()) {
        return reply.status(409).send({ error: 'Esta cita es el ' + fechaCita(servicio.programadoPara) + '. Podrá marcar "Voy en camino" desde 2 horas antes.' })
      }
      // Al llegar: el paciente le dice el código de 4 números que ve en su app (los dos saben que es la persona correcta)
      if (estado === 'en_curso' && servicio.codigoLlegada) {
        const ahora = Date.now(), reg = intentosCodigo.get(id)
        const intento = reg && ahora - reg.desde < 15 * 60 * 1000 ? reg : { n: 0, desde: ahora }
        if (intento.n >= 5) return reply.status(429).send({ error: 'Demasiados intentos con el código. Llame a la IPS: le confirmarán el código con el paciente (espere 15 minutos para intentarlo de nuevo).' })
        if (!codigo) return reply.status(400).send({ error: 'Pídale al paciente el código de llegada (4 números que aparecen en su app).', faltaCodigo: true })
        if (codigo !== servicio.codigoLlegada) {
          intento.n++; intentosCodigo.set(id, intento)
          if (intentosCodigo.size > 5000) intentosCodigo.clear()
          return reply.status(400).send({ error: 'El código no coincide. Pídale al paciente que lo revise en su app.', faltaCodigo: true })
        }
        intentosCodigo.delete(id)
      }
      if (estado === 'en_camino' && servicio.ordenArchivoId && !servicio.ordenRevisada) {
        return reply.status(409).send({ error: 'Antes de salir, abra y revise la orden médica del paciente (botón "Ver orden médica").', faltaRevisarOrden: true })
      }
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

    // ── IPS: solo cancela o cierra (perfil con permiso de servicios) ──
    if (rol === 'admin') {
      if (!tienePermiso(request.usuario, 'servicios')) return reply.status(403).send({ error: 'Su perfil en la IPS no tiene permiso para esto.' })
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
    // Ubicación del profesional al salir, llegar y terminar (seguridad de la visita)
    if (rol === 'profesional' && servicio.profesionalId && lat !== undefined && lng !== undefined && ['en_camino', 'en_curso', 'completado'].includes(estado)) {
      await prisma.trackingHistorial.create({ data: { servicioId: id, profesionalId: servicio.profesionalId, lat, lng } }).catch(() => {})
    }
    // Avisos al celular del paciente y del profesional
    if (rol === 'profesional' && servicio.paciente) {
      const AV: Record<string, [string, string]> = {
        en_camino: ['Su profesional va en camino', 'Tenga a mano el código de llegada: dígaselo cuando llegue a su puerta.'],
        en_curso: ['La visita comenzó', 'El profesional inició la atención.'],
        completado: ['Servicio completado', 'Puede ver la nota clínica y calificar al profesional en la app.'],
      }
      if (AV[estado]) avisarA(servicio.paciente.usuarioId, { titulo: AV[estado][0], cuerpo: AV[estado][1], url: `${APP_URL}/app-paciente.html` }).catch(() => {})
    }
    if (estado === 'cancelado' && rol !== 'profesional' && servicio.profesionalId) {
      const pr = await prisma.profesional.findUnique({ where: { id: servicio.profesionalId }, select: { usuarioId: true } })
      if (pr) avisarA(pr.usuarioId, { titulo: 'Servicio cancelado', cuerpo: rol === 'paciente' ? 'El paciente canceló el servicio.' : 'La IPS canceló el servicio.', url: `${APP_URL}/app-enfermero.html` }).catch(() => {})
    }

    // Pago retenido: se libera al completar con nota clínica; se marca para reembolso si se cancela
    if (estado === 'completado') {
      await liberarPago(id)
      if (servicio.profesionalId) {
        await prisma.profesional.update({ where: { id: servicio.profesionalId }, data: { totalServicios: { increment: 1 } } })
      }
    }
    if (estado === 'cancelado') await marcarReembolso(id)

    const final = await prisma.servicio.findUnique({ where: { id } })
    return rol === 'profesional' ? sinCodigo(final) : final
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
    if (request.usuario.rol === 'admin' && !tienePermiso(request.usuario, 'servicios')) return reply.status(403).send({ error: 'Su perfil en la IPS no tiene permiso para esto.' })
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

  // ── Chat del servicio (paciente ↔ profesional elegido; la IPS lo puede leer) ──
  // Quién participa y si puede escribir: mientras el servicio está activo (y 24 horas después solo para leer)
  async function participante(request: any, id: string) {
    const s = await prisma.servicio.findUnique({ where: { id }, select: { id: true, estado: true, tipo: true, fechaFin: true, updatedAt: true, asignadoEn: true, profesionalId: true, paciente: { select: { usuarioId: true } }, profesional: { select: { usuarioId: true } } } })
    if (!s) return null
    const u = request.usuario
    const activo = (ACTIVOS as readonly string[]).includes(s.estado)
    const reciente = ['completado', 'cancelado'].includes(s.estado) && Date.now() - (s.fechaFin || s.updatedAt).getTime() < 24 * 3600 * 1000
    if (u.rol === 'admin') return tienePermiso(u, 'servicios') ? { s, rol: 'admin', escribir: false, otro: null } : null
    if (u.rol === 'paciente' && s.paciente?.usuarioId === u.id && s.profesionalId && (activo || reciente)) return { s, rol: 'paciente', escribir: activo, otro: s.profesional?.usuarioId || null }
    if (u.rol === 'profesional' && s.profesional?.usuarioId === u.id && (activo || reciente)) return { s, rol: 'profesional', escribir: activo, otro: s.paciente?.usuarioId || null }
    return null
  }

  // GET /api/servicios/:id/mensajes
  app.get('/:id/mensajes', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const p = await participante(request, id)
    if (!p) return reply.status(404).send({ error: 'Chat no disponible' })
    // El profesional solo ve la conversación desde que lo eligieron (no la que hubo con un profesional anterior)
    const desde = p.rol === 'profesional' && p.s.asignadoEn ? { createdAt: { gte: p.s.asignadoEn } } : {}
    const items = await prisma.mensaje.findMany({ where: { servicioId: id, ...desde }, orderBy: { createdAt: 'desc' }, take: 150, select: { id: true, rol: true, texto: true, createdAt: true } })
    return { items: items.reverse(), puedeEscribir: p.escribir, yo: p.rol }
  })

  // POST /api/servicios/:id/mensajes
  app.post('/:id/mensajes', { preHandler: autenticar, config: { rateLimit: { max: 40, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { texto } = z.object({ texto: z.string().trim().min(1).max(500) }).parse(request.body)
    const p = await participante(request, id)
    if (!p || !p.escribir) return reply.status(409).send({ error: 'El chat de este servicio ya está cerrado.' })
    const total = await prisma.mensaje.count({ where: { servicioId: id } })
    if (total >= 300) return reply.status(409).send({ error: 'Este chat llegó al máximo de mensajes. Comuníquese por WhatsApp con la IPS.' })
    const m = await prisma.mensaje.create({ data: { servicioId: id, autorId: request.usuario.id, rol: p.rol, texto }, select: { id: true, rol: true, texto: true, createdAt: true } })
    marcarCambio()
    if (p.otro) {
      avisarA(p.otro, {
        titulo: p.rol === 'paciente' ? 'Mensaje del paciente' : 'Mensaje de su profesional',
        cuerpo: texto.length > 90 ? texto.slice(0, 90) + '…' : texto,
        url: `${APP_URL}/${p.rol === 'paciente' ? 'app-enfermero.html' : 'app-paciente.html'}`,
      }).catch(() => {})
    }
    return reply.status(201).send(m)
  })

  // POST /api/servicios/:id/alerta — botón de pánico (paciente o profesional durante el servicio)
  app.post('/:id/alerta', { preHandler: requerirRol('paciente', 'profesional'), config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { lat, lng, detalle } = z.object({
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      detalle: z.string().trim().max(300).optional(),
    }).parse(request.body || {})
    const s = await prisma.servicio.findUnique({ where: { id }, select: { id: true, estado: true, tipo: true, direccion: true, fechaFin: true, profesionalId: true, paciente: { select: { usuarioId: true, nombreCompleto: true, usuario: { select: { nombreCompleto: true, telefono: true } } } }, profesional: { select: { usuarioId: true, usuario: { select: { nombreCompleto: true, telefono: true } } } } } })
    const u = request.usuario
    const esPaciente = u.rol === 'paciente' && s?.paciente?.usuarioId === u.id
    const esProf = u.rol === 'profesional' && s?.profesional?.usuarioId === u.id
    if (!s || (!esPaciente && !esProf)) return reply.status(404).send({ error: 'Servicio no encontrado' })
    const recienCompletado = s.estado === 'completado' && !!s.fechaFin && Date.now() - s.fechaFin.getTime() < 24 * 3600 * 1000
    if (!(ACTIVOS as readonly string[]).includes(s.estado) && !recienCompletado) return reply.status(409).send({ error: 'Este servicio no está activo. Ante una emergencia llame al 123.' })
    const mapa = lat !== undefined && lng !== undefined ? ` Ubicación: https://maps.google.com/?q=${lat},${lng}` : ''
    const quien = esPaciente ? 'el PACIENTE' : 'el PROFESIONAL'
    const texto = `🆘 BOTÓN DE EMERGENCIA activado por ${quien} (${esPaciente ? (s.paciente?.usuario?.nombreCompleto || '') : (s.profesional?.usuario?.nombreCompleto || '')}). ` +
      `Paciente: ${s.paciente?.nombreCompleto || s.paciente?.usuario?.nombreCompleto || '—'} · tel. ${s.paciente?.usuario?.telefono || '—'}. ` +
      `Profesional: ${s.profesional?.usuario?.nombreCompleto || '—'} · tel. ${s.profesional?.usuario?.telefono || '—'}. ` +
      `Dirección: ${s.direccion || '—'}.${mapa}${detalle ? ' Detalle: ' + detalle : ''} LLAME DE INMEDIATO.`
    // Sin profesionalId: una alerta no es una queja contra el profesional (los nombres van en el texto)
    await crearQueja({ servicioId: id, usuarioId: u.id, profesionalId: null, texto: texto.slice(0, 2000) })
    // Además del correo de quejas, el dueño de la IPS recibe el aviso en su Gmail
    const { enviarCorreo } = await import('../utils/correo')
    const { DUENO_CORREO } = await import('../services/cuentas')
    const escH = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
    enviarCorreo(DUENO_CORREO, '🆘 EMERGENCIA en un servicio de Salud en Casa', `<div style="font-family:Arial,sans-serif;color:#1C2B39"><h2 style="color:#B4412F">Botón de emergencia activado</h2><p style="font-size:15px">${escH(texto)}</p><p><a href="${APP_URL}/panel.html" style="background:#B4412F;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Abrir el panel</a></p><p style="font-size:12px;color:#5D6B78">SkyNet Genesis · contacto@skynetgenesis.com · WhatsApp 3044375758</p></div>`).catch(() => {})
    return { ok: true, mensaje: 'La IPS recibió su alerta y le llamará. Si hay riesgo para la vida, llame al 123.' }
  })

  // GET /api/servicios/admin/todos
  app.get('/admin/todos', { preHandler: requerirPermiso('servicios') }, async (request) => {
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

