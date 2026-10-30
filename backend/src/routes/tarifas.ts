import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { requerirRol } from '../middleware/auth'
import { marcarCambio } from '../utils/cambios'

let cacheTarifas: { items: unknown[]; hasta: number } | null = null

export async function tarifasRoutes(app: FastifyInstance) {
  // GET /api/tarifas — público: tarifas activas para mostrar al paciente
  app.get('/', async () => {
    if (cacheTarifas && cacheTarifas.hasta > Date.now()) return { items: cacheTarifas.items }
    const items = await prisma.tarifa.findMany({ orderBy: { precio: 'asc' } })
    cacheTarifas = { items, hasta: Date.now() + 10 * 60 * 1000 }
    return { items }
  })

  // PUT /api/tarifas/:tipo — solo administrador de la IPS
  app.put('/:tipo', { preHandler: requerirRol('admin') }, async (request, reply) => {
    const { tipo } = z.object({
      tipo: z.enum(['curacion', 'medicacion', 'inyeccion', 'control', 'cuidado_basico', 'urgencia']),
    }).parse(request.params)
    const body = z.object({
      precio: z.number().int().min(10000).max(2000000).optional(),
      nombre: z.string().min(3).max(100).optional(),
      descripcion: z.string().max(200).optional(),
      activo: z.boolean().optional(),
    }).parse(request.body)

    const existe = await prisma.tarifa.findUnique({ where: { tipo: tipo as any } })
    if (!existe) return reply.status(404).send({ error: 'Tipo de servicio no encontrado' })

    const tarifa = await prisma.tarifa.update({ where: { tipo: tipo as any }, data: body })
    cacheTarifas = null
    marcarCambio()
    return tarifa
  })
}
