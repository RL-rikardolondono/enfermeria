import { prisma } from '../utils/prisma'
import { marcarCambio } from '../utils/cambios'

// Turno del profesional: pulsa "Disponible" al empezar y le llegan avisos al celular aunque tenga la app cerrada.
// El turno se termina cuando él pulsa "No disponible", a las 12 horas, o si deja pasar 3 solicitudes seguidas.
export const HORAS_TURNO = 12
export const MAX_IGNORADAS = 3

export const inicioTurnoVigente = () => new Date(Date.now() - HORAS_TURNO * 3600 * 1000)

// Condición (para Prisma) de un profesional que puede recibir solicitudes ahora
export function enTurno() {
  return {
    disponible: true,
    activo: true,
    estadoVerificacion: 'aprobado' as const,
    disponibleDesde: { gt: inicioTurnoVigente() },
    // Debe tener una sesión abierta: si se le cerró, no puede atender lo que le llegue
    usuario: { estado: 'activo' as const, sesiones: { some: { activa: true, expiresAt: { gt: new Date() } } } },
  }
}

// Apaga los turnos que pasaron de 12 horas (se ejecuta junto con el cierre de solicitudes vencidas)
export async function cerrarTurnosVencidos() {
  const r = await prisma.profesional.updateMany({
    where: {
      disponible: true,
      OR: [
        { disponibleDesde: null },
        { disponibleDesde: { lte: inicioTurnoVigente() } },
        { usuario: { sesiones: { none: { activa: true, expiresAt: { gt: new Date() } } } } },
      ],
    },
    data: { disponible: false, disponibleDesde: null, ignoradas: 0 },
  })
  if (r.count) marcarCambio()
}

// El profesional respondió (miró las solicitudes, se ofreció o descartó): se reinicia su contador
export async function profesionalRespondio(profesionalId: string) {
  await prisma.profesional.updateMany({ where: { id: profesionalId, ignoradas: { gt: 0 } }, data: { ignoradas: 0 } })
}
