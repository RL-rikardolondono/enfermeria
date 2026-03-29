// services/tarifas.ts
import { TipoServicio } from '@prisma/client'

const TARIFAS_BASE: Record<TipoServicio, number> = {
  rutina:      85000,
  urgente:     130000,
  emergencia:  200000,
}

export async function calcularTarifa(tipo: TipoServicio): Promise<number> {
  return TARIFAS_BASE[tipo]
}
