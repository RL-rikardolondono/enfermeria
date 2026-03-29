import React, { useState, useEffect } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, Alert, ActivityIndicator, Platform,
} from 'react-native'
import * as Location from 'expo-location'
import MapView, { Marker } from 'react-native-maps'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAuthStore } from '../store/authStore'

type TipoServicio = 'rutina' | 'urgente' | 'emergencia'

const TIPOS: { key: TipoServicio; label: string; color: string; precio: string }[] = [
  { key: 'rutina',     label: 'Rutina',     color: '#0284c7', precio: '$85.000' },
  { key: 'urgente',    label: 'Urgente',    color: '#d97706', precio: '$130.000' },
  { key: 'emergencia', label: 'Emergencia', color: '#dc2626', precio: '$200.000' },
]

export default function SolicitarServicioScreen() {
  const { usuario } = useAuthStore()
  const [tipo, setTipo] = useState<TipoServicio>('rutina')
  const [descripcion, setDescripcion] = useState('')
  const [ubicacion, setUbicacion] = useState<{ lat: number; lng: number } | null>(null)
  const [direccion, setDireccion] = useState('')

  useEffect(() => {
    obtenerUbicacion()
  }, [])

  const obtenerUbicacion = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync()
    if (status !== 'granted') {
      Alert.alert('Permiso requerido', 'Necesitamos tu ubicación para asignarte un enfermero cercano')
      return
    }
    const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })
    setUbicacion({ lat: loc.coords.latitude, lng: loc.coords.longitude })

    // Geocoding inverso
    const geo = await Location.reverseGeocodeAsync({ latitude: loc.coords.latitude, longitude: loc.coords.longitude })
    if (geo[0]) {
      setDireccion(`${geo[0].street} ${geo[0].streetNumber ?? ''}, ${geo[0].city}`)
    }
  }

  const mutation = useMutation({
    mutationFn: async () => {
      if (!ubicacion) throw new Error('Ubicación no disponible')
      const { data } = await api.post('/servicios', {
        tipo,
        descripcion,
        latDestino: ubicacion.lat,
        lngDestino: ubicacion.lng,
        direccionDestino: direccion || 'Ubicación actual',
      })
      return data
    },
    onSuccess: (data) => {
      Alert.alert(
        'Solicitud enviada',
        `Tu solicitud fue creada. Estamos buscando un enfermero disponible cerca de ti.\n\nID: ${data.id.slice(0, 8)}...`,
        [{ text: 'Ver estado', onPress: () => {} }]
      )
    },
    onError: (err: any) => {
      Alert.alert('Error', err.response?.data?.error || 'No se pudo crear la solicitud')
    },
  })

  const tipoSeleccionado = TIPOS.find(t => t.key === tipo)!

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.titulo}>Solicitar atención</Text>
      <Text style={styles.subtitulo}>Bienvenido, {usuario?.nombreCompleto.split(' ')[0]}</Text>

      {/* Tipo de servicio */}
      <Text style={styles.seccion}>Tipo de servicio</Text>
      <View style={styles.tiposRow}>
        {TIPOS.map(t => (
          <TouchableOpacity
            key={t.key}
            style={[styles.tipoBtn, tipo === t.key && { backgroundColor: t.color, borderColor: t.color }]}
            onPress={() => setTipo(t.key)}
          >
            <Text style={[styles.tipoBtnTexto, tipo === t.key && { color: '#fff' }]}>{t.label}</Text>
            <Text style={[styles.tipoPrecio, tipo === t.key && { color: 'rgba(255,255,255,0.85)' }]}>{t.precio}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Descripción */}
      <Text style={styles.seccion}>¿Qué tipo de atención necesitas?</Text>
      <TextInput
        style={styles.textarea}
        value={descripcion}
        onChangeText={setDescripcion}
        multiline
        numberOfLines={4}
        placeholder="Ej: Curacion de herida en pierna derecha, necesito toma de signos vitales..."
        placeholderTextColor="#9ca3af"
      />

      {/* Mapa */}
      <Text style={styles.seccion}>Tu ubicación</Text>
      {ubicacion ? (
        <View style={styles.mapaContainer}>
          <MapView
            style={styles.mapa}
            initialRegion={{
              latitude: ubicacion.lat,
              longitude: ubicacion.lng,
              latitudeDelta: 0.01,
              longitudeDelta: 0.01,
            }}
            onPress={(e) => {
              const { latitude, longitude } = e.nativeEvent.coordinate
              setUbicacion({ lat: latitude, lng: longitude })
            }}
          >
            <Marker
              coordinate={{ latitude: ubicacion.lat, longitude: ubicacion.lng }}
              title="Tu ubicación"
              pinColor={tipoSeleccionado.color}
            />
          </MapView>
          <Text style={styles.direccionTexto}>{direccion || 'Mueve el mapa para ajustar'}</Text>
        </View>
      ) : (
        <View style={styles.mapaPlaceholder}>
          <ActivityIndicator color="#0284c7" />
          <Text style={{ color: '#6b7280', marginTop: 8 }}>Obteniendo ubicación...</Text>
        </View>
      )}

      {/* Resumen */}
      <View style={[styles.resumen, { borderColor: tipoSeleccionado.color }]}>
        <Text style={styles.resumenLabel}>Servicio seleccionado</Text>
        <Text style={[styles.resumenTipo, { color: tipoSeleccionado.color }]}>
          {tipoSeleccionado.label} — {tipoSeleccionado.precio}
        </Text>
        <Text style={styles.resumenNota}>
          {tipo === 'emergencia'
            ? 'Un profesional será despachado de inmediato'
            : 'Se asignará el enfermero más cercano disponible'}
        </Text>
      </View>

      {/* Botón */}
      <TouchableOpacity
        style={[styles.boton, { backgroundColor: tipoSeleccionado.color }, mutation.isPending && styles.botonDisabled]}
        onPress={() => {
          if (!descripcion.trim()) {
            Alert.alert('Campo requerido', 'Describe la atención que necesitas')
            return
          }
          mutation.mutate()
        }}
        disabled={mutation.isPending || !ubicacion}
      >
        {mutation.isPending
          ? <ActivityIndicator color="#fff" />
          : <Text style={styles.botonTexto}>Solicitar enfermero</Text>
        }
      </TouchableOpacity>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  content: { padding: 20, paddingBottom: 40 },
  titulo: { fontSize: 24, fontWeight: '700', color: '#0f172a', marginBottom: 2 },
  subtitulo: { fontSize: 14, color: '#64748b', marginBottom: 24 },
  seccion: { fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 8, marginTop: 20 },
  tiposRow: { flexDirection: 'row', gap: 8 },
  tipoBtn: {
    flex: 1, borderWidth: 1.5, borderColor: '#d1d5db', borderRadius: 10,
    padding: 10, alignItems: 'center',
  },
  tipoBtnTexto: { fontSize: 13, fontWeight: '600', color: '#374151' },
  tipoPrecio: { fontSize: 11, color: '#6b7280', marginTop: 2 },
  textarea: {
    borderWidth: 1, borderColor: '#d1d5db', borderRadius: 10,
    padding: 12, fontSize: 14, color: '#111827', minHeight: 90, textAlignVertical: 'top',
  },
  mapaContainer: { borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: '#e2e8f0' },
  mapa: { height: 200 },
  direccionTexto: { padding: 10, fontSize: 13, color: '#475569', backgroundColor: '#f1f5f9' },
  mapaPlaceholder: {
    height: 200, borderRadius: 12, backgroundColor: '#f1f5f9',
    alignItems: 'center', justifyContent: 'center',
  },
  resumen: {
    borderWidth: 1.5, borderRadius: 12, padding: 14, marginTop: 20,
  },
  resumenLabel: { fontSize: 11, color: '#6b7280', fontWeight: '500' },
  resumenTipo: { fontSize: 16, fontWeight: '700', marginTop: 2 },
  resumenNota: { fontSize: 12, color: '#6b7280', marginTop: 4 },
  boton: {
    borderRadius: 12, paddingVertical: 16, alignItems: 'center', marginTop: 20,
  },
  botonDisabled: { opacity: 0.65 },
  botonTexto: { color: '#fff', fontSize: 16, fontWeight: '700' },
})
