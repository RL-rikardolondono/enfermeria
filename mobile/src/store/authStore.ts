import { create } from 'zustand'
import * as SecureStore from 'expo-secure-store'
import { api } from '../lib/api'

interface Usuario {
  id: string
  rol: 'paciente' | 'profesional' | 'admin'
  nombreCompleto: string
  email: string
  fotoUrl?: string
}

interface AuthState {
  usuario: Usuario | null
  accessToken: string | null
  isLoading: boolean
  login: (email: string, password: string, dispositivo?: string) => Promise<void>
  logout: () => Promise<void>
  restoreSession: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  usuario: null,
  accessToken: null,
  isLoading: true,

  login: async (email, password, dispositivo) => {
    const { data } = await api.post('/auth/login', { email, password, dispositivo })
    await SecureStore.setItemAsync('accessToken', data.accessToken)
    await SecureStore.setItemAsync('refreshToken', data.refreshToken)
    set({ usuario: data.usuario, accessToken: data.accessToken })
  },

  logout: async () => {
    try { await api.post('/auth/logout') } catch {}
    await SecureStore.deleteItemAsync('accessToken')
    await SecureStore.deleteItemAsync('refreshToken')
    set({ usuario: null, accessToken: null })
  },

  restoreSession: async () => {
    try {
      const token = await SecureStore.getItemAsync('accessToken')
      if (!token) { set({ isLoading: false }); return }
      api.defaults.headers.common['Authorization'] = `Bearer ${token}`
      const { data } = await api.get('/auth/me')
      set({ usuario: data, accessToken: token, isLoading: false })
    } catch {
      await SecureStore.deleteItemAsync('accessToken')
      set({ isLoading: false })
    }
  },
}))
