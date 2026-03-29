import { FastifyRequest, FastifyReply } from 'fastify'
import { prisma } from '../utils/prisma'

export interface JwtPayload {
  sub: string        // usuarioId
  rol: string
  iat: number
  exp: number
}

declare module 'fastify' {
  interface FastifyRequest {
    usuario: { id: string; rol: string }
  }
}

export async function autenticar(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    const payload = await request.jwtVerify<JwtPayload>()
    // Verificar que la sesión siga activa en DB
    const sesion = await prisma.sesion.findFirst({
      where: {
        usuarioId: payload.sub,
        expiresAt: { gt: new Date() },
      },
    })
    if (!sesion) {
      return reply.status(401).send({ error: 'Sesión expirada o inválida' })
    }
    request.usuario = { id: payload.sub, rol: payload.rol }
  } catch {
    return reply.status(401).send({ error: 'Token inválido' })
  }
}

export function requerirRol(...roles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await autenticar(request, reply)
    if (!roles.includes(request.usuario?.rol)) {
      return reply.status(403).send({ error: 'Acceso no autorizado' })
    }
  }
}
