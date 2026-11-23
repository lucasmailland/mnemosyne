# Mnemosyne API Error Reference

**English** · [Español](errors.es.md)

**Spec §35 lines 4301–4315**

All API errors return JSON with the shape:

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

- `type` — Stripe-style error category (see table below). Stable; use for branching logic.
- `code` — Fine-grained machine-readable code, snake_case. Stable.
- `message` — Human-readable explanation, localized (see [Language](#language)). May change; do not parse.
- `param` — _(400 only)_ The request field that caused the error.
- `details` — _(optional)_ Structured context (e.g. validation errors).
- `request_id` — Trace ID for support tickets.

---

## Language

`error.message` (and the top-level `message` of flat error bodies) is localized for 4xx/5xx JSON responses. Supported: `en-US` (default) and `es-419`. The server picks the language from:

1. The `mnemo_locale` cookie, if set to a supported value.
2. The `Accept-Language` header (any `es*` tag maps to `es-419`).
3. `en-US`.

Every non-HEAD 4xx/5xx JSON response carries `Content-Language` and `Vary: Accept-Language, Cookie`, English too. `Content-Language` names the language the message is actually in: `es-419` only when the message was translated; a message with no Spanish translation stays in English and says `en-US`. Bodies over 64 KiB are not translated.

Only `message` is translated. `type`, `code`, `param`, `details` and `request_id` are the same in every language: branch on `code`, never on `message`.

---

## Error Types

| `type`                  | HTTP status | Meaning                                                                         |
| ----------------------- | ----------- | ------------------------------------------------------------------------------- |
| `invalid_request_error` | 400, 422    | Malformed request — fix the input                                               |
| `authentication_error`  | 401         | Missing or invalid API key                                                      |
| `permission_error`      | 403         | Authenticated but not authorized (wrong scope, region lock, test/prod mismatch) |
| `not_found_error`       | 404         | The resource does not exist                                                     |
| `conflict_error`        | 409         | Concurrent modification conflict                                                |
| `rate_limit_error`      | 429         | Rate limit exceeded                                                             |
| `api_error`             | 5xx         | Server-side failure — retry with backoff                                        |

---

## Error Codes Reference

### `bad_request` {#bad_request}

**Type:** `invalid_request_error` | **Status:** 400

The request body is malformed or missing required fields.

- **Cause:** Missing `statement` in `POST /remember`, or invalid JSON.
- **Fix:** Check the `param` field (e.g. `"param": "statement"`) to identify the offending field.
- **Example:**
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

**Type:** `invalid_request_error` | **Status:** 422

The request is well-formed but semantically invalid (e.g. embedding dimension mismatch).

### `unauthorized` {#unauthorized}

**Type:** `authentication_error` | **Status:** 401

No API key was provided, or the `Authorization: Bearer` header is missing.

- **Fix:** Provide `Authorization: Bearer msk_...` or `Authorization: Bearer mk_live_...`.

### `forbidden` {#forbidden}

**Type:** `permission_error` | **Status:** 403

The API key does not have the required scope, or a workspace/region binding was violated.

Subcases:

- **Scope not granted** — key lacks the required scope (e.g. `memory:write` for write operations).
- **Region lock** — workspace is homed in a different region; see `details.homeRegion`.
- **Test/prod mismatch** — `mk_test_` key used against a production workspace (or vice versa).
- **Wrong region** — `MNEMO_REGION` mismatch.

### `wrong_region` {#wrong_region}

**Type:** `permission_error` | **Status:** 403

The workspace is homed in a different region.

- **Details:** `{ "homeRegion": "eu-west-1" }`
- **Fix:** Re-route the request to the workspace's home region.

### `not_found` {#not_found}

**Type:** `not_found_error` | **Status:** 404

The requested resource (fact, entity, session, task, etc.) does not exist or was deleted.

### `conflict` {#conflict}

**Type:** `conflict_error` | **Status:** 409

A concurrent write conflict occurred (e.g. two updates to the same fact simultaneously).

- **Fix:** Re-fetch the resource and retry.

### `rate_limited` {#rate_limited}

**Type:** `rate_limit_error` | **Status:** 429

The workspace's recall/write quota was exceeded.

- **Details:** Check `X-RateLimit-Remaining` header.
- **Fix:** Implement exponential backoff. Consider upgrading the plan.

### `internal_error` {#internal_error}

**Type:** `api_error` | **Status:** 500

An unexpected server-side error occurred.

- **Fix:** Retry with exponential backoff (max 3 retries). If persistent, contact support with the `request_id`.

### `service_unavailable` {#service_unavailable}

**Type:** `api_error` | **Status:** 503

The server is temporarily unable to handle the request (overload or maintenance).

- **Fix:** Retry after the `Retry-After` header value (seconds).

### `not_implemented` {#not_implemented}

**Type:** `api_error` | **Status:** 501

The endpoint exists but the feature is not yet implemented in this deployment.

---

## Retry Strategy

| Type                    | Retry? | Notes                                  |
| ----------------------- | ------ | -------------------------------------- |
| `invalid_request_error` | No     | Fix the request first                  |
| `authentication_error`  | No     | Check your API key                     |
| `permission_error`      | No     | Check scopes + region                  |
| `not_found_error`       | No     | Resource does not exist                |
| `conflict_error`        | Yes    | Re-fetch + retry                       |
| `rate_limit_error`      | Yes    | Exponential backoff from `Retry-After` |
| `api_error` (5xx)       | Yes    | Exponential backoff, max 3 retries     |

---

_Last updated: Wave AB — spec §35 lines 4301–4315_
