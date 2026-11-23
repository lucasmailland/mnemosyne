// Schema namespace — all v3 tables live in mnemosyne.* (not public.*)
export { mnemoSchema } from "./mnemo_schema.js";

// Custom Drizzle types (halfvec, tsvector, inet, bytea)
export * from "./_custom-types.js";

// Core primitive tables
export * from "./facts.js";
export * from "./decisions.js";
export * from "./episodes.js";
export * from "./entities.js";
export * from "./strategies.js";
export * from "./workflows.js";
export * from "./skills.js";
export * from "./tasks.js";
export * from "./events.js";
export * from "./reasoning.js";

// Relationship tables
export * from "./relations.js";

// Session & recall tables
export * from "./sessions.js";
export * from "./harness.js";

// Audit
export * from "./audit.js";

// Transactional outbox & deletion log
export * from "./outbox.js";

// Supporting tables (§2.11)
export * from "./supporting.js";

// Infrastructure tables (§4)
export * from "./infrastructure.js";

// Federation sync-state tables (migration 0011)
export * from "./sync.js";

// Compositionality tables (Wave E — migration 0014/0015)
export * from "./compositionality.js";

// Agent profile (Wave M2 — migration 0026)
export * from "./agent_profile.js";

// Idempotency keys (Wave T1 — migration 0035)
export * from "./idempotency.js";

// §6 Scoped API keys (additive; separate from the live mnemo_api_keys scheme)
export * from "./scoped-api-keys.js";

// Multi-tenant: tenant, user, workspace membership (migration 0008)
export * from "./tenants.js";

// Multi-model vector space architecture (B4.1-B4.5)
export * from "./vector_space.js";
