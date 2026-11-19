import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import zlib from 'zlib'
import { prisma } from '../utils/prisma'
import { requerirPermiso, tienePermiso } from '../middleware/auth'

// ── Paquete 8: informes por periodo (con CSV para Excel) y copia de seguridad completa ──

// Fechas del informe en hora de Colombia: desde 00:00 hasta 23:59 del día "hasta"
function rango(q: { desde?: string; hasta?: string }) {
  const hoy = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10)
  const hasta = q.hasta || hoy
  const desde = q.desde || hasta.slice(0, 8) + '01'
  const ini = new Date(desde + 'T05:00:00Z')
  const fin = new Date(new Date(hasta + 'T05:00:00Z').getTime() + 24 * 3600 * 1000)
  if (!(ini < fin)) throw Object.assign(new Error('La fecha "desde" debe ser anterior a "hasta"'), { statusCode: 400 })
  if (fin.getTime() - ini.getTime() > 400 * 24 * 3600 * 1000) throw Object.assign(new Error('El informe puede cubrir máximo 13 meses'), { statusCode: 400 })
  return { desde, hasta, ini, fin }
}
const consultaFechas = z.object({
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})
const col = (d?: Date | null) => d ? new Date(d.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') : ''
// CSV para Excel en español: separador punto y coma, BOM UTF-8 y celdas que no se interpretan como fórmulas
function csv(filas: (string | number | null | undefined)[][]) {
  const celda = (v: unknown) => {
    let t = v === null || v === undefined ? '' : String(v)
    if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+([.,]\d+)?$/.test(t)) t = "'" + t
    return /[";\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t
  }
  const pie = [[], ['Generado con Salud en Casa (Clínica Reina Elizabeth IPS) el ' + col(new Date()) + '. Tecnología SkyNet Genesis · contacto@skynetgenesis.com · WhatsApp 304 437 5758']]
  return '﻿' + filas.concat(pie).map((f) => f.map(celda).join(';')).join('\r\n') + '\r\n'
}
// Nombres para leer en Excel (en vez de los códigos internos)
const NOMBRE_PERFIL: Record<string, string> = { enfermero_profesional: 'Enfermero(a) profesional', auxiliar_enfermeria: 'Auxiliar de enfermería', medico: 'Médico(a) general', fisioterapeuta: 'Fisioterapeuta', terapeuta_ocupacional: 'Terapeuta ocupacional', terapeuta_respiratorio: 'Terapeuta respiratorio', psicologo: 'Psicólogo(a)', terapeuta_conductual: 'Terapeuta conductual (ABA)' }
const NOMBRE_VARIOS: Record<string, string> = { aprobado: 'Aprobado', pendiente: 'Pendiente', rechazado: 'Rechazado', reembolsado: 'Reembolsado', fallido: 'Fallido', retenido: 'Retenido (servicio sin terminar)', liberado: 'Por transferir al profesional', transferido: 'Transferido al profesional', reembolso: 'Reembolsado al paciente', revisar: 'Revisar a mano', iniciado: 'Pago iniciado', activo: 'Activa', suspendido: 'Suspendida', pendiente_verificacion: 'Por verificar', emitida: 'Emitida', faltan_datos: 'Faltan datos', rechazada: 'Rechazada por la DIAN', anulada: 'Anulada' }
const nv = (v?: string | null) => (v ? NOMBRE_VARIOS[v] || v : '')
async function nombresServicio() { const t = await prisma.tarifa.findMany({ select: { tipo: true, nombre: true } }).catch(() => [] as any[]); const m: Record<string, string> = {}; t.forEach((x: any) => { m[x.tipo] = x.nombre }); return (v: string) => m[v] || v }
const NOMBRE_ESTADO: Record<string, string> = { pendiente: 'Buscando profesional', asignado: 'Confirmado', en_camino: 'En camino', en_curso: 'Atendiendo', completado: 'Completado', cancelado: 'Cancelado' }

export async function informesRoutes(app: FastifyInstance) {
  const P = (permiso: string) => requerirPermiso(permiso)
  const veDinero = (u: any) => tienePermiso(u, 'pagos') || tienePermiso(u, 'facturacion')

  // GET /api/admin/informes/resumen?desde=AAAA-MM-DD&hasta=AAAA-MM-DD
  app.get('/resumen', { preHandler: P('informes') }, async (request) => {
    const { desde, hasta, ini, fin } = rango(consultaFechas.parse(request.query))
    const enRango = { createdAt: { gte: ini, lt: fin } }
    const [porEstado, porTipo, tarifas, completadosProf, quejas, eventos, calif] = await Promise.all([
      prisma.servicio.groupBy({ by: ['estado'], where: enRango, _count: { _all: true } }),
      prisma.servicio.groupBy({ by: ['tipo', 'estado'], where: enRango, _count: { _all: true } }),
      prisma.tarifa.findMany({ select: { tipo: true, nombre: true } }),
      prisma.servicio.groupBy({ by: ['profesionalId'], where: { ...enRango, estado: 'completado', profesionalId: { not: null } }, _count: { _all: true }, _avg: { calificacion: true } }),
      prisma.queja.groupBy({ by: ['estado'], where: enRango, _count: { _all: true } }),
      prisma.eventoSeguridad.groupBy({ by: ['gravedad'], where: enRango, _count: { _all: true } }),
      prisma.servicio.aggregate({ where: { ...enRango, calificacion: { not: null } }, _avg: { calificacion: true }, _count: { calificacion: true } }),
    ])
    const nombreTipo = Object.fromEntries(tarifas.map((t) => [t.tipo, t.nombre]))
    const tipos: Record<string, { tipo: string; nombre: string; total: number; completados: number; cancelados: number }> = {}
    for (const r of porTipo) {
      const t = (tipos[r.tipo] ||= { tipo: r.tipo, nombre: nombreTipo[r.tipo] || r.tipo, total: 0, completados: 0, cancelados: 0 })
      t.total += r._count._all
      if (r.estado === 'completado') t.completados += r._count._all
      if (r.estado === 'cancelado') t.cancelados += r._count._all
    }
    const profIds = completadosProf.map((p) => p.profesionalId!).filter(Boolean)
    const profs = await prisma.profesional.findMany({ where: { id: { in: profIds } }, select: { id: true, perfil: true, usuario: { select: { nombreCompleto: true } } } })
    const nombreProf = Object.fromEntries(profs.map((p) => [p.id, p.usuario.nombreCompleto]))
    const quejasProf = await prisma.queja.groupBy({ by: ['profesionalId'], where: { ...enRango, profesionalId: { in: profIds } }, _count: { _all: true } })
    const qp = Object.fromEntries(quejasProf.map((q) => [q.profesionalId, q._count._all]))
    const porProfesional: any[] = completadosProf.map((p) => ({
      id: p.profesionalId, nombre: nombreProf[p.profesionalId!] || '—', completados: p._count._all,
      calificacion: p._avg.calificacion ? Math.round(p._avg.calificacion * 10) / 10 : null, quejas: qp[p.profesionalId!] || 0,
    }))

    let dinero: any = null
    if (veDinero(request.usuario)) {
      const [pagos, porProfDinero, facturas] = await Promise.all([
        prisma.pago.groupBy({ by: ['estado', 'estadoLiquidacion'], where: { ...enRango, OR: [{ estado: { in: ['aprobado', 'reembolsado'] } }, { estadoLiquidacion: 'revisar' }] }, _count: { _all: true }, _sum: { monto: true, comision: true, valorProfesional: true } }),
        prisma.pago.findMany({ where: { ...enRango, estado: 'aprobado', estadoLiquidacion: { in: ['liberado', 'transferido'] } }, select: { valorProfesional: true, estadoLiquidacion: true, servicio: { select: { profesionalId: true } } } }),
        prisma.factura.groupBy({ by: ['estado'], where: enRango, _count: { _all: true }, _sum: { total: true } }),
      ])
      const s = (f: (x: typeof pagos[number]) => boolean, k: 'monto' | 'comision' | 'valorProfesional') => pagos.filter(f).reduce((t, x) => t + Number(x._sum[k] || 0), 0)
      const n = (f: (x: typeof pagos[number]) => boolean) => pagos.filter(f).reduce((t, x) => t + x._count._all, 0)
      const valido = (x: typeof pagos[number]) => x.estado === 'aprobado' && !['reembolso', 'revisar'].includes(x.estadoLiquidacion)
      dinero = {
        recaudado: s(valido, 'monto'), pagosRecibidos: n(valido),
        comisionIps: s((x) => valido(x) && ['liberado', 'transferido'].includes(x.estadoLiquidacion), 'comision'),
        porPagarProfesionales: s((x) => valido(x) && x.estadoLiquidacion === 'liberado', 'valorProfesional'),
        pagadoProfesionales: s((x) => valido(x) && x.estadoLiquidacion === 'transferido', 'valorProfesional'),
        enCurso: s((x) => valido(x) && x.estadoLiquidacion === 'retenido', 'monto'),
        porDevolver: s((x) => x.estado === 'aprobado' && x.estadoLiquidacion === 'reembolso', 'monto'),
        devuelto: s((x) => x.estado === 'reembolsado', 'monto'),
        paraRevisar: n((x) => x.estadoLiquidacion === 'revisar'),
        facturas: facturas.map((f) => ({ estado: f.estado, cantidad: f._count._all, total: f._sum.total || 0 })),
      }
      const porP: Record<string, { porPagar: number; pagado: number }> = {}
      for (const x of porProfDinero) {
        const id = x.servicio.profesionalId; if (!id) continue
        const o = (porP[id] ||= { porPagar: 0, pagado: 0 })
        if (x.estadoLiquidacion === 'liberado') o.porPagar += Number(x.valorProfesional || 0); else o.pagado += Number(x.valorProfesional || 0)
      }
      for (const p of porProfesional) Object.assign(p, porP[p.id] || { porPagar: 0, pagado: 0 })
    }
    return {
      desde, hasta,
      servicios: Object.fromEntries(porEstado.map((e) => [e.estado, e._count._all])),
      porTipo: Object.values(tipos).sort((a, b) => b.total - a.total),
      porProfesional: porProfesional.sort((a, b) => b.completados - a.completados),
      calidad: {
        calificacionPromedio: calif._avg.calificacion ? Math.round(calif._avg.calificacion * 10) / 10 : null, calificaciones: calif._count.calificacion,
        quejas: Object.fromEntries(quejas.map((q) => [q.estado, q._count._all])),
        eventos: Object.fromEntries(eventos.map((e) => [e.gravedad, e._count._all])),
      },
      dinero,
    }
  })

  // GET /api/admin/informes/csv/:tipo — servicios | pagos | facturas | profesionales (para abrir en Excel)
  app.get('/csv/:tipo', { preHandler: P('informes'), config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const { tipo } = z.object({ tipo: z.enum(['servicios', 'pagos', 'facturas', 'profesionales']) }).parse(request.params)
    const { desde, hasta, ini, fin } = rango(consultaFechas.parse(request.query))
    if (['pagos', 'facturas'].includes(tipo) && !veDinero(request.usuario)) return reply.status(403).send({ error: 'Su perfil no ve la información de dinero.' })
    const enRango = { createdAt: { gte: ini, lt: fin } }
    let filas: any[][] = []
    const ns = await nombresServicio()
    if (tipo === 'servicios') {
      const L = await prisma.servicio.findMany({ where: enRango, orderBy: { createdAt: 'asc' }, take: 20000, select: {
        id: true, tipo: true, estado: true, barrio: true, createdAt: true, programadoPara: true, fechaInicio: true, fechaFin: true, monto: true, calificacion: true,
        paciente: { select: { nombreCompleto: true } }, profesional: { select: { usuario: { select: { nombreCompleto: true } } } } } })
      filas = [['Servicio', 'Tipo', 'Estado', 'Solicitado', 'Cita para', 'Inicio', 'Fin', 'Barrio', 'Paciente', 'Profesional', 'Valor', 'Calificación'],
        ...L.map((s) => [s.id.slice(0, 8), ns(s.tipo), NOMBRE_ESTADO[s.estado] || s.estado, col(s.createdAt), col(s.programadoPara), col(s.fechaInicio), col(s.fechaFin), s.barrio || '',
          s.paciente?.nombreCompleto || '', s.profesional?.usuario.nombreCompleto || '', veDinero(request.usuario) ? Number(s.monto || 0) : '', s.calificacion ?? ''])]
    } else if (tipo === 'pagos') {
      const L = await prisma.pago.findMany({ where: { ...enRango, OR: [{ estado: { in: ['aprobado', 'reembolsado'] } }, { estadoLiquidacion: 'revisar' }] }, orderBy: { createdAt: 'asc' }, take: 20000, select: {
        createdAt: true, monto: true, estado: true, estadoLiquidacion: true, comision: true, valorProfesional: true, referenciaExterna: true, liberadoEn: true, transferidoEn: true, referenciaTransferencia: true,
        servicio: { select: { id: true, tipo: true, profesional: { select: { documentoNumero: true, banco: true, usuario: { select: { nombreCompleto: true } } } } } } } })
      filas = [['Fecha del pago', 'Servicio', 'Tipo', 'Referencia Bold', 'Valor pagado', 'Estado', 'Liquidación', 'Para la IPS', 'Para el profesional', 'Profesional', 'Cédula', 'Medio de pago del profesional', 'Liberado', 'Transferido', 'Comprobante de la transferencia'],
        ...L.map((p) => [col(p.createdAt), p.servicio.id.slice(0, 8), ns(p.servicio.tipo), p.referenciaExterna || '', Number(p.monto), nv(p.estado), nv(p.estadoLiquidacion), p.comision ?? '', p.valorProfesional ?? '',
          p.servicio.profesional?.usuario.nombreCompleto || '', p.servicio.profesional?.documentoNumero || '', p.servicio.profesional?.banco || '', col(p.liberadoEn), col(p.transferidoEn), p.referenciaTransferencia || ''])]
    } else if (tipo === 'facturas') {
      const L = await prisma.factura.findMany({ where: enRango, orderBy: { createdAt: 'asc' }, take: 20000, include: { servicio: { select: { id: true, tipo: true, paciente: { select: { nombreCompleto: true, documentoNumero: true } } } } } })
      filas = [['Creada', 'Servicio', 'Tipo', 'Paciente', 'Documento', 'Valor', 'Estado', 'Número', 'CUFE', 'CUV (RIPS)', 'Emitida', 'Nota crédito', 'Motivo'],
        ...L.map((f) => [col(f.createdAt), f.servicio.id.slice(0, 8), ns(f.servicio.tipo), f.servicio.paciente?.nombreCompleto || '', f.servicio.paciente?.documentoNumero || '', f.total, nv(f.estado),
          f.numero || '', f.cufe || '', f.cuv || '', col(f.emitidaEn), f.notaCreditoNumero || '', f.motivo || ''])]
    } else {
      const L = await prisma.profesional.findMany({ orderBy: { createdAt: 'asc' }, take: 5000, select: {
        perfil: true, estadoVerificacion: true, calificacionPromedio: true, totalServicios: true, createdAt: true, documentoNumero: true,
        usuario: { select: { nombreCompleto: true, email: true, telefono: true, estado: true } },
        documentos: { select: { tipo: true, estado: true, vence: true } } } })
      filas = [['Nombre', 'Correo', 'Teléfono', 'Cédula', 'Perfil', 'Verificación', 'Cuenta', 'Servicios', 'Calificación', 'Documentos aprobados', 'Póliza vence', 'Registrado'],
        ...L.map((p) => [p.usuario.nombreCompleto, p.usuario.email, p.usuario.telefono || '', p.documentoNumero || '', NOMBRE_PERFIL[p.perfil || ''] || p.perfil || '', nv(p.estadoVerificacion), nv(p.usuario.estado),
          p.totalServicios, p.calificacionPromedio ? Number(p.calificacionPromedio) : '', p.documentos.filter((d) => d.estado === 'aprobado').length,
          col(p.documentos.find((d) => d.tipo === 'poliza' && d.estado === 'aprobado')?.vence).slice(0, 10), col(p.createdAt).slice(0, 10)])]
    }
    await prisma.bitacora.create({ data: { actorId: request.usuario.id, accion: 'informe-csv', detalle: `${tipo} ${desde} a ${hasta}` } }).catch(() => {})
    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="salud-en-casa-${tipo}-${desde}-a-${hasta}.csv"`)
    return reply.send(csv(filas))
  })

  // ── Copia de seguridad ──
  // GET /api/admin/informes/copia/estado — cuándo se hizo la última copia
  app.get('/copia/estado', { preHandler: P('copias') }, async () => {
    const a = await prisma.ajuste.findUnique({ where: { clave: 'ultima_copia' } })
    return { ultima: a?.valor || null }
  })

  // GET /api/admin/informes/copia?archivos=1 — TODA la información de la app en un archivo .json.gz (solo el Superadministrador).
  // No lleva contraseñas, sesiones, enlaces de clave ni llaves secretas. Con archivos=1 incluye los documentos y órdenes médicas.
  app.get('/copia', { preHandler: P('copias'), config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const { archivos } = z.object({ archivos: z.enum(['0', '1']).default('0') }).parse(request.query)
    const [usuarios, pacientes, profesionales, documentos, servicios, evoluciones, pagos, tarifas, ofertas, quejas, bloqueos, recibidos, ajustes, bitacora, mensajes, eventos, facturas, tracking, adjuntos] = await Promise.all([
      prisma.usuario.findMany({ select: { id: true, rol: true, nombreCompleto: true, telefono: true, email: true, estado: true, rolIps: true, aceptoTerminosEn: true, ultimoIngreso: true, createdAt: true, updatedAt: true } }),
      prisma.paciente.findMany(), prisma.profesional.findMany(), prisma.documentoProfesional.findMany(), prisma.servicio.findMany(), prisma.evolucion.findMany(),
      prisma.pago.findMany(), prisma.tarifa.findMany(), prisma.oferta.findMany(), prisma.queja.findMany(), prisma.bloqueo.findMany(), prisma.recibido.findMany(),
      prisma.ajuste.findMany({ where: { NOT: [{ clave: { contains: 'vapid' } }, { clave: { contains: 'llave' } }, { clave: { contains: 'clave' } }, { clave: { contains: 'secret' } }] } }),
      prisma.bitacora.findMany(), prisma.mensaje.findMany(), prisma.eventoSeguridad.findMany(), prisma.factura.findMany(),
      prisma.trackingHistorial.findMany({ where: { createdAt: { gte: new Date(Date.now() - 90 * 24 * 3600 * 1000) } } }),
      archivos === '1' ? prisma.archivo.findMany() : prisma.archivo.findMany({ select: { id: true, categoria: true, mime: true, bytes: true, subidoPor: true, createdAt: true } }),
    ])
    const ahora = new Date()
    const copia = {
      app: 'Salud en Casa', empresa: 'Clínica Reina Elizabeth IPS', tecnologia: 'SkyNet Genesis · contacto@skynetgenesis.com · WhatsApp 304 437 5758',
      creada: ahora.toISOString(), version: 1, conArchivos: archivos === '1',
      aviso: 'Contiene datos de salud (Ley 1581 de 2012 y Res. 1995 de 1999). Guárdela en un lugar seguro y no la comparta.',
      datos: { usuarios, pacientes, profesionales, documentos, servicios, evoluciones, pagos, tarifas, ofertas, quejas, bloqueos, recibidos, ajustes, bitacora, mensajes, eventos, facturas, tracking,
        archivos: (adjuntos as any[]).map((a) => a.datos ? { ...a, datos: Buffer.from(a.datos).toString('base64') } : a) },
    }
    const json = JSON.stringify(copia, (_k, v) => typeof v === 'bigint' ? Number(v) : v)
    const gz = zlib.gzipSync(Buffer.from(json, 'utf8'))
    await prisma.ajuste.upsert({ where: { clave: 'ultima_copia' }, update: { valor: ahora.toISOString() }, create: { clave: 'ultima_copia', valor: ahora.toISOString() } })
    await prisma.bitacora.create({ data: { actorId: request.usuario.id, accion: 'copia-seguridad', detalle: `${archivos === '1' ? 'con archivos' : 'sin archivos'} · ${Math.round(gz.length / 1024)} KB` } }).catch(() => {})
    reply.header('Content-Type', 'application/gzip')
    reply.header('Content-Disposition', `attachment; filename="salud-en-casa-copia-${new Date(ahora.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 10)}.json.gz"`)
    return reply.send(gz)
  })
}
