const QUERIES = [
  "What did we decide about the pricing tiers?",
  "How does the session collapse pipeline work?",
  "What are the database connection pool settings?",
  "Explain the RLS row-level security model",
  "What is the hot-tier eviction policy?",
  "What LLM providers does Mnemosyne support?",
  "How does the HNSW vector index work?",
  "What is the worth decay formula?",
  "How are facts deduplicated?",
  "What is the federation consensus mechanism?",
  "How does the anticipation engine score predictions?",
  "What are the migration gap rules?",
];

const TOPICS = [
  "infra/pg", "infra/redis", "api/auth", "ml/embeddings",
  "ops/deploy", "core/worth", "core/collapse", "core/recall",
];

const TAGS = ["important", "verified", "provisional", "archived"];

export function randomQuery() {
  return QUERIES[Math.floor(Math.random() * QUERIES.length)];
}

export function randomStatement() {
  const nouns = ["The system", "Mnemosyne", "The API", "The database", "The cache"];
  const verbs = ["uses", "supports", "requires", "implements", "provides"];
  const objects = [
    "connection pooling with 20 max connections",
    "exponential backoff for retries",
    "JWT-based authentication",
    "vector similarity search via HNSW",
    "row-level security on all tables",
    `${Math.floor(Math.random() * 100) + 1} concurrent agents`,
  ];
  return `${nouns[Math.floor(Math.random() * nouns.length)]} ${verbs[Math.floor(Math.random() * verbs.length)]} ${objects[Math.floor(Math.random() * objects.length)]}.`;
}

export function randomTopic() {
  return TOPICS[Math.floor(Math.random() * TOPICS.length)];
}

export function randomTag() {
  return TAGS[Math.floor(Math.random() * TAGS.length)];
}
