# Referencia de errores de la API de Mnemosyne

[English](errors.md) · **Español**

**Spec §35 líneas 4301–4315**

Todos los errores de la API devuelven JSON con esta forma:

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "bad_request",
    "message": "Human-readable description",
    "param": "fieldName",
    "details": {},
    "request_id": "req_01abc..."
  }
}
```

- `type`: categoría del error al estilo de Stripe (consulta la tabla de abajo). Estable; úsala para ramificar la lógica.
- `code`: código fino legible por máquinas, en snake_case. Estable.
- `message`: explicación legible por personas, localizada (consulta [Idioma](#idioma)). Puede cambiar; no la analices.
- `param`: _(solo 400)_ el campo de la solicitud que causó el error.
- `details`: _(opcional)_ contexto estructurado (por ejemplo, errores de validación).
- `request_id`: ID de traza para los tickets de soporte.

---

## Idioma

`error.message` (y el `message` de nivel superior de los cuerpos de error planos) se localiza en las respuestas JSON 4xx/5xx. Idiomas admitidos: `en-US` (por defecto) y `es-419`. El servidor elige el idioma a partir de:

1. La cookie `mnemo_locale`, si tiene un valor admitido.
2. El encabezado `Accept-Language` (cualquier etiqueta `es*` se asigna a `es-419`).
3. `en-US`.

Toda respuesta JSON 4xx/5xx que no sea HEAD lleva `Content-Language` y `Vary: Accept-Language, Cookie`, también en inglés. `Content-Language` indica el idioma en el que realmente está el mensaje: `es-419` solo cuando el mensaje se tradujo; un mensaje sin traducción al español se queda en inglés y dice `en-US`. Los cuerpos de más de 64 KiB no se traducen.

Solo se traduce `message`. `type`, `code`, `param`, `details` y `request_id` son iguales en todos los idiomas: ramifica según `code`, nunca según `message`.

---

## Tipos de error

| `type`                  | Estado HTTP | Significado                                                                                                                |
| ----------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `invalid_request_error` | 400, 422    | Solicitud mal formada: corrige la entrada                                                                                  |
| `authentication_error`  | 401         | Falta la clave de API o no es válida                                                                                       |
| `permission_error`      | 403         | Autenticado pero sin autorización (permisos incorrectos, bloqueo de región, clave de prueba/producción que no corresponde) |
| `not_found_error`       | 404         | El recurso no existe                                                                                                       |
| `conflict_error`        | 409         | Conflicto de modificación concurrente                                                                                      |
| `rate_limit_error`      | 429         | Se superó el límite de tasa                                                                                                |
| `api_error`             | 5xx         | Falla del lado del servidor: reintenta con espera creciente                                                                |

---

## Referencia de códigos de error

### `bad_request` {#bad_request}

**Tipo:** `invalid_request_error` | **Estado:** 400

El cuerpo de la solicitud está mal formado o le faltan campos obligatorios.

- **Causa:** falta `statement` en `POST /remember`, o el JSON no es válido.
- **Solución:** revisa el campo `param` (por ejemplo, `"param": "statement"`) para identificar el campo con el problema.
- **Ejemplo:**
  ```json
  {
    "error": {
      "type": "invalid_request_error",
      "code": "bad_request",
      "message": "statement is required",
      "param": "statement"
    }
  }
  ```

### `unprocessable_entity` {#unprocessable_entity}

**Tipo:** `invalid_request_error` | **Estado:** 422

La solicitud está bien formada pero es semánticamente inválida (por ejemplo, la dimensión del embedding no coincide).

### `unauthorized` {#unauthorized}

**Tipo:** `authentication_error` | **Estado:** 401

No se envió ninguna clave de API, o falta el encabezado `Authorization: Bearer`.

- **Solución:** envía `Authorization: Bearer msk_...` o `Authorization: Bearer mk_live_...`.

### `forbidden` {#forbidden}

**Tipo:** `permission_error` | **Estado:** 403

La clave de API no tiene los permisos necesarios, o se violó un vínculo con un espacio de trabajo o una región.

Subcasos:

- **Permisos no concedidos**: a la clave le falta el permiso requerido (por ejemplo, `memory:write` para las operaciones de escritura).
- **Bloqueo de región**: el espacio de trabajo tiene su sede en otra región; consulta `details.homeRegion`.
- **Prueba/producción que no corresponde**: se usó una clave `mk_test_` contra un espacio de trabajo de producción (o al revés).
- **Región incorrecta**: `MNEMO_REGION` no coincide.

### `wrong_region` {#wrong_region}

**Tipo:** `permission_error` | **Estado:** 403

El espacio de trabajo tiene su sede en otra región.

- **Detalles:** `{ "homeRegion": "eu-west-1" }`
- **Solución:** redirige la solicitud a la región sede del espacio de trabajo.

### `not_found` {#not_found}

**Tipo:** `not_found_error` | **Estado:** 404

El recurso solicitado (hecho, entidad, sesión, tarea, etc.) no existe o fue eliminado.

### `conflict` {#conflict}

**Tipo:** `conflict_error` | **Estado:** 409

Ocurrió un conflicto de escritura concurrente (por ejemplo, dos actualizaciones simultáneas del mismo hecho).

- **Solución:** vuelve a obtener el recurso y reintenta.

### `rate_limited` {#rate_limited}

**Tipo:** `rate_limit_error` | **Estado:** 429

Se superó la cuota de recuperación o escritura del espacio de trabajo.

- **Detalles:** revisa el encabezado `X-RateLimit-Remaining`.
- **Solución:** implementa una espera exponencial. Considera mejorar el plan.

### `internal_error` {#internal_error}

**Tipo:** `api_error` | **Estado:** 500

Ocurrió un error inesperado del lado del servidor.

- **Solución:** reintenta con espera exponencial (máximo 3 reintentos). Si persiste, contacta a soporte con el `request_id`.

### `service_unavailable` {#service_unavailable}

**Tipo:** `api_error` | **Estado:** 503

El servidor no puede atender la solicitud temporalmente (sobrecarga o mantenimiento).

- **Solución:** reintenta después del valor del encabezado `Retry-After` (en segundos).

### `not_implemented` {#not_implemented}

**Tipo:** `api_error` | **Estado:** 501

El endpoint existe pero la funcionalidad todavía no está implementada en este despliegue.

---

## Estrategia de reintento

| Tipo                    | ¿Reintentar? | Notas                                        |
| ----------------------- | ------------ | -------------------------------------------- |
| `invalid_request_error` | No           | Primero corrige la solicitud                 |
| `authentication_error`  | No           | Revisa tu clave de API                       |
| `permission_error`      | No           | Revisa los permisos y la región              |
| `not_found_error`       | No           | El recurso no existe                         |
| `conflict_error`        | Sí           | Vuelve a obtener y reintenta                 |
| `rate_limit_error`      | Sí           | Espera exponencial a partir de `Retry-After` |
| `api_error` (5xx)       | Sí           | Espera exponencial, máximo 3 reintentos      |

---

_Última actualización: Wave AB — spec §35 líneas 4301–4315_
