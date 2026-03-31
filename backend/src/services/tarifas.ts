// services/tarifas.ts

const TARIFAS_BASE: Record<string, number> = {
  rutina:      85000,
  urgente:     130000,
  emergencia:  200000,
}

export async function calcularTarifa(tipo: string): Promise<number> {
  return TARIFAS_BASE[tipo] ?? 85000
}
