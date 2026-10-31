import { prisma } from '../utils/prisma'

// ── Perfiles de profesional y qué servicios puede atender cada uno ───────────────
export const PERFILES: Record<string, string> = {
  enfermero_profesional: 'Enfermero(a) profesional',
  auxiliar_enfermeria: 'Auxiliar de enfermería',
  medico: 'Médico(a) general',
  fisioterapeuta: 'Fisioterapeuta',
  terapeuta_ocupacional: 'Terapeuta ocupacional',
  terapeuta_respiratorio: 'Terapeuta respiratorio',
  psicologo: 'Psicólogo(a)',
  terapeuta_conductual: 'Terapeuta conductual (ABA)',
}
export const PERFIL_IDS = Object.keys(PERFILES) as [string, ...string[]]
// Un profesional antiguo sin perfil asignado solo atiende lo que puede un auxiliar, hasta que la IPS le asigne el suyo
export const perfilEfectivo = (perfil?: string | null) => perfil || 'auxiliar_enfermeria'

export const TIPOS = ['curacion', 'medicacion', 'inyeccion', 'control', 'cuidado_basico', 'urgencia',
  'consulta_medica', 'terapia_fisica', 'terapia_ocupacional', 'terapia_respiratoria', 'terapia_conductual', 'psicologia'] as const
export type Tipo = typeof TIPOS[number]

const ENF = ['enfermero_profesional', 'auxiliar_enfermeria']
// Catálogo inicial. Los servicios nuevos (médico y terapias) nacen INACTIVOS: la IPS fija precio y los activa en el panel.
export const CATALOGO_INICIAL: { tipo: Tipo; nombre: string; descripcion: string; precio: number; activo: boolean; perfiles: string[]; requiereOrden: boolean; orden: number }[] = [
  { tipo: 'curacion', nombre: 'Curación', descripcion: 'Heridas, úlceras y retiro de puntos', precio: 75000, activo: true, perfiles: ENF, requiereOrden: false, orden: 1 },
  { tipo: 'medicacion', nombre: 'Administración de medicamentos', descripcion: 'Vía oral, IV o por sonda (con orden médica)', precio: 70000, activo: true, perfiles: ENF, requiereOrden: true, orden: 2 },
  { tipo: 'inyeccion', nombre: 'Inyectable', descripcion: 'Intramuscular o subcutánea (con orden médica)', precio: 45000, activo: true, perfiles: ENF, requiereOrden: true, orden: 3 },
  { tipo: 'control', nombre: 'Control de signos vitales', descripcion: 'Tensión, glucometría y saturación', precio: 45000, activo: true, perfiles: ENF, requiereOrden: false, orden: 4 },
  { tipo: 'cuidado_basico', nombre: 'Cuidado básico (6 h)', descripcion: 'Higiene, confort y acompañamiento', precio: 90000, activo: true, perfiles: ENF, requiereOrden: false, orden: 5 },
  { tipo: 'urgencia', nombre: 'Atención prioritaria', descripcion: 'Enfermero(a) profesional, llegada prioritaria', precio: 120000, activo: true, perfiles: ['enfermero_profesional', 'medico'], requiereOrden: false, orden: 6 },
  { tipo: 'consulta_medica', nombre: 'Consulta médica en casa', descripcion: 'Médico(a) general a domicilio', precio: 150000, activo: false, perfiles: ['medico'], requiereOrden: false, orden: 7 },
  { tipo: 'terapia_fisica', nombre: 'Terapia física', descripcion: 'Sesión de fisioterapia en casa', precio: 70000, activo: false, perfiles: ['fisioterapeuta'], requiereOrden: false, orden: 8 },
  { tipo: 'terapia_ocupacional', nombre: 'Terapia ocupacional', descripcion: 'Sesión en casa', precio: 70000, activo: false, perfiles: ['terapeuta_ocupacional'], requiereOrden: false, orden: 9 },
  { tipo: 'terapia_respiratoria', nombre: 'Terapia respiratoria', descripcion: 'Nebulizaciones y fisioterapia respiratoria', precio: 65000, activo: false, perfiles: ['terapeuta_respiratorio', 'fisioterapeuta'], requiereOrden: false, orden: 10 },
  { tipo: 'terapia_conductual', nombre: 'Terapia conductual', descripcion: 'Autismo y neurodivergencia, en casa', precio: 80000, activo: false, perfiles: ['terapeuta_conductual', 'psicologo'], requiereOrden: false, orden: 11 },
  { tipo: 'psicologia', nombre: 'Psicología', descripcion: 'Atención psicológica en casa', precio: 90000, activo: false, perfiles: ['psicologo'], requiereOrden: false, orden: 12 },
]

// Crea los servicios que falten. Una sola vez (catalogo_v5) completa perfiles, orden médica y orden en los que ya existían,
// sin tocar el precio ni si están activos (eso lo decidió la IPS).
export async function asegurarCatalogo() {
  for (const t of CATALOGO_INICIAL) {
    await prisma.tarifa.upsert({ where: { tipo: t.tipo as any }, update: {}, create: { ...t, tipo: t.tipo as any } })
  }
  const hecho = await prisma.ajuste.findUnique({ where: { clave: 'catalogo_v5' } })
  if (hecho) return
  for (const t of CATALOGO_INICIAL) {
    await prisma.tarifa.update({ where: { tipo: t.tipo as any }, data: { perfiles: t.perfiles, requiereOrden: t.requiereOrden, orden: t.orden } })
  }
  // Documentos subidos antes (sin archivo guardado): se piden de nuevo, con el motivo visible para el profesional
  await prisma.documentoProfesional.updateMany({ where: { archivoId: null, estado: { not: 'rechazado' } }, data: { estado: 'rechazado', nota: 'Vuelva a subirlo desde la app (Perfil → Mis documentos)' } })
  await prisma.ajuste.createMany({ data: [{ clave: 'catalogo_v5', valor: new Date().toISOString() }], skipDuplicates: true })
}

// Plazo de transición: los profesionales que ya estaban aprobados antes de exigir perfil y documentos
// pueden seguir tomando turnos durante 30 días mientras la IPS les asigna perfil y aprueba sus documentos.
export const DIAS_TRANSICION = 30
export async function enTransicion(profesional: { createdAt: Date }) {
  const a = await prisma.ajuste.findUnique({ where: { clave: 'catalogo_v5' } })
  if (!a) return false
  const desde = new Date(a.valor).getTime()
  if (!Number.isFinite(desde)) return false
  return profesional.createdAt.getTime() < desde && Date.now() < desde + DIAS_TRANSICION * 24 * 3600 * 1000
}

export function puedeAtender(perfil: string | null | undefined, perfilesDelServicio: string[]) {
  return !perfilesDelServicio.length || perfilesDelServicio.includes(perfilEfectivo(perfil))
}

// ── Documentos que la IPS exige a cada profesional ─────────────────────────────
export const DOCUMENTOS: { tipo: string; nombre: string; vence: boolean; obligatorio: boolean; ayuda: string }[] = [
  { tipo: 'foto', nombre: 'Foto de perfil', vence: false, obligatorio: true, ayuda: 'Foto reciente de su rostro, de frente y con uniforme. El paciente la ve para reconocerle cuando llegue' },
  { tipo: 'cedula', nombre: 'Cédula de ciudadanía', vence: false, obligatorio: true, ayuda: 'Foto de ambos lados' },
  { tipo: 'titulo', nombre: 'Tarjeta profesional o certificado de auxiliar', vence: false, obligatorio: true, ayuda: 'Según su profesión' },
  { tipo: 'rethus', nombre: 'Registro en RETHUS', vence: false, obligatorio: true, ayuda: 'Consulta del Registro Único Nacional del Talento Humano en Salud' },
  { tipo: 'poliza', nombre: 'Póliza de responsabilidad civil', vence: true, obligatorio: true, ayuda: 'Vigente; indique la fecha de vencimiento' },
  { tipo: 'vacunas', nombre: 'Carné de vacunas (hepatitis B y tétanos)', vence: false, obligatorio: true, ayuda: 'Esquema completo' },
  { tipo: 'soporte_vital', nombre: 'Curso de soporte vital básico', vence: true, obligatorio: false, ayuda: 'Opcional; indique cuándo vence' },
]
export const TIPOS_DOC = DOCUMENTOS.map((d) => d.tipo) as [string, ...string[]]

// ¿Tiene el profesional todos sus documentos obligatorios aprobados y vigentes?
export async function documentosAlDia(profesionalId: string) {
  const docs = await prisma.documentoProfesional.findMany({
    where: { profesionalId },
    orderBy: { createdAt: 'desc' },
    select: { tipo: true, estado: true, vence: true },
  })
  const faltan: string[] = [], vencidos: string[] = [], porRevisar: string[] = []
  const ahora = Date.now()
  for (const req of DOCUMENTOS.filter((d) => d.obligatorio)) {
    const deTipo = docs.filter((d) => d.tipo === req.tipo)
    // Basta con uno aprobado y vigente (si renueva antes de tiempo, el anterior sigue valiendo mientras se revisa el nuevo)
    const vigente = deTipo.some((d) => d.estado === 'aprobado' && (!req.vence || (d.vence && d.vence.getTime() >= ahora)))
    if (vigente) continue
    if (deTipo.some((d) => d.estado === 'pendiente')) porRevisar.push(req.nombre)
    else if (deTipo.some((d) => d.estado === 'aprobado')) vencidos.push(req.nombre)
    else faltan.push(req.nombre)
  }
  return { ok: !faltan.length && !vencidos.length && !porRevisar.length, faltan, vencidos, porRevisar }
}

export function textoDocumentos(r: { faltan: string[]; vencidos: string[]; porRevisar: string[] }) {
  const p: string[] = []
  if (r.faltan.length) p.push('Faltan: ' + r.faltan.join(', ') + '.')
  if (r.vencidos.length) p.push('Vencidos: ' + r.vencidos.join(', ') + '.')
  if (r.porRevisar.length) p.push('En revisión de la IPS: ' + r.porRevisar.join(', ') + '.')
  return p.join(' ')
}

// ── Archivos (imágenes JPEG/PNG ya comprimidas en el celular, o PDF) ─────────────
const MIMES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' }
export function leerDataUrl(dataUrl: string, maxBytes: number) {
  const m = /^data:(image\/jpeg|image\/png|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl || '')
  if (!m) throw Object.assign(new Error('El archivo debe ser una foto (JPG o PNG) o un PDF'), { statusCode: 400 })
  const datos = Buffer.from(m[2], 'base64')
  if (datos.length > maxBytes) throw Object.assign(new Error('El archivo es muy grande (máximo ' + Math.round(maxBytes / 1024) + ' KB). Tome la foto de nuevo o reduzca el PDF.'), { statusCode: 400 })
  // Revisa la firma real del archivo (no basta con lo que dice el encabezado)
  const ok = (m[1] === 'image/jpeg' && datos[0] === 0xff && datos[1] === 0xd8)
    || (m[1] === 'image/png' && datos.slice(0, 4).toString('hex') === '89504e47')
    || (m[1] === 'application/pdf' && datos.slice(0, 4).toString() === '%PDF')
  if (!ok) throw Object.assign(new Error('El archivo no es válido'), { statusCode: 400 })
  return { mime: m[1], datos, ext: MIMES[m[1]] }
}

export async function guardarArchivo(tx: any, categoria: 'documento' | 'orden', a: { mime: string; datos: Buffer }, subidoPor: string) {
  return tx.archivo.create({ data: { categoria, mime: a.mime, bytes: a.datos.length, datos: a.datos, subidoPor }, select: { id: true } })
}

// ── Vencimientos de documentos (se revisa como máximo cada 6 horas, cuando alguien usa la app) ──
let ultimaRevisionDocs = 0
// Saca del turno al profesional si ya no tiene sus documentos al día (y no está en el plazo de transición).
// Lo asignado lo puede terminar; solo deja de recibir solicitudes nuevas y se retiran sus ofertas abiertas.
export async function sacarDelTurnoSiFaltanDocs(profesionalId: string) {
  const pr = await prisma.profesional.findUnique({ where: { id: profesionalId }, select: { createdAt: true, disponible: true } })
  if (!pr || !pr.disponible) return
  if ((await documentosAlDia(profesionalId)).ok || (await enTransicion(pr))) return
  await prisma.profesional.update({ where: { id: profesionalId }, data: { disponible: false, disponibleDesde: null } })
  await prisma.oferta.updateMany({ where: { profesionalId, estado: 'activa' }, data: { estado: 'retirada' } })
  const { marcarCambio } = await import('../utils/cambios')
  marcarCambio()
}

// Libera espacio de la base: fotos de órdenes de servicios cancelados (más de 1 día) y archivos de
// documentos rechazados hace más de 30 días. Las órdenes de servicios atendidos se conservan (historia clínica).
async function limpiarArchivos() {
  const hace1 = new Date(Date.now() - 24 * 3600 * 1000), hace30 = new Date(Date.now() - 30 * 24 * 3600 * 1000)
  const cancelados = await prisma.servicio.findMany({ where: { estado: 'cancelado', ordenArchivoId: { not: null }, updatedAt: { lt: hace1 } }, select: { id: true, ordenArchivoId: true }, take: 200 })
  for (const c of cancelados) {
    await prisma.servicio.update({ where: { id: c.id }, data: { ordenArchivoId: null } })
    await prisma.archivo.delete({ where: { id: c.ordenArchivoId! } }).catch(() => {})
  }
  const rechazados = await prisma.documentoProfesional.findMany({ where: { estado: 'rechazado', archivoId: { not: null }, revisadoEn: { lt: hace30 } }, select: { id: true, archivoId: true }, take: 200 })
  for (const d of rechazados) {
    await prisma.documentoProfesional.update({ where: { id: d.id }, data: { archivoId: null } })
    await prisma.archivo.delete({ where: { id: d.archivoId! } }).catch(() => {})
  }
}

export async function revisarVencimientos() {
  if (Date.now() - ultimaRevisionDocs < 6 * 3600 * 1000) return
  ultimaRevisionDocs = Date.now()
  await limpiarArchivos().catch(() => {})
  const conVence = DOCUMENTOS.filter((d) => d.vence).map((d) => d.tipo)
  const obligatorios = DOCUMENTOS.filter((d) => d.vence && d.obligatorio).map((d) => d.tipo)
  const ahora = new Date()
  // 1) Póliza u otro obligatorio vencido: sale del turno (y no podrá iniciar otro hasta subir el vigente)
  const vencidos = await prisma.documentoProfesional.findMany({
    where: { tipo: { in: obligatorios }, estado: 'aprobado', vence: { lt: ahora }, profesional: { disponible: true } },
    select: { profesionalId: true },
  })
  if (vencidos.length) {
    // Solo si no tiene uno más nuevo vigente del mismo tipo
    for (const v of vencidos) await sacarDelTurnoSiFaltanDocs(v.profesionalId)
  }
  // 2) Aviso 15 días antes (y de nuevo cada 7 días hasta que lo renueve)
  const pronto = await prisma.documentoProfesional.findMany({
    where: {
      tipo: { in: conVence }, estado: 'aprobado', vence: { gt: ahora, lt: new Date(ahora.getTime() + 15 * 24 * 3600 * 1000) },
      OR: [{ avisadoEn: null }, { avisadoEn: { lt: new Date(ahora.getTime() - 7 * 24 * 3600 * 1000) } }],
    },
    select: { id: true, tipo: true, vence: true, profesionalId: true, profesional: { select: { usuarioId: true, usuario: { select: { email: true, nombreCompleto: true } } } } },
    take: 100,
  })
  if (!pronto.length) return
  const { notificarUsuario } = await import('../routes/push')
  const { enviarCorreo } = await import('../utils/correo')
  for (const d of pronto) {
    // ¿Ya subió uno más nuevo de ese tipo? Entonces no se avisa
    const nuevo = await prisma.documentoProfesional.count({ where: { profesionalId: d.profesionalId, tipo: d.tipo, vence: { gt: d.vence! } } })
    await prisma.documentoProfesional.update({ where: { id: d.id }, data: { avisadoEn: ahora } })
    if (nuevo) continue
    const def = DOCUMENTOS.find((x) => x.tipo === d.tipo)
    const fecha = d.vence!.toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Bogota' })
    const texto = (def?.nombre || d.tipo) + ' vence el ' + fecha + '. Suba el documento renovado en Perfil → Mis documentos para no quedar fuera de turno.'
    notificarUsuario(d.profesional.usuarioId, { titulo: 'Documento por vencer', cuerpo: texto }).catch(() => {})
    const nombre = (d.profesional.usuario.nombreCompleto || '').split(' ')[0].replace(/[<>&"']/g, '')
    enviarCorreo(d.profesional.usuario.email, 'Documento por vencer · Salud en Casa', `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1C2B39">
        <div style="background:#0B4F8A;color:#fff;padding:14px 18px;border-bottom:4px solid #14A38B;font-size:20px;font-weight:bold">Salud en Casa</div>
        <div style="padding:18px"><p>Hola, ${nombre}.</p><p>${texto.replace(/[<>&"']/g, '')}</p></div>
        <p style="font-size:11px;color:#8A979D;text-align:center;border-top:1px solid #DCE5EE;padding-top:10px">Tecnología SkyNet Genesis · contacto@skynetgenesis.com · WhatsApp 304 437 5758</p>
      </div>`).catch(() => {})
  }
}
