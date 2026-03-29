import React, { useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native'
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'

interface Props { servicioId: string }

export default function TrackingScreen({ servicioId }: Props) {
  const wsRef = useRef<WebSocket | null>(null)
  const [posicionProfesional, setPosicionProfesional] = useState<{ lat: number; lng: number } | null>(null)
  const [ruta, setRuta] = useState<{ latitude: number; longitude: number }[]>([])
  const [conectado, setConectado] = useState(false)
  const mapRef = useRef<MapView>(null)

  const { data: servicio, isLoading } = useQuery({
    queryKey: ['servicio', servicioId],
    queryFn: async () => {
      const { data } = await api.get(`/servicios/${servicioId}`)
      return data
    },
    refetchInterval: 15000,
  })

  useEffect(() => {
    const wsUrl = `${process.env.EXPO_PUBLIC_WS_URL || 'wss://api.reinaelizabeth.com'}/ws/tracking/${servicioId}`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => setConectado(true)
    ws.onclose = () => setConectado(false)

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'ubicacion' && msg.data) {
          const { lat, lng } = msg.data
          setPosicionProfesional({ lat, lng })
          setRuta(prev => [...prev.slice(-30), { latitude: lat, longitude: lng }])

          // Centrar mapa
          mapRef.current?.animateToRegion({
            latitude: lat, longitude: lng,
            latitudeDelta: 0.01, longitudeDelta: 0.01,
          }, 600)
        }
      } catch {}
    }

    return () => ws.close()
  }, [servicioId])

  const estadoColor: Record<string, string> = {
    asignado:    '#0284c7',
    en_camino:   '#d97706',
    en_curso:    '#16a34a',
    completado:  '#6b7280',
  }

  const estadoLabel: Record<string, string> = {
    asignado:    'Profesional asignado',
    en_camino:   'En camino hacia ti',
    en_curso:    'Atención en curso',
    completado:  'Servicio completado',
  }

  if (isLoading) return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color="#0284c7" />
    </View>
  )

  const destLat = parseFloat(servicio?.latDestino ?? '0')
  const destLng = parseFloat(servicio?.lngDestino ?? '0')

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_GOOGLE}
        style={styles.mapa}
        initialRegion={{
          latitude: destLat || 4.6097,
          longitude: destLng || -74.0817,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05,
        }}
      >
        {/* Destino del paciente */}
        <Marker
          coordinate={{ latitude: destLat, longitude: destLng }}
          title="Tu ubicación"
          pinColor="#0284c7"
        />

        {/* Posición del enfermero */}
        {posicionProfesional && (
          <Marker
            coordinate={{ latitude: posicionProfesional.lat, longitude: posicionProfesional.lng }}
            title={`${servicio?.profesional?.usuario?.nombreCompleto}`}
            pinColor="#16a34a"
          />
        )}

        {/* Trayectoria */}
        {ruta.length > 1 && (
          <Polyline
            coordinates={ruta}
            strokeColor="#16a34a"
            strokeWidth={3}
            lineDashPattern={[5, 3]}
          />
        )}
      </MapView>

      {/* Panel inferior */}
      <View style={styles.panel}>
        {/* Estado del servicio */}
        <View style={[styles.estadoBadge, { backgroundColor: estadoColor[servicio?.estado] + '20' }]}>
          <View style={[styles.estadoDot, { backgroundColor: estadoColor[servicio?.estado] }]} />
          <Text style={[styles.estadoTexto, { color: estadoColor[servicio?.estado] }]}>
            {estadoLabel[servicio?.estado] ?? servicio?.estado}
          </Text>
          {!conectado && <Text style={styles.desconectado}> · Sin señal</Text>}
        </View>

        {/* Datos del profesional */}
        {servicio?.profesional && (
          <View style={styles.profesionalCard}>
            <View style={styles.avatarCircle}>
              <Text style={styles.avatarLetra}>
                {servicio.profesional.usuario.nombreCompleto[0]}
              </Text>
            </View>
            <View style={styles.profesionalInfo}>
              <Text style={styles.profesionalNombre}>
                {servicio.profesional.usuario.nombreCompleto}
              </Text>
              <Text style={styles.profesionalSub}>Enfermero/a profesional verificado</Text>
              {posicionProfesional && (
                <Text style={styles.distancia}>En movimiento ·  señal en vivo</Text>
              )}
            </View>
          </View>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  mapa: { flex: 1 },
  panel: {
    backgroundColor: '#fff', padding: 20,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 10, elevation: 8,
  },
  estadoBadge: {
    flexDirection: 'row', alignItems: 'center', padding: 10,
    borderRadius: 8, marginBottom: 16,
  },
  estadoDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  estadoTexto: { fontSize: 14, fontWeight: '600' },
  desconectado: { fontSize: 12, color: '#9ca3af' },
  profesionalCard: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatarCircle: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: '#dbeafe', alignItems: 'center', justifyContent: 'center',
  },
  avatarLetra: { fontSize: 20, fontWeight: '700', color: '#1d4ed8' },
  profesionalInfo: { flex: 1 },
  profesionalNombre: { fontSize: 15, fontWeight: '600', color: '#111827' },
  profesionalSub: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  distancia: { fontSize: 12, color: '#16a34a', marginTop: 4, fontWeight: '500' },
})
