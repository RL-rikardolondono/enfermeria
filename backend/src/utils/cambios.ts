// Contador de cambios en memoria. Las apps lo consultan cada pocos segundos (sin tocar la base de datos)
// y solo vuelven a pedir las listas cuando algo cambió. Así Neon puede "dormir" y no se gastan
// sus horas gratuitas de cómputo aunque haya pantallas abiertas todo el día.
// Al reiniciar el servidor arranca con la hora actual, de modo que las apps notan el cambio y recargan.
let version = Date.now()

export function marcarCambio(): void {
  version += 1
}

export function versionActual(): number {
  return version
}
