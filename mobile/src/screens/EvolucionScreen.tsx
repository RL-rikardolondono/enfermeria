import React, { useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, Alert, ActivityIndicator,
} from 'react-native'
import { useMutation } from '@tanstack/react-query'
import { api } from '../lib/api'

interface Props { servicioId: string }

export default function EvolucionScreen({ servicioId }: Props) {
  const [signos, setSignos] = useState({
    presionSistolica: '',
    presionDiastolica: '',
    frecuenciaCardiaca: '',
    frecuenciaRespiratoria: '',
    temperatura: '',
    saturacionO2: '',
    glucemia: '',
  })
  const [procedimientos, setProcedimientos] = useState<string[]>([])
  const [nuevoProcedimiento, setNuevoProcedimiento] = useState('')
  const [observaciones, setObservaciones] = useState('')

  const mutation = useMutation({
    mutationFn: async () => {
      const signosNum: any = {}
      Object.entries(signos).forEach(([k, v]) => {
        if (v !== '') signosNum[k] = parseFloat(v)
      })
      const { data } = await api.post(`/servicios/${servicioId}/evolucion`, {
        signosVitales: signosNum,
        procedimientos,
        observaciones: observaciones || undefined,
      })
      return data
    },
    onSuccess: (data) => {
      const alertas = data.alertas ?? []
      if (alertas.length > 0) {
        Alert.alert(
          '⚠️ Alertas clínicas detectadas',
          alertas.map((a: any) => `• ${a.mensaje}`).join('\n'),
          [{ text: 'Entendido' }]
        )
      } else {
        Alert.alert('Evolución guardada', 'Los registros clínicos fueron guardados correctamente.')
      }
    },
    onError: () => Alert.alert('Error', 'No se pudo guardar la evolución'),
  })

  const agregarProcedimiento = () => {
    if (nuevoProcedimiento.trim()) {
      setProcedimientos(p => [...p, nuevoProcedimiento.trim()])
      setNuevoProcedimiento('')
    }
  }

  const SignoInput = ({
    label, campo, unidad, min, max, color,
  }: { label: string; campo: keyof typeof signos; unidad: string; min?: number; max?: number; color?: string }) => {
    const val = parseFloat(signos[campo])
    const esCritico = !isNaN(val) && min !== undefined && max !== undefined && (val < min || val > max)

    return (
      <View style={[styles.signoCard, esCritico && styles.signoCardCritico]}>
        <Text style={[styles.signoLabel, esCritico && styles.signoCriticoTexto]}>{label}</Text>
        <View style={styles.signoInputRow}>
          <TextInput
            style={[styles.signoInput, esCritico && styles.signoInputCritico]}
            value={signos[campo]}
            onChangeText={(v) => setSignos(s => ({ ...s, [campo]: v }))}
            keyboardType="decimal-pad"
            placeholder="—"
            placeholderTextColor="#9ca3af"
          />
          <Text style={styles.signoUnidad}>{unidad}</Text>
        </View>
        {esCritico && <Text style={styles.alertaInline}>¡Valor fuera de rango!</Text>}
      </View>
    )
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.titulo}>Registro de evolución</Text>

      <Text style={styles.seccion}>Signos vitales</Text>
      <View style={styles.signosGrid}>
        <SignoInput label="P. sistólica" campo="presionSistolica" unidad="mmHg" min={90} max={170} />
        <SignoInput label="P. diastólica" campo="presionDiastolica" unidad="mmHg" min={60} max={100} />
        <SignoInput label="F. cardíaca" campo="frecuenciaCardiaca" unidad="lpm" min={50} max={120} />
        <SignoInput label="F. respiratoria" campo="frecuenciaRespiratoria" unidad="rpm" min={12} max={20} />
        <SignoInput label="Temperatura" campo="temperatura" unidad="°C" min={36} max={38.5} />
        <SignoInput label="SatO2" campo="saturacionO2" unidad="%" min={92} max={100} />
        <SignoInput label="Glucemia" campo="glucemia" unidad="mg/dL" min={70} max={180} />
      </View>

      <Text style={styles.seccion}>Procedimientos realizados</Text>
      <View style={styles.addRow}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          value={nuevoProcedimiento}
          onChangeText={setNuevoProcedimiento}
          placeholder="Ej: Curación de herida grado II"
          placeholderTextColor="#9ca3af"
          onSubmitEditing={agregarProcedimiento}
        />
        <TouchableOpacity style={styles.addBtn} onPress={agregarProcedimiento}>
          <Text style={styles.addBtnTexto}>+</Text>
        </TouchableOpacity>
      </View>
      {procedimientos.map((p, i) => (
        <View key={i} style={styles.procedimientoTag}>
          <Text style={styles.procedimientoTexto}>{p}</Text>
          <TouchableOpacity onPress={() => setProcedimientos(ps => ps.filter((_, j) => j !== i))}>
            <Text style={styles.removeTag}>×</Text>
          </TouchableOpacity>
        </View>
      ))}

      <Text style={styles.seccion}>Observaciones clínicas</Text>
      <TextInput
        style={[styles.input, styles.textarea]}
        value={observaciones}
        onChangeText={setObservaciones}
        multiline
        numberOfLines={4}
        placeholder="Evolución del paciente, indicaciones especiales, hallazgos relevantes..."
        placeholderTextColor="#9ca3af"
        textAlignVertical="top"
      />

      <TouchableOpacity
        style={[styles.boton, mutation.isPending && { opacity: 0.7 }]}
        onPress={() => mutation.mutate()}
        disabled={mutation.isPending}
      >
        {mutation.isPending
          ? <ActivityIndicator color="#fff" />
          : <Text style={styles.botonTexto}>Guardar evolución</Text>
        }
      </TouchableOpacity>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  content: { padding: 20, paddingBottom: 40 },
  titulo: { fontSize: 22, fontWeight: '700', color: '#0f172a', marginBottom: 20 },
  seccion: { fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 10, marginTop: 20 },
  signosGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  signoCard: {
    width: '48%', backgroundColor: '#fff', borderRadius: 10,
    padding: 10, borderWidth: 1, borderColor: '#e2e8f0',
  },
  signoCardCritico: { borderColor: '#dc2626', backgroundColor: '#fff5f5' },
  signoLabel: { fontSize: 11, color: '#6b7280', fontWeight: '500', marginBottom: 4 },
  signoCriticoTexto: { color: '#dc2626' },
  signoInputRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  signoInput: {
    flex: 1, fontSize: 18, fontWeight: '700', color: '#111827',
    paddingVertical: 4,
  },
  signoInputCritico: { color: '#dc2626' },
  signoUnidad: { fontSize: 11, color: '#9ca3af' },
  alertaInline: { fontSize: 10, color: '#dc2626', marginTop: 4 },
  addRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  input: {
    borderWidth: 1, borderColor: '#d1d5db', borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: '#111827',
  },
  textarea: { minHeight: 90 },
  addBtn: {
    backgroundColor: '#0284c7', borderRadius: 10, width: 44,
    alignItems: 'center', justifyContent: 'center',
  },
  addBtnTexto: { color: '#fff', fontSize: 22, fontWeight: '700', lineHeight: 28 },
  procedimientoTag: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#dbeafe', borderRadius: 8, padding: 10, marginBottom: 6,
  },
  procedimientoTexto: { fontSize: 13, color: '#1d4ed8', flex: 1 },
  removeTag: { fontSize: 18, color: '#1d4ed8', paddingLeft: 8 },
  boton: {
    backgroundColor: '#0284c7', borderRadius: 12, paddingVertical: 16,
    alignItems: 'center', marginTop: 24,
  },
  botonTexto: { color: '#fff', fontSize: 16, fontWeight: '700' },
})
