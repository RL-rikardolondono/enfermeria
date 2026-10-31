import { prisma } from '../utils/prisma'

// Precio de un servicio según el catálogo de la IPS (panel → Servicios y tarifas)
export async function calcularTarifa(tipo: string): Promise<number> {
  const tarifa = await prisma.tarifa.findUnique({ where: { tipo: tipo as any } })
  if (!tarifa) throw Object.assign(new Error('Tipo de servicio no disponible'), { statusCode: 400 })
  // Si la IPS desactivó el servicio, no se puede pedir
  if (!tarifa.activo) throw Object.assign(new Error('Este servicio no está disponible por ahora'), { statusCode: 400 })
  return tarifa.precio
}
