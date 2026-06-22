/**
 * Spanish (neutral Latin American) content for `sheepit_help` and
 * `sheepit_quickstart`.
 *
 * **File-budget exemption:** see the matching note in
 * `help-content-en.ts`. Pure i18n data — no logic.
 *
 * **Spanish dialect:** neutral Latin American — "tú" form with
 * imperative ("ejecuta", "llama", "configura"), no Argentinian voseo,
 * no Castilian "vosotros". Castilian (es-ES) reserved for a future
 * variant. Avoid regionalisms ("computadora" not "ordenador").
 *
 * **Translation contract:** prose is localized; identifiers, tool
 * names, code fences, endpoint paths, env vars, and the SQL/JSON
 * snippets stay byte-identical to `help-content-en.ts`. Those are
 * addressable contracts — translating them would break the LLM's
 * ability to chain tools the recipe describes.
 *
 * **Drift guard:** the `Record<(typeof HELP_TOPICS)[number], string>`
 * index forces this file to cover every topic + recipe in the English
 * source at type-check time. Adding a new English topic without a
 * Spanish stub fails `tsc`.
 */

import type { HELP_TOPICS, QUICKSTART_RECIPES } from "./help-content-en.js";

import { TOOL_COUNT } from "../generated/build-meta.js";

export const HELP_BODY_ES: Record<(typeof HELP_TOPICS)[number], string> = {
  overview: `# Sheepit MCP — qué puedes hacer

Estás conectado a un proyecto Sheepit como usuario autenticado. Desde esta
conversación puedes:

  • **Ejecutar campañas de growth de extremo a extremo** — define una audiencia +
    contenido creativo + canal, previsualiza el plan y lánzalo. El envío de
    correo vía Resend ya está disponible.
  • **Administrar destinos** — conecta los canales por los que tus campañas
    salen (webhook, Resend; Meta CAPI / Google Ads en cola).
  • **Componer dashboards de analítica** — crea dashboards, agrega widgets,
    ejecuta consultas timeseries ad hoc contra \`events_raw\`.
  • **Capturar puntos de fricción** — cuando algo se sienta torpe o esté roto,
    llama a \`feedback_submit\` para que el equipo de Sheepit lo vea sin que
    tengas que cambiar de contexto.

${TOOL_COUNT} herramientas registradas:
  - 11 campaign_*       (list / get / create / update / preview / launch /
                         pause / resume / complete / archive / results)
  - 7  destination_*    (catalog / list / get / create / update / delete / test)
  - 11 herramientas de dashboard / widget / insights (list / get / create /
                         update / delete / template_list / template_get /
                         widget_create / widget_update / widget_delete /
                         insights_query)

Los flujos comunes ya tienen recetas listas — llama a \`sheepit_quickstart\`
con uno de:
  send_email_campaign, create_dashboard, analyze_signups, ship_feedback,
  wire_webhook_destination.

Para profundizar en un área específica, llama a \`sheepit_help\` con un tema:
  campaigns, destinations, dashboards, insights, feedback, credentials.`,

  campaigns: `# Campañas

Una **campaña** es una primitiva única que agrupa audiencia + canales +
contenido creativo + (opcional) experimento + métrica de éxito + presupuesto +
programación. Un solo objeto en lugar de coser cohorts + flags + experimentos +
destinos a través de APIs separadas.

## Máquina de estados

  draft → scheduled → running → paused ⇄ running → completed → archived

Las mutaciones solo se permiten en **draft** o **paused**. Las transiciones
de estado usan las herramientas dedicadas \`campaign_pause\` /
\`campaign_resume\` / \`campaign_complete\` / \`campaign_archive\` — no
intentes hacer PATCH a \`status\` directamente.

## Disciplina de preview/launch (anti-alucinación)

\`campaign_launch\` REQUIERE un \`preview_token\` reciente generado por
\`campaign_preview\`. No puedes lanzar sin previsualizar antes el plan con
el usuario. El token es de un solo uso y está atado a un snapshot — si
cualquier campo de la campaña cambia entre el preview y el launch, el
token queda invalidado y debes volver a previsualizar.

## Gramática de audiencia

La audiencia es una lista de \`{field, op, values}\` unidos por AND. Solo
hace match contra el perfil: \`email / role / country / preferred_language /
internal / billing_exempt / created_at\`. Operadores: \`eq | neq | in |
not_in | gt | gte | lt | lte | contains\`. \`regex\` se rechaza a propósito
(riesgo de catastrophic backtracking).

Ejemplo: usuarios de EE. UU. registrados en los últimos 7 días:
  [{ field: "country", op: "in", values: ["US"] },
   { field: "created_at", op: "gte", values: ["2026-04-22T00:00:00Z"] }]

## Canales

Cada canal es \`{kind, config?, destination_config_id?}\`. Unión discriminada
sobre \`kind\`. La v1 envía email (Resend) + webhook de extremo a extremo;
los slots meta / google / tiktok / linkedin están reservados.

## Flujo de extremo a extremo

  campaign_create  →  campaign_preview  →  campaign_launch
                                       ↳  (preview_token consumido)`,

  destinations: `# Destinos

Un **destino** es una instalación de un conector por (proyecto, entorno).
Las campañas envían a través de ellos.

## Empieza siempre por destination_catalog

Lista los \`connector_ids\` que están realmente conectados en este build.
El LLM no puede inventar \`"hubspot"\` o \`"sendgrid"\` — solo se aceptan
los ids del catálogo.

Disponibles en v1: \`webhook\`, \`resend\`. En cola: meta-capi, google-ads,
tiktok-events, linkedin-conversions, customerio, onesignal.

## Resend (correo transaccional)

Config: \`{ from: "Display <addr@domain>", reply_to?, audience_scan_limit? }\`
La API key real se lee del lado del servidor desde \`RESEND_API_KEY\`; NO
la pases a través de la config del destino.

La audiencia se resuelve vía \`audience-resolver\` — escaneo acotado
(default 1000) sobre \`User\`, filtros solo de perfil, devuelve
\`truncated: true\` si se alcanzó el tope.

## Webhook (escotilla universal)

Config: \`{ url: "https://...", signing_secret?, timeout_ms? }\`
Solo HTTPS. Firma HMAC-SHA256 opcional vía \`signing_secret\`. Envía un
POST por launch con el \`CampaignDispatchPayload\` completo. 4xx →
fallo permanente; 5xx + errores de red → reintentable.

## Prueba antes de lanzar

\`destination_test\` valida la conexión (Resend: GET /domains; webhook:
HEAD ligero o POST de muestra). Ejecútalo después de \`destination_create\`
para que un \`from\` mal escrito no salga a la luz recién en el primer
\`campaign_launch\`.`,

  dashboards: `# Dashboards + widgets + insights

Analítica multi-tenant — misma forma que PostHog / Mixpanel / Amplitude.
Un **dashboard** está scopeado al proyecto y contiene N widgets. Un
**widget** tiene una query validada por Zod (kind: \`timeseries\` en v1) +
una especificación de visualización (line / bar / area / single_metric).

## Templates

No empieces de cero. \`dashboard_template_list\` enumera los blueprints
semilla (DAU & Engagement / Acquisition / Friction / Errors & Health /
Soft Launch Funnel). \`dashboard_template_get\` devuelve la spec completa
de los widgets para que selecciones algunos o materialices el template
entero.

## Regla crítica de correctitud (locked)

DAU = \`count_distinct anonymous_id\` de \`$session_start\`, NO \`user_id\`.
Los lectores anónimos de contenido (marketing, catálogo, preview de
learning) tienen que contar. La heurística de smart-naming distingue:
  count_distinct anonymous_id  → "Daily Active Users"
  count_distinct user_id       → "Daily Active Signed-In Users"

## Analítica ad hoc: insights_query

La herramienta poderosa para el LLM. Ejecuta una query timeseries
arbitraria contra \`events_raw\` para que puedas responder "¿bajaron los
signups ayer?" / "¿errores por hora por versión de la app?" sin abrir
una UI. La allowlist de bases JSON es \`event_properties\` y
\`event_context\` — ambas direccionables hasta profundidad ≤5
(p. ej. \`event_context.attribution.utm_source\`).`,

  insights: `# Consultas de insights

\`insights_query\` ejecuta analítica ad hoc. La v1 soporta
\`query.kind: "timeseries"\`.

## Envelope (coincide con \`insightsQueryRequestSchema\`)

\`\`\`json
{
  "environment_id": "00000000-0000-0000-0000-000000000020",
  "query": {
    "kind": "timeseries",
    "event": "signup_completed",
    "interval": "day",
    "range": { "kind": "relative", "last": "30d" },
    "filters": [
      { "field": "country", "op": "eq", "value": "US" }
    ],
    "breakdownProperty": "event_properties.utm_source",
    "aggregation": { "kind": "count" }
  }
}
\`\`\`

Referencia de campos:

- \`environment_id\` (opcional) — por defecto, el environment de la API key.
- \`query.kind\` — siempre \`"timeseries"\` en v1.
- \`query.event\` — nombre del evento de \`event_catalog_canonical\`.
- \`query.interval\` — \`"minute" | "hour" | "day" | "week"\`.
- \`query.range\` — \`{kind: "relative", last: "24h"|"7d"|"30d"|...}\` o
  \`{kind: "absolute", from: iso, to: iso}\`.
- \`query.filters\` (opcional) — array de \`{field, op, value}\`. El campo es un
  dot-path bajo \`event_properties\` / \`event_context\` (profundidad máx 5).
  El op \`regex\` se rechaza por riesgo de DoS.
- \`query.breakdownProperty\` (opcional) — un solo path de propiedad que
  divide la respuesta en series por valor. Máx 20 valores; el resto se
  agrupa en "(other)".
- \`query.aggregation\` (opcional, default \`{kind: "count"}\`) — \`{kind: "count"}\`
  o \`{kind: "count_distinct", field: "user_id"}\`.

## Flujos comunes

  • "¿Bajaron los signups ayer?" → event=signup_completed, count, interval=day,
                                    range=last 7d
  • "Errores por hora por versión" → event=$error, count, interval=hour,
                                      breakdownProperty=event_context.app.version,
                                      range=last 7d
  • "Usuarios anónimos activos por día" → event=$session_start,
                                          aggregation=count_distinct anonymous_id,
                                          interval=day, range=last 30d
  • "¿Dónde aterrizan los usuarios de EE. UU.?" → event=$pageview,
                                                   filters=[{country, eq, "US"}],
                                                   breakdownProperty=event_context.attribution.landing_page

Devuelve buckets con gap-fill — un bucket vacío se renderiza como 0.`,

  feedback: `# Captura de feedback (en la conversación)

Cuando algo se sienta torpe, esté roto o sea sorprendente, llama a
\`feedback_submit\`. El equipo de Sheepit lo ve en la pestaña Feedback del
admin sin que el usuario tenga que salir del chat. **La barrera de fricción
entre "esto es molesto" y "reporte enviado" es una sola llamada a una
herramienta.**

## Tres tipos de feedback

  bug      — algo está roto (resultado incorrecto, error, crash)
  feature  — una capacidad obviamente faltante ("ojalá pudiera…")
  general  — cualquier otra cosa: roces de UX, vacíos en la documentación,
             herramientas lentas, nombres confusos

## Metadata estampada automáticamente

La herramienta MCP estampa \`metadata.source = "mcp"\` más la versión del
cliente + versión de Node + plataforma automáticamente — tú no las pasas.
El usuario solo aporta la narrativa.

## Cuándo deberías (tú, el LLM) llamarla proactivamente

  • El usuario dijo algo como "esto es confuso" / "estaría bueno si…"
    → pregunta "¿quieres que lo registre como feedback?" y luego llama
    a feedback_submit si dice que sí.
  • Una herramienta devolvió un error confuso → después de mostrárselo
    al usuario, ofrece registrar feedback para que el equipo arregle el
    mensaje de error.
  • Te topaste con un vacío obvio (un connector_id que el usuario quería
    pero que aún no está en el catálogo) → regístralo como feature
    request después de confirmar con el usuario.`,

  sdk_integration: `# Guía de integración del SDK

Sheepit publica SDKs para cada superficie principal. Elige el que coincida
con el stack del cliente:

  @sheepit-ai/sdk-js     Lado navegador. Vanilla JS, Vue, Svelte, HTML plano.
  @sheepit-ai/react      React + Next.js. Hooks: useFlag, useExperiment,
                       useTrack. <Provider> en la raíz de la app.
  @sheepit-ai/server     Lado servidor en Node. Express / Fastify / Next.js
                       Server Actions / cron jobs. Tiene un sub-export
                       para Next.js (\`@sheepit-ai/server/nextjs\`).
  GoaTechSDK (Swift)  iOS / iPadOS / macOS. SPM. Módulos de crash + perf.

## Dónde llamar a init()

  Web (Next.js App Router):
    Crea app/providers.tsx con "use client":
      'use client';
      import { GoaTechProvider } from '@sheepit-ai/react';
      export function Providers({ children }) {
        return (
          <GoaTechProvider
            publishableKey={process.env.NEXT_PUBLIC_GOATECH_KEY!}
            appVersion={process.env.NEXT_PUBLIC_APP_VERSION}
          >{children}</GoaTechProvider>
        );
      }
    Luego envuelve el body en app/layout.tsx con <Providers>.

  Web (vanilla / Vite / SPA):
    Al inicio de main.ts:
      import { Sheepit } from '@sheepit-ai/sdk-js';
      export const client = await Sheepit.create({
        publishableKey: import.meta.env.VITE_GOATECH_KEY,
        appVersion: import.meta.env.VITE_APP_VERSION,
      });

  Servidor (Node, Fastify / Express / etc.):
    Al inicio del bootstrap del servidor, ANTES de las rutas:
      import { GoaTechServer } from '@sheepit-ai/server';
      export const sheepit = await GoaTechServer.init({
        secretKey: process.env.GOATECH_SECRET_KEY!,  // lp_sec_*
      });
    Usa \`secretKey\` (lp_sec_*), NUNCA la publishable key en el servidor.
    La publishable key es solo para bundles de cliente.

  iOS:
    Singleton AppContext.swift:
      let sheepit = await GoaTechSDK.shared.start(
        publishableKey: "lp_pub_...",
        appVersion: Bundle.main.version
      )

## Crítico: appVersion

Cada SDK acepta una config \`appVersion\`. DEBE ser un identificador de
build estable (sha del commit de Vercel para web, semver para mobile,
"vX.Y.Z" para Node). Habilita la detección de regresiones entre releases.
Si la omites, \`release_id\` queda en null y los templates de Errors-by-version
+ crash-free no reportan nada.

  Web (Next.js):     mete VERCEL_GIT_COMMIT_SHA en NEXT_PUBLIC_APP_VERSION
                      vía next.config.ts
  Web (Vite):        misma idea, en VITE_APP_VERSION
  Servidor:          \`process.env.npm_package_version\` está bien para v1
  iOS:               Bundle.main.shortVersionString

## Tipos de keys

Tres tipos de keys — elige la correcta para cada superficie:
  publishable (lp_pub_*)  lado cliente. Navegadores + bundles mobile.
                          No puede leer definiciones de flags ni endpoints
                          de admin. SEGURA para incrustar en bundles
                          públicos.
  secret      (lp_sec_*)  lado servidor. Acceso completo al proyecto.
                          Incrústala solo en variables de entorno del
                          servidor.
  dev         (lp_dev_*)  desarrollador / CI. Solo lectura de schemas y
                          definiciones. Úsala para codegen + lint en CI,
                          no en runtime.

Al integrar, genera dos keys: una publishable para el cliente + una
secret para el servidor.`,

  event_conventions: `# Convenciones de naming de eventos y propiedades

Sheepit tiene opiniones. Seguir estas reglas hace que los eventos del
cliente caigan automáticamente en dashboards, funnels y templates
prearmados sin retrabajo manual. Romper las reglas funciona (los eventos
se aceptan) pero quedan invisibles en las vistas por defecto.

## Nombres de eventos

  ✓  snake_case          course_viewed, signup_completed, payment_succeeded
  ✓  pasado              course_viewed (NO view_course)
  ✓  forma sustantivo_verbo course_viewed (NO viewed_course)
  ✗  PascalCase          UserSignedUp        — rechazado por el regex
  ✗  espacios / guiones  "user signed up"    — rechazado
  ✗  número al inicio    2fa_enabled         — rechazado
  ✗  presente            view_course         — aceptado pero no matchea
                                                con los templates

Regex: \`^\\$?[a-z][a-z0-9_]{0,255}$\`. El prefijo opcional \`$\` está
RESERVADO para eventos del sistema emitidos automáticamente por el SDK
($session_start, $pageview, $error, etc.). Los clientes NO deben usarlo.

## Nombres de propiedades

Misma forma: snake_case, sin espacios. Estables entre llamadas — \`user_id\`
(no \`userId\`/\`UserId\`/\`user-id\`). El PII va en propiedades; el SDK
nunca lo limpia por ti.

## Usa los nombres canónicos cuando existan

Antes de escribir \`track("UserSignedUp")\`, llama a event_catalog_canonical.
Sheepit publica ~20 nombres de eventos canónicos que los templates
prearmados de funnel / acquisition / DAU ya consultan. Usar el nombre
canónico significa que el template de signup del cliente "simplemente
funciona", sin tener que rearmar widgets.

## Qué NO meter en propiedades

  ✗ Queries de búsqueda crudas    filtra PII / contenido privado
  ✗ Contraseñas / tokens          obvio
  ✗ Blobs HTML / DOM completos    inflan events_raw
  ✗ Stack traces > 8KB            trúncalos primero
  ✗ Innertext de rage_click       los campos auto-sistema están bien;
                                  no agregues más

En su lugar: hash, solo length, o categoría. \`search_performed\` envía
\`query_length: 12, result_count: 4\` y NO \`query: "datos de tarjeta de
crédito"\`.

## Cuándo trackear del lado cliente vs del lado servidor

  Lado cliente      navegación de páginas, clicks de botones, uso de
                    features in-app, errores de UI, captura de
                    atribución. El SDK adjunta automáticamente el
                    contexto de session/device/UA.
  Lado servidor     eventos de pago (webhooks), eventos de auth
                    (después de emitir el JWT), eventos de enrollment
                    (después del write a DB), acciones de admin. Usa
                    @sheepit-ai/server.

No tracquees doble. \`payment_succeeded\` va del lado servidor (el webhook
es la fuente de verdad); una contraparte del lado cliente diverge de la
verdad del proveedor y sesga los dashboards de revenue.

## Idempotencia para eventos del servidor

Las llamadas a track del lado servidor tienen entrega at-least-once. Usa
una propiedad \`request_id\` estable derivada del id del evento upstream
(id de evento de Stripe, id de mensaje de Resend) para que los dashboards
puedan deduplicar.`,

  flag_patterns: `# Patrones de flags + experimentos

Sheepit unifica feature flags, rollouts y experimentos bajo una sola
primitiva "Flag". Orden de evaluación: kill-switch → reglas → rollout →
default. Las asignaciones de variante por usuario son determinísticas.

## Lee los flags en el LÍMITE, no profundo en el render

  React (bien):
    const showNew = useFlag('new_pricing_v2', false);
    if (showNew) return <NewPricingPage />;
    return <OldPricingPage />;

  React (mal):
    function PriceLabel() {
      const flag = useFlag('round_prices', false);  // se reevalúa en cada render
      ...
    }

Lee en el límite del layout / página; pasa los resultados como props.
Cada llamada \`useFlag\` es barata (memoizada) pero la legibilidad sufre
cuando los flags proliferan dentro de los componentes.

## Los valores default importan

  ✓  useFlag('show_dashboard_link', false)    default seguro y explícito
  ✗  useFlag('show_dashboard_link')           sin fallback si el SDK no cargó

El default se dispara cuando:
  • El SDK aún no se inicializó (primer paint de una página SSR)
  • La red está offline / el SDK nunca cargó
  • El flag no existe en el dashboard (typo)

Elige un default que signifique "el comportamiento que el usuario tiene
hoy" — generalmente \`false\` para features nuevas, \`true\` para
kill-switches.

## Naming de flags

  snake_case, presente:
    show_dashboard_link, enable_new_checkout, kill_legacy_payments
  prefija con \`enable_\` o \`show_\` para toggles booleanos
  prefija con \`kill_\` para kill-switches

Evita números de versión en el nombre (\`pricing_v2\` queda obsoleto en
cuanto sale \`pricing_v3\`). Prefiere experimentos atados a fecha
(\`pricing_october\`) o a feature (\`pricing_with_seats\`).

## Codegen: constantes de flag con tipos

Ejecuta \`pnpm sheepit codegen:flags\` (o \`npx @sheepit-ai/cli codegen\`).
Genera:
  - TypeScript:  \`generated/flags.ts\` exporta el enum \`Flags\`
  - Swift:       \`Generated/Flags.swift\`

Luego:
    import { Flags } from './generated/flags';
    const enabled = useFlag(Flags.ShowNewPricing, false);

Una key con typo no compila. Vuelve a correr el codegen cada vez que
crees o renombres un flag en el dashboard.

## Experimentos

Misma primitiva, evaluación distinta. Las variantes se asignan
determinísticamente por user_id (o anonymous_id antes del login). Usa
\`useExperiment\`:

    const { variant, payload } = useExperiment('hero_h1_copy_v1');
    return <h1>{payload?.headline ?? 'Default headline'}</h1>;

Las asignaciones de variante son estables durante toda la vida del
experimento por usuario, incluso si toggleas el flag.

## Matar un flag durante un incidente

\`sheepit flags kill <key> --reason="<detalle del incidente>"\` voltea el
kill-switch. La evaluación se salta reglas + rollout + default y devuelve
el valor del kill-switch (generalmente \`false\`). Queda en el audit log
con la razón.

\`sheepit flags restore <key>\` lo deshace.`,

  debugging_with_sheepit: `# Debugging con Sheepit

Sheepit instrumenta tu app — eso significa que Sheepit también es tu
debugger post-hoc cuando algo sale mal en prod. Tres herramientas
principales:

## insights_query — analítica ad hoc

La herramienta poderosa del LLM. Cualquier timeseries / breakdown que el
usuario pida. "¿Bajaron los signups ayer?" / "¿Errores por hora por
versión?" / "¿Dónde aterrizan los usuarios de EE. UU.?".

  Tool:  insights_query
  Poder: filtros sobre event_properties.* + event_context.* (profundidad ≤ 5)
  Límite: solo kind timeseries en v1; funnel + retention en cola

## Timeline de ChangeEvent — qué se desplegó antes de que algo se rompiera

Cada mutación de flag / regla / rollout / experimento / release / campaña
escribe una fila \`ChangeEvent\`. \`GET /v1/changes\` (paginado por cursor) +
\`/v1/changes/:id\`. Filtra por entity_type / entity_id / rango de tiempo.

Caso de uso: apareció una regresión a las 14:32; trae \`/v1/changes\` de
la hora previa para ver exactamente qué flip de flag / paso de rollout /
deploy de release correlaciona. A menudo es root-cause instantáneo.

## Audit log — quién hizo qué

\`/v1/admin/audit/events\` (gateado por admin) muestra cada mutación
autenticada. Filtra por actor / action / resource_type. Úsalo cuando el
cambio no fue un deploy de release sino un cambio de configuración hecho
por un compañero o admin.

## Releases + health

Las filas \`Release\` se crean automáticamente desde webhooks de push de
GitHub (cuando la integración de GitHub está conectada) y se estampan
desde \`appVersion\` en cada ingest de evento. Cada Release acumula:
  - tasa crash-free
  - tasa de error
  - latencia p50 / p99
  - snapshots de health rolling de 30 min (cada 5 min)

\`/v1/releases/:id/health\` devuelve el snapshot más reciente. El template
de Errors & Health visualiza esto por release.

## Auto-pause + regresión por cambio

Si un release en rollout entra en estado crítico con ≥50 sesiones, el
snapshotter pausa el rollout automáticamente y escribe
\`$release_regression\` / \`$change_regression\` en events_raw. Vigila esos
nombres de evento en insights_query — son sistema de alerta temprana,
no operación normal.

## Eventos $error — fallos no capturados

\`@sheepit-ai/sdk-js\` BrowserErrorCapture instala window.onerror +
unhandledrejection. \`@sheepit-ai/server\` hace lo mismo para Node. Cada
crash / no capturado dispara \`$error\` con stack + url + version.
Consulta los recientes:

    insights_query {
      kind: "timeseries", event: "$error",
      breakdown_property: "event_properties.message",
      time_window: { kind: "relative", days: 1 },
      granularity: "hour"
    }

Si un solo mensaje de error domina, esa es la regresión.`,

  credentials: `# Credenciales

El servidor MCP lee \`~/.sheepit/credentials.json\`, que se llena con:

  sheepit login

Eso es un flujo PKCE-OAuth contra \`api.goatech.ai\` — el mismo flujo que
usan Vercel / Neon / Stripe / GitHub. El mismo archivo de credenciales
alimenta al CLI Y al servidor MCP, así que un solo round-trip de OAuth
autentica ambas superficies.

## Selección de perfil por llamada

\`credentials.json\` puede contener N perfiles con nombre. Configura
\`SHEEPIT_PROFILE=<nombre>\` (variable de entorno) antes de lanzar el MCP
para elegir uno. El perfil default es el usado más recientemente.

## Estampado de fuente de la key

El flujo OAuth genera keys \`lp_sec_*\` estampadas con \`source = "mcp"\`
del lado de Sheepit, así que cualquier efecto colateral (campaña lanzada,
destino creado, widget escrito) es auditable hasta el origen MCP vía
\`api_keys.source\` + la tabla AuditLog.

## Reemplazar credenciales

Si las keys del usuario se filtran: \`sheepit login --force\` rehace el
flujo + revoca la key vieja.`,
};

export const QUICKSTART_BODY_ES: Record<(typeof QUICKSTART_RECIPES)[number], string> = {
  send_email_campaign: `# Receta: enviar una campaña de email

## Prerrequisitos

  1. \`destination_catalog\` — confirma que "resend" está en la lista
  2. \`destination_list\` — verifica si ya existe un destino Resend en este
     proyecto

## Si no existe un destino Resend

  3. \`destination_create\`:
     {
       connector_id: "resend",
       name: "default",
       config: { from: "Sheepit <noreply@goatech.ai>" }
     }
  4. \`destination_test\` — verifica que el dominio del from esté verificado
     en Resend

## Arma la campaña

  5. \`campaign_create\`:
     {
       name: "<nombre corto>",
       audience: [
         { field: "country", op: "in", values: ["US"] }
         // agrega filtros; solo campos de perfil
       ],
       channels: [{ kind: "resend" }],
       creative: [{
         payload: {
           subject: "<línea de asunto>",
           html:    "<cuerpo en HTML>",
           text:    "<cuerpo en texto plano>"   // recomendado
         }
       }],
       success_metric: { kind: "event", event: "course_enrolled" }   // opcional
     }
  6. \`campaign_preview\` — muéstrale al usuario el plan + el tamaño de la
     audiencia. El usuario DEBE confirmar antes de lanzar. La respuesta
     incluye un \`preview_token\` que vas a necesitar después.
  7. \`campaign_launch\`: { id, preview_token }

## Después del launch

  8. La respuesta trae \`dispatch: {attempted, succeeded, failed, ...}\` —
     muéstraselo al usuario para que sepa a cuántos destinatarios se intentó
     enviar.
  9. \`campaign_results\` devuelve métricas post-hoc cuando lleguen los eventos.`,

  create_dashboard: `# Receta: crear un dashboard desde un template

## Descubrir

  1. \`dashboard_template_list\` — muéstrale al usuario los blueprints
     disponibles
  2. \`dashboard_template_get\` { id: "<elegido>" } — obtén las specs de
     los widgets

## Materializar

  3. \`dashboard_create\`: { name: "<custom>", description: "..." }
  4. Por cada widget en el template:
     \`widget_create\`: { dashboard_id, query, viz_type, layout }

## Personalizar

  5. \`widget_update\` para cambiar la query / visualización / breakdown
  6. \`widget_delete\` para descartar los que no son relevantes

## Desde cero

  Saltea 1+2; arranca en \`dashboard_create\` y agrega widgets vía
  \`insights_query\` para validar la query primero, luego \`widget_create\`
  para persistirla.`,

  analyze_signups: `# Receta: investigar una caída de signups

## Visualiza la caída

  1. \`insights_query\`:
     {
       kind: "timeseries", event: "signup_completed",
       measure: { type: "count" },
       time_window: { kind: "relative", days: 30 },
       granularity: "day"
     }
  2. Léele al usuario los conteos diarios. Identifica la fecha de la caída.

## Desglosa por fuente

  3. \`insights_query\` de nuevo con breakdown_property:
     "event_context.attribution.utm_source"  → ¿se secó alguna fuente?
     "event_context.attribution.landing_page" → ¿cambió alguna campaña?
     "event_properties.signup_method"        → ¿se rompió Google OAuth?

## Crúzalo con errores

  4. \`insights_query\`:
     { kind: "timeseries", event: "$error", measure: { type: "count" },
       breakdown_property: "event_properties.message",
       time_window: { kind: "relative", days: 7 }, granularity: "hour" }
     Si una ruta empezó a devolver 500 el día que cayeron los signups,
     esa es la causa.

## Crúzalo con releases

  5. Compara el timestamp del inicio de la caída con el \`createdAt\` del
     \`Release\` más reciente — si hubo un deploy dentro de la hora de la
     caída, mira el diff.

## Persiste la respuesta

  6. Si la caída es real, \`feedback_submit\` { type: "bug", message:
     "<lo que encontraste>" } para que el equipo se entere.`,

  ship_feedback: `# Receta: capturar puntos de fricción en línea

  1. \`feedback_submit\`:
     {
       type: "bug" | "feature" | "general",
       message: "<las palabras del usuario; cítalas cuando puedas>"
     }

El MCP estampa automáticamente \`metadata.source = "mcp"\` + info de
versión. Devuelve \`{ id, created_at }\` cuando hay éxito.

Cuándo llamarla sin que te lo pidan:
  • El usuario dice "esto es confuso" / "esperaba X pero obtuve Y"
  • Un error de una herramienta es poco útil
  • El usuario tuvo que hacerte una pregunta que CUALQUIER usuario futuro
    también va a hacer

Cuándo NO llamarla:
  • El usuario hizo una pregunta y obtuvo una respuesta — eso es happy path
  • La fricción está antes de Sheepit (npm / red / configuración del usuario)`,

  instrument_signup_funnel: `# Receta: instrumentar el funnel de signup

Objetivo: cada signup queda trackeado de extremo a extremo para que los
templates de Acquisition + DAU + Funnel se prendan automáticamente.

## Paso 1 — confirma los nombres canónicos

  event_catalog_canonical { category: "auth" }

Vas a obtener \`signup_completed\`, \`login_succeeded\`, \`login_failed\`.
Usa esos nombres exactos — los templates prearmados los consultan.

## Paso 2 — lado cliente: trackea el submit del formulario

  Web (React):
    import { useTrack } from '@sheepit-ai/react';
    function SignupForm() {
      const track = useTrack();
      const onSubmit = async (values) => {
        track('signup_submitted', { method: 'email' });
        try {
          await api.signup(values);
          // el éxito se maneja del lado servidor (siguiente paso)
        } catch (err) {
          track('signup_failed', { reason: err.code });
        }
      };
    }

\`signup_submitted\` es un evento custom (no canónico) — es la señal de
intención de signup, no la de éxito. Inclúyelo para diagnosticar el
funnel; el canónico \`signup_completed\` se emite solo del lado servidor.

## Paso 3 — lado servidor: trackea el éxito después del write a DB

  Node (Fastify / Express):
    import { sheepit } from '../lib/sheepit';
    app.post('/auth/signup', async (req, reply) => {
      const user = await db.user.create({ ... });
      // CRÍTICO: trackea DESPUÉS del write a DB, no antes
      await sheepit.track({
        userId: user.id,
        event: 'signup_completed',
        properties: { method: 'email', plan: req.body.plan },
      });
      return reply.code(201).send({ user });
    });

El binding de user_id es lo que después permite que los dashboards /
cohorts por usuario funcionen. Si solo emites del lado cliente,
anonymous_id es el único id y rebindearlo a user_id después es engorroso.

## Paso 4 — verifica

  insights_query {
    kind: "timeseries", event: "signup_completed",
    measure: { type: "count" },
    time_window: { kind: "relative", days: 1 },
    granularity: "hour"
  }

Deberías ver conteos dentro de los ~30s de un signup real. Si no, mira la
pestaña de network en dev tools — \`/v1/ingest\` debería devolver 200, no 4xx.

## Paso 5 — conecta el template

\`dashboard_template_get { id: "acquisition" }\` devuelve un dashboard
prearmado que vigila \`signup_completed\` + breakdowns de UTM.
Materialízalo con \`dashboard_create\` + un \`widget_create\` masivo.`,

  add_first_flag: `# Receta: agregar el primer feature flag del cliente

Objetivo: el cliente puede lanzar una feature en oscuro y prenderla para
una cohort sin desplegar.

## Paso 1 — instala el SDK (saltea si ya está)

  Web (Next.js):  npm i @sheepit-ai/react @sheepit-ai/sdk-js
  Monta el GoaTechProvider en la raíz de la app con la publishable key.
  Mira \`sheepit_help { topic: "sdk_integration" }\` para el snippet.

## Paso 2 — elige un nombre de flag

Convención: snake_case, presente, orientado a la acción.
  ✓ show_new_pricing, enable_dark_mode, kill_legacy_checkout
  ✗ NewPricing, pricingV2

## Paso 3 — lee el flag en el código

  React:
    import { useFlag } from '@sheepit-ai/react';
    function PricingPage() {
      const showNew = useFlag('show_new_pricing', false);
      return showNew ? <NewPricing /> : <OldPricing />;
    }

El default \`false\` es lo que ven los usuarios si el SDK no se inicializó
o el flag aún no existe — elige un default que signifique "lo que ven hoy".

## Paso 4 — registra el flag en Sheepit

Créalo acá mismo sin salir del chat:

  flag_create {
    key: "show_new_pricing", name: "Show New Pricing",
    value_type: "boolean", default_value: false, platforms: ["web"]
  }

Matchea la key en el código exactamente. \`flag_create\` necesita una API
key secreta con rol editor (\`sheepit login\` con una key \`lp_sec_*\`). O
abre https://www.goatech.ai/app/flags → New Flag en el dashboard. Edita
metadata después con \`flag_update\`; lista con \`flag_list\`.

## Paso 5 — préndelo para una cohort

En el detalle del flag en el dashboard:
  - Agrega una Rule: \`country eq US\` → value \`true\`. 100% de los
    usuarios de EE. UU. lo ven.
  - O agrega un Rollout: 5% → 25% → 100% en una semana. Determinístico
    por user_id, así que el mismo usuario se queda en su bucket mientras
    rampeas.

## Paso 6 — codegen para tipos seguros

  npx @sheepit-ai/cli codegen

Genera \`src/generated/flags.ts\` con un enum \`Flags\`. Cambia a:

    const showNew = useFlag(Flags.ShowNewPricing, false);

Ahora un typo falla en compile, no en fallback silencioso al default.

## Paso 7 — observa

  insights_query {
    kind: "timeseries", event: "$pageview",
    filters: [{ field: "event_properties.path", op: "eq", values: ["/pricing"] }],
    breakdown_property: "event_context.flags.show_new_pricing",
    time_window: { kind: "relative", days: 7 },
    granularity: "day"
  }

Divide las vistas de la página de pricing entre quienes vieron la versión
nueva vs la vieja. Útil para detectar "¿el pricing nuevo hundió la
conversión?".`,

  wire_release_health: `# Receta: conectar release health

Objetivo: cada deploy crea una fila Release en Sheepit, acumula rollups
de crash-free / error / latency, y se auto-pausa si entra en estado
crítico.

## Paso 1 — mete appVersion en el SDK

  Web (Next.js, next.config.ts):
    env: { NEXT_PUBLIC_APP_VERSION: process.env.VERCEL_GIT_COMMIT_SHA }
  Luego:
    <GoaTechProvider appVersion={process.env.NEXT_PUBLIC_APP_VERSION}>

  Servidor (Node):
    import pkg from './package.json' with { type: 'json' };
    GoaTechServer.init({ appVersion: pkg.version, ... });

  iOS:
    GoaTechSDK.shared.start(appVersion: Bundle.main.shortVersionString!, ...)

Sin appVersion cada evento tiene \`release_id = null\` — release-health
queda mudo.

## Paso 2 — instala la integración de GitHub (stack web)

Abre /app/settings/integrations → enlaza un repo de GitHub. Genera un
secret para el webhook que pegas en la config de webhook del repo de
GitHub (o usa \`sheepit integrations github link <owner>/<repo>\` desde
el CLI).

Después de eso, cada push a la branch default crea automáticamente una
fila \`Release\` etiquetada con el sha del commit. iOS / nativo — la
creación automática no está disponible; crea Releases manualmente vía
dashboard o CI.

## Paso 3 — verifica

  insights_query {
    kind: "timeseries", event: "$pageview",
    breakdown_property: "event_context.app.version",
    time_window: { kind: "relative", days: 1 },
    granularity: "hour"
  }

Deberías ver el tráfico dividido por los shas de commit recientes. La
leyenda muestra \`abc1234 · 2h ago\` (release_resolver enriquece con tiempo
relativo) una vez que el webhook de GitHub disparó.

## Paso 4 — arranca un rollout

En /app/releases para el release nuevo: elige Rolling out → setea el
porcentaje inicial (p. ej. 5%). El release auto-avanza según un schedule,
O se auto-pausa si crash-free baja > 2pp vs el release anterior con ≥50
sesiones en la ventana.

## Paso 5 — observa

  insights_query {
    kind: "timeseries", event: "$error",
    breakdown_property: "event_context.app.version",
    time_window: { kind: "relative", days: 1 },
    granularity: "hour"
  }

Si el release nuevo tiene un conteo de \`$error\` mayor que el anterior,
\`$change_regression\` se va a disparar y el template de Errors & Health
del dashboard lo va a marcar. Haz rollback vía el panel de Decision del
release o \`POST /v1/admin/ops/releases/:id/decide\` (CLI: en cola).`,

  diagnose_a_regression: `# Receta: diagnosticar una regresión en prod

Objetivo: un usuario reporta que algo se rompió; descubre cuándo + por qué
+ qué hay que rollbackear.

## Paso 1 — obtén el timestamp + síntoma

Pregúntale al usuario cuándo lo encontró + qué estaba haciendo. "Como a
las 2pm" alcanza — las ventanas de cambio se miden en minutos, no en
segundos.

## Paso 2 — revisa los ChangeEvents de la hora previa

  curl -H "Authorization: Bearer $SHEEPIT_API_KEY" \\
       "https://api.goatech.ai/v1/changes?to=2026-04-29T14:30:00Z&from=2026-04-29T13:00:00Z"

Devuelve cada mutación de flag / regla / rollout / experimento / release /
campaña en la ventana. El 80% de las veces el nombre de la regresión está
en la lista (un flag que se volteó, un rollout que avanzó, un release que
se desplegó). Cada fila trae \`actorSource\` (jwt / api_key / cli /
scheduler / webhook) así que sabes si fue un compañero o un proceso
automatizado.

## Paso 3 — consulta $error en la misma ventana

  insights_query {
    kind: "timeseries", event: "$error",
    breakdown_property: "event_properties.message",
    filters: [{ field: "timestamp", op: "gte", values: ["2026-04-29T13:00:00Z"] }],
    time_window: { kind: "relative", hours: 2 },
    granularity: "minute"
  }

Si un solo mensaje domina, esa es probablemente la regresión. El stack +
URL vienen como propiedades adicionales.

## Paso 4 — desglosa por versión + cohort

  insights_query {
    kind: "timeseries", event: "$error",
    breakdown_property: "event_context.app.version",
    time_window: { kind: "relative", hours: 2 },
    granularity: "minute"
  }

Si solo el release más reciente tiene errores, el deploy es la causa.
Pausa o rollbackea el rollout (Paso 6).

  insights_query {
    kind: "timeseries", event: "$error",
    breakdown_property: "event_context.flags.<flag_sospechoso>",
    time_window: { kind: "relative", hours: 2 },
    granularity: "minute"
  }

Si los errores aparecen solo cuando el flag está prendido, el flag es la
causa. Mátalo con \`sheepit flags kill <key> --reason=<una línea>\`.

## Paso 5 — confirma que el fix aterrizó

Después del rollback / kill, vuelve a correr la query del Paso 3 por los
próximos 15 min. La tasa de error debería caer al baseline. Si no,
arreglaste lo equivocado — vuelve al Paso 2.

## Paso 6 — documenta el fix

\`feedback_submit { type: "bug", message: "<causa raíz + remediación>" }\`
para que el equipo tenga registro. Después en código, escribe un test de
regresión + lanza un commit follow-up siguiendo la regla de bug-fix
observability (telemetría del servidor + evento estructurado + test).`,

  wire_webhook_destination: `# Receta: conectar un destino webhook

Para el cliente que quiere reenviar los launches de campaña a su propio
pipeline.

  1. \`destination_create\`:
     {
       connector_id: "webhook",
       name: "ops-pipeline",
       config: {
         url: "https://example.com/sheepit/campaigns",   // solo HTTPS
         signing_secret: "<secreto compartido>",         // opcional pero recomendado
         timeout_ms: 10000                                // 1000-30000
       }
     }
  2. \`destination_test\` — envía un POST de muestra + verifica 2xx
  3. La campaña que use este destino debería referenciarlo vía
     \`channels: [{ kind: "webhook", destination_config_id: "<del paso 1>" }]\`

## Qué recibe el endpoint del cliente

\`\`\`
POST <url>
content-type: application/json
x-sheepit-event-id: campaign:<id>:launch
x-sheepit-signature-256: sha256=<hmac>     (cuando signing_secret está seteado)

{
  campaign: { id, name, ... },
  audience: { count, sample, truncated },
  creative: [...],
  success_metric, budget, schedule,
  project: { id, slug },
  environment: { id, name }
}
\`\`\`

El receptor verifica el HMAC con el \`signing_secret\` que nos pasó. Debería
tratar \`x-sheepit-event-id\` como la idempotency key — podríamos reintentar
en 5xx.`,
};
