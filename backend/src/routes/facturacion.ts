import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { requerirPermiso, tienePermiso } from '../middleware/auth'
import { marcarCambio } from '../utils/cambios'
import {
  FIA_URL, leerLlave, guardarLlave, llamarFIA, enPausa, pausar, emitirFactura, anularFactura, armarFactura,
  TIPOS_DOC_PACIENTE, daneDe, procesarCola,
} from '../services/facturacion'

// Panel → Facturación: conexión con Factura-IA, cola de facturas de salud con RIPS, reintentos y anulación
export async function facturacionRoutes(app: FastifyInstance) {
  const P = (permiso: string) => requerirPermiso(permiso)
  const bit = (actorId: string, accion: string, detalle?: string) =>
    prisma.bitacora.create({ data: { actorId, accion, detalle: detalle?.slice(0, 500) } }).catch(() => {})

  // GET /api/admin/facturacion/estado — si está conectado y qué le falta a la IPS en Factura-IA
  app.get('/estado', { preHandler: P('facturacion') }, async () => {
    const llave = await leerLlave()
    const conteo = await prisma.factura.groupBy({ by: ['estado'], _count: { _all: true }, _sum: { total: true } })
    const base = { url: FIA_URL, pausa: await enPausa(), conteo }
    if (!llave) return { ...base, conectada: false }
    let r: any
    try {
      r = await llamarFIA('GET', '/api/empresa', undefined, llave)
    } catch { return { ...base, conectada: true, error: 'Factura-IA no respondió. Intente de nuevo en un momento.' } }
    if (r.status === 401) return { ...base, conectada: true, valida: false, error: 'La llave guardada ya no es válida: genere una nueva en Factura-IA y péguela aquí.' }
    if (!r.ok) return { ...base, conectada: true, error: r.error || 'Factura-IA no respondió bien.' }
    const e = r.empresa || {}
    const codigoPrestador = e.salud?.codigoPrestador || null
    return {
      ...base, conectada: true, valida: true,
      empresa: { razon: e.razon || null, nit: e.nit || null, produccion: String(e.ambiente) === '1', activa: !!e.activa || !!e.interna, simulada: !!e.simulada },
      avisos: Array.isArray(r.avisos) ? r.avisos.slice(0, 6).map((a: any) => String(a?.texto || '').slice(0, 300)) : [],
      pasos: r.pasos || null, cupo: r.cupo || null,
      salud: { codigoPrestador, listo: /^\d{12}$/.test(String(codigoPrestador || '')) },
    }
  })

  // PUT /api/admin/facturacion/llave — el Superadministrador pega la llave que generó en Factura-IA
  // (Factura-IA → Datos de la empresa → "Llave de conexión para otras apps"). Nunca se registra la IPS otra vez.
  app.put('/llave', { preHandler: P('cuentas') }, async (request, reply) => {
    const { llave } = z.object({ llave: z.string().trim().min(20).max(200).regex(/^[A-Za-z0-9._-]+$/, 'La llave no es válida') }).parse(request.body)
    let r: any
    try { r = await llamarFIA('GET', '/api/empresa', undefined, llave) }
    catch { return reply.status(502).send({ error: 'No se pudo hablar con Factura-IA. Intente de nuevo en un momento.' }) }
    if (r.status === 401 || !r.ok) return reply.status(400).send({ error: 'Factura-IA no reconoce esa llave. Genere una nueva en Factura-IA y cópiela completa.' })
    await guardarLlave(llave)
    await bit(request.usuario.id, 'fia-llave', 'Conectó Factura-IA (' + String(r.empresa?.razon || r.empresa?.nit || '').slice(0, 100) + ')')
    // las facturas que esperaban la conexión se intentan ya
    await prisma.factura.updateMany({ where: { estado: { in: ['pendiente', 'faltan_datos'] } }, data: { proximoIntento: new Date() } })
    marcarCambio()
    // se envían ya, sin esperar la vuelta de 10 minutos de la cola
    setTimeout(() => { procesarCola().then(() => marcarCambio()).catch(() => {}) }, 500)
    const enCola = await prisma.factura.count({ where: { estado: { in: ['pendiente', 'faltan_datos'] } } })
    return { ok: true, empresa: r.empresa?.razon || null, enCola }
  })

  // DELETE /api/admin/facturacion/llave — desconectar (las facturas ya emitidas siguen en Factura-IA)
  app.delete('/llave', { preHandler: P('cuentas') }, async (request) => {
    await guardarLlave(null)
    await bit(request.usuario.id, 'fia-desconectar', 'Desconectó Factura-IA')
    return { ok: true }
  })

  // PUT /api/admin/facturacion/pausa — pausar o reanudar la emisión automática
  app.put('/pausa', { preHandler: P('facturacion') }, async (request) => {
    const { pausa } = z.object({ pausa: z.boolean() }).parse(request.body)
    await pausar(pausa)
    await bit(request.usuario.id, pausa ? 'fia-pausa' : 'fia-reanudar')
    return { ok: true, pausa }
  })

  // GET /api/admin/facturacion/facturas?estado=&page=
  app.get('/facturas', { preHandler: P('facturacion') }, async (request) => {
    const q = z.object({
      estado: z.enum(['pendiente', 'faltan_datos', 'emitida', 'rechazada', 'anulada']).optional(),
      page: z.coerce.number().int().min(1).default(1),
    }).parse(request.query)
    const items = await prisma.factura.findMany({
      where: q.estado ? { estado: q.estado } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * 50, take: 50,
      include: { servicio: { select: { id: true, tipo: true, fechaFin: true, paciente: { select: { id: true, nombreCompleto: true, usuario: { select: { nombreCompleto: true } } } },
        profesional: { select: { id: true, usuario: { select: { nombreCompleto: true } } } } } } },
    })
    return { items, page: q.page, hayMas: items.length === 50 }
  })

  // GET /api/admin/facturacion/facturas/:id/datos — los datos que pide la factura (para completar los que faltan)
  app.get('/facturas/:id/datos', { preHandler: P('facturacion') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const f = await prisma.factura.findUnique({ where: { id }, include: { servicio: { select: { id: true, tipo: true,
      paciente: { select: { id: true, nombreCompleto: true, documentoTipo: true, documentoNumero: true, fechaNacimiento: true, sexo: true, municipioDane: true, zonaResidencia: true, ciudad: true } },
      profesional: { select: { id: true, documentoTipo: true, documentoNumero: true, usuario: { select: { nombreCompleto: true } } } },
      evoluciones: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, cie10: true, impresionDiagnostica: true } } } } } })
    if (!f) return reply.status(404).send({ error: 'Factura no encontrada' })
    const { faltan } = await armarFactura(f.servicioId)
    const p = f.servicio.paciente
    return { factura: f, faltan: faltan || [], municipioSugerido: p ? (p.municipioDane || daneDe(p.ciudad)) : null, tiposDoc: TIPOS_DOC_PACIENTE }
  })

  // PUT /api/admin/facturacion/facturas/:id/datos — la IPS completa lo que falta y la factura vuelve a la cola
  app.put('/facturas/:id/datos', { preHandler: P('facturacion') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const b = z.object({
      pacienteDocumentoTipo: z.enum(TIPOS_DOC_PACIENTE).optional(),
      pacienteDocumentoNumero: z.string().trim().regex(/^[0-9A-Za-z]{4,20}$/, 'Documento no válido').optional(),
      pacienteFechaNacimiento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !isNaN(Date.parse(v)) && new Date(v) <= new Date(), 'Fecha inválida').optional(),
      pacienteSexo: z.enum(['H', 'M', 'I']).optional(),
      pacienteMunicipio: z.string().regex(/^\d{5}$/, 'Código DANE de 5 números').optional(),
      pacienteZona: z.enum(['01', '02']).optional(),
      profesionalDocumentoTipo: z.enum(['CC', 'CE', 'PA', 'PT', 'PE']).optional(),
      profesionalDocumentoNumero: z.string().trim().regex(/^[0-9A-Za-z]{4,20}$/, 'Cédula no válida').optional(),
      cie10: z.string().trim().toUpperCase().regex(/^[A-Z][0-9]{2}[0-9A-Z]$/, 'Diagnóstico CIE-10 de 4 caracteres (ej. Z480)').optional(),
    }).parse(request.body)
    const f = await prisma.factura.findUnique({ where: { id }, include: { servicio: { select: { pacienteId: true, profesionalId: true, evoluciones: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true } } } } } })
    if (!f) return reply.status(404).send({ error: 'Factura no encontrada' })
    if (!['pendiente', 'faltan_datos', 'rechazada'].includes(f.estado)) return reply.status(409).send({ error: 'Esta factura ya fue emitida o anulada.' })
    const dp: any = {}
    if (b.pacienteDocumentoTipo) dp.documentoTipo = b.pacienteDocumentoTipo
    if (b.pacienteDocumentoNumero) dp.documentoNumero = b.pacienteDocumentoNumero
    if (b.pacienteFechaNacimiento) dp.fechaNacimiento = new Date(b.pacienteFechaNacimiento)
    if (b.pacienteSexo) dp.sexo = b.pacienteSexo
    if (b.pacienteMunicipio) dp.municipioDane = b.pacienteMunicipio
    if (b.pacienteZona) dp.zonaResidencia = b.pacienteZona
    if (Object.keys(dp).length && f.servicio.pacienteId) await prisma.paciente.update({ where: { id: f.servicio.pacienteId }, data: dp })
    // La cédula del profesional la cambia el propio profesional o el Superadministrador (separación de funciones)
    if ((b.profesionalDocumentoNumero || b.profesionalDocumentoTipo) && f.servicio.profesionalId) {
      if (!tienePermiso(request.usuario, 'cuentas')) return reply.status(403).send({ error: 'La cédula del profesional la corrige él en su app o el Superadministrador.' })
      await prisma.profesional.update({ where: { id: f.servicio.profesionalId }, data: { ...(b.profesionalDocumentoTipo ? { documentoTipo: b.profesionalDocumentoTipo } : {}), ...(b.profesionalDocumentoNumero ? { documentoNumero: b.profesionalDocumentoNumero } : {}) } })
    }
    if (b.cie10 && f.servicio.evoluciones[0]) await prisma.evolucion.update({ where: { id: f.servicio.evoluciones[0].id }, data: { cie10: b.cie10 } })
    await bit(request.usuario.id, 'fia-datos', 'Completó datos de la factura del servicio ' + f.servicioId.slice(0, 8))
    await prisma.factura.update({ where: { id }, data: { estado: f.estado === 'rechazada' ? 'rechazada' : 'pendiente', proximoIntento: new Date() } })
    const { faltan } = await armarFactura(f.servicioId)
    return { ok: true, faltan: faltan || [] }
  })

  // POST /api/admin/facturacion/facturas/:id/emitir — emitir ya (o reintentar una rechazada después de corregir)
  app.post('/facturas/:id/emitir', { preHandler: P('facturacion'), config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const f = await prisma.factura.findUnique({ where: { id } })
    if (!f) return reply.status(404).send({ error: 'Factura no encontrada' })
    if (f.estado === 'rechazada') await prisma.factura.update({ where: { id }, data: { estado: 'pendiente' } })
    const r: any = await emitirFactura(id, true)
    await bit(request.usuario.id, 'fia-emitir', 'Emitir factura del servicio ' + f.servicioId.slice(0, 8) + ': ' + (r.factura?.estado || ''))
    marcarCambio()
    return { ok: !!r.ok, factura: r.factura, faltan: r.faltan || [] }
  })

  // POST /api/admin/facturacion/facturas/:id/anular — nota crédito total (o retirarla de la cola si aún no existe ante la DIAN)
  app.post('/facturas/:id/anular', { preHandler: P('facturacion') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { motivo } = z.object({ motivo: z.string().trim().min(10).max(300) }).parse(request.body)
    const r: any = await anularFactura(id, motivo)
    if (!r.ok) return reply.status(r.status || 400).send({ error: r.error })
    await bit(request.usuario.id, 'fia-anular', 'Anuló factura ' + id.slice(0, 8) + ': ' + motivo)
    marcarCambio()
    return r
  })

  // GET /api/admin/facturacion/facturas/:id/pdf — PDF de la factura (desde Factura-IA)
  app.get('/facturas/:id/:formato', { preHandler: P('facturacion') }, async (request, reply) => {
    const { id, formato } = z.object({ id: z.string().uuid(), formato: z.enum(['pdf', 'xml', 'rips']) }).parse(request.params)
    const f = await prisma.factura.findUnique({ where: { id } })
    if (!f?.docId) return reply.status(404).send({ error: 'La factura aún no existe en Factura-IA' })
    const r: Response = await llamarFIA('GET', '/api/documentos/' + encodeURIComponent(f.docId) + '/' + formato, undefined, undefined, true)
    if (!(r as any).ok || typeof (r as any).arrayBuffer !== 'function') return reply.status(502).send({ error: 'Factura-IA no entregó el archivo' })
    reply.header('Content-Type', r.headers.get('content-type') || 'application/octet-stream')
    reply.header('Content-Disposition', `attachment; filename="factura-${(f.numero || f.id.slice(0, 8)).replace(/[^A-Za-z0-9-]/g, '')}.${formato === 'rips' ? 'json' : formato}"`)
    return reply.send(Buffer.from(await r.arrayBuffer()))
  })
}
