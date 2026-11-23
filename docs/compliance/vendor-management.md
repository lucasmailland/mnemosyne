# Vendor Management

**Spec §35 lines 4363–4368**

**PENDING HUMAN OWNER**: Legal/DPO must execute vendor DPAs and maintain this registry.

---

## Sub-Processor Registry

All vendors that process customer personal data (per GDPR Art. 28).

| Vendor | Service | Data Processed | DPA Status | Last Review | Notes |
|---|---|---|---|---|---|
| Neon / AWS RDS | Primary database hosting | All customer memory data, PII | **PENDING** | — | Core data store; DPA required before production |
| Upstash / Redis Cloud | Cache / hot tier | Session working memory, hot-tier keys | **PENDING** | — | May contain PII in session context |
| OpenAI | LLM inference + embeddings | Memory content (for embedding) | PENDING | — | Review data retention policy; use Zero Data Retention (ZDR) option |
| Cohere | Alternative LLM/embedding | Memory content | PENDING | — | Same as OpenAI |
| Fly.io / Railway | Container hosting (app tier) | Network traffic; logs | PENDING | — | May process IP addresses (personal data) |
| GitHub | Source control + CI/CD | Source code, CI logs | PENDING | — | GitHub DPA available; execute standard form |
| Datadog / Grafana Cloud | Observability | System metrics, logs (may contain PII if logged) | PENDING | — | Ensure PII scrubbing in logging pipeline |
| PagerDuty | On-call alerting | Email/phone of on-call engineers | PENDING | — | Personnel data; DPA with PagerDuty |
| Stripe / Paddle | Billing | Customer payment + contact data | PENDING | — | PCI-DSS + DPA required |

---

## Annual Review Cadence

1. Q4 each year: review all sub-processors
2. Check for new sub-processors added during the year (any new 3rd-party API calls)
3. Verify DPA currency (renew if expired or vendor terms changed)
4. Remove sub-processors no longer in use

---

## DPA Checklist (per vendor)

- [ ] DPA document signed and filed in legal vault
- [ ] Standard Contractual Clauses (SCCs) executed if vendor is outside EU
- [ ] Transfer Impact Assessment (TIA) completed for restricted-sensitivity data
- [ ] Data processing location confirmed (must match workspace's home region for restricted data)
- [ ] Breach notification SLA: vendor must notify within 24 hours of becoming aware

---

## AI/LLM Data Governance

For OpenAI and Cohere:
- **Zero Data Retention (ZDR)**: Ensure ZDR option is active — input/output not retained for training
- **Embedding only mode**: Where possible, send embeddings (not plaintext) to reduce PII exposure
- **Prompt scrubbing**: The LLM router scrubs PII markers before sending content (see `packages/core/src/v3/` governance layer)

**PENDING HUMAN OWNER**: Legal must confirm LLM vendor agreements include ZDR and appropriate DPA terms.
