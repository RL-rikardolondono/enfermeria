import { prisma } from '../utils/prisma'

// Pago retenido: el paciente paga a la IPS al confirmar; la IPS libera el valor
// del profesional solo cuando el servicio termina con nota clínica registrada.
//
// Estados de liquidación del pago:
//   retenido     → pagado por el paciente, en poder de la IPS
//   liberado     → servicio completado con nota clínica; listo para transferir al profesional
//   transferido  → la IPS ya le pagó al profesional
//   reembolso    → servicio cancelado después de pagar; la IPS debe devolver el dinero desde el panel de Bold
//   revisar      → el valor pagado no cubre la tarifa; revisar a mano

export const COMISION_IPS_PORCENTAJE = Math.min(
  100,
  Math.max(0, Number(process.env.COMISION_IPS_PORCENTAJE ?? 40) || 0),
)

// Pagos en línea con el sistema central de Bold de SkyNet Genesis: se activan poniendo PAGOS_BOLD=1 en Render,
// después de agregar los planes saludencasa:cien y saludencasa:prueba al firmador y crear bold-app-saludencasa.php.
// Sin esa variable, el servicio se paga en persona.
export const PAGO_OBLIGATORIO = process.env.PAGOS_BOLD === '1'

export function calcularReparto(monto: number) {
  const comision = Math.round((monto * COMISION_IPS_PORCENTAJE) / 100)
  return { comision, valorProfesional: monto - comision }
}

export async function liberarPago(servicioId: string) {
  const pago = await prisma.pago.findUnique({ where: { servicioId } })
  if (!pago) return null
  const { comision, valorProfesional } = calcularReparto(Number(pago.monto))
  // Atómico: solo pasa de retenido a liberado una vez
  return prisma.pago.updateMany({
    where: { servicioId, estado: 'aprobado', estadoLiquidacion: 'retenido' },
    data: { estadoLiquidacion: 'liberado', liberadoEn: new Date(), comision, valorProfesional },
  })
}

export async function marcarReembolso(servicioId: string, db: any = prisma) {
  return db.pago.updateMany({
    where: { servicioId, estado: 'aprobado', estadoLiquidacion: 'retenido' },
    data: { estadoLiquidacion: 'reembolso' },
  })
}
