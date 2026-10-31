import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { requerirPermiso } from '../middleware/auth'
import { marcarCambio } from '../utils/cambios'
import { TIPOS, PERFIL_IDS, PERFILES } from '../services/catalogo'

let cacheTarifas: { items: unknown[]; hasta: number } | null = null

export async function tarifasRoutes(app: FastifyInstance) {
  // GET /api/tarifas — público: catálogo de servicios con su tarifa (la app muestra solo los activos)
  app.get('/', async () => {
    if (cacheTarifas && cacheTarifas.hasta > Date.now()) return { items: cacheTarifas.items, perfiles: PERFILES }
    const items = await prisma.tarifa.findMany({ orderBy: [{ orden: 'asc' }, { precio: 'asc' }] })
    cacheTarifas = { items, hasta: Date.now() + 10 * 60 * 1000 }
    return { items, perfiles: PERFILES }
  })

  // PUT /api/tarifas/:tipo — solo el Superadministrador (las tarifas no las fija quien cobra ni quien coordina)
  app.put('/:tipo', { preHandler: requerirPermiso('tarifas') }, async (request, reply) => {
    const { tipo } = z.object({ tipo: z.enum(TIPOS) }).parse(request.params)
    const body = z.object({
      precio: z.number().int().min(10000).max(2000000).optional(),
      nombre: z.string().trim().min(3).max(100).optional(),
      descripcion: z.string().trim().max(200).optional(),
      activo: z.boolean().optional(),
      perfiles: z.array(z.enum(PERFIL_IDS)).max(10).optional(),
      requiereOrden: z.boolean().optional(),
    }).parse(request.body)
    if (body.perfiles && !body.perfiles.length) return reply.status(400).send({ error: 'Elija al menos un perfil de profesional que pueda atender este servicio.' })

    const existe = await prisma.tarifa.findUnique({ where: { tipo: tipo as any } })
    if (!existe) return reply.status(404).send({ error: 'Tipo de servicio no encontrado' })

    const tarifa = await prisma.tarifa.update({ where: { tipo: tipo as any }, data: body })
    cacheTarifas = null
    marcarCambio()
    return tarifa
  })
}
