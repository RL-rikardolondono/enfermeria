import crypto from 'crypto'
import { prisma } from '../utils/prisma'

// ── Factura electrónica de salud con RIPS (paquete 7) ─────────────────────────────
// Salud en Casa NO factura por su cuenta: le pide a Factura-IA (servicio central de SkyNet Genesis) que emita la factura
// de cada servicio pagado, con la llave de conexión de la IPS. Si Factura-IA no está conectado, la DIAN aún no habilitó a la
// IPS o falta un dato del paciente, la factura queda EN COLA con el motivo visible en el panel y se reintenta sola.
// Norma: Res. 948 de 2026 de MinSalud (FEV salud + RIPS en JSON). Paciente particular: cobertura 15, pago por evento,
// sin copago (SS-SinAporte), atención extramural domiciliaria. Los códigos CUPS/REPS/finalidad los fija la IPS en el panel.

export const FIA_URL = (process.env.FACTURA_IA_URL || 'https://factura-ia.skynetgenesis.com').replace(/\/+$/, '')
const CLAVE_LLAVE = 'fia_llave' // llave de conexión de la IPS, cifrada
const CLAVE_PAUSA = 'fia_pausa' // '1' = la IPS pausó la emisión automática

// ── Cifrado de la llave (AES-256-GCM con una clave derivada del secreto del servidor) ──
function claveCifrado() {
  const base = process.env.CLAVE_CIFRADO || process.env.JWT_SECRET || ''
  if (!base) throw new Error('Falta JWT_SECRET para cifrar la llave de Factura-IA')
  return crypto.createHash('sha256').update('saludencasa-fia:' + base).digest()
}
export function cifrar(texto: string) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', claveCifrado(), iv)
  const datos = Buffer.concat([c.update(texto, 'utf8'), c.final()])
  return [iv, c.getAuthTag(), datos].map((b) => b.toString('base64')).join('.')
}
export function descifrar(guardado: string) {
  try {
    const [iv, tag, datos] = guardado.split('.').map((x) => Buffer.from(x, 'base64'))
    const d = crypto.createDecipheriv('aes-256-gcm', claveCifrado(), iv)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(datos), d.final()]).toString('utf8')
  } catch { return null }
}

export async function leerLlave() {
  const a = await prisma.ajuste.findUnique({ where: { clave: CLAVE_LLAVE } })
  return a ? descifrar(a.valor) : null
}
export async function guardarLlave(llave: string | null) {
  if (!llave) { await prisma.ajuste.deleteMany({ where: { clave: CLAVE_LLAVE } }); return }
  const valor = cifrar(llave)
  await prisma.ajuste.upsert({ where: { clave: CLAVE_LLAVE }, update: { valor }, create: { clave: CLAVE_LLAVE, valor } })
}
export async function enPausa() {
  return (await prisma.ajuste.findUnique({ where: { clave: CLAVE_PAUSA } }))?.valor === '1'
}
export async function pausar(si: boolean) {
  await prisma.ajuste.upsert({ where: { clave: CLAVE_PAUSA }, update: { valor: si ? '1' : '0' }, create: { clave: CLAVE_PAUSA, valor: si ? '1' : '0' } })
}

// ── Llamadas a Factura-IA (servidor a servidor; la llave nunca va al navegador) ──
export async function llamarFIA(metodo: string, ruta: string, cuerpo?: unknown, llave?: string | null, crudo = false): Promise<any> {
  const token = llave === undefined ? await leerLlave() : llave
  if (!token) return { status: 409, ok: false, conectar: true, error: 'Factura-IA no está conectado' }
  const r = await fetch(FIA_URL + ruta, {
    method: metodo,
    signal: AbortSignal.timeout(90000),
    headers: { 'content-type': 'application/json', 'user-agent': 'SkyNetGenesis-saludencasa/1.0', authorization: 'Bearer ' + token },
    body: cuerpo && metodo !== 'GET' ? JSON.stringify(cuerpo) : undefined,
  })
  if (crudo) return r
  const j: any = await r.json().catch(() => ({ ok: false, error: "Respuesta no válida de Factura-IA" }))
  return { status: r.status, ...j }
}

// ── Valores por defecto de los RIPS por servicio (la IPS los revisa y corrige en el panel) ──
// CUPS 8901xx: atención (visita) domiciliaria; REPS: 312 enfermería, 328 medicina general, 344 psicología,
// 739 fisioterapia, 742 terapia ocupacional, 743 terapia respiratoria. Finalidad 16 tratamiento, 15 diagnóstico,
// 17 rehabilitación; causa 38 enfermedad general. POR CONFIRMAR con el auditor de la IPS en la primera factura real.
export const RIPS_DEFECTO: Record<string, { cups: string; codServicioReps: number; finalidad: string; causaAtencion: string; cie10: string }> = {
  curacion: { cups: '890105', codServicioReps: 312, finalidad: '16', causaAtencion: '38', cie10: 'Z480' },
  medicacion: { cups: '890105', codServicioReps: 312, finalidad: '16', causaAtencion: '38', cie10: 'Z519' },
  inyeccion: { cups: '890105', codServicioReps: 312, finalidad: '16', causaAtencion: '38', cie10: 'Z519' },
  control: { cups: '890105', codServicioReps: 312, finalidad: '15', causaAtencion: '38', cie10: 'Z018' },
  cuidado_basico: { cups: '890105', codServicioReps: 312, finalidad: '16', causaAtencion: '38', cie10: 'Z741' },
  urgencia: { cups: '890105', codServicioReps: 312, finalidad: '16', causaAtencion: '38', cie10: 'R688' },
  consulta_medica: { cups: '890101', codServicioReps: 328, finalidad: '15', causaAtencion: '38', cie10: 'Z000' },
  terapia_fisica: { cups: '890110', codServicioReps: 739, finalidad: '17', causaAtencion: '38', cie10: 'Z509' },
  terapia_ocupacional: { cups: '890111', codServicioReps: 742, finalidad: '17', causaAtencion: '38', cie10: 'Z509' },
  terapia_respiratoria: { cups: '890113', codServicioReps: 743, finalidad: '16', causaAtencion: '38', cie10: 'Z509' },
  terapia_conductual: { cups: '890108', codServicioReps: 344, finalidad: '17', causaAtencion: '38', cie10: 'F849' },
  psicologia: { cups: '890108', codServicioReps: 344, finalidad: '16', causaAtencion: '38', cie10: 'Z719' },
}
// Una sola vez: completa los códigos que falten en el catálogo, sin pisar lo que ya puso la IPS
export async function asegurarRipsCatalogo() {
  const hecho = await prisma.ajuste.findUnique({ where: { clave: 'rips_v1' } })
  if (hecho) return
  for (const [tipo, d] of Object.entries(RIPS_DEFECTO)) {
    const t = await prisma.tarifa.findUnique({ where: { tipo: tipo as any } })
    if (!t) continue
    await prisma.tarifa.update({ where: { tipo: tipo as any }, data: {
      cups: t.cups || d.cups, codServicioReps: t.codServicioReps || d.codServicioReps, finalidad: t.finalidad || d.finalidad,
      causaAtencion: t.causaAtencion || d.causaAtencion, cie10: t.cie10 || d.cie10,
    } })
  }
  await prisma.ajuste.createMany({ data: [{ clave: 'rips_v1', valor: new Date().toISOString() }], skipDuplicates: true })
}

// Tipos de documento: los del paciente (RIPS) y su código ante la DIAN (adquirente de la factura)
export const TIPOS_DOC_PACIENTE = ['CC', 'TI', 'RC', 'CE', 'PA', 'PT', 'PE', 'CN', 'MS', 'AS'] as const
const DOC_DIAN: Record<string, string> = { RC: '11', TI: '12', CC: '13', CE: '22', PA: '41', PE: '47', PT: '48', CN: '11', MS: '13', AS: '13' }
// Municipios más comunes por nombre (si el paciente no tiene código DANE se toma de la ciudad; Santa Marta por defecto)
const DANE: Record<string, string> = { 'santa marta': '47001', 'cienaga': '47189', 'ciénaga': '47189', 'barranquilla': '08001', 'cartagena': '13001', 'bogota': '11001', 'bogotá': '11001', 'medellin': '05001', 'medellín': '05001', 'valledupar': '20001', 'riohacha': '44001', 'fundacion': '47288', 'fundación': '47288', 'zona bananera': '47980', 'aracataca': '47053' }
export const daneDe = (ciudad?: string | null) => DANE[String(ciudad || 'santa marta').trim().toLowerCase()] || null

const fechaCol = (d: Date) => new Date(d.getTime() - 5 * 3600 * 1000) // hora de Colombia
const diaCol = (d: Date) => fechaCol(d).toISOString().slice(0, 10)
const fechaHoraCol = (d: Date) => fechaCol(d).toISOString().slice(0, 16).replace('T', ' ')
const limpio = (v: unknown, n = 200) => String(v ?? '').replace(/[<>]/g, '').trim().slice(0, n)

// Arma la factura de un servicio. Devuelve { cuerpo } listo para Factura-IA o { faltan: [...] } con lo que falta
export async function armarFactura(servicioId: string): Promise<{ cuerpo?: any; faltan?: string[] }> {
  const s = await prisma.servicio.findUnique({
    where: { id: servicioId },
    include: {
      pago: true,
      paciente: { include: { usuario: { select: { email: true, telefono: true, nombreCompleto: true } } } },
      profesional: { select: { documentoTipo: true, documentoNumero: true, usuario: { select: { nombreCompleto: true } } } },
      evoluciones: { orderBy: { createdAt: 'desc' }, select: { cie10: true } },
    },
  })
  if (!s) return { faltan: ['el servicio no existe'] }
  const faltan: string[] = []
  const t = await prisma.tarifa.findUnique({ where: { tipo: s.tipo } })
  const p = s.paciente
  const total = Math.round(Number(s.pago?.monto ?? s.monto ?? 0))
  if (!p) faltan.push('el paciente del servicio')
  if (!(total > 0)) faltan.push('el valor pagado')
  const tipoDoc = String(p?.documentoTipo || '').toUpperCase()
  const numDoc = String(p?.documentoNumero || '').replace(/[^0-9A-Za-z]/g, '')
  if (!(TIPOS_DOC_PACIENTE as readonly string[]).includes(tipoDoc)) faltan.push('tipo de documento del paciente')
  if (!/^[0-9A-Za-z]{4,20}$/.test(numDoc)) faltan.push('número de documento del paciente')
  if (!p?.fechaNacimiento) faltan.push('fecha de nacimiento del paciente')
  if (!['H', 'M', 'I'].includes(String(p?.sexo || ''))) faltan.push('sexo del paciente')
  const municipio = p?.municipioDane || daneDe(p?.ciudad)
  if (!municipio || !/^\d{5}$/.test(municipio)) faltan.push('municipio de residencia del paciente (código DANE)')
  const docProf = String(s.profesional?.documentoNumero || '').replace(/[^0-9A-Za-z]/g, '')
  if (!/^[0-9A-Za-z]{4,20}$/.test(docProf)) faltan.push('cédula del profesional que atendió')
  if (!t?.cups || !/^[0-9A-Z]{6}$/.test(t.cups)) faltan.push('código CUPS del servicio (panel → Servicios y tarifas)')
  if (!t?.codServicioReps) faltan.push('código REPS del servicio (panel → Servicios y tarifas)')
  const cie10 = (s.evoluciones.find((e) => e.cie10)?.cie10 || t?.cie10 || '').toUpperCase()
  if (!/^[A-Z][0-9]{2}[0-9A-Z]$/.test(cie10)) faltan.push('diagnóstico CIE-10')
  if (!s.fechaInicio && !s.fechaFin) faltan.push('la fecha de la atención')
  // Factura a nombre del titular de la cuenta (quien paga) cuando el servicio fue para un familiar; los RIPS siguen con el paciente
  let comprador: { tipoDoc: string; num: string; nombre: string } | null = null
  if ((s as any).facturarA === 'titular' && p && !p.esTitular) {
    const tit = await prisma.paciente.findFirst({ where: { usuarioId: p.usuarioId, esTitular: true } })
    const tDoc = String(tit?.documentoTipo || '').toUpperCase(), tNum = String(tit?.documentoNumero || '').replace(/[^0-9A-Za-z]/g, '')
    if (!tit || !(TIPOS_DOC_PACIENTE as readonly string[]).includes(tDoc) || !/^[0-9A-Za-z]{4,20}$/.test(tNum)) faltan.push('documento del titular de la cuenta (la factura sale a su nombre)')
    else comprador = { tipoDoc: tDoc, num: tNum, nombre: limpio(tit.nombreCompleto || p.usuario.nombreCompleto, 200) }
  }
  if (faltan.length) return { faltan }

  const atencion = s.fechaInicio || s.fechaFin || s.createdAt
  const dia = diaCol(s.fechaFin || atencion)
  const nombre = limpio(p!.nombreCompleto || p!.usuario.nombreCompleto, 200)
  const cuerpo = {
    refApp: 'sec-' + s.id, // evita facturas repetidas si se reintenta
    cliente: {
      tipoDoc: DOC_DIAN[comprador ? comprador.tipoDoc : tipoDoc] || '13', num: comprador ? comprador.num : numDoc, nombre: comprador ? comprador.nombre : nombre,
      email: p!.usuario.email, telefono: p!.usuario.telefono || undefined,
      direccion: limpio(s.direccion || p!.direccionBase || '', 200) || undefined, municipio,
    },
    lineas: [{ descripcion: limpio((t!.nombre || 'Atención domiciliaria') + ' · Salud en Casa (atención en casa)', 300), cantidad: 1, precio: total, impuesto: 'EXCLUIDO', tarifa: 0, codigo: t!.cups }],
    medioPago: '48', // tarjeta / pago electrónico (Bold)
    notas: 'Servicio de salud a domicilio pagado en línea con Bold. Ref. ' + (s.pago?.referenciaExterna || s.id.slice(0, 8)),
    salud: { tipoOperacion: 'SS-SinAporte', modalidadPago: '04', cobertura: '15', periodo: { inicio: dia, fin: dia }, pagos: [] },
    rips: {
      usuarios: [{
        tipoDocumentoIdentificacion: tipoDoc, numDocumentoIdentificacion: numDoc, tipoUsuario: '12',
        fechaNacimiento: p!.fechaNacimiento!.toISOString().slice(0, 10), codSexo: p!.sexo,
        codPaisResidencia: '170', codMunicipioResidencia: municipio, codZonaTerritorialResidencia: p!.zonaResidencia === '01' ? '01' : '02',
        incapacidad: 'NO', codPaisOrigen: '170',
        servicios: {
          consultas: [{
            fechaInicioAtencion: fechaHoraCol(atencion), numAutorizacion: null, codConsulta: t!.cups,
            modalidadGrupoServicioTecSal: '03', grupoServicios: '01', codServicio: t!.codServicioReps,
            finalidadTecnologiaSalud: t!.finalidad || '16', causaMotivoAtencion: t!.causaAtencion || '38',
            codDiagnosticoPrincipal: cie10, tipoDiagnosticoPrincipal: '01',
            tipoDocumentoIdentificacion: s.profesional!.documentoTipo || 'CC', numDocumentoIdentificacion: docProf,
            vrServicio: total, conceptoRecaudo: '05', valorPagoModerador: 0,
          }],
        },
      }],
    },
  }
  return { cuerpo }
}

// Pone en cola la factura de un servicio pagado y completado (una sola por servicio)
export async function encolarFactura(servicioId: string) {
  const s = await prisma.servicio.findUnique({ where: { id: servicioId }, select: { estado: true, pago: { select: { estado: true, monto: true } } } })
  if (!s || s.estado !== 'completado' || s.pago?.estado !== 'aprobado') return null
  const f = await prisma.factura.upsert({
    where: { servicioId },
    update: {},
    create: { servicioId, total: Math.round(Number(s.pago.monto)), estado: 'pendiente', proximoIntento: new Date() },
  })
  emitirFactura(f.id).catch(() => {}) // intenta de una vez; si no se puede queda en cola
  return f
}

const ESPERAS_MIN = [5, 15, 30, 60, 120, 240, 480, 720, 1440] // reintentos cada vez más espaciados (máximo 1 día)
const enCurso = new Set<string>()

// Intenta emitir una factura en cola. Nunca lanza error: deja el motivo guardado.
export async function emitirFactura(facturaId: string, manual = false) {
  if (enCurso.has(facturaId)) return { ok: false, error: 'Ya se está emitiendo' }
  enCurso.add(facturaId)
  try {
    const f = await prisma.factura.findUnique({ where: { id: facturaId } })
    if (!f || ['emitida', 'anulada'].includes(f.estado)) return { ok: !!f, factura: f }
    const reprogramar = async (estado: string, motivo: string, esperar = true) => {
      const espera = ESPERAS_MIN[Math.min(f.intentos, ESPERAS_MIN.length - 1)]
      return prisma.factura.update({ where: { id: f.id }, data: { estado, motivo: motivo.slice(0, 1000), intentos: { increment: 1 },
        proximoIntento: new Date(Date.now() + (esperar ? espera : 24 * 60) * 60 * 1000) } })
    }
    if (!manual && await enPausa()) return { ok: false, error: 'Emisión automática en pausa' }
    const { cuerpo, faltan } = await armarFactura(f.servicioId)
    if (!cuerpo) {
      const factura = await reprogramar('faltan_datos', 'Faltan datos: ' + (faltan || []).join(', '), false)
      return { ok: false, factura, faltan }
    }
    const llave = await leerLlave()
    if (!llave) { const factura = await reprogramar('pendiente', 'Factura-IA aún no está conectado (panel → Facturación → pegar la llave de conexión de la IPS).', false); return { ok: false, factura } }
    let r: any
    try { r = await llamarFIA('POST', '/api/documentos', cuerpo, llave) }
    catch { const factura = await reprogramar('pendiente', 'Factura-IA no respondió; se reintenta sola.'); return { ok: false, factura } }
    const d = r.documento
    if (r.ok && d && ['Aceptada', 'Pendiente', 'Enviada'].includes(d.estado)) {
      const aceptada = d.estado === 'Aceptada'
      const factura = await prisma.factura.update({ where: { id: f.id }, data: {
        estado: aceptada ? 'emitida' : 'pendiente', docId: String(d.id || ''), numero: d.numero ? String(d.numero) : null, cufe: d.cufe || null,
        cuv: d.muv?.cuv || null, motivo: aceptada ? null : 'La DIAN aún no confirma la factura ' + (d.numero || '') + '; se revisa sola.',
        emitidaEn: aceptada ? new Date() : null, intentos: { increment: 1 }, proximoIntento: new Date(Date.now() + 15 * 60 * 1000),
      } })
      return { ok: aceptada, factura }
    }
    if (r.status === 422 || d?.estado === 'Rechazada') {
      const factura = await prisma.factura.update({ where: { id: f.id }, data: { estado: 'rechazada', docId: d?.id ? String(d.id) : f.docId,
        motivo: String(r.error || 'La DIAN rechazó la factura').slice(0, 1000), intentos: { increment: 1 }, proximoIntento: new Date(Date.now() + 365 * 24 * 3600 * 1000) } })
      return { ok: false, factura }
    }
    let motivo = String(r.error || 'Factura-IA no pudo emitir la factura')
    if (r.status === 401 || r.reconectar) motivo = 'La llave de Factura-IA ya no es válida: genere una nueva en Factura-IA y péguela en el panel.'
    else if (r.sinCupo || r.status === 402) motivo = 'Factura-IA: ' + motivo + ' (compre un paquete de facturas en Factura-IA).'
    else if (r.status === 409) motivo = 'Factura-IA: ' + motivo + ' (la IPS debe terminar la habilitación DIAN o la configuración de salud en Factura-IA).'
    else if (r.status === 400) motivo = 'Factura-IA rechazó los datos: ' + motivo
    const factura = await reprogramar(r.status === 400 ? 'faltan_datos' : 'pendiente', motivo, ![400, 401].includes(r.status))
    return { ok: false, factura }
  } finally { enCurso.delete(facturaId) }
}

// Revisa una factura que quedó "Pendiente" en la DIAN
async function refrescar(f: { id: string; docId: string | null }) {
  if (!f.docId) return
  const r = await llamarFIA('GET', '/api/documentos/' + encodeURIComponent(f.docId)).catch(() => null)
  const d = r?.documento
  if (!d) return
  if (d.estado === 'Aceptada') await prisma.factura.update({ where: { id: f.id }, data: { estado: 'emitida', numero: d.numero ? String(d.numero) : undefined, cufe: d.cufe || undefined, cuv: d.muv?.cuv || undefined, motivo: null, emitidaEn: new Date() } })
  else if (d.estado === 'Rechazada') await prisma.factura.update({ where: { id: f.id }, data: { estado: 'rechazada', motivo: 'La DIAN rechazó la factura ' + (d.numero || '') + ': ' + (d.errores || []).map((x: any) => x.explicacion || x.texto).join(' · ').slice(0, 800) } })
  else await prisma.factura.update({ where: { id: f.id }, data: { intentos: { increment: 1 }, proximoIntento: new Date(Date.now() + 30 * 60 * 1000) } })
}

// Anula una factura emitida con una nota crédito total (por ejemplo, si se devolvió el dinero al paciente)
export async function anularFactura(facturaId: string, motivo: string) {
  const f = await prisma.factura.findUnique({ where: { id: facturaId } })
  if (!f) return { status: 404, error: 'Factura no encontrada' }
  if (f.estado !== 'emitida' || !f.docId) {
    if (['pendiente', 'faltan_datos', 'rechazada'].includes(f.estado) && !f.numero) { // aún no existe ante la DIAN: solo se saca de la cola
      await prisma.factura.update({ where: { id: f.id }, data: { estado: 'anulada', motivo: 'Retirada de la cola: ' + motivo.slice(0, 900) } })
      return { ok: true, sinNota: true }
    }
    return { status: 409, error: 'Solo se anula una factura ya aceptada por la DIAN.' }
  }
  const r = await llamarFIA('POST', '/api/documentos/' + encodeURIComponent(f.docId) + '/nota-credito', { motivo: motivo.slice(0, 300), refApp: 'nc-' + f.servicioId })
  if (!r.ok || !r.documento) return { status: r.status === 401 ? 409 : (r.status || 502), error: r.error || 'Factura-IA no pudo hacer la nota crédito' }
  await prisma.factura.update({ where: { id: f.id }, data: { estado: 'anulada', notaCreditoId: String(r.documento.id || ''), notaCreditoNumero: r.documento.numero ? String(r.documento.numero) : null, motivo: 'Anulada con nota crédito: ' + motivo.slice(0, 900) } })
  return { ok: true, nota: r.documento.numero }
}

// Cola: cada 10 minutos emite lo pendiente y revisa lo que la DIAN no ha confirmado
let corriendo = false
export async function procesarCola() {
  if (corriendo) return
  corriendo = true
  try {
    if (await enPausa()) return
    const lista = await prisma.factura.findMany({
      where: { estado: { in: ['pendiente', 'faltan_datos'] }, proximoIntento: { lte: new Date() }, intentos: { lt: 40 } },
      orderBy: { proximoIntento: 'asc' }, take: 20, select: { id: true, docId: true, numero: true },
    })
    for (const f of lista) {
      if (f.docId) await refrescar(f).catch(() => {})
      else await emitirFactura(f.id)
    }
  } catch { /* se reintenta en la próxima vuelta */ }
  finally { corriendo = false }
}
export function iniciarColaFacturas() {
  setTimeout(() => procesarCola(), 60 * 1000)
  setInterval(() => procesarCola(), 10 * 60 * 1000).unref?.()
}
