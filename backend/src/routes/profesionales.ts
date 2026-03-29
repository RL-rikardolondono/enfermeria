import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { autenticar, requerirRol } from '../middleware/auth'

export async function profesionalesRoutes(app: FastifyInstance) {

  // GET /api/profesionales/cercanos?lat=&lng=&radio=
  app.get('/cercanos', async (request) => {
    const query = z.object({
      lat: z.coerce.number(),
      lng: z.coerce.number(),
      radio: z.coerce.number().default(15),
      especialidad: z.string().optional(),
    }).parse(request.query)

    const cercanos = await prisma.$queryRaw<any[]>`
      SELECT p.id, u.nombre_completo, u.foto_url,
        p.calificacion_promedio, p.total_servicios, p.especialidades,
        ROUND((ST_Distance(
          up.geom,
          ST_SetSRID(ST_MakePoint(${query.lng}, ${query.lat}), 4326)::geography
        ) / 1000)::DECIMAL, 2) AS distancia_km,
        up.lat, up.lng
      FROM profesionales p
      JOIN usuarios u ON u.id = p.usuario_id
      JOIN ubicacion_profesional up ON up.profesional_id = p.id
      WHERE p.estado_verificacion = 'aprobado'
        AND p.disponible = TRUE AND up.en_servicio = FALSE AND u.estado = 'activo'
        AND (${query.especialidad ?? null} IS NULL OR ${query.especialidad ?? null} = ANY(p.especialidades))
        AND ST_DWithin(up.geom,
          ST_SetSRID(ST_MakePoint(${query.lng}, ${query.lat}), 4326)::geography,
          ${query.radio * 1000})
      ORDER BY distancia_km ASC, p.calificacion_promedio DESC
      LIMIT 10
    `
    return cercanos
  })

  // GET /api/profesionales/:id
  app.get('/:id', { preHandler: autenticar }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const prof = await prisma.profesional.findUnique({
      where: { id },
      include: {
        usuario: { select: { nombreCompleto: true, email: true, telefono: true, fotoUrl: true } },
        ubicacion: true,
        documentos: true,
      },
    })
    if (!prof) return reply.status(404).send({ error: 'Profesional no encontrado' })
    return prof
  })

  // PUT /api/profesionales/:id/ubicacion — GPS update (cada 5s)
  app.put('/:id/ubicacion', { preHandler: requerirRol('profesional') }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { lat, lng } = z.object({ lat: z.number(), lng: z.number() }).parse(request.body)

    await prisma.ubicacionProfesional.upsert({
      where: { profesionalId: id },
      update: { lat, lng, updatedAt: new Date() },
      create: { profesionalId: id, lat, lng },
    })

    return { ok: true }
  })

  // PATCH /api/profesionales/:id/disponibilidad
  app.patch('/:id/disponibilidad', { preHandler: requerirRol('profesional') }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { disponible } = z.object({ disponible: z.boolean() }).parse(request.body)

    const prof = await prisma.profesional.update({
      where: { id },
      data: { disponible },
      select: { id: true, disponible: true },
    })
    return prof
  })

  // PUT /api/profesionales/:id/perfil
  app.put('/:id/perfil', { preHandler: requerirRol('profesional') }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({
      titulo: z.string().optional(),
      universidad: z.string().optional(),
      anioGraduacion: z.number().optional(),
      especialidades: z.array(z.string()).optional(),
      radioServicioKm: z.number().min(1).max(50).optional(),
      tarifaHora: z.number().optional(),
    }).parse(request.body)

    return prisma.profesional.update({ where: { id }, data: body })
  })

  // GET /api/profesionales/:id/servicios
  app.get('/:id/servicios', { preHandler: requerirRol('profesional', 'admin') }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { estado } = z.object({ estado: z.string().optional() }).parse(request.query)

    return prisma.servicio.findMany({
      where: { profesionalId: id, ...(estado ? { estado: estado as any } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        paciente: { include: { usuario: { select: { nombreCompleto: true } } } },
      },
    })
  })
}
