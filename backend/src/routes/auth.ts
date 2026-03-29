import { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { autenticar } from '../middleware/auth'

const registerSchema = z.object({
  rol: z.enum(['paciente', 'profesional']),
  nombreCompleto: z.string().min(3).max(200),
  telefono: z.string().regex(/^\+57[0-9]{10}$/),
  email: z.string().email(),
  password: z.string().min(8),
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

    const existe = await prisma.usuario.findFirst({
      where: { OR: [{ email: body.email }, { telefono: body.telefono }] },
    })
    if (existe) {
      return reply.status(409).send({ error: 'Email o teléfono ya registrado' })
    }

    const passwordHash = await bcrypt.hash(body.password, 12)
    const usuario = await prisma.usuario.create({
      data: {
        rol: body.rol,
        nombreCompleto: body.nombreCompleto,
        telefono: body.telefono,
        email: body.email.toLowerCase(),
        passwordHash,
        estado: 'activo',
      },
    })

    // Crear perfil según rol
    if (body.rol === 'paciente') {
      await prisma.paciente.create({
        data: {
          usuarioId: usuario.id,
          documentoTipo: 'CC',
          documentoNumero: `TEMP-${usuario.id.slice(0, 8)}`,
          fechaNacimiento: new Date('2000-01-01'),
        },
      })
    }

    return reply.status(201).send({
      message: 'Usuario registrado exitosamente',
      id: usuario.id,
    })
  })

  // POST /api/auth/login
  app.post('/login', async (request, reply) => {
    const body = loginSchema.parse(request.body)

    const usuario = await prisma.usuario.findUnique({
      where: { email: body.email.toLowerCase() },
    })
    if (!usuario || !(await bcrypt.compare(body.password, usuario.passwordHash))) {
      return reply.status(401).send({ error: 'Credenciales inválidas' })
    }
    if (usuario.estado !== 'activo') {
      return reply.status(403).send({ error: 'Cuenta suspendida o pendiente' })
    }

    const accessToken = app.jwt.sign(
      { sub: usuario.id, rol: usuario.rol },
      { expiresIn: '15m' }
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
        { expiresIn: '15m' }
      )
      return { accessToken: newAccessToken }
    } catch {
      return reply.status(401).send({ error: 'Refresh token inválido' })
    }
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
