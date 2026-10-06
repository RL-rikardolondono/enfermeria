import { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { autenticar } from '../middleware/auth'
import crypto from 'crypto'
import { enviarCorreo } from '../utils/correo'
import { APP_URL } from '../utils/config'

const URL_RESTABLECER = `${APP_URL}/restablecer.html`
const sha256 = (t: string) => crypto.createHash('sha256').update(t).digest('hex')
 
const registerSchema = z.object({
  rol: z.enum(['paciente', 'profesional']),
  nombreCompleto: z.string().min(3).max(200),
  telefono: z.string().min(7).max(20),
  email: z.string().email(),
  password: z.string().min(8),
  especialidad: z.string().max(100).optional(),
  aceptaTerminos: z.boolean().optional(),
})
 
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  dispositivo: z.string().optional(),
})
 
export async function authRoutes(app: FastifyInstance) {
 
  // POST /api/auth/register
  app.post('/register', async (request, reply) => {
    const body = registerSchema.parse(request.body)
 
    // Normalizar teléfono: asegurar que tenga +57
    let telefono = body.telefono.replace(/\s/g, '')
    if (!telefono.startsWith('+')) {
      telefono = '+57' + telefono.replace(/\D/g, '')
    }
 
    const existe = await prisma.usuario.findFirst({
      where: { OR: [{ email: body.email.toLowerCase() }, { telefono }] },
    })
    if (existe) {
      return reply.status(409).send({ error: 'El correo o teléfono ya está registrado' })
    }
 
    const passwordHash = await bcrypt.hash(body.password, 12)
    const usuario = await prisma.usuario.create({
      data: {
        rol: body.rol,
        nombreCompleto: body.nombreCompleto,
        telefono,
        email: body.email.toLowerCase(),
        passwordHash,
        estado: 'activo',
        aceptoTerminosEn: body.aceptaTerminos ? new Date() : null,
      },
    })
 
    // Crear perfil según rol
    if (body.rol === 'paciente') {
      await prisma.paciente.create({
        data: {
          usuarioId: usuario.id,
          nombreCompleto: body.nombreCompleto,
          parentesco: 'Titular',
          esTitular: true,
          documentoTipo: 'CC',
          documentoNumero: `TEMP-${usuario.id.slice(0, 8)}`,
          fechaNacimiento: new Date('2000-01-01'),
        },
      })
    } else if (body.rol === 'profesional') {
      await prisma.profesional.create({
        data: {
          usuarioId: usuario.id,
          especialidad: body.especialidad || null,
          estadoVerificacion: 'pendiente',
          disponible: false,
          totalServicios: 0,
        },
      })
    }
 
    // Generar token para login inmediato (con su sesión, igual que al ingresar)
    const accessToken = app.jwt.sign(
      { sub: usuario.id, rol: usuario.rol },
      { expiresIn: '24h' }
    )
    await prisma.sesion.create({
      data: {
        usuarioId: usuario.id,
        tokenHash: await bcrypt.hash(accessToken, 8),
        ip: request.ip,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    })
 
    return reply.status(201).send({
      accessToken,
      usuario: {
        id: usuario.id,
        rol: usuario.rol,
        nombreCompleto: usuario.nombreCompleto,
        email: usuario.email,
        telefono: usuario.telefono,
      },
    })
  })
 
  // POST /api/auth/login
  app.post('/login', async (request, reply) => {
    const body = loginSchema.parse(request.body)
 
    const usuario = await prisma.usuario.findUnique({
      where: { email: body.email.toLowerCase() },
    })
    if (!usuario || !(await bcrypt.compare(body.password, usuario.passwordHash))) {
      return reply.status(401).send({ error: 'Correo o contraseña incorrectos' })
    }
    if (usuario.estado !== 'activo') {
      return reply.status(403).send({ error: 'Cuenta suspendida o pendiente de activación' })
    }
 
    const accessToken = app.jwt.sign(
      { sub: usuario.id, rol: usuario.rol },
      { expiresIn: '24h' }
    )
    const refreshToken = app.jwt.sign(
      { sub: usuario.id, rol: usuario.rol, type: 'refresh' },
      { expiresIn: '30d' }
    )
 
    const bcryptImport = await import('bcryptjs')
    await prisma.sesion.create({
      data: {
        usuarioId: usuario.id,
        tokenHash: await bcryptImport.hash(accessToken, 8),
        refreshHash: await bcryptImport.hash(refreshToken, 8),
        dispositivo: body.dispositivo,
        ip: request.ip,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    })
 
    return {
      accessToken,
      refreshToken,
      usuario: {
        id: usuario.id,
        rol: usuario.rol,
        nombreCompleto: usuario.nombreCompleto,
        email: usuario.email,
        telefono: usuario.telefono,
      },
    }
  })
 
  // POST /api/auth/refresh
  app.post('/refresh', async (request, reply) => {
    const { refreshToken } = z.object({ refreshToken: z.string() }).parse(request.body)
    try {
      const payload = app.jwt.verify<{ sub: string; rol: string; type: string }>(refreshToken)
      if (payload.type !== 'refresh') throw new Error()
      const newAccessToken = app.jwt.sign(
        { sub: payload.sub, rol: payload.rol },
        { expiresIn: '24h' }
      )
      return { accessToken: newAccessToken }
    } catch {
      return reply.status(401).send({ error: 'Token de refresco inválido' })
    }
  })
 
  // POST /api/auth/olvide — envía un enlace para crear una contraseña nueva
  // Siempre responde lo mismo, exista o no el correo, para no revelar quién está registrado.
  app.post('/olvide', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request) => {
    const { email } = z.object({ email: z.string().email() }).parse(request.body)
    const respuesta = { mensaje: 'Si el correo está registrado, le enviamos un enlace para crear una contraseña nueva.' }

    const usuario = await prisma.usuario.findUnique({ where: { email: email.toLowerCase() } })
    if (!usuario || usuario.estado === 'suspendido') return respuesta

    // Invalida enlaces anteriores y crea uno nuevo válido por 1 hora
    await prisma.recuperacionClave.updateMany({
      where: { usuarioId: usuario.id, usadoEn: null },
      data: { usadoEn: new Date() },
    })
    const token = crypto.randomBytes(32).toString('hex')
    await prisma.recuperacionClave.create({
      data: { usuarioId: usuario.id, tokenHash: sha256(token), expiraEn: new Date(Date.now() + 60 * 60 * 1000) },
    })

    const enlace = `${URL_RESTABLECER}?token=${token}`
    const nombre = usuario.nombreCompleto.split(' ')[0]
    await enviarCorreo(usuario.email, 'Recupere su contraseña · Salud en Casa', `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#15232B">
        <div style="background:#1E3A4C;color:#fff;padding:14px 18px;border-bottom:4px solid #E0A21A;font-size:20px;font-weight:bold">Salud en Casa <span style="font-weight:normal;font-size:13px;opacity:.8">· Clínica Reina Elizabeth IPS</span></div>
        <div style="padding:18px">
          <h2 style="color:#1E3A4C;margin-top:0">Recuperar contraseña</h2>
          <p>Hola, ${nombre}. Recibimos una solicitud para cambiar la contraseña de su cuenta en Salud en Casa.</p>
          <p><a href="${enlace}" style="display:inline-block;background:#1E3A4C;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Crear contraseña nueva</a></p>
          <p style="font-size:13px;color:#5B6B73">El enlace vence en 1 hora y solo sirve una vez. Si usted no lo pidió, ignore este correo: su contraseña actual sigue funcionando.</p>
          <p style="font-size:13px;color:#5B6B73">¿Necesita ayuda? Escríbanos al WhatsApp <a href="https://wa.me/573128886611" style="color:#1F8A4C">312 888 6611</a>.</p>
        </div>
        <p style="font-size:11px;color:#8A979D;text-align:center;border-top:1px solid #D3DCDA;padding-top:10px">Tecnología SkyNet Genesis · contacto@skynetgenesis.com · WhatsApp 304 437 5758</p>
      </div>`)
    return respuesta
  })

  // POST /api/auth/restablecer — guarda la contraseña nueva con el enlace del correo
  app.post('/restablecer', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const { token, password } = z.object({
      token: z.string().min(32).max(200),
      password: z.string().min(8).max(100),
    }).parse(request.body)

    const registro = await prisma.recuperacionClave.findUnique({
      where: { tokenHash: sha256(token) },
      include: { usuario: { select: { id: true, rol: true } } },
    })
    if (!registro || registro.usadoEn || registro.expiraEn < new Date()) {
      return reply.status(400).send({ error: 'El enlace no es válido o ya venció. Solicite uno nuevo.' })
    }

    await prisma.$transaction([
      prisma.usuario.update({ where: { id: registro.usuarioId }, data: { passwordHash: await bcrypt.hash(password, 12) } }),
      prisma.recuperacionClave.update({ where: { id: registro.id }, data: { usadoEn: new Date() } }),
      // Cierra todas las sesiones abiertas con la contraseña anterior
      prisma.sesion.deleteMany({ where: { usuarioId: registro.usuarioId } }),
    ])
    return { mensaje: 'Contraseña actualizada. Ya puede ingresar con la nueva.', rol: registro.usuario.rol }
  })

  // POST /api/auth/logout
  app.post('/logout', { preHandler: autenticar }, async (request, reply) => {
    await prisma.sesion.deleteMany({ where: { usuarioId: request.usuario.id } })
    return { message: 'Sesión cerrada' }
  })
 
  // GET /api/auth/me
  app.get('/me', { preHandler: autenticar }, async (request) => {
    const usuario = await prisma.usuario.findUnique({
      where: { id: request.usuario.id },
      select: {
        id: true, rol: true, nombreCompleto: true,
        email: true, telefono: true, fotoUrl: true, estado: true,
      },
    })
    return usuario
  })
}
 
