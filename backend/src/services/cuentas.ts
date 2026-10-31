import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { prisma } from '../utils/prisma'
import { enviarCorreo } from '../utils/correo'
import { APP_URL } from '../utils/config'

// Cuenta del Superadministrador de Salud en Casa (regla del 29 oct 2026: un correo propio por app).
// Se usa solo para entrar: no tiene buzón. Los enlaces de clave de las cuentas del dueño llegan a su Gmail.
export const SUPERADMIN_CORREO = 'superadmin.saludencasa@skynetgenesis.com'
const CORREO_VIEJO = 'superadmin@skynetgenesis.com'
export const DUENO_CORREO = process.env.DUENO_CORREO || 'rikardolondono@gmail.com'

const sha256 = (t: string) => crypto.createHash('sha256').update(t).digest('hex')
const URL_RESTABLECER = `${APP_URL}/restablecer.html`

// A dónde llega el enlace: las cuentas del dueño (Superadministrador y administración antigua sin perfil) van directo a su Gmail;
// las de coordinación y tesorería, al correo de cada persona.
export function esCuentaDelDueno(u: { rol: string; rolIps?: string | null }) {
  return u.rol === 'admin' && (!u.rolIps || u.rolIps === 'superadmin')
}
export function destinoClave(u: { email: string; rol: string; rolIps?: string | null }) {
  return esCuentaDelDueno(u) ? DUENO_CORREO : u.email
}

// Al arrancar: deja lista la cuenta superadmin.saludencasa@ y quita el acceso del correo compartido viejo
export async function asegurarSuperadmin(log: { info: (o: any, m?: string) => void; error: (o: any, m?: string) => void }) {
  const nuevo = await prisma.usuario.findUnique({ where: { email: SUPERADMIN_CORREO } })
  const viejo = await prisma.usuario.findUnique({ where: { email: CORREO_VIEJO } })
  if (!nuevo && viejo && viejo.rol === 'admin') {
    // Se conserva la misma contraseña: solo cambia el correo con que se entra
    await prisma.usuario.update({ where: { id: viejo.id }, data: { email: SUPERADMIN_CORREO, estado: 'activo', rolIps: 'superadmin' } })
    log.info({ id: viejo.id }, 'Superadministrador: el correo compartido pasó a ' + SUPERADMIN_CORREO)
    return
  }
  if (!nuevo) {
    // Sin contraseña usable: el dueño la crea con "¿Olvidó su contraseña?" (el enlace llega a su Gmail)
    const azar = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12)
    await prisma.usuario.create({
      data: { email: SUPERADMIN_CORREO, rol: 'admin', rolIps: 'superadmin', nombreCompleto: 'Superadministrador Salud en Casa', passwordHash: azar, claveCreada: false, estado: 'activo' },
    })
    log.info({}, 'Superadministrador creado: ' + SUPERADMIN_CORREO + ' (crear la contraseña con "¿Olvidó su contraseña?")')
  } else if (nuevo.rol !== 'admin' || nuevo.estado !== 'activo' || nuevo.rolIps !== 'superadmin') {
    await prisma.usuario.update({ where: { id: nuevo.id }, data: { rol: 'admin', estado: 'activo', rolIps: 'superadmin' } })
  }
  // El correo compartido viejo ya no entra a esta app
  if (viejo && viejo.estado === 'activo') {
    await prisma.usuario.update({ where: { id: viejo.id }, data: { estado: 'suspendido' } })
    await prisma.sesion.deleteMany({ where: { usuarioId: viejo.id } })
    log.info({ id: viejo.id }, 'Se quitó el acceso de ' + CORREO_VIEJO)
  }
}

// Crea un enlace de 1 hora (invalida los anteriores) y lo envía. Devuelve a qué correo salió.
export async function enviarEnlaceClave(usuario: { id: string; email: string; rol: string; rolIps?: string | null; nombreCompleto: string }, motivo: 'olvido' | 'ips') {
  await prisma.recuperacionClave.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 7 * 24 * 3600 * 1000) } } })
  await prisma.recuperacionClave.updateMany({ where: { usuarioId: usuario.id, usadoEn: null }, data: { usadoEn: new Date() } })
  const token = crypto.randomBytes(32).toString('hex')
  await prisma.recuperacionClave.create({
    data: { usuarioId: usuario.id, tokenHash: sha256(token), expiraEn: new Date(Date.now() + 60 * 60 * 1000) },
  })
  const enlace = `${URL_RESTABLECER}?token=${token}`
  const para = destinoClave(usuario)
  const nombre = usuario.nombreCompleto.split(' ')[0].replace(/[<>&"']/g, '')
  const cuenta = usuario.email.replace(/[<>&"']/g, '')
  const paraDueno = para !== usuario.email
  const intro = paraDueno
    ? `<p>Enlace para crear o cambiar la contraseña de la cuenta <b>${cuenta}</b> (administración de la IPS) en Salud en Casa.</p>`
    : motivo === 'ips'
      ? `<p>Hola, ${nombre}. La Clínica Reina Elizabeth IPS le envía este enlace para crear o cambiar la contraseña de su cuenta en Salud en Casa.</p>`
      : `<p>Hola, ${nombre}. Recibimos una solicitud para cambiar la contraseña de su cuenta en Salud en Casa.</p>`
  setImmediate(() => {
    enviarCorreo(para, paraDueno ? 'Contraseña de ' + cuenta + ' · Salud en Casa' : 'Su contraseña · Salud en Casa', `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1C2B39">
        <div style="background:#0B4F8A;color:#fff;padding:14px 18px;border-bottom:4px solid #14A38B;font-size:20px;font-weight:bold">Salud en Casa <span style="font-weight:normal;font-size:13px;opacity:.8">· Clínica Reina Elizabeth IPS</span></div>
        <div style="padding:18px">
          <h2 style="color:#0B4F8A;margin-top:0">Crear contraseña nueva</h2>
          ${intro}
          <p><a href="${enlace}" style="display:inline-block;background:#0B4F8A;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Crear contraseña nueva</a></p>
          <p style="font-size:13px;color:#5D6B78">El enlace vence en 1 hora y solo sirve una vez. Si usted no lo pidió, ignore este correo: su contraseña actual sigue funcionando.</p>
          <p style="font-size:13px;color:#5D6B78">¿Necesita ayuda? Escríbanos al WhatsApp <a href="https://wa.me/573128886611" style="color:#1F8A4C">312 888 6611</a>.</p>
        </div>
        <p style="font-size:11px;color:#8A979D;text-align:center;border-top:1px solid #DCE5EE;padding-top:10px">Tecnología SkyNet Genesis · contacto@skynetgenesis.com · WhatsApp 304 437 5758</p>
      </div>`).catch(() => {})
  })
  return para
}
