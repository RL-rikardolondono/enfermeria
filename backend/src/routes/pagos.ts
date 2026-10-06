import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { autenticar, requerirRol } from '../middleware/auth'
import { calcularReparto } from '../services/liquidacion'
import crypto from 'crypto'
import { APP_URL } from '../utils/config'

const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY || ''
const WOMPI_INTEGRITY_SECRET = process.env.WOMPI_INTEGRITY_SECRET || ''
const WOMPI_EVENTS_SECRET = process.env.WOMPI_EVENTS_SECRET || ''

function generarFirma(ref: string, monto: number, moneda: string, secreto: string): string {
  const cadena = `${ref}${monto}${moneda}${secreto}`
  return crypto.createHash('sha256').update(cadena).digest('hex')
}

// Verifica que el evento venga realmente de Wompi (firma con el secreto de eventos)
function eventoWompiValido(body: any): boolean {
  if (!WOMPI_EVENTS_SECRET || !body?.signature?.properties || !body?.signature?.checksum) return false
  const valores = (body.signature.properties as string[]).map((ruta) =>
    ruta.split('.').reduce((obj: any, k: string) => (obj == null ? obj : obj[k]), body.data),
  )
  const cadena = valores.join('') + String(body.timestamp) + WOMPI_EVENTS_SECRET
  const calculado = crypto.createHash('sha256').update(cadena).digest('hex')
  const recibido = String(body.signature.checksum).toLowerCase()
  return calculado.length === recibido.length &&
    crypto.timingSafeEqual(Buffer.from(calculado), Buffer.from(recibido))
}

export async function pagosRoutes(app: FastifyInstance) {

  // POST /api/pagos/iniciar — datos para el widget de Wompi (solo el titular del servicio)
  app.post('/iniciar', { preHandler: autenticar }, async (request, reply) => {
    const { servicioId } = z.object({ servicioId: z.string().uuid() }).parse(request.body)
    const servicio = await prisma.servicio.findUnique({
      where: { id: servicioId },
      include: {
        pago: true,
        paciente: { include: { usuario: { select: { id: true, email: true, nombreCompleto: true } } } },
      },
    })
    if (!servicio || servicio.paciente?.usuario?.id !== request.usuario.id) {
      return reply.status(404).send({ error: 'Servicio no encontrado' })
    }
    if (!servicio.monto) return reply.status(400).send({ error: 'Sin monto definido' })
    if (servicio.pago?.estado === 'aprobado') return reply.status(409).send({ error: 'Este servicio ya está pagado' })
    if (servicio.estado === 'cancelado') return reply.status(400).send({ error: 'El servicio está cancelado' })
    if (!WOMPI_PUBLIC_KEY) return reply.status(503).send({ error: 'Los pagos en línea aún no están activos' })

    const referencia = `RE-${servicioId.slice(0, 8)}-${Date.now()}`
    const montoEnCentavos = Math.round(Number(servicio.monto) * 100)
    const firma = generarFirma(referencia, montoEnCentavos, 'COP', WOMPI_INTEGRITY_SECRET)

    return {
      publicKey: WOMPI_PUBLIC_KEY,
      referencia,
      monto: montoEnCentavos,
      moneda: 'COP',
      firma,
      email: servicio.paciente?.usuario?.email || '',
      redirectUrl: `${APP_URL}/app-paciente.html`,
    }
  })

  // POST /api/pagos/confirmar — webhook de eventos de Wompi
  app.post('/confirmar', async (request, reply) => {
    try {
      const body = request.body as any
      if (!eventoWompiValido(body)) {
        app.log.warn('Evento de Wompi rechazado: firma inválida o WOMPI_EVENTS_SECRET sin configurar')
        return reply.status(200).send({ ok: true })
      }
      const tx = body?.data?.transaction
      if (body.event !== 'transaction.updated' || tx?.status !== 'APPROVED') return reply.status(200).send({ ok: true })

      const prefijo = String(tx.reference || '').split('-')[1]
      if (!prefijo) return reply.status(200).send({ ok: true })
      const servicio = await prisma.servicio.findFirst({ where: { id: { startsWith: prefijo } } })
      if (!servicio) return reply.status(200).send({ ok: true })

      const monto = tx.amount_in_cents / 100
      if (Math.round(Number(servicio.monto) * 100) !== tx.amount_in_cents) {
        app.log.error({ servicioId: servicio.id, monto }, 'Monto pagado no coincide con la tarifa del servicio')
      }
      const { comision, valorProfesional } = calcularReparto(monto)
      await prisma.pago.upsert({
        where: { servicioId: servicio.id },
        update: { estado: 'aprobado', referenciaExterna: tx.id, monto, comision, valorProfesional },
        create: {
          servicioId: servicio.id, monto, estado: 'aprobado', referenciaExterna: tx.id,
          estadoLiquidacion: 'retenido', comision, valorProfesional,
        },
      })
      return reply.status(200).send({ ok: true })
    } catch (e) {
      app.log.error(e, 'Error procesando evento de Wompi')
      return reply.status(200).send({ ok: true })
    }
  })

  // GET /api/pagos/servicio/:id
  app.get('/servicio/:id', { preHandler: autenticar }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const pago = await prisma.pago.findUnique({ where: { servicioId: id } })
    return pago || { estado: 'sin_pago' }
  })

  // ── Liquidaciones a profesionales (solo administrador) ──────────────

  // GET /api/pagos/liquidaciones?estado=liberado
  app.get('/liquidaciones', { preHandler: requerirRol('admin') }, async (request) => {
    const { estado } = z.object({
      estado: z.enum(['retenido', 'liberado', 'transferido', 'reembolso']).optional(),
    }).parse(request.query)

    const items = await prisma.pago.findMany({
      where: { estado: 'aprobado', ...(estado ? { estadoLiquidacion: estado } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
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
      by: ['estadoLiquidacion'],
      where: { estado: 'aprobado' },
      _count: { _all: true },
      _sum: { monto: true, valorProfesional: true },
    })

    return { items, resumen }
  })

  // PUT /api/pagos/liquidaciones/:id/transferido — la IPS ya pagó al profesional
  app.put('/liquidaciones/:id/transferido', { preHandler: requerirRol('admin') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const r = await prisma.pago.updateMany({
      where: { id, estadoLiquidacion: 'liberado' },
      data: { estadoLiquidacion: 'transferido', transferidoEn: new Date() },
    })
    if (r.count === 0) return reply.status(409).send({ error: 'Solo se pueden marcar pagos liberados' })
    return { ok: true }
  })

  // PUT /api/pagos/liquidaciones/:id/reembolsado — la IPS devolvió el dinero al paciente
  app.put('/liquidaciones/:id/reembolsado', { preHandler: requerirRol('admin') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const r = await prisma.pago.updateMany({
      where: { id, estadoLiquidacion: 'reembolso' },
      data: { estado: 'reembolsado' },
    })
    if (r.count === 0) return reply.status(409).send({ error: 'Este pago no está pendiente de reembolso' })
    return { ok: true }
  })
}
