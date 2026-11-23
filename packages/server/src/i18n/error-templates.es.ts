/**
 * Neutral Spanish (tú) for every key of the English table. Placeholders keep
 * their names; commands, flags, env vars and JSON keys stay as they are.
 */
import type { en } from "./error-templates.en.js";

export const es: { [K in keyof typeof en]: string } = {
  err_bad_request: "Solicitud incorrecta",
  err_unauthorized: "No autorizado",
  err_forbidden: "Prohibido",
  err_not_found: "No encontrado",
  err_conflict: "Conflicto",
  err_rate_limited: "Demasiadas solicitudes",
  err_unprocessable: "Entidad no procesable",
  err_unavailable: "Servicio no disponible",
  err_internal: "Error interno del servidor",
  err_not_implemented: "No implementado",

  err_poisoning: "Contenido rechazado por el filtro de envenenamiento",
  err_semantic_unavailable: "La búsqueda semántica no está disponible temporalmente",
  err_encryption_not_configured:
    "Este servidor no tiene MNEMO_MASTER_KEY, así que no puede guardar recuerdos confidenciales ni restringidos. Usa public o internal, o pide al operador que configure la clave.",
  err_breaker_open:
    "Una dependencia no está disponible temporalmente. Vuelve a intentarlo más tarde; la solicitud no se intentó.",
  err_breaker_timeout:
    "Una dependencia no respondió a tiempo. Vuelve a intentarlo más tarde; si era una escritura, puede que se haya aplicado o no, así que repítela de forma idempotente.",
  err_db_unavailable:
    "La base de datos no está disponible temporalmente. Puede que una escritura se haya aplicado o no; repítela de forma idempotente.",

  req_invalid: "Solicitud no válida",
  req_too_large: "El cuerpo de la solicitud supera el límite de 1 MB",

  mnemo_001: "Falló la conexión con Redis — se usa memoria local en su lugar",
  mnemo_002: "Se agotó el pool de PG — se descartan las tareas de baja prioridad",
  mnemo_003: "Tiempo de espera agotado del proveedor de embeddings — se usa solo búsqueda de texto",
  mnemo_004: "Falló el LLM de cierre de sesión — la sesión se conserva para reintentarlo",
  mnemo_005: "Nodo par de federación inaccesible — sincronización aplazada",
  mnemo_006: "Ciclo de propagación de valor detectado — se corta a profundidad 5",
  mnemo_007: "Se activó la reversión de consolidación — la calidad de recuperación se degradó",
  mnemo_008: "Falló la verificación de la cadena Merkle — alerta de integridad de auditoría",
  mnemo_009: "El nivel caliente de Redis está lleno — se desaloja por activación LRU",
  mnemo_010: "Tiempo de espera agotado de un complemento — complemento desactivado",

  auth_unavailable: "Servicio de autenticación no disponible",
  auth_no_credentials: "No se proporcionaron credenciales",
  auth_missing_bearer: "Falta el token de portador",
  auth_malformed_key: "Clave de API con formato incorrecto",
  auth_invalid_key: "Clave de API no válida",

  scope_insufficient: "Los permisos de la clave de API son insuficientes",
  scope_requires: "Los permisos de la clave de API son insuficientes: requiere '{scope}'",
  scope_requires_one_of:
    "Los permisos de la clave de API son insuficientes: requiere uno de [{scopes}]",
  scope_empty:
    "La clave de API no tiene permisos definidos — el acceso completo está desactivado. Crea una clave con permisos, o define MNEMO_ALLOW_LEGACY_FULL_SCOPE=true para permitir las claves antiguas sin permisos.",

  rbac_break_glass: "el acceso de emergencia requiere una clave mk_admin_ vinculada a un usuario",
  rbac_no_policy:
    "No se encontró una política RBAC para este agente (modo de denegación por defecto activo).",
  rbac_approval_denied: "aprobación denegada",
  rbac_needs_user_key:
    "esta acción requiere aprobación, y la aprobación requiere una clave vinculada a un usuario",
  rbac_agent_rate: "Se superó el límite de {metric} por minuto del agente ({limit}/min)",
  rbac_session_edits: "Se superó el límite de autoediciones por sesión ({limit}/sesión)",
  rbac_sessions: "Se superó el límite de sesiones simultáneas ({limit})",

  rl_concurrent: "Se superó el límite de solicitudes simultáneas",
  rl_rate: "Se superó el límite de frecuencia de solicitudes",
  rl_shed: "El servicio está descartando carga; vuelve a intentarlo en un momento",

  flat_invalid_credentials: "Correo electrónico o contraseña incorrectos.",
  flat_too_many_attempts: "Demasiados intentos. Vuelve a intentarlo más tarde.",
  flat_invalid_json: "El cuerpo de la solicitud debe ser JSON válido",
  flat_api_key_required: "apiKey es obligatorio",
  flat_db_unreachable: "No se pudo conectar con la base de datos",

  store_entity_exists: 'Ya existe una entidad llamada "{name}" de tipo {kind}',
  store_entity_not_found: "No se encontró la entidad {id}",
  store_entity_closed: "La entidad {id} ya está cerrada",
  store_decision_not_found: "No se encontró la decisión {id}",
  store_decision_self: "Una decisión no puede reemplazarse a sí misma",
  store_decision_superseded: "La decisión {id} ya fue reemplazada por otra decisión",
  store_hyperedge_not_found: "No se encontró la hiperarista: {id}",
  store_hyperedge_members_missing: "No se encontraron uno o más miembros de la hiperarista",
  store_hyperedge_distinct: "Los miembros de la hiperarista deben ser distintos",
  store_relation_self: "Una relación no puede unir un nodo consigo mismo",
  // zod's type name ({expected}) is English, so the Spanish leaves it out.
  zod_required: "{path}: Obligatorio",
  zod_invalid: "{path}: Valor no válido",
  zod_invalid_option: "{path}: Opción no válida: se esperaba una de {options}",
  zod_too_small_string: "{path}: Demasiado corto: se esperaban {bound} caracteres",
  zod_too_big_string: "{path}: Demasiado largo: se esperaban {bound} caracteres",
  zod_too_small_array: "{path}: Muy pocos elementos: se esperaban {bound}",
  zod_too_big_array: "{path}: Demasiados elementos: se esperaban {bound}",
  zod_too_small_number: "{path}: Valor demasiado pequeño: se esperaba {bound}",
  zod_too_big_number: "{path}: Valor demasiado grande: se esperaba {bound}",
  zod_invalid_guid: "{path}: GUID no válido",
  zod_invalid_uuid: "{path}: UUID no válido",
  zod_invalid_datetime: "{path}: Fecha y hora ISO no válida",
  zod_invalid_date: "{path}: Fecha ISO no válida",
  zod_invalid_email: "{path}: Dirección de correo electrónico no válida",
  zod_invalid_url: "{path}: URL no válida",
  zod_invalid_pattern: "{path}: Texto no válido: debe coincidir con el patrón {pattern}",

  // Task 4: administration and account routes. "tenant" stays a product term.
  // routes/tenants.ts
  tenants_not_authorized: "No tienes autorización para este tenant",
  tenants_owner_admin_required: "Se requiere el rol de propietario o administrador del tenant",
  tenants_workspace_owner_admin_required:
    "Se requiere el rol de propietario o administrador del espacio de trabajo",
  tenants_owner_token_needs_user:
    "issueOwnerToken necesita una clave de API vinculada a un usuario",
  tenants_not_found: "No se encontró el tenant",
  tenants_user_email_not_found: "No se encontró un usuario con ese correo electrónico",
  tenants_user_exists_other_tenant:
    "Ya existe un usuario con ese correo electrónico que no es miembro de este tenant; una clave de API con usuario solo puede invitar correos electrónicos nuevos o miembros de su propio tenant",
  tenants_email_registered: "El correo electrónico ya está registrado",
  tenants_no_user_for_key: "No hay ningún usuario asociado a esta clave de API",
  tenants_user_not_found: "No se encontró el usuario",
  tenants_owner_not_in_tenant: "el propietario no pertenece a este tenant",
  tenants_workspace_not_found: "No se encontró el espacio de trabajo",
  tenants_user_not_in_tenant: "el usuario no pertenece a este tenant",

  // routes/instance.ts
  instance_unavailable: "La administración de la instancia no está disponible",
  instance_invalid_password: "Contraseña incorrecta.",
  instance_master_key_missing: "MNEMO_MASTER_KEY no está configurada.",

  // routes/bootstrap.ts
  bootstrap_invalid_api_key:
    "apiKey debe tener el formato mns_(live|test)_<20+ caracteres alfanuméricos> o mk_(live|test|...)_<20+ caracteres alfanuméricos>",
  bootstrap_invalid_workspace_id: "workspaceId debe ser un UUID válido",
  bootstrap_admin_together: "adminEmail y adminPassword deben indicarse juntos",
  bootstrap_admin_email_invalid: "adminEmail debe ser un correo electrónico válido",
  bootstrap_already:
    "Mnemosyne ya tiene claves de API. Usa la API de administración para crear más claves.",
  bootstrap_register_failed: "No se pudo registrar la clave de API",
  bootstrap_setup_done: "La configuración inicial ya se completó.",
  bootstrap_token_invalid: "El token de configuración no es válido o expiró.",
  bootstrap_workspace_failed: "No se pudo crear el espacio de trabajo",

  // routes/dashboard-links.ts
  links_invalid: "Este enlace no es válido o expiró.",
  links_choose_password: "Elige una contraseña.",
  links_sign_in_required: "Inicia sesión en esta cuenta para aceptar la invitación.",

  // routes/my-workspaces.ts, workspace-members.ts, workspace-target.ts
  workspaces_unavailable: "Los espacios de trabajo no están disponibles",
  workspaces_password_session: "Inicia sesión con tu correo electrónico y tu contraseña.",
  members_unavailable: "La gestión de miembros no está disponible",
  members_owner_admin_only:
    "Solo los propietarios y administradores del espacio de trabajo pueden hacer esto.",
  members_invitations_off: "Las invitaciones están desactivadas en esta instalación.",
  target_needs_user_key:
    "targetWorkspaceId requiere una clave de API vinculada a un usuario (mk_user_* o mk_live_* con user_id)",
  target_not_write_member:
    "El usuario no es miembro con permiso de escritura del espacio de trabajo de destino",

  // routes/keys.ts and user-tokens.ts
  scopes_unknown: "Permisos desconocidos: {scopes}",
  scopes_cannot_grant: "No se pueden conceder permisos que el solicitante no tiene: {scopes}",
  scopes_cannot_grant_ceiling:
    "No se puede conceder un nivel máximo de sensibilidad superior al del solicitante ({ceiling})",
  keys_federation_shape:
    'Una clave de federación tiene exactamente ["memory:federation"] y es una clave de espacio de trabajo, no de prueba',
  keys_revoke_not_found: "No se encontró la clave de API o ya fue revocada",
  keys_not_found: "No se encontró la clave de API",
  keys_revoked: "La clave de API ya está revocada y no se puede rotar",
  keys_deprecated: "La clave de API ya fue rotada y no se puede rotar de nuevo",
  keys_expired: "La clave de API está vencida y no se puede rotar",
  keys_rotate_scopes_beyond:
    "No se puede rotar una clave de API con permisos que el solicitante no tiene: {scopes}",
  keys_rotate_ceiling_beyond:
    "No se puede rotar una clave de API cuyo nivel máximo de sensibilidad es superior al del solicitante",
  scoped_keys_admin_needs_user:
    "Una clave mk_admin_ queda ligada al usuario que la emite: emítela con una clave ligada a un usuario o desde una sesión del dashboard",
  scoped_keys_ttl_too_long: "Una clave {prefix} dura como máximo {hours} horas",
  scoped_keys_admin_rotate_owner:
    "Solo el usuario al que está ligada una clave mk_admin_ puede rotarla",
  tokens_target_not_member: "El usuario de destino no es miembro de este tenant",
  tokens_home_workspace_other: "homeWorkspaceId no pertenece a este tenant",
  tokens_target_not_in_home:
    "El usuario de destino no es miembro de homeWorkspaceId — agrégalo primero con POST /workspaces/:id/members",
  tokens_not_found: "No se encontró el token, ya fue revocado o pertenece a otro usuario o tenant",

  // routes/federation.ts
  federation_workspace_not_in_scope: "el espacio de trabajo no está dentro del alcance del JWT",
  federation_cert_required: "newCertDer es obligatorio (DER codificado en base64)",
  federation_peer_not_provisioned:
    "El nodo par '{peerId}' no está aprovisionado; agrégalo antes de aprobar una rotación de claves",
  federation_peer_not_found: "No se encontró el nodo par '{peerId}'",
  federation_peer_invalid: "Nodo par no válido: {detail}",
  federation_peer_exists: "El nodo par '{peerId}' ya existe",
  federation_sync_peer_key:
    "La clave de federación de un nodo par no puede iniciar una sincronización",
  federation_storage_unavailable: "El adaptador de almacenamiento no está disponible",
  federation_peer_id_required: "peerId es obligatorio",
  federation_sync_job_not_found: "No se encontró la tarea de sincronización '{jobId}'",
  federation_items_required: "itemA e itemB son obligatorios y deben ser objetos",

  // routes/admin-agent-policies.ts
  agent_policy_unavailable:
    "Las políticas de agente no están disponibles: el almacén de políticas no está configurado",
  agent_policy_not_found: "No hay política RBAC para el agente '{agentId}'",
  agent_policy_self: "Una clave no puede cambiar su propia política RBAC",

  // routes/approvals.ts
  approvals_not_found: "aprobación no encontrada",
  approvals_status_invalid: "status debe ser approved|denied",
  approvals_needs_user_key:
    "resolver una aprobación requiere una clave de API vinculada a un usuario",
  approvals_already: "la aprobación ya tiene el estado {status}",
  approvals_self:
    "no se permite la autoaprobación: quien solicita una aprobación no puede resolver su propia solicitud",

  // routes/consolidation.ts
  consolidation_dry_run:
    "La simulación de consolidación aún no es compatible; no se hicieron cambios.",
  consolidation_deep:
    "La consolidación profunda manual aún no es compatible; no se hicieron cambios.",
  consolidation_storage_unwired:
    "El adaptador de almacenamiento no está conectado a ServerDeps. Instala @mnemo-ai/adapter-postgres y reinicia el servidor.",
  consolidation_not_installed:
    "@mnemo-ai/consolidation no está instalado. Agrégalo como dependencia y reinicia el servidor para habilitar este endpoint.",

  // Task 5: memory-primitive routes and the rest of src (source literals, verbatim)
  // auth-evaluate.ts, app-scope, dashboard-password.ts
  auth_ip_denied: "La IP no está en la lista de permitidas",
  auth_key_sunset:
    "La clave de API está obsoleta y superó su fecha de retiro; rota a una clave nueva",
  scope_session_insufficient: "Los permisos de la sesión son insuficientes",
  password_min_length: "La contraseña debe tener al menos 12 caracteres.",
  password_max_bytes: "La contraseña debe tener como máximo 72 bytes UTF-8.",
  password_same_email: "La contraseña debe ser distinta de tu correo electrónico.",

  // embed-adapter.ts, idempotency.ts, single-use-link.ts
  embed_not_configured:
    "No hay un adaptador de embeddings configurado: define MNEMO_LLM_PROVIDER y MNEMO_LLM_API_KEY para habilitar la recuperación semántica",
  idem_in_progress: "Ya hay una solicitud en curso con esta Idempotency-Key",
  idem_reused: "Se reutilizó la Idempotency-Key en una solicitud distinta",
  links_rate_limited: "Demasiados enlaces. Vuelve a intentarlo más tarde.",

  // middleware/rbac-policy.ts, rbac.ts
  rbac_break_glass_unavailable:
    "aprobación de acceso de emergencia no disponible: las operaciones con privilegios de mk_admin_ requieren la autorización de dos personas",
  rbac_break_glass_second_admin:
    "acceso de emergencia: un segundo administrador debe aprobar antes de permitir esta operación con privilegios",
  rbac_sensitivity_above_ceiling:
    "la sensibilidad '{requested}' supera el nivel máximo de lectura de esta credencial ('{ceiling}'); el recuerdo nunca podría leerse de nuevo, por lo que no se guardó.",
  rbac_sensitivity_above_ceiling_update:
    "la sensibilidad '{requested}' supera el nivel máximo de lectura de esta credencial ('{ceiling}'); el evento nunca podría leerse de nuevo, por lo que no se cambió.",
  fact_not_found: "No se encontró el hecho {id}",

  // routes/_fact-hard-delete.ts, facts.ts, governance.ts
  hard_delete_scope_required:
    "Se requiere el permiso memory:hard_delete para el borrado definitivo",
  hard_delete_no_storage: "el adaptador de almacenamiento no está disponible",
  hard_delete_unsupported: "este adaptador de almacenamiento no admite el borrado definitivo",
  fact_being_consolidated:
    "El hecho {id} se está consolidando; vuelve a intentar el borrado más tarde",
  fact_none_active: "No hay ningún hecho activo {id} en este espacio de trabajo.",
  fact_quoted_not_found: "No se encontró el hecho '{factId}'",

  // routes/admin-harness.ts, harness.ts, workspace-mode.ts
  admin_scope_required: "Se requiere el permiso administrativo del espacio de trabajo",
  managed_storage_unavailable:
    "El almacenamiento del ciclo de vida administrado no está disponible",
  harness_too_large: "El cuerpo de la solicitud de harness supera el límite de 1 MiB",
  harness_invalid_json: "El cuerpo de la solicitud de harness debe ser JSON válido",
  harness_protocol_version: "Solo se admite la versión {version} del protocolo de harness",
  harness_invalid_probe: "Sobre de sonda de harness no válido",
  harness_invalid_batch: "Sobre de lote de harness no válido",
  harness_binding_mismatch:
    "El vínculo de harness no coincide con el espacio de trabajo autenticado",
  workspace_mode_unsupported:
    "El adaptador de almacenamiento no admite el modo de espacio de trabajo",

  // routes/break-glass.ts
  bg_request_needs_admin_key:
    "las solicitudes de acceso de emergencia requieren una clave mk_admin_",
  bg_reason_required: "reason es obligatorio",
  bg_scopes_required: "requestedScopes debe ser un arreglo no vacío",
  bg_request_not_found: "no se encontró la solicitud de acceso de emergencia",
  bg_approve_needs_admin_key:
    "las aprobaciones de acceso de emergencia requieren una clave mk_admin_",

  // routes/composition.ts
  composition_invalid_condition: "conditionDsl no válido: {detail}",
  composition_invalid_action: "actionDsl no válido: {detail}",
  composition_not_found: "No se encontró la regla de composición {id}",

  // routes/conflicts.ts, relations.ts
  relation_not_found: "No se encontró la relación {id}",
  relation_not_conflict: "La relación {id} no es una relación conflicts_with (se obtuvo: {verb})",
  relations_verb_locked:
    'El verbo "{verb}" no está en el vocabulario cerrado. Verbos permitidos: {allowed}.',

  // routes/entities.ts
  entities_no_fields: "No hay campos para actualizar",
  entities_canonical_self: "canonicalId no puede ser igual al id de la entidad",
  entities_canonical_missing: "el destino de canonicalId no existe",
  entities_closed: "La entidad {id} está cerrada",
  entities_link_person_only:
    "Solo las entidades con kind='person' se pueden vincular a una cuenta de usuario",
  entities_link_other_user:
    "Vincular a un usuario distinto requiere el permiso memory:admin y un rol de propietario o administrador en este espacio de trabajo",
  entities_relink_other_user:
    "Reasignar una entidad ya vinculada a un usuario distinto requiere el permiso memory:admin y un rol de propietario o administrador en este espacio de trabajo",
  entities_user_not_member: "El usuario {userId} no es miembro de este espacio de trabajo",
  entities_not_linked: "La entidad {id} no está vinculada a ningún usuario",
  entities_unlink_other_user:
    "Desvincular a un usuario distinto requiere el permiso memory:admin y un rol de propietario o administrador en este espacio de trabajo",

  // routes/episodes.ts, events.ts, reasoning.ts, hyperedges.ts, reminders.ts, review.ts
  episode_not_found: "No se encontró el episodio {id}",
  event_not_found: "No se encontró el evento {id}",
  event_immutable:
    "Los eventos son inmutables y no se pueden eliminar; olvida en su lugar los hechos derivados de ellos.",
  reasoning_not_found: "No se encontró el razonamiento {id}",
  hyperedge_not_found: "No se encontró la hiperarista {id}",
  reminder_not_found: "No se encontró el recordatorio {id}",
  review_not_found: "No se encontró la fila de revisión {id}",
  review_resolved: "La fila de revisión {id} ya está resuelta",

  // routes/export.ts
  export_needs_user_key:
    "Esta acción requiere aprobación, y la aprobación requiere una clave de API vinculada a un usuario",
  export_approval_not_found: "No se encontró la solicitud de aprobación",
  export_approval_other_workspace: "La solicitud de aprobación pertenece a otro espacio de trabajo",
  export_approval_not_approved: "La solicitud de aprobación no fue aprobada",
  export_approval_expired: "La solicitud de aprobación expiró",
  // re-audit 2026-11-22 (server-sec S1)
  export_approval_wrong_trigger: "Esta aprobación no se otorgó para una exportación masiva",
  export_approval_wrong_requester:
    "Esta aprobación la pidió otro usuario; solo esa persona puede usarla",
  insufficient_scope: "Permisos insuficientes",

  // routes/forget.ts
  forget_hard_facts_only:
    "mode=hard solo se admite para hechos (DELETE /forget/fact/{idForget}?mode=hard o DELETE /facts/{idFacts}/hard); un elemento de tipo {kind} solo se puede olvidar (sin borrado definitivo, sin mode). El borrado de todos los datos de una persona (RGPD) es POST /admin/erasure.",
  forget_not_found: "No se encontró el elemento {id} (tipo: {kind})",

  // routes/admin-erasure.ts
  erasure_subject_required: "Indica exactamente uno de userId o actorId",
  erasure_not_confirmed: "confirm debe repetir el userId o actorId que se borra",
  erasure_unsupported: "Este adaptador de almacenamiento no admite el borrado criptográfico",
  erasure_nothing_to_erase: "No hay ninguna clave de cifrado activa que borrar para {kind} {id}",

  // routes/import-route.ts
  // APP-007 (audit 2026-11-22)
  approval_not_covering: "esta aprobación no cubre esta solicitud: ya se usó, venció o se otorgó para otra solicitud o usuario",
  approval_expired_resolve: "la aprobación venció",
  approval_no_longer_pending: "la aprobación ya no está pendiente",
  // APP-004 / APP-005 (audit 2026-11-22)
  bootstrap_setup_token_required:
    "Registrar la primera clave de API requiere el token de configuración que el servidor imprime en su registro al arrancar. Envíalo como setupToken en el cuerpo o en la cabecera X-Setup-Token.",
  webhook_url_invalid:
    "La URL del webhook no es una URL válida.",
  webhook_url_must_be_https:
    "La URL del webhook debe usar https (un operador puede permitir http con MNEMO_WEBHOOK_ALLOW_HTTP=true).",
  webhook_url_credentials:
    "La URL del webhook no debe llevar usuario ni contraseña.",
  webhook_url_private:
    "La URL del webhook apunta a una dirección de loopback, privada o de enlace local (un operador puede permitir receptores internos con MNEMO_WEBHOOK_ALLOW_PRIVATE=true).",
  import_too_large: "La carga es demasiado grande",
  import_bad_jsonl: "No se pudo descomprimir o analizar el cuerpo como JSONL",
  import_from_array: "Las importaciones con --from esperan un arreglo JSON",
  import_empty: "No se encontraron líneas con contenido en el cuerpo de la importación",
  import_bad_header: "La primera línea debe ser JSON válido",
  import_version: "Versión de exportación no compatible",

  // routes/recall.ts, remember.ts
  recall_personal_needs_user_key:
    "scope 'personal' requiere una clave de API vinculada a un usuario (la clave debe tener userId)",
  recall_asof_in_future: "asOf no puede estar en el futuro",
  recall_no_personal_workspace:
    "No se encontró un espacio de trabajo personal para este usuario. Registra primero un perfil de usuario.",
  remember_invalid_kind: "kind '{kind}' no válido. Debe ser uno de: {kinds}.",
  remember_subtype_empty:
    "subtype no debe estar vacío: omítelo para usar el valor predeterminado del kind.",
  remember_statement_blank: "statement debe contener texto que no sea solo espacios en blanco.",
  remember_valid_from_future: "validFrom no puede estar en el futuro.",
  remember_nul: "{field} no debe contener caracteres NUL (\\u0000).",
  remember_owner_user: "scopeOwner 'user:<id>' debe coincidir con el userId autenticado",
  remember_owner_tenant: "scopeOwner 'tenant:<id>' debe coincidir con el tenantId autenticado",
  remember_owner_workspace:
    "scopeOwner 'workspace:<id>' debe coincidir con el workspaceId de destino",
  remember_owner_prefix: "scopeOwner debe empezar con 'workspace:', 'user:' o 'tenant:'",

  // routes/self.ts
  self_storage_unavailable: "El almacenamiento no está disponible",
  self_invalid_body: "Cuerpo de solicitud no válido: action, target y reason son obligatorios.",
  self_content_required: "content es obligatorio (no vacío) para la acción '{action}'.",
  self_target_not_found: "No se encontró el destino de la autoedición",
  self_forget_unsupported:
    "memory_self_edit(action:'forget') no se admite con la política de aprobación de este espacio de trabajo: no existe un flujo de aprobación que lo resuelva. Usa memory_forget (kind: 'fact' | 'strategy'), que hace el mismo archivado bitemporal sin esperar una aprobación que nunca llegará.",

  // routes/session.ts
  session_not_found_dot: "No se encontró la sesión {id}.",
  session_not_found: "No se encontró la sesión {id}",
  session_managed_turns:
    "Las sesiones administradas deben usar la ingesta de harness para los turnos.",
  session_closed: "La sesión {id} está cerrada para escritura.",
  session_managed_collapse:
    "Las sesiones administradas deben usar el ciclo de vida de cierre administrado.",
  session_turn_not_found: "No se encontró el turno {turnId} en la sesión {id}.",
  session_turn_index_not_found: "No se encontró el índice de turno {index} en la sesión {id}.",
  session_continuity_incomplete:
    "La continuidad requiere conversación, cliente, generación y predecesora para las sucesoras",
  session_predecessor_not_found: "No se encontró la sesión predecesora",
  session_continuity_rejected: "Se rechazó la continuidad de la sesión",
  session_generation_mismatch: "La generación de la sesión no coincide",
  session_message_identity_reused: "Identidad de mensaje reutilizada",
  // provenance.ts
  traffic_origin_unauthorized: "El origen del tráfico no está autorizado para esta credencial",

  // routes/skills.ts, strategies.ts, tasks.ts, timeline.ts, webhooks.ts, workflows.ts
  skill_not_found: "No se encontró la habilidad {id}",
  skills_one_field: "debes indicar al menos un campo",
  strategy_not_found: "No se encontró la estrategia {id}",
  task_not_found: "No se encontró la tarea {id}",
  tasks_policy_no_create:
    "La política del agente prohíbe crear tareas (taskScopes.canCreate=false)",
  tasks_policy_no_delegate: "La política del agente prohíbe delegar (taskScopes.canDelegate=false)",
  tasks_delegate_target:
    "La política no permite el destino de la delegación (taskScopes.canDelegateTo)",
  tasks_state_not_delegable: "Una tarea en estado '{status}' no se puede delegar",
  timeline_bad_cursor: "cursor no es un cursor de línea de tiempo válido",
  webhook_not_found: "No se encontró el webhook {id}",
  workflow_not_found: "No se encontró el flujo de trabajo {id}",

  // r2/server-core (audit 2026-11-22): errors.ts 22P02, routes/recall.ts kinds
  invalid_input_syntax:
    "Un valor de la solicitud no tiene el formato de su campo (por ejemplo, un id que no es un UUID).",
  recall_unknown_kind: "Tipo desconocido '{kind}' en kinds. Tipos válidos: {valid}.",

  // middleware/rbac.ts, middleware/region.ts (HttpError subclasses outside errors.ts)
  rbac_missing_scope: "Falta el permiso requerido: {scope}",
  wrong_region:
    "El espacio de trabajo está bloqueado en la región '{workspaceRegion}'. Esta instancia atiende '{envRegion}'.",
};
