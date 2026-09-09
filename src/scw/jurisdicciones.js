// jurisdicciones.js — mapeo entre el código interno que usa el <select> del
// SCW (formPublica:camaraNumAni, atributo value) y la sigla/nombre visibles.
//
// Extraído del HTML real de https://scw.pjn.gov.ar/scw/home.seam (no
// inventado ni completado a mano) — si el SCW agrega o reordena
// jurisdicciones esto puede quedar desactualizado; conviene revalidarlo
// contra el HTML real de tanto en tanto.

export const JURISDICCIONES = [
  { value: '0', sigla: 'CSJ', nombre: 'Corte Suprema de Justicia de la Nación' },
  { value: '1', sigla: 'CIV', nombre: 'Cámara Nacional de Apelaciones en lo Civil' },
  { value: '2', sigla: 'CAF', nombre: 'Cámara Nacional de Apelaciones en lo Contencioso Administrativo Federal' },
  { value: '3', sigla: 'CCF', nombre: 'Cámara Nacional de Apelaciones en lo Civil y Comercial Federal' },
  { value: '4', sigla: 'CNE', nombre: 'Cámara Nacional Electoral' },
  { value: '5', sigla: 'CSS', nombre: 'Cámara Federal de la Seguridad Social' },
  { value: '6', sigla: 'CPE', nombre: 'Cámara Nacional de Apelaciones en lo Penal Económico' },
  { value: '7', sigla: 'CNT', nombre: 'Cámara Nacional de Apelaciones del Trabajo' },
  { value: '8', sigla: 'CFP', nombre: 'Cámara Criminal y Correccional Federal' },
  { value: '9', sigla: 'CCC', nombre: 'Cámara Nacional de Apelaciones en lo Criminal y Correccional' },
  { value: '10', sigla: 'COM', nombre: 'Cámara Nacional de Apelaciones en lo Comercial' },
  { value: '11', sigla: 'CPF', nombre: 'Cámara Federal de Casación Penal' },
  { value: '12', sigla: 'CPN', nombre: 'Cámara Nacional de Casación Penal' },
  { value: '13', sigla: 'FBB', nombre: 'Justicia Federal de Bahía Blanca' },
  { value: '14', sigla: 'FCR', nombre: 'Justicia Federal de Comodoro Rivadavia' },
  { value: '15', sigla: 'FCB', nombre: 'Justicia Federal de Córdoba' },
  { value: '16', sigla: 'FCT', nombre: 'Justicia Federal de Corrientes' },
  { value: '17', sigla: 'FGR', nombre: 'Justicia Federal de General Roca' },
  { value: '18', sigla: 'FLP', nombre: 'Justicia Federal de La Plata' },
  { value: '19', sigla: 'FMP', nombre: 'Justicia Federal de Mar del Plata' },
  { value: '20', sigla: 'FMZ', nombre: 'Justicia Federal de Mendoza' },
  { value: '21', sigla: 'FPO', nombre: 'Justicia Federal de Posadas' },
  { value: '22', sigla: 'FPA', nombre: 'Justicia Federal de Paraná' },
  { value: '23', sigla: 'FRE', nombre: 'Justicia Federal de Resistencia' },
  { value: '24', sigla: 'FSA', nombre: 'Justicia Federal de Salta' },
  { value: '25', sigla: 'FRO', nombre: 'Justicia Federal de Rosario' },
  { value: '26', sigla: 'FSM', nombre: 'Justicia Federal de San Martín' },
  { value: '27', sigla: 'FTU', nombre: 'Justicia Federal de Tucumán' },
];

export function valorPorSigla(sigla) {
  const j = JURISDICCIONES.find((j) => j.sigla === sigla);
  return j ? j.value : null;
}
