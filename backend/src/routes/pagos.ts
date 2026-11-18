import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { autenticar, requerirRol, requerirPermiso, tienePermiso } from '../middleware/auth'
import { calcularReparto, PAGO_OBLIGATORIO, marcarReembolso } from '../services/liquidacion'
import { avisarQueja } from '../services/quejas'
import { marcarCambio } from '../utils/cambios'
import { notificarUsuario } from './push'
import { APP_URL } from '../utils/config'

// Pagos con el sistema central de Bold de SkyNet Genesis (skynetgenesis.com), patrón SIN secreto compartido:
// 1) El paciente, ya con profesional elegido, pide pagar. Este servidor arma el pedido con el valor de la tarifa
//    del panel: plan "saludencasa:paq_cien-xN" (N unidades de $100 del plan saludencasa:cien del firmador)
//    y empresa = código del servicio. La pantalla pide la firma al firmador central y abre la pasarela de Bold.
// 2) Bold avisa al receptor central (bold-webhook.php), que llama a /api/pagos/bold/aplicar.
// 3) Este servidor NO confía en lo que le mandan: consulta bold-verificar.php y aplica SOLO lo que el verificador
//    confirma. Respaldo: al volver de Bold la pantalla llama a /api/pagos/bold/volver con la referencia del pedido.
const APP_BOLD = 'saludencasa'
const FIRMADOR = 'https://skynetgenesis.com/bold-firma.php'
const VERIFICADOR = 'https://skynetgenesis.com/bold-verificar.php'
const UNIDAD = 100 // valor del plan saludencasa:cien en el firmador
const MAX_UNIDADES = 9999

type OrdenVerificada = { pagoId: string; empresa: string; plan: string; valor: number; referencia: string }

// Pregunta al verificador central; devuelve la orden SOLO si el pago está confirmado y es de esta app
async function verificarCentral(params: { pago?: string; ref?: string }, log: any): Promise<OrdenVerificada | null> {
  const url = VERIFICADOR + '?app=' + APP_BOLD + '&' + (params.pago ? 'pago=' + encodeURIComponent(params.pago) : 'ref=' + encodeURIComponent(params.ref || ''))
  let txt = '', r: Response
  try {
    // SiteGround rechaza llamadas de servidor sin User-Agent
    r = await fetch(url, { headers: { 'User-Agent': 'SkyNetGenesis-SaludEnCasa/1.0', accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
    txt = await r.text()
  } catch (e: any) { log.error({ url, error: String(e?.message || e).slice(0, 200) }, 'Verificador Bold no respondió'); return null }
  let j: any = null
  try { j = JSON.parse(txt) } catch { j = null }
  if (!r.ok || !j || j.ok === false) { log.warn({ url, estado: r.status, respuesta: txt.slice(0, 300) }, 'Verificador Bold sin confirmación'); return null }
  const o = j.orden || j.order || j.pedido || j.data || j
  const pagoId = String(o.pago_id || o.pagoId || o.payment_id || '')
  const plan = String(o.plan || '')
  if (!pagoId || (o.app && o.app !== APP_BOLD) || !plan.startsWith(APP_BOLD + ':')) return null
  const valor = Math.round(Number(o.valor ?? o.amount ?? o.total ?? 0))
  return { pagoId, empresa: String(o.empresa || ''), plan, valor: Number.isFinite(valor) ? valor : 0, referencia: String(o.referencia || o.ref || params.ref || '') }
}

export async function pagosRoutes(app: FastifyInstance) {

  // Aplica una orden YA verificada por el sistema central. Idempotente por pago_id; un solo proceso a la vez por servicio.
  async function aplicarOrden(o: OrdenVerificada): Promise<{ ok: true; [k: string]: any }> {
    if (o.plan === APP_BOLD + ':prueba') { app.log.info({ pagoId: o.pagoId, valor: o.valor }, 'Pago de prueba de Bold recibido'); return { ok: true, prueba: true } }
    const servicioId = o.empresa
    if (!/^[0-9a-f-]{36}$/i.test(servicioId)) { app.log.error({ o }, 'Pago de Bold con código de servicio no válido: revisar a mano'); return { ok: true, revisar: 'servicio_no_valido' } }
    let aviso: { usuarioId: string } | null = null
    const alertas: { servicioId: string; usuarioId: string; profesionalId: string | null; texto: string }[] = []
    const resultado = await prisma.$transaction(async (tx: any) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'pago:' + servicioId}))::text`
      const previo = await tx.pago.findUnique({ where: { servicioId }, select: { estado: true, referenciaExterna: true, estadoLiquidacion: true } })
      if (previo && previo.referenciaExterna === o.pagoId) return { ok: true as const, repetido: true }
      const servicio = await tx.servicio.findUnique({ where: { id: servicioId }, select: { id: true, estado: true, monto: true, profesionalId: true, notas: true } })
      if (!servicio) { app.log.error({ o }, 'Pago de Bold para un servicio que no existe: revisar a mano'); return { ok: true as const, revisar: 'servicio_no_existe' } }
      // Pago doble solo si el anterior sí quedó aprobado (un pago menor ya devuelto no impide pagar bien)
      if (previo && previo.estado === 'aprobado') {
        // Segundo pago del mismo servicio: queda anotado y la IPS recibe la alerta para devolverlo
        const nota = 'PAGO DOBLE en Bold (pago ' + o.pagoId + ', $' + o.valor + '): devolverlo desde el panel de Bold.'
        const yaAvisado = await tx.queja.findFirst({ where: { servicioId, texto: { contains: o.pagoId } }, select: { id: true } })
        if (!yaAvisado) {
          // La alerta se anota dentro del candado (dos avisos simultáneos no la duplican) y el correo sale después
          const q = { servicioId, usuarioId: 'sistema', profesionalId: null, texto: nota }
          await tx.queja.create({ data: q })
          alertas.push(q)
        }
        return { ok: true as const, revisar: 'pagado_dos_veces' }
      }
      // Un pago anterior que no alcanzó ("para revisar") no se borra: queda anotado y la IPS recibe la alerta
      if (previo && previo.referenciaExterna && previo.referenciaExterna !== o.pagoId) {
        const ant = await tx.pago.findUnique({ where: { servicioId }, select: { monto: true } })
        const nota = previo.estado === 'reembolsado'
          ? 'Llegó un pago nuevo en Bold (pago ' + o.pagoId + ', $' + o.valor + ') después de devolver el pago anterior (' + previo.referenciaExterna + ', ya devuelto: no devolverlo otra vez).'
          : 'PAGO ANTERIOR en Bold (pago ' + previo.referenciaExterna + ', $' + Math.round(Number(ant?.monto || 0)) + ') reemplazado por el pago ' + o.pagoId + ': revisar si se devuelve.'
        const q = { servicioId, usuarioId: 'sistema', profesionalId: null, texto: nota }
        await tx.queja.create({ data: q })
        alertas.push(q)
      }
      const cubre = o.valor >= Math.round(Number(servicio.monto || 0))
      // Si el servicio ya se canceló (por ejemplo, venció el plazo de pago), el dinero queda marcado para devolver
      const estadoLiquidacion = !cubre ? 'revisar' : servicio.estado === 'cancelado' ? 'reembolso' : 'retenido'
      const { comision, valorProfesional } = calcularReparto(o.valor)
      await tx.pago.upsert({
        where: { servicioId },
        update: { estado: cubre ? 'aprobado' : 'pendiente', referenciaExterna: o.pagoId, monto: o.valor, comision, valorProfesional, estadoLiquidacion },
        create: { servicioId, monto: o.valor, estado: cubre ? 'aprobado' : 'pendiente', referenciaExterna: o.pagoId, estadoLiquidacion, comision, valorProfesional },
      })
      if (estadoLiquidacion === 'retenido') {
        const u = await tx.servicio.updateMany({ where: { id: servicioId, estado: { in: ['asignado', 'en_camino', 'en_curso', 'completado'] } }, data: { buscandoHasta: null } })
        // Servicio que volvió a buscar profesional (el anterior desistió): el pago sigue retenido para el próximo
        if (u.count === 0 && servicio.estado === 'pendiente') return { ok: true as const, aplicado: 'retenido', sinProfesional: true }
        if (u.count === 0) {
          await tx.pago.update({ where: { servicioId }, data: { estadoLiquidacion: 'reembolso' } })
          app.log.error({ servicioId, pagoId: o.pagoId }, 'Pago confirmado para un servicio ya cancelado: queda para devolver')
          return { ok: true as const, aplicado: 'reembolso' }
        }
        if (servicio.profesionalId) aviso = await tx.profesional.findUnique({ where: { id: servicio.profesionalId }, select: { usuarioId: true } })
      } else {
        app.log.error({ servicioId, pagoId: o.pagoId, valor: o.valor, estadoLiquidacion }, 'Pago de Bold para revisar a mano')
      }
      return { ok: true as const, aplicado: estadoLiquidacion }
    })
    for (const q of alertas) setImmediate(() => avisarQueja(q))
    if (aviso) {
      const u = (aviso as { usuarioId: string }).usuarioId
      setImmediate(() => { notificarUsuario(u, { titulo: 'Pago recibido', cuerpo: 'El paciente ya pagó. Puede salir hacia el domicilio.' }).catch(() => {}) })
    }
    marcarCambio()
    return resultado
  }

  // POST /api/pagos/bold/iniciar — pedido para pagar un servicio ya asignado (solo el titular)
  app.post('/bold/iniciar', { preHandler: requerirRol('paciente') }, async (request, reply) => {
    const { servicioId } = z.object({ servicioId: z.string().uuid() }).parse(request.body)
    if (!PAGO_OBLIGATORIO) return reply.status(503).send({ error: 'Los pagos en línea aún no están activos' })
    const servicio = await prisma.servicio.findUnique({
      where: { id: servicioId },
      include: { pago: true, paciente: { select: { usuarioId: true } } },
    })
    if (!servicio || servicio.paciente?.usuarioId !== request.usuario.id) return reply.status(404).send({ error: 'Servicio no encontrado' })
    if (servicio.pago?.estado === 'aprobado') return reply.status(409).send({ error: 'Este servicio ya está pagado' })
    if (servicio.estado === 'pendiente') return reply.status(409).send({ error: 'Primero elija al profesional que lo atenderá; luego podrá pagar.' })
    if (servicio.estado !== 'asignado') return reply.status(409).send({ error: 'Este servicio ya no se puede pagar' })
    if (!servicio.monto) return reply.status(400).send({ error: 'Sin valor definido' })
    if (servicio.buscandoHasta && servicio.buscandoHasta <= new Date()) {
      return reply.status(409).send({ error: 'Se venció el plazo para pagar. Pida el servicio de nuevo.' })
    }
    // PSE y Nequi pueden tardar unos minutos en confirmar: la primera vez que inicia el pago se asegura que le
    // queden al menos 10 minutos (una sola prórroga; se marca creando el registro del pago en "pendiente")
    if (!servicio.pago) {
      const minimo = new Date(Date.now() + 10 * 60 * 1000)
      await prisma.$transaction(async (tx: any) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'pago:' + servicio.id}))::text`
        const ya = await tx.pago.findUnique({ where: { servicioId: servicio.id }, select: { id: true } })
        if (ya) return
        await tx.pago.create({ data: { servicioId: servicio.id, monto: servicio.monto, estado: 'pendiente', estadoLiquidacion: 'iniciado' } })
        if (!servicio.buscandoHasta || servicio.buscandoHasta < minimo) {
          await tx.servicio.updateMany({ where: { id: servicio.id, estado: 'asignado' }, data: { buscandoHasta: minimo } })
        }
      })
    }
    const unidades = Math.ceil(Math.round(Number(servicio.monto)) / UNIDAD)
    if (unidades < 1 || unidades > MAX_UNIDADES) return reply.status(400).send({ error: 'Este valor no se puede pagar en línea. Escríbanos por WhatsApp.' })
    const valor = unidades * UNIDAD
    const params = new URLSearchParams({
      plan: APP_BOLD + ':paq_cien-x' + unidades, empresa: servicio.id, meses: '1',
      org: servicio.tipo.replace('_', ' '), volver: APP_URL.replace(/\/$/, '') + '/app-paciente.html',
    })
    return { url: FIRMADOR + '?' + params.toString(), valor }
  })

  // POST /api/pagos/bold/prueba — pago de prueba de $1.000 del administrador (comprueba el circuito completo)
  app.post('/bold/prueba', { preHandler: requerirPermiso('pagos') }, async () => {
    const params = new URLSearchParams({ plan: APP_BOLD + ':prueba', empresa: 'prueba', meses: '1', volver: APP_URL.replace(/\/$/, '') + '/panel.html' })
    return { url: FIRMADOR + '?' + params.toString(), valor: 1000 }
  })

  // POST /api/pagos/bold/aplicar — aviso del receptor central. Solo se usa el pago_id para preguntar al verificador.
  // Debe responder {"ok": true} cuando quedó aplicado (o no hay nada que hacer); si no, el receptor reintenta.
  app.post('/bold/aplicar', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const b: any = request.body || {}
    const o0 = b.orden || b.order || b
    const pagoId = String(o0?.pago_id || o0?.pagoId || o0?.payment_id || '').slice(0, 100)
    if (!pagoId) return reply.status(400).send({ ok: false, error: 'sin_pago' })
    const o = await verificarCentral({ pago: pagoId }, app.log)
    if (!o) return reply.status(409).send({ ok: false, error: 'no_confirmado' })
    return aplicarOrden(o)
  })

  // POST /api/pagos/bold/volver — respaldo al volver de Bold (por si el aviso de Bold no llega)
  app.post('/bold/volver', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { ref } = z.object({ ref: z.string().trim().regex(/^[A-Za-z0-9_-]{6,80}$/) }).parse(request.body)
    if (!ref.toUpperCase().startsWith('SGSALUDE')) return reply.status(400).send({ ok: false, error: 'Referencia no válida' })
    const o = await verificarCentral({ ref }, app.log)
    if (!o) return { ok: false, pendiente: true, mensaje: 'Bold aún no confirma el pago. Si ya pagó, en unos minutos se verá aplicado.' }
    const r: any = await aplicarOrden(o)
    let confirmado = r.aplicado === 'retenido'
    if (r.repetido) {
      const pg = await prisma.pago.findUnique({ where: { servicioId: o.empresa }, select: { estado: true, estadoLiquidacion: true } }).catch(() => null)
      confirmado = !!pg && pg.estado === 'aprobado' && pg.estadoLiquidacion === 'retenido'
    }
    if (r.prueba) return { ok: true, confirmado: true, prueba: true }
    return { ok: true, confirmado, revisar: !confirmado, sinProfesional: !!r.sinProfesional }
  })

  // GET /api/pagos/servicio/:id
  app.get('/servicio/:id', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const servicio = await prisma.servicio.findUnique({
      where: { id },
      select: { paciente: { select: { usuarioId: true } }, profesional: { select: { usuarioId: true } } },
    })
    const u = request.usuario
    const permitido = !!servicio && (u.rol === 'admin' || servicio.paciente?.usuarioId === u.id || servicio.profesional?.usuarioId === u.id)
    if (!permitido) return reply.status(404).send({ error: 'Servicio no encontrado' })
    const pago = await prisma.pago.findUnique({
      where: { servicioId: id },
      select: { estado: true, monto: true, estadoLiquidacion: true, createdAt: true },
    })
    return pago || { estado: 'sin_pago' }
  })

  // GET /api/pagos/mis-ganancias — el profesional ve lo que le deben y lo que ya le pagaron
  app.get('/mis-ganancias', { preHandler: requerirRol('profesional') }, async (request, reply) => {
    const prof = await prisma.profesional.findUnique({ where: { usuarioId: request.usuario.id }, select: { id: true, banco: true, cuentaBancaria: true, tipoCuenta: true } })
    if (!prof) return reply.status(404).send({ error: 'Perfil no encontrado' })
    const pagos = await prisma.pago.findMany({
      where: { estado: 'aprobado', servicio: { profesionalId: prof.id } },
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
      select: { id: true, monto: true, valorProfesional: true, estadoLiquidacion: true, transferidoEn: true, liberadoEn: true, soporteNumero: true, createdAt: true, servicio: { select: { tipo: true, fechaFin: true, estado: true } } },
    })
    let porCobrar = 0, enCurso = 0, transferido = 0
    const items = pagos.map((p: any) => {
      const valor = p.valorProfesional != null ? Number(p.valorProfesional) : calcularReparto(Number(p.monto)).valorProfesional
      if (p.estadoLiquidacion === 'liberado') porCobrar += valor
      else if (p.estadoLiquidacion === 'retenido') enCurso += valor
      else if (p.estadoLiquidacion === 'transferido') transferido += valor
      return { id: p.id, tipo: p.servicio?.tipo, fecha: p.servicio?.fechaFin || p.createdAt, valor, estado: p.estadoLiquidacion, transferidoEn: p.transferidoEn, soporte: p.soporteNumero ? 'DS-' + String(p.soporteNumero).padStart(6, '0') : null }
    })
    return { items, porCobrar, enCurso, transferido, cuenta: { banco: prof.banco, tipoCuenta: prof.tipoCuenta, numero: prof.cuentaBancaria } }
  })

  // ── Liquidaciones a profesionales (solo administrador) ──────────────

  // GET /api/pagos/liquidaciones?estado=liberado
  app.get('/liquidaciones', { preHandler: requerirPermiso('pagos') }, async (request) => {
    const { estado } = z.object({
      estado: z.enum(['retenido', 'liberado', 'transferido', 'reembolso', 'revisar', 'reembolsado']).optional(),
    }).parse(request.query)
    const { page } = z.object({ page: z.coerce.number().int().min(1).default(1) }).parse(request.query)

    // "revisar": pagos de Bold cuyo valor no cubre la tarifa (no quedan aprobados)
    const where: any = estado === 'revisar' ? { estadoLiquidacion: 'revisar' }
      : estado === 'reembolsado' ? { estado: 'reembolsado' }
      : estado ? { estado: 'aprobado', estadoLiquidacion: estado }
      : { OR: [{ estado: { in: ['aprobado', 'reembolsado'] } }, { estadoLiquidacion: 'revisar' }] }
    const items = await prisma.pago.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * 100,
      take: 100,
      include: {
        servicio: {
          select: {
            id: true, tipo: true, estado: true, fechaFin: true,
            paciente: { select: { nombreCompleto: true, usuario: { select: { nombreCompleto: true } } } },
            profesional: {
              select: {
                banco: true, cuentaBancaria: true, tipoCuenta: true,
                usuario: { select: { nombreCompleto: true, telefono: true } },
              },
            },
          },
        },
      },
    })

    const resumen = await prisma.pago.groupBy({
      by: ['estado', 'estadoLiquidacion'],
      where: { OR: [{ estado: { in: ['aprobado', 'reembolsado'] } }, { estadoLiquidacion: 'revisar' }] },
      _count: { _all: true },
      _sum: { monto: true, valorProfesional: true },
    })

    return { items, resumen, page, hayMas: items.length === 100 }
  })

  // PUT /api/pagos/liquidaciones/:id/transferido — la IPS ya pagó al profesional
  app.put('/liquidaciones/:id/transferido', { preHandler: requerirPermiso('pagos') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    // Atómico: se marca transferido y recibe el siguiente número de documento soporte (DS) en la misma operación
    const r = await prisma.$transaction(async (tx: any) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('soporte-ds'))::text`
      const u = await tx.pago.updateMany({ where: { id, estadoLiquidacion: 'liberado' }, data: { estadoLiquidacion: 'transferido', transferidoEn: new Date() } })
      if (u.count === 0) return u
      const m = await tx.pago.aggregate({ _max: { soporteNumero: true } })
      await tx.pago.update({ where: { id }, data: { soporteNumero: (m._max.soporteNumero || 0) + 1 } })
      return u
    })
    if (r.count === 0) return reply.status(409).send({ error: 'Solo se pueden marcar pagos liberados' })
    // Aviso a la profesional: ya le pagaron
    const p = await prisma.pago.findUnique({ where: { id }, select: { valorProfesional: true, servicio: { select: { profesional: { select: { usuarioId: true } } } } } }).catch(() => null)
    const uid = p?.servicio?.profesional?.usuarioId
    if (uid) notificarUsuario(uid, { titulo: 'Le transferimos su pago', cuerpo: 'La IPS le transfirió $' + Number(p!.valorProfesional || 0).toLocaleString('es-CO') + '. Véalo en Perfil → Mis ganancias.', url: `${APP_URL}/app-enfermero.html` }).catch(() => {})
    marcarCambio()
    return { ok: true }
  })

  // GET /api/pagos/soporte/:id — documento soporte del pago al profesional (página para imprimir o guardar en PDF).
  // Lo ven Tesorería/Superadministrador y el propio profesional. La transmisión electrónica a la DIAN se hará con Factura-IA
  // cuando tenga el módulo de documento soporte; mientras tanto es el soporte interno del egreso.
  app.get('/soporte/:id', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const p = await prisma.pago.findUnique({ where: { id }, include: { servicio: { select: { id: true, tipo: true, fechaFin: true,
      profesional: { select: { usuarioId: true, documentoTipo: true, documentoNumero: true, banco: true, tipoCuenta: true, cuentaBancaria: true, perfil: true, usuario: { select: { nombreCompleto: true, telefono: true, email: true } } } } } } } })
    if (!p || !p.soporteNumero) return reply.status(404).send({ error: 'Este pago aún no tiene documento soporte (se crea al marcarlo como transferido).' })
    const u = request.usuario
    const esDueno = u.rol === 'profesional' && p.servicio.profesional?.usuarioId === u.id
    if (!esDueno && !tienePermiso(u, 'pagos')) return reply.status(404).send({ error: 'No encontrado' })
    const t = await prisma.tarifa.findUnique({ where: { tipo: p.servicio.tipo }, select: { nombre: true } })
    const pr = p.servicio.profesional
    const e = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
    const $ = (n: number) => '$' + Math.round(n).toLocaleString('es-CO')
    const f = (d?: Date | null) => d ? new Date(d.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') : ''
    const cuenta = pr?.cuentaBancaria ? (pr.banco || '') + (pr.tipoCuenta ? ' · ' + pr.tipoCuenta : '') + ' · ' + pr.cuentaBancaria : 'No registrada'
    const num = 'DS-' + String(p.soporteNumero).padStart(6, '0')
    reply.header('Content-Type', 'text/html; charset=utf-8')
    return reply.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${num} · Salud en Casa</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:'Public Sans',Arial,sans-serif;color:#1C2B39;max-width:760px;margin:24px auto;padding:0 16px}h1{font-family:'Barlow Condensed',Arial,sans-serif;color:#0B4F8A;margin:0}
.cab{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:4px solid #14A38B;padding-bottom:12px;margin-bottom:16px}table{width:100%;border-collapse:collapse;margin:10px 0}td,th{border:1px solid #DCE5EE;padding:8px;text-align:left;font-size:14px}th{background:#E8F1FA}
.tot{font-size:18px;font-weight:bold;color:#0B4F8A}.nota{font-size:12px;color:#5D6B78;margin-top:18px;line-height:1.5}.firmas{display:flex;gap:40px;margin-top:50px}.firmas div{flex:1;border-top:1px solid #1C2B39;padding-top:6px;font-size:13px}
button{background:#0B4F8A;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer}@media print{button{display:none}}</style></head><body>
<button onclick="print()">🖨 Imprimir o guardar en PDF</button>
<div class="cab"><div><h1>Documento soporte de pago</h1><div>Pago a profesional independiente · Salud en Casa</div></div><div style="text-align:right"><b style="font-size:20px">${num}</b><br>Fecha: ${e(f(p.transferidoEn))}</div></div>
<table><tr><th colspan="2">Quien paga</th></tr><tr><td>Razón social</td><td>Reina Elizabeth IPS S.A.S. (Clínica Reina Elizabeth IPS)</td></tr><tr><td>NIT</td><td>901074496-5</td></tr><tr><td>Dirección</td><td>Calle 22 No. 18-18, Santa Marta (Magdalena) · WhatsApp 312 888 6611</td></tr></table>
<table><tr><th colspan="2">Quien recibe (profesional no obligado a facturar)</th></tr><tr><td>Nombre</td><td>${e(pr?.usuario.nombreCompleto)}</td></tr><tr><td>Documento</td><td>${e(pr?.documentoTipo || 'CC')} ${e(pr?.documentoNumero || 'NO REGISTRADO')}</td></tr><tr><td>Contacto</td><td>${e(pr?.usuario.telefono || '')} · ${e(pr?.usuario.email)}</td></tr><tr><td>Medio de pago</td><td>${e(cuenta)}</td></tr></table>
<table><tr><th>Concepto</th><th>Servicio</th><th>Atendido</th><th style="text-align:right">Valor</th></tr>
<tr><td>Honorarios por atención domiciliaria: ${e(t?.nombre || p.servicio.tipo)}</td><td>${e(p.servicio.id.slice(0, 8))}</td><td>${e(f(p.servicio.fechaFin))}</td><td style="text-align:right">${$(Number(p.valorProfesional || 0))}</td></tr>
<tr><td colspan="3" style="text-align:right">Valor pagado por el paciente: ${$(Number(p.monto))} · Parte de la IPS: ${$(Number(p.comision || 0))}</td><td></td></tr>
<tr><td colspan="3" style="text-align:right" class="tot">Total pagado al profesional</td><td style="text-align:right" class="tot">${$(Number(p.valorProfesional || 0))}</td></tr></table>
<div class="firmas"><div>Firma de quien paga (Tesorería)</div><div>Firma de quien recibe</div></div>
<p class="nota">Soporte interno del pago a un profesional independiente no obligado a expedir factura. La transmisión del documento soporte electrónico a la DIAN se hará con Factura-IA cuando ese módulo esté activo para la IPS. Sin retenciones aplicadas en este documento; si la IPS debe practicarlas, se registran en su contabilidad.</p>
<p class="nota" style="text-align:center;border-top:1px solid #DCE5EE;padding-top:8px">Tecnología SkyNet Genesis · contacto@skynetgenesis.com · WhatsApp 304 437 5758</p></body></html>`)
  })

  // PUT /api/pagos/liquidaciones/:id/reembolsado — la IPS devolvió el dinero al paciente
  app.put('/liquidaciones/:id/reembolsado', { preHandler: requerirPermiso('pagos') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    // También los pagos "para revisar" (no alcanzaron la tarifa) se pueden devolver
    const r = await prisma.pago.updateMany({
      where: { id, estadoLiquidacion: { in: ['reembolso', 'revisar'] } },
      data: { estado: 'reembolsado', estadoLiquidacion: 'reembolso' },
    })
    if (r.count === 0) return reply.status(409).send({ error: 'Este pago no está pendiente de reembolso' })
    return { ok: true }
  })
}
