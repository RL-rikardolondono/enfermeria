'use client'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, LineChart, Line,
} from 'recharts'
import { api } from '@/lib/api'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'

interface DashboardData {
  serviciosHoy: number
  serviciosActivos: number
  profesionalesDisponibles: number
  pendientesVerificacion: number
  ingresosMes: number
}

export default function DashboardPage() {
  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: async () => (await api.get('/admin/dashboard')).data,
    refetchInterval: 30000,
  })

  const { data: reporte } = useQuery({
    queryKey: ['reporte'],
    queryFn: async () => (await api.get('/admin/reportes')).data,
  })

  if (isLoading) return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
    </div>
  )

  const metricas = [
    { label: 'Servicios hoy',           valor: data?.serviciosHoy ?? 0,              color: 'bg-blue-50 text-blue-700',   border: 'border-blue-200' },
    { label: 'Servicios activos',        valor: data?.serviciosActivos ?? 0,           color: 'bg-green-50 text-green-700', border: 'border-green-200' },
    { label: 'Enf. disponibles',         valor: data?.profesionalesDisponibles ?? 0,   color: 'bg-teal-50 text-teal-700',   border: 'border-teal-200' },
    { label: 'Pend. verificación',       valor: data?.pendientesVerificacion ?? 0,     color: 'bg-amber-50 text-amber-700', border: 'border-amber-200' },
    { label: 'Ingresos del mes',         valor: `$${Number(data?.ingresosMes ?? 0).toLocaleString('es-CO')}`, color: 'bg-purple-50 text-purple-700', border: 'border-purple-200' },
  ]

  // Datos de ejemplo para gráficas (en producción vienen del backend)
  const datosServiciosSemana = [
    { dia: 'Lun', servicios: 12 }, { dia: 'Mar', servicios: 19 },
    { dia: 'Mié', servicios: 15 }, { dia: 'Jue', servicios: 22 },
    { dia: 'Vie', servicios: 28 }, { dia: 'Sáb', servicios: 18 },
    { dia: 'Dom', servicios: 9  },
  ]

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-medium text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500 mt-1">
          {format(new Date(), "EEEE d 'de' MMMM, yyyy", { locale: es })} — Reina Elizabeth IPS
        </p>
      </div>

      {/* Métricas */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
        {metricas.map((m) => (
          <div key={m.label} className={`rounded-xl border p-4 ${m.border}`}>
            <p className="text-xs font-medium text-gray-500 mb-1">{m.label}</p>
            <p className={`text-2xl font-medium ${m.color.split(' ')[1]}`}>{m.valor}</p>
          </div>
        ))}
      </div>

      {/* Gráficas */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <div className="bg-white rounded-xl border border-gray-100 p-6">
          <h2 className="text-sm font-medium text-gray-700 mb-4">Servicios por día (semana actual)</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={datosServiciosSemana}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="dia" tick={{ fontSize: 12, fill: '#6b7280' }} />
              <YAxis tick={{ fontSize: 12, fill: '#6b7280' }} />
              <Tooltip
                contentStyle={{ borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 12 }}
                cursor={{ fill: '#f3f4f6' }}
              />
              <Bar dataKey="servicios" fill="#0284c7" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-6">
          <h2 className="text-sm font-medium text-gray-700 mb-4">Distribución por tipo de servicio</h2>
          {reporte?.porTipo && (
            <div className="space-y-3 mt-4">
              {reporte.porTipo.map((t: any) => {
                const total = reporte.porTipo.reduce((a: number, b: any) => a + b._count, 0)
                const pct = Math.round((t._count / total) * 100)
                const colorMap: any = { rutina: '#0284c7', urgente: '#d97706', emergencia: '#dc2626' }
                return (
                  <div key={t.tipo}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="capitalize text-gray-700">{t.tipo}</span>
                      <span className="text-gray-500">{t._count} ({pct}%)</span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-2 rounded-full transition-all"
                        style={{ width: `${pct}%`, backgroundColor: colorMap[t.tipo] ?? '#6b7280' }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Servicios activos en vivo */}
      <ServiciosActivos />

      {/* Cola de verificación */}
      {(data?.pendientesVerificacion ?? 0) > 0 && <ColaVerificacion />}
    </div>
  )
}

function ServiciosActivos() {
  const { data, isLoading } = useQuery({
    queryKey: ['servicios-activos'],
    queryFn: async () => {
      const { data } = await api.get('/admin/servicios?estado=en_curso&limit=10')
      return data
    },
    refetchInterval: 15000,
  })

  const estadoBadge: Record<string, string> = {
    en_camino: 'bg-amber-50 text-amber-700 border-amber-200',
    en_curso:  'bg-green-50 text-green-700 border-green-200',
    asignado:  'bg-blue-50 text-blue-700 border-blue-200',
  }

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-6 mb-6">
      <h2 className="text-sm font-medium text-gray-700 mb-4">Servicios activos en este momento</h2>
      {isLoading ? (
        <div className="text-sm text-gray-400">Cargando...</div>
      ) : data?.items?.length === 0 ? (
        <div className="text-sm text-gray-400 py-4 text-center">No hay servicios activos en este momento</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left py-2 px-3 text-xs font-medium text-gray-500">Paciente</th>
                <th className="text-left py-2 px-3 text-xs font-medium text-gray-500">Profesional</th>
                <th className="text-left py-2 px-3 text-xs font-medium text-gray-500">Tipo</th>
                <th className="text-left py-2 px-3 text-xs font-medium text-gray-500">Estado</th>
                <th className="text-left py-2 px-3 text-xs font-medium text-gray-500">Inicio</th>
              </tr>
            </thead>
            <tbody>
              {data?.items?.map((s: any) => (
                <tr key={s.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="py-3 px-3 font-medium text-gray-900">
                    {s.paciente?.usuario?.nombreCompleto}
                  </td>
                  <td className="py-3 px-3 text-gray-600">
                    {s.profesional?.usuario?.nombreCompleto ?? '—'}
                  </td>
                  <td className="py-3 px-3 capitalize text-gray-600">{s.tipo}</td>
                  <td className="py-3 px-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs border ${estadoBadge[s.estado] ?? 'bg-gray-50 text-gray-600 border-gray-200'}`}>
                      {s.estado.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="py-3 px-3 text-gray-500 text-xs">
                    {s.iniciadoEn ? format(new Date(s.iniciadoEn), 'HH:mm') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ColaVerificacion() {
  const { data } = useQuery({
    queryKey: ['verificacion'],
    queryFn: async () => (await api.get('/admin/profesionales/verificacion')).data,
  })

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-6">
      <h2 className="text-sm font-medium text-amber-800 mb-3">
        Profesionales pendientes de verificación ({data?.length ?? 0})
      </h2>
      <div className="space-y-2">
        {data?.slice(0, 5).map((p: any) => (
          <div key={p.id} className="flex items-center justify-between bg-white rounded-lg px-4 py-3 border border-amber-100">
            <div>
              <p className="text-sm font-medium text-gray-900">{p.usuario.nombreCompleto}</p>
              <p className="text-xs text-gray-500">{p.titulo} · RETHUS: {p.registroRethus ?? 'Pendiente'}</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  await api.post(`/admin/profesionales/${p.id}/aprobar`, { aprobado: true })
                }}
                className="text-xs bg-green-600 text-white px-3 py-1.5 rounded-lg hover:bg-green-700"
              >
                Aprobar
              </button>
              <button
                onClick={async () => {
                  await api.post(`/admin/profesionales/${p.id}/aprobar`, { aprobado: false, motivo: 'Documentación incompleta' })
                }}
                className="text-xs bg-red-100 text-red-700 px-3 py-1.5 rounded-lg hover:bg-red-200"
              >
                Rechazar
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
