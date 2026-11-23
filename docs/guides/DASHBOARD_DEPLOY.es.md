# Notas de despliegue del dashboard

[English](DASHBOARD_DEPLOY.md) · **Español**

## Rediseño del dashboard: cambios en el servidor (fase 2)

Todo lo que sigue es aditivo: no se renombra, elimina ni cambia el tipo de ningún campo. Las respuestas por defecto no cambian, salvo `GET /timeline`, que ahora también lista eventos de decisiones.

- **Sin migraciones.** No hay tablas, columnas ni dependencias de ejecución nuevas. Despliega primero el servidor y después el dashboard.
- **`GET /admin/stats` se puede leer con `memory:read`.** Quien llama sin `memory:admin` recibe un cuerpo reducido: se omiten `facts.withZeroHits`, `facts.byScopeRef`, `embeddings`, `snapshot` y `recall.precision*` (no se devuelven como `null` ni como 403). Quien llama con permisos de administración recibe el cuerpo completo.
- **Campos nuevos de estadísticas:** `recall.latencyP50Ms7d` / `recall.latencyP95Ms7d` (`null` si no hay muestras) y `writesPerDay14d` (14 días UTC rellenados con ceros, del más antiguo al más reciente, que cuentan `mnemo_fact.created_at`). Los percentiles de latencia son por recuerdo servido, no por solicitud (el registro de recuperaciones tiene una fila por cada recuerdo servido), y las recuperaciones que no sirvieron nada no se cuentan.
- **Recuperación:** el indicador opcional de la solicitud `debug: true` agrega `debug.trace`, una lista de etapas `{ name, candidatesIn, candidatesOut, ms }`. `ms` es el tiempo desde la etapa anterior en orden de ejecución, en una recuperación de varios niveles solo se devuelve la traza del nivel que respondió, y un nivel de almacenamiento sin resultados informa 0 candidatos. Las etapas anteriores a `eligibility` informan conteos `null` salvo que el techo efectivo de quien llama admita todos los niveles de sensibilidad (`memory:admin` y `MNEMO_SENSITIVITY_CEILING=restricted`); para todos los demás, `eligibility` informa solo lo que pasó el techo. Sin el indicador no se genera traza ni se mide el tiempo.
- **Detalle de un hecho:** `GET /facts/{id}` acepta `includeClosed=true` (los hechos cerrados dejan de devolver 404) y `provenance=true`, que agrega `sessionId`, `supersededById`, `supersededAt` y `supersedesIds`. Un episodio sucesor o de origen por encima del techo de sensibilidad de quien llama se lee como `null` (`supersededById`, `sessionId`), igual que si no existiera; los hechos reemplazados por encima de ese techo se dejan fuera de `supersedesIds`.
- **Línea de tiempo:** nuevos tipos de evento `decision_created`, `decision_superseded` y `decision_withdrawn` con un `decisionId` opcional (en esos eventos no hay `factId`). Los cursores antiguos siguen funcionando.
- **Puente del dashboard:** el puente de la cookie de sesión ahora también monta las rutas de conflictos (listar y resolver) y las de explicación de recuperación, en sus variantes hot y unified, con las mismas reglas de permisos y la misma protección CSRF que las demás mutaciones del puente.

Las rutas de este documento van sin prefijo de versión, como todas las rutas de la referencia de la API.
