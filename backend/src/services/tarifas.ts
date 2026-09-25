import { prisma } from '../utils/prisma'

// Tarifas fijas de Reina Elizabeth IPS (COP, incluyen desplazamiento e insumos básicos).
// Son los valores iniciales; la IPS las ajusta desde el panel administrativo.
export const TARIFAS_INICIALES = [
  { tipo: 'curacion',       nombre: 'Curación',               descripcion: 'Heridas, úlceras y retiro de puntos', precio: 75000 },
  { tipo: 'medicacion',     nombre: 'Administración de medicamentos', descripcion: 'Vía oral, IV o por sonda',  precio: 70000 },
  { tipo: 'inyeccion',      nombre: 'Inyectable',             descripcion: 'Intramuscular o subcutánea',          precio: 45000 },
  { tipo: 'control',        nombre: 'Control de signos vitales', descripcion: 'Tensión, glucometría y saturación', precio: 45000 },
  { tipo: 'cuidado_basico', nombre: 'Cuidado básico (6 h)',   descripcion: 'Higiene, confort y acompañamiento',  precio: 90000 },
  { tipo: 'urgencia',       nombre: 'Atención prioritaria',   descripcion: 'Enfermero(a) profesional, llegada prioritaria', precio: 120000 },
] as const

// Crea las tarifas que falten sin tocar las que la IPS ya haya ajustado.
export async function asegurarTarifas(): Promise<void> {
  for (const t of TARIFAS_INICIALES) {
    await prisma.tarifa.upsert({
      where: { tipo: t.tipo as any },
      update: {},
      create: { ...t, tipo: t.tipo as any },
    })
  }
}

export async function calcularTarifa(tipo: string): Promise<number> {
  const tarifa = await prisma.tarifa.findUnique({ where: { tipo: tipo as any } })
  if (tarifa && tarifa.activo) return tarifa.precio
  const inicial = TARIFAS_INICIALES.find((t) => t.tipo === tipo)
  if (inicial) return inicial.precio
  throw Object.assign(new Error('Tipo de servicio no disponible'), { statusCode: 400 })
}
