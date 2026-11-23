# @mnemo-ai/federation

[English](README.md) · **Español**

> **Puntero para IA:** federación de recuerdos entre instancias: descubrimiento de pares, votación de recuperación federada y agregación ponderada por confianza.
>
> **Depende de:** @mnemo-ai/types, @mnemo-ai/core
>
> **Expone:** SyncEngine, MtlsAuthAdapter; 9 rutas HTTP de federación (montadas en el servidor)
>
> **Estado:** BETA — SyncEngine + 9 rutas HTTP conectadas (/resolve con LWW en vivo); todos los transportes implementados
>
> **Ver también:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [docs/architecture/FEDERATION.md](../../docs/architecture/FEDERATION.md)

Capa de sincronización entre pares firmada con Ed25519 para compartir recuerdos a través de los límites
de un espacio de trabajo o entre varias instancias de Mnemosyne en un despliegue distribuido.

---

## Qué hace

La federación permite que dos instancias de Mnemosyne, que se ejecutan en organizaciones,
regiones o dominios de seguridad distintos, compartan recuerdos seleccionados con atribución
criptográfica y una puntuación acotada por la confianza.

Un recuerdo federado llega con `attribution: 'federation_received'` y una puntuación
de confianza limitada a 20, sin importar la confianza interna del par de origen.
Esto evita que un par comprometido o malicioso inyecte hechos de alta confianza.

---

## Posición en la arquitectura

```
Instance A (local)         Instance B (remote peer)
  @mnemo-ai/federation  ←───Ed25519-signed payload───  @mnemo-ai/federation
       ↓
  @mnemo-ai/core  (StorageAdapter, VectorAdapter)
```

La federación es una responsabilidad separada del almacenamiento. El motor de sincronización se coordina
con los puertos del núcleo, pero no los esquiva: los hechos federados pasan por la
misma interfaz `StorageAdapter` que los hechos creados localmente.

---

## Estado de la implementación

| Componente                          | Estado    | Notas                                                                                                                     |
| ----------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------- |
| Definiciones de tipos de federación | Listo     | En `@mnemo-ai/types`                                                                                                      |
| Clase `SyncEngine`                  | **Listo** | Implementada y conectada al arrancar el servidor                                                                          |
| `MtlsAuthAdapter`                   | **Listo** | Autenticación de pares con mTLS implementada                                                                              |
| Rutas HTTP                          | **Listo** | 10 rutas montadas mediante `mountFederation` en `routes/federation.ts`                                                    |
| Almacén de pares                    | **Listo** | `DrizzlePeerStore` (Postgres, migración 0061); alta con `POST /memory/federation/peers`                                   |
| Resolución de conflictos LWW        | **Listo** | `POST /memory/federation/resolve` en vivo (gana la última escritura)                                                      |
| Protocolo de lápidas (tombstones)   | **Listo** | `/items` sirve un hecho olvidado, fusionado o borrado en duro como lápida; quien extrae archiva su copia                  |
| Guarda de resurrección              | **Listo** | Un `remoteId` con lápida nunca vuelve a insertarse (`SyncEngine`)                                                         |
| Transporte de extracción (pull)     | **Listo** | `pullFromPeer` se llama en `routes/federation.ts`; ciclo de sincronización completo con verificación Ed25519 implementado |
| Conectado al servidor en vivo       | **Listo** | `deps.federation` conectado al arrancar el servidor                                                                       |

---

## Modelo de seguridad

**La confianza en los pares es solo configuración LOCAL.** Los pesos de confianza nunca se aceptan de
las cargas de sincronización entrantes: un par no puede declarar su propio nivel de confianza. Es una
invariante de seguridad central.

Un operador da de alta cada par con una clave que tenga `federation:admin`; es
la única forma de crear un par (un ANNOUNCE de rotación de clave nunca crea uno).
El servidor guarda los pares en `mnemo_federation_peer` (migración 0061), o en
memoria cuando corre sin el adaptador de Postgres.

```bash
curl -X POST "$MNEMO_URL/memory/federation/peers" \
  -H "Authorization: Bearer $MNEMO_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{
    "peerId": "acme.example",
    "pinnedCertDer": "<base64 DER>",
    "trustWeight": 0.6,
    "url": "https://acme.example",
    "apiKey": "<key this server sends when pulling>"
  }'
```

`trustWeight` (de 0 a 1) es una decisión LOCAL; se ignora si el par envía el suyo.
`enabled` vale true por defecto; `signingPublicKey` (PEM) y `symmetricKey` (32
bytes en base64) van juntos y activan la extracción firmada y sellada. Un campo
desconocido responde 400 y un `peerId` que ya existe responde 409.

`apiKey` y `symmetricKey` se guardan cifrados con el anillo de claves de
`MNEMO_MASTER_KEY` (sin clave maestra, solo en desarrollo, se guardan tal cual), y
ninguna respuesta, entrada de auditoría ni línea de registro los lleva:
`GET /memory/federation/peers` muestra `hasApiKey`, `hasSymmetricKey` y la
`certFingerprint` del pin en su lugar.

### Extraer entre dos servidores

Cada servidor tiene una sola identidad de federación:

- `MNEMO_FED_PEER_ID`: el id con que los demás servidores lo registran (por
  ejemplo `acme.example`). Es el `iss` de cada JWT de servicio que firma y el
  `aud` que acepta (`MNEMO_FED_AUDIENCE` reemplaza este último).
- `MNEMO_FEDERATION_PRIVATE_KEY`: su clave privada Ed25519, en PEM. Los pares
  fijan la clave pública correspondiente (SPKI DER, base64) como `pinnedCertDer`.

Para que Larkspur (`larkspur.example`) extraiga de Acme (`acme.example`):

1. En Acme, `POST /admin/keys` con `"federation": true` y
   `"scopes": ["memory:federation"]` devuelve una clave `mk_fed_`. Entrégala a Larkspur.
2. En Acme, registra a Larkspur: su id y su clave pública.
3. En Larkspur, registra a Acme: su id, su clave pública, `url` y la clave
   `mk_fed_` como `apiKey`.
4. En Larkspur, `POST /memory/federation/sync` con `{"peerId": "acme.example"}`
   y una clave local con `memory:federation` (la clave `mk_fed_` de un par se
   rechaza: un par no puede hacerte extraer). Consulta
   `GET /memory/federation/sync/{jobId}`; los elementos llegan al espacio de
   trabajo de quien la llamó. Una sincronización lee todas las páginas que el
   par tiene después del cursor que guardó la anterior con ese par, así que las
   ediciones llegan como versiones nuevas y los hechos olvidados o borrados como lápidas.
   El trabajo se guarda en Postgres (migración 0063), así que un reinicio no lo
   pierde; uno que un reinicio cortó se ve como `failed`.

Cada extracción lleva la clave `mk_fed_` en `Authorization`, más
`x-mnemo-peer-id`, `x-mnemo-client-cert` (la clave pública de quien extrae) y
`x-mnemo-service-jwt`, un JWT EdDSA para ese único servidor (`aud` = su id, `jti`
nuevo, 60 segundos). Acme verifica la clase de la clave, el pin y la firma del
JWT con la clave fijada, que es la prueba de posesión, y luego el emisor, la
audiencia, el vencimiento y la repetición. Ningún encabezado vale por sí solo.

Transporte: el servidor que responde exige TLS 1.3, que conoce por su propio
socket TLS o, con `MNEMO_FED_TLS_PROXY=true`, por `x-mnemo-tls-protocol`, que
pone el proxy que termina TLS delante de él. Ese proxy debe sobrescribir
`x-mnemo-tls-protocol` (nginx: `$ssl_protocol`) en cada petición y descartar la
copia que mande el cliente; con mTLS también puede sobrescribir
`x-mnemo-client-cert` con el certificado de cliente verificado (nginx:
`$ssl_client_escaped_cert`), cuya clave pública debe ser la clave fijada del
par. Define `MNEMO_TRUSTED_PROXY_IP` con la dirección desde la que se conecta el
proxy, para que un cliente que llega directo al servidor no pueda escribir esos
encabezados por su cuenta. En `docs/architecture/MTLS_BOUNDARY.md` hay una
configuración de nginx que funciona. `MNEMO_FED_INSECURE_TRANSPORT=true`
acepta HTTP sin cifrar para desarrollo; el servidor no arranca con él en
producción.

Cuando Larkspur extrae de un Acme cuyo proxy exige certificado de cliente,
Larkspur presenta uno: `MNEMO_FED_CLIENT_CERT_FILE` y
`MNEMO_FED_CLIENT_KEY_FILE` (archivos PEM; el certificado se emite para la
clave de federación de Larkspur, así que su clave pública es la que Acme
fijó). `MNEMO_FED_CA_FILE`, opcional, verifica el certificado TLS de Acme con
una CA propia en lugar de las raíces del sistema. Sin ellas, las extracciones
salen sin certificado de cliente, como antes; un certificado sin su clave o un
archivo que no se puede leer impiden que el servidor arranque.

Todas las cargas de sincronización se firman con Ed25519. Una carga con una firma
inválida o ausente se rechaza antes de escribir ningún dato.

---

## Conceptos clave

### Límite de atribución

Todos los elementos federados se almacenan con:

```
attribution: 'federation_received'
trustScore: 20   // hard cap — never higher, regardless of peer's local score
```

Esto garantiza que los hechos federados se distingan de los de origen local y
que no puedan superarlos al recuperar sin una promoción explícita de un administrador local.

### Protocolo de lápidas (tombstones)

Cuando un hecho se elimina localmente, se propaga una lápida a los pares. Los pares
que tienen una copia del hecho lo marcan como con lápida en lugar de eliminarlo
de inmediato, lo que preserva las pistas de auditoría.

### Guarda de resurrección

Un hecho con lápida no puede volver a crearse por una sincronización entrante del
par de origen. La guarda consulta el registro de lápidas antes de aceptar cualquier upsert.

### Guarda de versión

Los elementos de sincronización entrantes se rechazan si:

```
incoming.version > local.version + 100
```

Esto evita los ataques de manipulación de números de versión, en los que un par inunda con números
de versión falsos para forzar la sobrescritura de hechos locales.

---

## Cuándo usar la federación

- Despliegues con varias instancias donde dos instalaciones de Mnemosyne necesitan compartir
  recuerdos (p. ej., dos filiales de una organización)
- Colaboración entre espacios de trabajo con límites de confianza explícitos
- Topologías de recuperación ante desastres donde una instancia en espera replica a una principal

**No** uses la federación para el aislamiento multi-tenant de una sola instancia: eso lo
gestiona la seguridad a nivel de fila en `@mnemo-ai/adapter-postgres`.
