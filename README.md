# pickagent scan

CLI local. Lee el uso de tus agentes, construye un perfil `pickagent.profile/v1` y abre el veredicto en el navegador. El perfil viaja en el fragmento `#p=` de la URL. No se sube.

Página del escáner: https://pickagent.dev/es/escaner

## Instalar y usar

Hace falta Node 20 o superior. Windows: sin probar.

En una máquina que no tiene el repositorio:

```bash
npx pickagent scan
npx pickagent scan --period 2026-10 --plan claude-pro
npx pickagent scan --help
```

`npx` descarga el paquete y lo ejecuta ahí. No se instala en un proyecto.

## Opciones

```text
--period YYYY-MM     Mes natural. Por defecto, el mes local en curso.
--days N             Últimos N días, incluido hoy (1–366).
--plan SLUG          Plan que pagas hoy. Se puede repetir. Ej. claude-pro.
--base-url URL       Origen del veredicto. Por defecto https://pickagent.dev.
--json               Escribe solo el perfil JSON en stdout.
--yes                Abre el navegador sin preguntar.
--no-open            No abre el navegador.
--codex              Experimental: lee rollouts de Codex en vez de Claude.
--help               Esta ayuda.
```

`--codex` no se mezcla con Claude: un perfil tiene una sola fuente.

Desarrollo, dentro del repositorio:

```bash
npm run scan:build
node packages/scanner/dist/cli.js scan --period 2026-10 --plan claude-pro
```

Sin empaquetar: `npm run scan:dev -- scan --help`.

## Qué lee

Claude Code, por defecto.

1. `npx --yes ccusage@latest` con tres informes, en paralelo:
   - `claude daily --json --breakdown --no-cost --offline --since YYYY-MM-DD --until YYYY-MM-DD --timezone <IANA>`
   - `claude session` con las mismas banderas
   - `blocks` con `--json --no-cost --offline` y el mismo rango (el informe de ventanas de 5 h es de Claude; no lleva prefijo `claude`)
2. Si ccusage no arranca, no devuelve JSON o el resultado no cumple el esquema, el parser propio lee `~/.claude/projects/**/*.jsonl` y, si existe, `~/.config/claude/projects/**/*.jsonl`. `CLAUDE_CONFIG_DIR` sustituye esas rutas y admite una lista separada por comas.

`ccusage daily` a secas, en ccusage 20, mezcla todos los agentes. Por eso el escáner usa la forma enfocada `ccusage claude`.

ccusage no es de pickagent. Es código de terceros y cada ejecución lo resuelve `npx` como `ccusage@latest`, sin versión fijada.

Codex, solo con `--codex` (experimental, ver abajo). No se mezcla con Claude: cada métrica del perfil tiene una sola fuente.

## Qué no lee, nunca

- El texto de los mensajes, los prompts y el contenido de las herramientas.
- Rutas, `cwd`, nombres de proyecto y títulos.
- El id de sesión en claro. Sirve solo para agrupar, y antes se pasa por SHA-256. El hash no entra en el perfil.
- Claves de API. No se piden. El proceso de ccusage no hereda el entorno: solo recibe `LOG_LEVEL=0` (lo pone el escáner) y, si existen, estas variables: `PATH`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TZ`, `LANG`, `LC_*`, `TMPDIR`, `TEMP`, `TMP`, `SystemRoot`, `ComSpec`, `PATHEXT`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `npm_config_registry`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `http_proxy`, `https_proxy`, `no_proxy`, `ALL_PROXY`, `npm_config_proxy`, `npm_config_https_proxy`, `npm_config_cafile`, `npm_config_userconfig`, `NODE_EXTRA_CA_CERTS` y `SSL_CERT_FILE`. Los nombres se comparan sin distinguir mayúsculas. No se pasa ninguna variable cuyo nombre termine en `_TOKEN`, `_KEY` o `_SECRET`, ni `npm_config_*auth*`. Si la URL de tu proxy o de tu registry lleva usuario y contraseña, ccusage la recibe. ccusage se ejecuta con tus permisos de usuario, así que puede leer tus archivos, como `~/.npmrc`.

De cada línea de Claude se copian, como números u horas, solo esto: marca de tiempo, id de modelo, `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` y el id de sesión (ya hasheado). Las líneas que no parecen un registro `assistant` con `usage` o `rate_limit` no se parsean.

Las horas del perfil van en bloques de una hora (se trunca a la hora local, igual que el motor). No se guardan minutos de reloj. La mediana de sesión sí va en minutos, porque el esquema lo pide, redondeada a un minuto.

La salida de ccusage se filtra antes de usarla: se quedan fechas, modelos, tokens y las banderas `isGap` / `isActive`. Se tiran costes, ids de sesión, rutas y la agrupación por proyecto (las claves de `projects` no se copian).

## Red

Solo dos salidas de red:

- `npx` puede descargar `ccusage@latest` la primera vez. ccusage se lanza con `--offline` para que no pida precios.
- Abrir el navegador en la URL del veredicto, después de confirmar.

No hay más HTTP. No hay base de datos.

Para ver esas llamadas: en el repositorio, `npm run scan:smoke -- --trace`. El script anota cada `npx` que lanza el proceso y explica cómo mirar los sockets con `tcpdump`. El contenedor se llama `pickagent-smoke-<pid>`, el pid del script.

El smoke por defecto usa `--network none`. No descarga ccusage y no ejercita el camino en el que ccusage responde bien. Comprueba el parser local y que el paquete no abre otra conexión. `--trace` deja la red abierta.

Fuera del repositorio, con el paquete ya descargado, en Linux: `strace -f -e trace=network -o /tmp/pickagent.strace npx pickagent scan --no-open`. `strace` es solo de Linux; en macOS no existe. La única conexión esperada es la de `npx` al bajar `ccusage`. Con `--no-open` el navegador no se abre.

## Bloqueos de Claude (parser local)

ccusage no dice cuándo te quedas sin cuota (`no_limit_hits`). El parser propio sí, y solo si ccusage no produjo un perfil válido. Es best-effort, sobre el texto que Claude Code escribe en el transcript cuando `error` es `"rate_limit"`.

Cuenta la primera línea si encaja con una de estas:

```text
/^You've hit your (?:session|weekly) limit\b/
/^You've hit your org's monthly spend limit\b/
```

No cuenta, aunque el error sea `rate_limit`, un límite transitorio de la API:

```text
/not your usage limit/i
/temporarily limiting requests/i
```

La espera sale de:

```text
/\bresets (\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i
```

La frase no trae fecha. La espera es la próxima vez que el reloj marca esa hora en la zona del paréntesis, redondeada a horas. En un tope semanal o mensual eso se queda corto. Si la zona falta o no es IANA, el bloqueo cuenta y `wait_hours` se omite. El texto de la frase no se guarda.

Los registros `assistant` repetidos con el mismo `message.id` cuentan una vez: Claude Code escribe la misma respuesta bajo varios `uuid`.

## Codex (`--codex`, experimental)

No hay un directorio `~/.codex/sessions` en la máquina donde se escribió este lector, así que el formato no está confirmado aquí. La forma esperada es la que documentan lectores de terceros: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` y `archived_sessions/**/rollout-*.jsonl` (`CODEX_HOME` o `~/.codex`).

Un archivo entra solo si la primera línea es `session_meta` y `payload.originator` contiene `codex`. Las líneas `response_item` (prompts, herramientas, rutas) no se parsean.

Se usan `turn_context.payload.model` y `event_msg` con `payload.type === "token_count"` e `info.last_token_usage`. El acumulado `total_token_usage` se ignora. `input_tokens` incluye la parte cacheada, así que la entrada no cacheada es `input_tokens - cached_input_tokens`, la lectura de caché es `cached_input_tokens` y la salida suma `output_tokens` y `reasoning_output_tokens`. No hay escritura de caché: ese campo queda a 0 y los tokens y `by_model` se marcan `estimated`. Las horas que salen de las marcas de tiempo siguen `measured`.

Un bloqueo cuenta cuando `rate_limits.rate_limit_reached_type` es un string no vacío. El string no se guarda. La espera sale de `primary.resets_at` o, si no está, `secondary.resets_at` (unix, segundos).

## Salida

Sin `--json`, un resumen en español y la URL. Pregunta antes de abrir el navegador. `--yes` abre sin preguntar. `--no-open` no abre. `--json` escribe solo el perfil en stdout; el navegador se abre solo si además pasas `--yes` y no `--no-open`.

La URL es `{base}/es/veredicto` más `profileToHash()`. Base por defecto: `https://pickagent.dev`.

El perfil pasa por `parseProfile` antes de usarse. Si no cumple el esquema, se imprimen las incidencias y el proceso sale con código 1. Sin uso medible (no hay horas con inicio y fin distintos) también sale con código 1: un perfil vacío no cabe en el esquema, porque `agent_hours`, `activity` y `by_model` son obligatorios.

## Cómo auditarlo

El código cabe en `packages/scanner/src`. El motor no se modifica: se importa `src/lib/engine` y esbuild lo mete en `dist/cli.js` junto con Zod. No hay dependencias de runtime en este paquete.

Busca `fetch(`, `http.request`, `net.connect` y claves: no deberían aparecer, salvo la lista blanca de variables que sí se pasan a ccusage. La única ejecución externa es `npx ccusage@latest` y el `open` / `xdg-open` del sistema. En Windows el hijo no arranca `npx.cmd` a pelo (Node 20.12 o superior lo rechaza) y la URL del navegador va entre comillas. Windows: sin probar.

En una máquina limpia, `npm run scan:smoke` (`scripts/scanner/smoke.sh`) ejecuta `npx pickagent scan --help` y un `scan --json --no-open` contra logs de fixture, dentro de contenedores `node:20` y `node:22`. Por defecto usa el `npm pack` local, antes de publicar. `npm run scan:smoke -- --published` usa `npx pickagent@<versión>` del registro.
