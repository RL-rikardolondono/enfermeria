import { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { autenticar, olvidarSesion, olvidarSesionesDe, SESION_MAX_MS, permisosDe } from '../middleware/auth'
import crypto from 'crypto'
import { APP_URL } from '../utils/config'
import { enviarEnlaceClave } from '../services/cuentas'
import { PERFIL_IDS, PERFILES } from '../services/catalogo'

const sha256 = (t: string) => crypto.createHash('sha256').update(t).digest('hex')
 
const registerSchema = z.object({
  rol: z.enum(['paciente', 'profesional']),
  nombreCompleto: z.string().min(3).max(200),
  telefono: z.string().min(7).max(20),
  email: z.string().email().max(150),
  password: z.string().min(10, 'La contraseña debe tener mínimo 10 caracteres').max(100),
  especialidad: z.string().max(100).optional(),
  perfil: z.enum(PERFIL_IDS).optional(),
  aceptaTerminos: z.literal(true, { errorMap: () => ({ message: 'Debe aceptar los términos y la política de datos' }) }),
})
 
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().max(100),
  dispositivo: z.string().max(200).optional(),
})
 
// Freno de intentos de ingreso (como el panel de skynetgenesis.com/admin): 5 fallos seguidos con el mismo
// correo desde la misma conexión bloquean 15 minutos. Se cuenta por correo + IP para que nadie pueda bloquear
// a otra persona desde otro lugar, y el intento se anota ANTES de revisar la clave (intentos simultáneos).
const MAX_FALLOS = 5
const CLAVE_FALSA = '$2a$12$aOKT0Xo68cpopvv7ubsJg.Cqy2eO0DTDsZWWrZkBXa51.HC3ootKa'
const BLOQUEO_MS = 15 * 60 * 1000
const fallos = new Map<string, { n: number; hasta: number; desde?: number }>()
function claveIntento(email: string, ip: string) { return email.toLowerCase().trim() + '|' + (ip || '') }
function bloqueado(clave: string) {
  const f = fallos.get(clave)
  if (!f) return 0
  if (f.hasta && f.hasta > Date.now()) return Math.ceil((f.hasta - Date.now()) / 60000)
  if (f.hasta && f.hasta <= Date.now()) fallos.delete(clave)
  return 0
}

export async function authRoutes(app: FastifyInstance) {
 
  // Crea la sesión en la base de datos y firma los tokens ligados a ella (sid)
  async function abrirSesion(usuario: { id: string; rol: string }, ip: string, dispositivo?: string) {
    // Limpia sesiones vencidas de este usuario
    await prisma.sesion.deleteMany({ where: { usuarioId: usuario.id, expiresAt: { lt: new Date() } } })
    const sesion = await prisma.sesion.create({
      data: { usuarioId: usuario.id, ip: (ip || '').slice(0, 50), dispositivo, expiresAt: new Date(Date.now() + SESION_MAX_MS), ultimoUso: new Date() },
    })
    // Sesiones cortas: máximo 12 horas seguidas y se cierran tras 15 minutos sin uso (ver middleware/auth).
    // Cerrar sesión, cambiar la contraseña o suspender la cuenta la invalida de inmediato.
    const accessToken = app.jwt.sign({ sub: usuario.id, rol: usuario.rol, sid: sesion.id, type: 'access' }, { expiresIn: '12h' })
    const refreshToken = app.jwt.sign({ sub: usuario.id, rol: usuario.rol, sid: sesion.id, type: 'refresh' }, { expiresIn: '12h' })
    return { accessToken, refreshToken }
  }
  const datosPublicos = (u: { id: string; rol: string; rolIps?: string | null; nombreCompleto: string; email: string; telefono: string | null }) =>
    ({ id: u.id, rol: u.rol, rolIps: u.rol === 'admin' ? (u.rolIps || 'superadmin') : undefined, permisos: permisosDe(u), nombreCompleto: u.nombreCompleto, email: u.email, telefono: u.telefono })

  // POST /api/auth/register
  app.post('/register', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
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
      return reply.status(409).send({ error: 'El correo o el teléfono ya están registrados' })
    }

    const passwordHash = await bcrypt.hash(body.password, 12)
    // Usuario y perfil se crean juntos: si algo falla no queda un usuario a medias
    const usuario = await prisma.$transaction(async (tx: any) => {
      const u = await tx.usuario.create({
        data: {
          rol: body.rol,
          nombreCompleto: body.nombreCompleto.trim(),
          telefono,
          email: body.email.toLowerCase(),
          passwordHash,
          estado: 'activo',
          aceptoTerminosEn: new Date(),
        },
      })
      if (body.rol === 'paciente') {
        await tx.paciente.create({
          data: { usuarioId: u.id, nombreCompleto: u.nombreCompleto, parentesco: 'Titular', esTitular: true },
        })
      } else {
        await tx.profesional.create({
          data: {
            usuarioId: u.id,
            especialidad: (body.perfil ? PERFILES[body.perfil] : body.especialidad) || null,
            perfil: body.perfil || null,
            estadoVerificacion: 'pendiente',
            disponible: false,
            totalServicios: 0,
          },
        })
      }
      return u
    })

    const { accessToken, refreshToken } = await abrirSesion(usuario, request.ip)
    return reply.status(201).send({ accessToken, refreshToken, usuario: datosPublicos(usuario) })
  })

  // POST /api/auth/login
  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const body = loginSchema.parse(request.body)
    const clave = claveIntento(body.email, request.ip)
    const minutos = bloqueado(clave)
    if (minutos) return reply.status(429).send({ error: 'Demasiados intentos fallidos. Espere ' + minutos + ' minuto' + (minutos === 1 ? '' : 's') + ' o use "¿Olvidó su contraseña?".' })
    // Se anota el intento antes de revisar la clave
    let f = fallos.get(clave) || { n: 0, hasta: 0, desde: Date.now() }
    // Los fallos viejos (más de 15 minutos) no cuentan
    if (!f.hasta && f.desde && Date.now() - f.desde > BLOQUEO_MS) f = { n: 0, hasta: 0, desde: Date.now() }
    f.n++
    if (f.n >= MAX_FALLOS) f.hasta = Date.now() + BLOQUEO_MS
    fallos.set(clave, f)
    if (fallos.size > 20000) {
      // Se sacan los intentos viejos sin borrar los bloqueos vigentes
      const ahora = Date.now()
      for (const [k, v] of fallos) if (!(v.hasta > ahora) && (!v.desde || ahora - v.desde > BLOQUEO_MS)) fallos.delete(k)
    }

    const usuario = await prisma.usuario.findUnique({
      where: { email: body.email.toLowerCase() },
    })
    // Sin la cuenta también se compara (contra una clave falsa) para tardar lo mismo y no revelar quién existe
    if (!usuario) await bcrypt.compare(body.password, CLAVE_FALSA)
    if (!usuario || !(await bcrypt.compare(body.password, usuario.passwordHash))) {
      const quedan = MAX_FALLOS - f.n
      return reply.status(401).send({ error: f.hasta ? 'Demasiados intentos fallidos. Espere 15 minutos o use "¿Olvidó su contraseña?".'
        : 'Correo o contraseña incorrectos' + (quedan <= 2 ? (quedan === 1 ? '. Le queda 1 intento' : '. Le quedan ' + quedan + ' intentos') + ' antes de un bloqueo de 15 minutos.' : '') })
    }
    fallos.delete(clave)
    if (usuario.estado !== 'activo') {
      return reply.status(403).send({ error: 'Su cuenta está suspendida. Comuníquese con la IPS.' })
    }

    const { accessToken, refreshToken } = await abrirSesion(usuario, request.ip, body.dispositivo)
    await prisma.usuario.update({ where: { id: usuario.id }, data: { ultimoIngreso: new Date() } }).catch(() => {})
    return { accessToken, refreshToken, usuario: datosPublicos(usuario) }
  })

  // POST /api/auth/refresh — solo con una sesión vigente y un usuario activo
  app.post('/refresh', async (request, reply) => {
    const { refreshToken } = z.object({ refreshToken: z.string().max(2000) }).parse(request.body)
    try {
      const payload = app.jwt.verify<{ sub: string; rol: string; sid?: string; type: string }>(refreshToken)
      if (payload.type !== 'refresh' || !payload.sid) throw new Error()
      const sesion = await prisma.sesion.findFirst({
        where: { id: payload.sid, usuarioId: payload.sub, activa: true, expiresAt: { gt: new Date() } },
        select: { usuario: { select: { estado: true, rol: true } } },
      })
      if (!sesion || sesion.usuario.estado !== 'activo') throw new Error()
      const accessToken = app.jwt.sign({ sub: payload.sub, rol: sesion.usuario.rol, sid: payload.sid, type: 'access' }, { expiresIn: '12h' })
      return { accessToken }
    } catch {
      return reply.status(401).send({ error: 'Sesión expirada. Ingrese de nuevo.' })
    }
  })

  // POST /api/auth/sigo — la app avisa que la persona sigue usándola (leyendo, escribiendo) aunque no cargue datos
  app.post('/sigo', { preHandler: autenticar }, async () => ({ ok: true }))

  // POST /api/auth/olvide — envía un enlace para crear una contraseña nueva
  // Siempre responde lo mismo, exista o no el correo, para no revelar quién está registrado.
  app.post('/olvide', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request) => {
    const { email } = z.object({ email: z.string().email() }).parse(request.body)
    const respuesta = { mensaje: 'Si el correo está registrado, le enviamos un enlace para crear una contraseña nueva.' }

    const usuario = await prisma.usuario.findUnique({ where: { email: email.toLowerCase() } })
    if (!usuario || usuario.estado === 'suspendido') return respuesta
    // Máximo un correo cada 5 minutos por persona (cuida el cupo diario de Brevo y el buzón del usuario)
    const reciente = await prisma.recuperacionClave.findFirst({
      where: { usuarioId: usuario.id, createdAt: { gt: new Date(Date.now() - 5 * 60 * 1000) } },
      select: { id: true },
    })
    if (reciente) return respuesta

    // Enlace de 1 hora, un solo uso; las cuentas de la IPS lo reciben en el Gmail del dueño. Sale en segundo plano.
    await enviarEnlaceClave(usuario, 'olvido')
    return respuesta
  })

  // POST /api/auth/restablecer — guarda la contraseña nueva con el enlace del correo
  app.post('/restablecer', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const { token, password } = z.object({
      token: z.string().min(32).max(200),
      password: z.string().min(10, 'La contraseña debe tener mínimo 10 caracteres').max(100),
    }).parse(request.body)

    const registro = await prisma.recuperacionClave.findUnique({
      where: { tokenHash: sha256(token) },
      include: { usuario: { select: { id: true, rol: true } } },
    })
    if (!registro || registro.usadoEn || registro.expiraEn < new Date()) {
      return reply.status(400).send({ error: 'El enlace no es válido o ya venció. Solicite uno nuevo.' })
    }

    // Marca el enlace como usado de forma atómica: dos intentos simultáneos no pueden usarlo dos veces
    const marcado = await prisma.recuperacionClave.updateMany({ where: { id: registro.id, usadoEn: null }, data: { usadoEn: new Date() } })
    if (marcado.count === 0) return reply.status(400).send({ error: 'El enlace no es válido o ya venció. Solicite uno nuevo.' })
    const passwordHash = await bcrypt.hash(password, 12)
    await prisma.$transaction([
      prisma.usuario.update({ where: { id: registro.usuarioId }, data: { passwordHash, claveCreada: true } }),
      // Cierra todas las sesiones abiertas con la contraseña anterior
      prisma.sesion.deleteMany({ where: { usuarioId: registro.usuarioId } }),
    ])
    olvidarSesionesDe(registro.usuarioId)
    return { mensaje: 'Contraseña actualizada. Ya puede ingresar con la nueva.', rol: registro.usuario.rol }
  })

  // POST /api/auth/logout
  app.post('/logout', { preHandler: autenticar }, async (request) => {
    const { sid } = request.user as { sid?: string }
    await prisma.sesion.deleteMany({ where: { id: sid, usuarioId: request.usuario.id } })
    olvidarSesion(sid)
    // El profesional que sale deja de aparecer como disponible y retira sus ofertas
    if (request.usuario.rol === 'profesional') {
      const p = await prisma.profesional.findUnique({ where: { usuarioId: request.usuario.id }, select: { id: true } })
      if (p) {
        await prisma.profesional.update({ where: { id: p.id }, data: { disponible: false, ignoradas: 0 } })
        await prisma.oferta.updateMany({ where: { profesionalId: p.id, estado: 'activa', servicio: { programadoPara: null } }, data: { estado: 'retirada' } })
      }
    }
    return { message: 'Sesión cerrada' }
  })
 
  // GET /api/auth/me
  app.get('/me', { preHandler: autenticar }, async (request) => {
    const usuario = await prisma.usuario.findUnique({
      where: { id: request.usuario.id },
      select: {
        id: true, rol: true, rolIps: true, nombreCompleto: true,
        email: true, telefono: true, fotoUrl: true, estado: true,
      },
    })
    if (!usuario) return usuario
    const { rolIps, ...resto } = usuario
    return { ...resto, rolIps: usuario.rol === 'admin' ? (rolIps || 'superadmin') : undefined, permisos: permisosDe(usuario) }
  })
}
 
