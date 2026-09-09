# Infocivil Ebook

Consulta pública de expedientes del fuero Civil (PJN) — búsqueda por
jurisdicción/número/año (sin login, igual que la Consulta Pública del SCW),
descarga en ZIP o PDF unificado, y lector tipo libro con animación de pasar
hoja, banderitas y anotaciones.

Proyecto hermano de [`pjn-descargador`](https://gitdc.pjn.gov.ar/Civil/pjn-descargador)
(la extensión de Chrome) — reusa su módulo `unificador.js` casi sin cambios,
y el mismo criterio de scraping probado ahí, pero corriendo del lado del
servidor con Playwright en vez de dentro del navegador de cada usuario.

## Por qué existe un servicio separado

La extensión depende de que la persona ya esté logueada en el SCW en su
propio navegador. Este servicio, en cambio, resuelve todo del lado del
servidor usando la Consulta Pública (que no requiere login para el fuero
Civil) — así se puede ofrecer como un sitio al que cualquiera entra con solo
el número de expediente, sin instalar nada.

## Diferencia clave de arquitectura con la extensión

Como acá **nosotros controlamos toda la navegación** con Playwright, siempre
visitamos `actuacionesHistoricas.seam` como parte del mismo scraping — no
hace falta que nadie la visite a mano primero (que sí era necesario en la
extensión). El aviso de "históricas faltantes" que tiene la extensión no
aplica acá.

## Sin estado

Cada request abre su propia sesión de Playwright, aislada, y no se guarda
nada del lado del servidor — ni el HTML scrapeado, ni los PDFs armados. "Mis
Expedientes" vive enteramente en el navegador de la persona (localStorage),
no en el servidor.

## Estructura

| Archivo | Rol |
|---|---|
| `src/server.js` | Servidor Express, rutas de la API |
| `src/scw/browser.js` | Sesión de Playwright + límite de concurrencia contra el SCW |
| `src/scw/jurisdicciones.js` | Códigos reales del `<select>` de jurisdicción (extraídos del HTML de `home.seam`) |
| `src/scw/buscarExpediente.js` | Completa el formulario de Consulta Pública y devuelve el `cid` |
| `src/scw/scrapeActuaciones.js` | Recorre actuaciones actuales e históricas (puerto de la lógica ya probada en la extensión) |
| `src/scw/descargarActuaciones.js` | Baja cada PDF con validación `%PDF-` y reintento |
| `src/lib/unificador.js` | Arma el PDF unificado — modo `completo` (portada+índice+links) o `simple` (solo concatena) |
| `src/lib/zip.js` | Armador de ZIP sin dependencias (puerto del que ya usa la extensión) |

## Endpoints

- `GET /api/jurisdicciones` — lista para poblar el `<select>` del front.
- `POST /api/buscar` — `{ jurisdiccion, numero, anio }` → `{ cid }`.
- `GET /api/expediente/:cid/actuaciones` — lista de actuaciones + carátula.
- `GET /api/expediente/:cid/descargar/:formato` — `formato` = `zip` | `unificado` | `unificado-indice`.

## Estado del proyecto — qué falta

- **Sin probar contra el SCW real todavía.** Los selectores de
  `buscarExpediente.js` están confirmados contra el HTML real de
  `home.seam`, pero qué pasa después de apretar "Consultar" (¿navega directo
  si hay un único resultado, o siempre hay una página intermedia?) sigue sin
  confirmarse — hay que probarlo en `10.5.1.224`.
- Falta el front (landing, menú, lector) — hoy solo existe la API. El diseño
  ya está acordado (ver conversación): header azul institucional, menú de 4
  acciones + "Mis Expedientes", lector con spread de dos páginas responsive,
  animación de pasar hoja, índice lateral, banderitas que sobresalen del
  borde con nota + tag.
- Falta manejar el caso de resultados múltiples en la búsqueda (si puede
  pasar que número/año/jurisdicción no identifiquen un único expediente).
- Falta detectar el mensaje real de "expediente no encontrado" del SCW (hoy
  se infiere por ausencia de resultados, no por el texto exacto).
