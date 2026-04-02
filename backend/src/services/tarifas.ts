const TARIFAS: Record<string, number> = {
  curacion:      85000,
  medicacion:    75000,
  inyeccion:     65000,
  control:       60000,
  cuidado_basico: 90000,
  urgencia:      150000,
  rutina:        85000,
  urgente:       130000,
  emergencia:    200000,
}

export async function calcularTarifa(tipo: string): Promise<number> {
  return TARIFAS[tipo] ?? 85000
}
