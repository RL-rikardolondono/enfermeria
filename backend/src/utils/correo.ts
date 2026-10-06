// Envío de correos de Salud en Casa.
// Servicio principal: Brevo (cuenta de SkyNet Genesis, plan gratis de 300 correos al día).
// Respaldo: Resend, solo si Brevo no está configurado.
//
// Variables en Render:
//   BREVO_API_KEY   → llave de API de Brevo (SMTP & API → API keys)
//   EMAIL_FROM      → remitente: "Salud en Casa <saludencasa@skynetgenesis.com>"
//                     (el dominio skynetgenesis.com debe estar autenticado en Brevo)
//   RESEND_API_KEY  → (opcional) respaldo mientras se termina de configurar Brevo

const BREVO_API_KEY = process.env.BREVO_API_KEY || ''
const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const EMAIL_FROM = process.env.EMAIL_FROM || 'Salud en Casa <saludencasa@skynetgenesis.com>'

export const CORREO_ACTIVO = !!(BREVO_API_KEY || RESEND_API_KEY)

// "Salud en Casa <saludencasa@skynetgenesis.com>" → { name, email }
function remitente(): { name: string; email: string } {
  const m = EMAIL_FROM.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/)
  if (m) return { name: m[1] || 'Salud en Casa', email: m[2] }
  return { name: 'Salud en Casa', email: EMAIL_FROM.trim() }
}

async function enviarConBrevo(para: string, asunto: string, html: string): Promise<boolean> {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender: remitente(),
      to: [{ email: para }],
      replyTo: { email: remitente().email, name: remitente().name },
      subject: asunto,
      htmlContent: html,
    }),
  })
  if (!res.ok) console.error('Brevo respondió', res.status, await res.text())
  return res.ok
}

async function enviarConResend(para: string, asunto: string, html: string): Promise<boolean> {
  const r = remitente()
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${r.name} <${r.email}>`, to: [para], subject: asunto, html }),
  })
  if (!res.ok) console.error('Resend respondió', res.status, await res.text())
  return res.ok
}

export async function enviarCorreo(para: string, asunto: string, html: string): Promise<boolean> {
  try {
    if (BREVO_API_KEY) {
      if (await enviarConBrevo(para, asunto, html)) return true
      // Si Brevo falla (p. ej. remitente aún sin autenticar), intenta con Resend
      if (RESEND_API_KEY) return await enviarConResend(para, asunto, html)
      return false
    }
    if (RESEND_API_KEY) return await enviarConResend(para, asunto, html)
    console.warn(`Correo NO enviado a ${para} ("${asunto}"): falta BREVO_API_KEY en Render`)
    return false
  } catch (err) {
    console.error('Error enviando correo', err)
    return false
  }
}
