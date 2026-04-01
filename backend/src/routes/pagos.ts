import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { autenticar } from '../middleware/auth'
import crypto from 'crypto'

const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY || ''
const WOMPI_INTEGRITY_SECRET = process.env.WOMPI_INTEGRITY_SECRET || ''

function generarFirma(ref: string, monto: number, moneda: string, secreto: string): string {
  const cadena = `${ref}${monto}${moneda}${secreto}`
  return crypto.createHash('sha256').update(cadena).digest('hex')
}

export async function pagosRoutes(app: FastifyInstance) {

  app.post('/iniciar', { preHandler: autenticar }, async (request, reply) => {
    const { servicioId } = z.object({ servicioId: z.string().uuid() }).parse(request.body)
    const servicio = await prisma.servicio.findUnique({
      where: { id: servicioId },
      include: { paciente: { include: { usuario: { select: { email: true, nombreCompleto: true } } } } },
    })
    if (!servicio) return reply.status(404).send({ error: 'Servicio no encontrado' })
    if (!servicio.monto) return reply.status(400).send({ error: 'Sin monto definido' })

    const referencia = `RE-${servicioId.slice(0,8)}-${Date.now()}`
    const montoEnCentavos = Math.round(Number(servicio.monto) * 100)
    const firma = generarFirma(referencia, montoEnCentavos, 'COP', WOMPI_INTEGRITY_SECRET)

    return {
      publicKey: WOMPI_PUBLIC_KEY,
      referencia,
      monto: montoEnCentavos,
      moneda: 'COP',
      firma,
      email: servicio.paciente?.usuario?.email || '',
      redirectUrl: 'https://rl-rikardolondono.github.io/enfermeria/app-paciente.html',
    }
  })

  app.post('/confirmar', async (request, reply) => {
    try {
      const body = request.body as any
      if (body?.event === 'transaction.updated' && body?.data?.transaction?.status === 'APPROVED') {
        const tx = body.data.transaction
        const servicioId = tx.reference?.split('-')[1]
        if (servicioId) {
          const servicio = await prisma.servicio.findFirst({ where: { id: { startsWith: servicioId } } })
          if (servicio) {
            await prisma.pago.upsert({
              where: { servicioId: servicio.id },
              update: { estado: 'aprobado', referenciaExterna: tx.id },
              create: { servicioId: servicio.id, monto: tx.amount_in_cents / 100, estado: 'aprobado', referenciaExterna: tx.id },
            })
          }
        }
      }
      return reply.status(200).send({ ok: true })
    } catch(e) {
      return reply.status(200).send({ ok: true })
    }
  })

  app.get('/servicio/:id', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const pago = await prisma.pago.findUnique({ where: { servicioId: id } })
    return pago || { estado: 'sin_pago' }
  })
}
