import { prisma } from '../utils/prisma'

// Pago retenido: el paciente paga a la IPS al confirmar; la IPS libera el valor
// del profesional solo cuando el servicio termina con nota clínica registrada.
//
// Estados de liquidación del pago:
//   retenido     → pagado por el paciente, en poder de la IPS
//   liberado     → servicio completado con nota clínica; listo para transferir al profesional
//   transferido  → la IPS ya le pagó al profesional
//   reembolso    → servicio cancelado después de pagar; la IPS debe devolver el dinero

export const COMISION_IPS_PORCENTAJE = Math.min(
  100,
  Math.max(0, Number(process.env.COMISION_IPS_PORCENTAJE ?? 18) || 0),
)

// El pago es obligatorio para asignar servicios solo cuando Wompi está configurado.
export const PAGO_OBLIGATORIO = !!process.env.WOMPI_PUBLIC_KEY

export function calcularReparto(monto: number) {
  const comision = Math.round((monto * COMISION_IPS_PORCENTAJE) / 100)
  return { comision, valorProfesional: monto - comision }
}

export async function liberarPago(servicioId: string) {
  const pago = await prisma.pago.findUnique({ where: { servicioId } })
  if (!pago || pago.estado !== 'aprobado' || pago.estadoLiquidacion !== 'retenido') return null
  const { comision, valorProfesional } = calcularReparto(Number(pago.monto))
  return prisma.pago.update({
    where: { servicioId },
    data: { estadoLiquidacion: 'liberado', liberadoEn: new Date(), comision, valorProfesional },
  })
}

export async function marcarReembolso(servicioId: string) {
  const pago = await prisma.pago.findUnique({ where: { servicioId } })
  if (!pago || pago.estado !== 'aprobado' || pago.estadoLiquidacion !== 'retenido') return null
  return prisma.pago.update({ where: { servicioId }, data: { estadoLiquidacion: 'reembolso' } })
}
