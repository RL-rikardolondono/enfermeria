// Envío de correos con Resend (https://resend.com). Plan gratuito: 3.000 correos al mes.
// Variables en Render:
//   RESEND_API_KEY  → llave de la cuenta de Resend
//   EMAIL_FROM      → remitente, p. ej. "Reina Elizabeth IPS <no-responder@reinaelizabeth.com>"
//                     (mientras no se verifique el dominio, usar "onboarding@resend.dev")

const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const EMAIL_FROM = process.env.EMAIL_FROM || 'Reina Elizabeth IPS <onboarding@resend.dev>'

export const CORREO_ACTIVO = !!RESEND_API_KEY

export async function enviarCorreo(para: string, asunto: string, html: string): Promise<boolean> {
  if (!RESEND_API_KEY) {
    console.warn(`Correo NO enviado a ${para} ("${asunto}"): falta RESEND_API_KEY en Render`)
    return false
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to: [para], subject: asunto, html }),
    })
    if (!res.ok) console.error('Resend respondió', res.status, await res.text())
    return res.ok
  } catch (err) {
    console.error('Error enviando correo', err)
    return false
  }
}
