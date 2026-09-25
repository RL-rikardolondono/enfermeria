import Redis from 'ioredis'

// Redis es opcional. Si REDIS_URL no está definido (por ejemplo, en el plan
// gratuito de Render), se usa un almacén en memoria con la misma interfaz
// mínima que necesita la app (get, setex, disconnect).

interface AlmacenClaveValor {
  get(clave: string): Promise<string | null>
  setex(clave: string, segundos: number, valor: string): Promise<unknown>
  disconnect(): void
}

class AlmacenEnMemoria implements AlmacenClaveValor {
  private datos = new Map<string, { valor: string; expira: number }>()

  async get(clave: string) {
    const item = this.datos.get(clave)
    if (!item) return null
    if (Date.now() > item.expira) {
      this.datos.delete(clave)
      return null
    }
    return item.valor
  }

  async setex(clave: string, segundos: number, valor: string) {
    this.datos.set(clave, { valor, expira: Date.now() + segundos * 1000 })
    return 'OK'
  }

  disconnect() {
    this.datos.clear()
  }
}

export const redisReal: Redis | null = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true })
  : null

if (redisReal) {
  redisReal.on('error', (err) => console.error('Redis error:', err))
} else {
  console.log('REDIS_URL no definido: usando almacén en memoria')
}

export const redis: AlmacenClaveValor = redisReal ?? new AlmacenEnMemoria()
