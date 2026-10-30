import { FastifyRequest, FastifyReply } from 'fastify'
import { prisma } from '../utils/prisma'

export interface JwtPayload {
  sub: string        // usuarioId
  rol: string
  sid?: string       // id de la sesión en la base de datos
  type?: string      // 'access' | 'refresh'
  iat: number
  exp: number
}

declare module 'fastify' {
  interface FastifyRequest {
    usuario: { id: string; rol: string }
  }
}

// Sesiones cortas: máximo 12 horas seguidas; se cierran tras 15 minutos sin uso.
// (Las apps preguntan "¿Sigue ahí?" a los 15 minutos y cierran a los 17; el servidor, por seguridad, a los 17.)
export const SESION_MAX_MS = 12 * 3600 * 1000
export const INACTIVIDAD_MS = 17 * 60 * 1000

// Caché corta de sesiones válidas: evita consultar la base en cada solicitud (ahorra horas de Neon).
// Cerrar sesión, suspender o cambiar la contraseña la invalidan de inmediato en este servidor.
const CACHE_MS = 60 * 1000
const cache = new Map<string, { usuarioId: string; rol: string; hasta: number; usoAnotado: number }>()

export function olvidarSesion(sid?: string) {
  if (sid) cache.delete(sid)
}
export function olvidarSesionesDe(usuarioId: string) {
  for (const [sid, v] of cache) if (v.usuarioId === usuarioId) cache.delete(sid)
}

// Verifica el token y que SU sesión siga activa y el usuario no esté suspendido.
export async function autenticar(request: FastifyRequest, reply: FastifyReply) {
  let payload: JwtPayload
  try {
    payload = await request.jwtVerify<JwtPayload>()
  } catch {
    return reply.status(401).send({ error: 'Token inválido' })
  }
  if (payload.type === 'refresh' || !payload.sid) {
    return reply.status(401).send({ error: 'Sesión expirada o inválida' })
  }

  const deLaPersona = request.headers['x-segundo-plano'] !== '1'
  const enCache = cache.get(payload.sid)
  if (enCache && enCache.hasta > Date.now() && enCache.usuarioId === payload.sub) {
    // Si la persona está usando la app, se anota el uso (una vez por minuto) aunque la caché venga de una consulta automática
    if (deLaPersona && Date.now() - enCache.usoAnotado > 60 * 1000) {
      const u = await prisma.sesion.updateMany({ where: { id: payload.sid }, data: { ultimoUso: new Date() } })
      if (u.count === 0) { cache.delete(payload.sid); return reply.status(401).send({ error: 'Sesión expirada o inválida' }) }
      enCache.usoAnotado = Date.now()
    }
    request.usuario = { id: payload.sub, rol: enCache.rol }
    return
  }

  const sesion = await prisma.sesion.findFirst({
    where: { id: payload.sid, usuarioId: payload.sub, activa: true, expiresAt: { gt: new Date() } },
    select: { ultimoUso: true, usuario: { select: { estado: true, rol: true } } },
  })
  if (!sesion || sesion.usuario.estado !== 'activo') {
    cache.delete(payload.sid)
    return reply.status(401).send({ error: 'Sesión expirada o inválida' })
  }
  // El profesional en turno ("Disponible") no se desconecta por inactividad: guarda el celular y le llegan los avisos.
  // Su sesión dura lo que dura el turno (máximo 12 horas).
  const enTurnoAhora = sesion.usuario.rol === 'profesional' && await prisma.profesional.count({
    where: { usuarioId: payload.sub, disponible: true, activo: true, estadoVerificacion: 'aprobado', disponibleDesde: { gt: new Date(Date.now() - 12 * 3600 * 1000) } },
  }) > 0
  if (!enTurnoAhora && sesion.ultimoUso.getTime() < Date.now() - INACTIVIDAD_MS) {
    cache.delete(payload.sid)
    await prisma.sesion.deleteMany({ where: { id: payload.sid } })
    return reply.status(401).send({ error: 'Su sesión se cerró por inactividad. Ingrese de nuevo.' })
  }
  // Registra el uso de la persona (como máximo una vez por minuto, gracias a la caché).
  // Las consultas automáticas de la app (encabezado X-Segundo-Plano) no cuentan como uso.
  let usoAnotado = 0
  if (deLaPersona) {
    const u = await prisma.sesion.updateMany({ where: { id: payload.sid }, data: { ultimoUso: new Date() } })
    if (u.count === 0) return reply.status(401).send({ error: 'Sesión expirada o inválida' })
    usoAnotado = Date.now()
  }
  if (cache.size > 5000) cache.clear() // límite de memoria
  cache.set(payload.sid, { usuarioId: payload.sub, rol: sesion.usuario.rol, hasta: Date.now() + CACHE_MS, usoAnotado })
  request.usuario = { id: payload.sub, rol: sesion.usuario.rol }
}

export function requerirRol(...roles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await autenticar(request, reply)
    if (reply.sent) return reply
    if (!roles.includes(request.usuario?.rol)) {
      return reply.status(403).send({ error: 'Acceso no autorizado' })
    }
  }
}
