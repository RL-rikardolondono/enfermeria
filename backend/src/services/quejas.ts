import { prisma } from '../utils/prisma'
import { enviarCorreo } from '../utils/correo'
import { marcarCambio } from '../utils/cambios'
import { APP_URL } from '../utils/config'

// Correo donde la IPS recibe las alertas de quejas (variable ALERTAS_EMAIL en Render)
const ALERTAS_EMAIL = process.env.ALERTAS_EMAIL || 'saludencasa@skynetgenesis.com'
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))

type DatosQueja = { servicioId: string; usuarioId: string; profesionalId: string | null; texto: string }

export async function crearQueja(datos: DatosQueja) {
  const queja = await prisma.queja.create({ data: datos })
  avisarQueja(datos)
  return queja
}

// Aviso de una queja ya guardada: actualiza las pantallas y envía el correo a la IPS
export function avisarQueja(datos: DatosQueja) {
  marcarCambio()
  // Alerta por correo a la IPS, en segundo plano
  setImmediate(async () => {
    try {
      const prof = datos.profesionalId
        ? await prisma.profesional.findUnique({ where: { id: datos.profesionalId }, select: { usuario: { select: { nombreCompleto: true } } } })
        : null
      await enviarCorreo(ALERTAS_EMAIL, 'Nueva queja en Salud en Casa',
        `<div style="font-family:Arial,sans-serif;color:#1C2B39">
          <h2 style="color:#0B4F8A">Nueva queja de un paciente</h2>
          <p><b>Profesional:</b> ${esc(prof?.usuario?.nombreCompleto || 'Sin profesional asignado')}</p>
          <p style="background:#F4F8FB;border:1px solid #DCE5EE;border-radius:8px;padding:12px">${esc(datos.texto)}</p>
          <p><a href="${APP_URL}/panel.html" style="background:#14A38B;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Revisar en el panel</a></p>
          <p style="font-size:12px;color:#5D6B78">SkyNet Genesis · contacto@skynetgenesis.com · WhatsApp 3044375758</p>
        </div>`)
    } catch (e) { console.error('No se pudo enviar la alerta de queja', e) }
  })
}
