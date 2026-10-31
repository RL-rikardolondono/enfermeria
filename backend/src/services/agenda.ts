import crypto from 'crypto'
import { prisma } from '../utils/prisma'
import { marcarCambio } from '../utils/cambios'
import { APP_URL } from '../utils/config'
import { documentosAlDia, enTransicion } from './catalogo'

// ── Citas programadas ──────────────────────────────────────────────────────────
// Un servicio programado se "activa" 2 horas antes de la cita: desde ahí cuenta como servicio del profesional
// (no recibe urgencias) y puede salir hacia el domicilio. Antes, el profesional sigue libre para otros servicios.
export const HORAS_ACTIVACION = 2
export const HORAS_MIN_PROGRAMAR = 3 // con al menos 3 horas de anticipación
export const DIAS_MAX_PROGRAMAR = 30
export const MAX_CITAS_POR_CUENTA = 10
export const ESTADOS_ACTIVOS = ['asignado', 'en_camino', 'en_curso'] as const

const H = 3600 * 1000
export const limiteActivacion = () => new Date(Date.now() + HORAS_ACTIVACION * H)

// Servicios que hoy ocupan al profesional (urgentes, o citas que empiezan en menos de 2 horas)
export function ocupadoAhora() {
  return {
    estado: { in: [...ESTADOS_ACTIVOS] },
    OR: [{ programadoPara: null }, { programadoPara: { lte: limiteActivacion() } }],
  }
}

// Hasta cuándo se reciben ofertas para una cita: hasta 2 horas antes (si ya es muy pronto, 10 minutos más)
export function finBusquedaProgramada(programadoPara: Date) {
  const tope = programadoPara.getTime() - HORAS_ACTIVACION * H
  return new Date(Math.max(Date.now() + 10 * 60 * 1000, tope))
}

// Plazo para pagar una cita después de confirmarla: 15 minutos si el paciente la eligió en la app; si fue
// "otra visita" que el profesional aceptó (el paciente quizá no está mirando), hasta 12 horas (y 2 horas antes de la cita)
export function plazoPagoCita(programadoPara: Date, dirigida: boolean) {
  if (!dirigida) return new Date(Date.now() + 15 * 60 * 1000)
  const tope = programadoPara.getTime() - HORAS_ACTIVACION * H
  return new Date(Math.max(Date.now() + 15 * 60 * 1000, Math.min(Date.now() + 12 * H, tope)))
}

// ¿Ya tiene el profesional otra cita (o un servicio urgente) que se cruce con esa hora? (±2 horas)
export async function conflictoAgenda(profesionalId: string, fecha: Date, excluirServicioId?: string) {
  const desde = new Date(fecha.getTime() - HORAS_ACTIVACION * H), hasta = new Date(fecha.getTime() + HORAS_ACTIVACION * H)
  const n = await prisma.servicio.count({
    where: {
      profesionalId, estado: { in: [...ESTADOS_ACTIVOS] },
      ...(excluirServicioId ? { id: { not: excluirServicioId } } : {}),
      programadoPara: { gte: desde, lte: hasta },
    },
  })
  if (n > 0) return true
  // Si la cita es en menos de 4 horas, un servicio urgente que está atendiendo ahora también se cruza
  if (fecha.getTime() - Date.now() < 2 * HORAS_ACTIVACION * H) {
    const urgente = await prisma.servicio.count({ where: { profesionalId, programadoPara: null, estado: { in: [...ESTADOS_ACTIVOS] } } })
    if (urgente) return true
  }
  return false
}

// ¿Puede trabajar? (aprobado, activo, con perfil y documentos al día; o en el plazo de transición)
export async function puedeTrabajar(profesionalId: string) {
  const p = await prisma.profesional.findUnique({ where: { id: profesionalId }, select: { estadoVerificacion: true, activo: true, perfil: true, createdAt: true } })
  if (!p || p.estadoVerificacion !== 'aprobado' || !p.activo) return false
  if (await enTransicion(p)) return true
  return !!p.perfil && (await documentosAlDia(profesionalId)).ok
}

// Código de 4 números que el paciente le dice al profesional cuando llega (así ambos saben que es la persona correcta)
export const nuevoCodigo = () => String(crypto.randomInt(0, 10000)).padStart(4, '0')

export function validarFechaCita(texto: string): Date | string {
  const f = new Date(texto)
  if (!Number.isFinite(f.getTime())) return 'La fecha de la cita no es válida.'
  if (f.getTime() < Date.now() + HORAS_MIN_PROGRAMAR * H) return 'Programe la cita con al menos ' + HORAS_MIN_PROGRAMAR + ' horas de anticipación. Si es urgente, pida el servicio para ahora.'
  if (f.getTime() > Date.now() + DIAS_MAX_PROGRAMAR * 24 * H) return 'Solo se pueden programar citas hasta ' + DIAS_MAX_PROGRAMAR + ' días adelante.'
  return f
}

export const fechaCita = (d: Date) => d.toLocaleString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' })

// Recordatorios (2 horas antes) y aviso a la IPS cuando una cita ya pasó y el profesional no la ha iniciado.
// Se revisa como máximo cada 5 minutos, cuando alguien usa la app.
let ultimaRevisionCitas = 0
export async function revisarCitas() {
  if (Date.now() - ultimaRevisionCitas < 5 * 60 * 1000) return
  ultimaRevisionCitas = Date.now()
  const { notificarUsuario } = await import('../routes/push')
  const ahora = new Date()
  const proximas = await prisma.servicio.findMany({
    where: { estado: 'asignado', recordadoEn: null, programadoPara: { gt: ahora, lte: limiteActivacion() } },
    select: { id: true, tipo: true, programadoPara: true, paciente: { select: { usuarioId: true } }, profesional: { select: { usuarioId: true } } },
    take: 100,
  })
  for (const s of proximas) {
    const r = await prisma.servicio.updateMany({ where: { id: s.id, recordadoEn: null }, data: { recordadoEn: ahora } })
    if (!r.count) continue
    const hora = s.programadoPara!.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' })
    if (s.profesional) notificarUsuario(s.profesional.usuarioId, { titulo: 'Cita de hoy a las ' + hora, cuerpo: 'Recuerde su servicio programado. Revise la dirección y salga a tiempo.', url: `${APP_URL}/app-enfermero.html` }).catch(() => {})
    if (s.paciente) notificarUsuario(s.paciente.usuarioId, { titulo: 'Su cita es hoy a las ' + hora, cuerpo: 'El profesional le avisará cuando salga. Tenga a mano el código de llegada.', url: `${APP_URL}/app-paciente.html` }).catch(() => {})
  }
  if (proximas.length) marcarCambio()
  // Cita que pasó hace más de 1 hora y no ha empezado: la IPS debe llamar al paciente y al profesional
  const atrasadas = await prisma.servicio.findMany({
    where: { estado: { in: ['asignado', 'en_camino'] }, atrasoAvisadoEn: null, programadoPara: { lt: new Date(ahora.getTime() - H) } },
    select: { id: true },
    take: 50,
  })
  if (!atrasadas.length) return
  const { crearQueja } = await import('./quejas')
  for (const s of atrasadas) {
    const r = await prisma.servicio.updateMany({ where: { id: s.id, atrasoAvisadoEn: null }, data: { atrasoAvisadoEn: ahora } })
    if (!r.count) continue
    await crearQueja({ servicioId: s.id, usuarioId: 'sistema', profesionalId: null, texto: 'Cita programada atrasada: pasó más de 1 hora de la hora acordada y el profesional no ha iniciado la visita. Llame al paciente y al profesional.' }).catch(() => {})
  }
}
