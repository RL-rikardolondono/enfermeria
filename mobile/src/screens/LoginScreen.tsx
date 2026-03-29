import React, { useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
} from 'react-native'
import { useRouter } from 'expo-router'
import { useAuthStore } from '../store/authStore'

export default function LoginScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const { login } = useAuthStore()
  const router = useRouter()

  const handleLogin = async () => {
    if (!email || !password) {
      Alert.alert('Campos requeridos', 'Ingresa tu email y contraseña')
      return
    }
    setLoading(true)
    try {
      await login(email.toLowerCase().trim(), password)
      router.replace('/(tabs)/home')
    } catch (err: any) {
      Alert.alert('Error', err.response?.data?.error || 'No se pudo iniciar sesión')
    } finally {
      setLoading(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.inner}>
        <Text style={styles.marca}>Reina Elizabeth</Text>
        <Text style={styles.subtitulo}>Enfermería a domicilio</Text>

        <View style={styles.card}>
          <Text style={styles.label}>Correo electrónico</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            placeholder="tucorreo@email.com"
            placeholderTextColor="#9ca3af"
          />

          <Text style={styles.label}>Contraseña</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="••••••••"
            placeholderTextColor="#9ca3af"
          />

          <TouchableOpacity
            style={[styles.boton, loading && styles.botonDisabled]}
            onPress={handleLogin}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.botonTexto}>Iniciar sesión</Text>
            }
          </TouchableOpacity>

          <TouchableOpacity onPress={() => router.push('/registro')}>
            <Text style={styles.enlace}>¿No tienes cuenta? Regístrate</Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f9ff' },
  inner: { flex: 1, justifyContent: 'center', padding: 24 },
  marca: { fontSize: 28, fontWeight: '700', color: '#0c4a6e', textAlign: 'center', marginBottom: 4 },
  subtitulo: { fontSize: 15, color: '#0369a1', textAlign: 'center', marginBottom: 32 },
  card: {
    backgroundColor: '#fff', borderRadius: 16, padding: 24,
    shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 12, elevation: 4,
  },
  label: { fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 6, marginTop: 12 },
  input: {
    borderWidth: 1, borderColor: '#d1d5db', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: '#111827',
  },
  boton: {
    backgroundColor: '#0284c7', borderRadius: 10, paddingVertical: 14,
    alignItems: 'center', marginTop: 24,
  },
  botonDisabled: { opacity: 0.7 },
  botonTexto: { color: '#fff', fontSize: 16, fontWeight: '700' },
  enlace: { textAlign: 'center', color: '#0284c7', marginTop: 16, fontSize: 14 },
})
