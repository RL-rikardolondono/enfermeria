// Dirección pública de las pantallas de Salud en Casa (GitHub Pages con dominio propio).
// Se puede cambiar con la variable APP_URL en Render sin tocar el código.
export const APP_URL = (process.env.APP_URL || 'https://saludencasa.skynetgenesis.com').replace(/\/+$/, '')

// Orígenes que pueden llamar a la API desde el navegador
export const ORIGENES_PERMITIDOS = Array.from(new Set([
  APP_URL,
  'https://saludencasa.skynetgenesis.com',
  'https://rl-rikardolondono.github.io',
  'http://localhost:3001',
  ...(process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean),
]))
