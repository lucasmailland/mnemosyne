import { serverRequest } from "./support";

/**
 * The palace's data, written through the server API with the e2e API key into
 * the shared E2E Team workspace, so the gate specs (layout, a11y, motion) and
 * palace.spec measure the five rooms WITH memories in them. The empty states
 * are measured in another workspace that holds nothing (support.ts,
 * EMPTY_SESSION_FILE).
 *
 * Once per run, not idempotent: global-setup runs it once and refuses a stack
 * that is already bootstrapped. The facts and decisions carry a topicKey (a
 * repeat write would update them in place), but the episode, the entities and
 * the relations have none, so a second run would duplicate them.
 */
export interface PalaceSeed {
  /** The fact that was true in Lisbon and was closed when Porto replaced it. */
  supersededFactId: string;
  supersededStatement: string;
  /** The fact that replaced it. */
  currentFactId: string;
  currentStatement: string;
  episodeId: string;
  episodeTitle: string;
  /** A fact the episode produced. */
  producedStatement: string;
  /** Titles of the decision that was superseded and of the one that replaced it. */
  oldDecisionTitle: string;
  newDecisionTitle: string;
  /** The two statements that disagree (an open conflict pair). */
  conflictStatements: [string, string];
  /** A phrase every seeded fact answers to in a recall. */
  recallQuery: string;
  /** Entity names on the constellation. */
  entityNames: string[];
  /** The UTC day the seed ran: "superseded today" only holds while it is still that day. */
  seededOn: string;
}

type Json = Record<string, unknown>;

function call(
  key: string,
  method: string,
  path: string,
  body?: unknown,
  ok: number[] = [200, 201]
) {
  const res = serverRequest(key, method, path, body);
  if (!ok.includes(res.status))
    throw new Error(`seed: ${method} ${path} answered ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as Json;
}

const idOf = (body: Json, what: string): string => {
  const id = body["id"];
  if (typeof id !== "string")
    throw new Error(`seed: ${what} returned no id: ${JSON.stringify(body)}`);
  return id;
};

export function seedPalace(key: string): PalaceSeed {
  const remember = (body: Json, what: string) => idOf(call(key, "POST", "/remember", body), what);
  const relate = (
    source: [string, string],
    target: [string, string],
    relation: string,
    confidence: number
  ) =>
    call(key, "POST", "/relations", {
      sourceKind: source[0],
      sourceId: source[1],
      targetKind: target[0],
      targetId: target[1],
      relation,
      confidence,
      markedByKind: "user",
    });

  // Two facts of the episode, written first: an episode links facts by id.
  const replyStatement = "Support replies go out within one business day.";
  const replyFactId = remember(
    {
      statement: replyStatement,
      topicKey: "e2e/support-replies",
      tags: ["support"],
      subtype: "policy",
    },
    "support fact"
  );
  const deployFactId = remember(
    {
      statement: "The deploy window for the billing service is Tuesday morning.",
      topicKey: "e2e/deploy-window",
      tags: ["billing", "deploys"],
      subtype: "process",
    },
    "deploy fact"
  );

  const episodeTitle = "Billing office review";
  const episodeId = idOf(
    call(key, "POST", "/episodes", {
      title: episodeTitle,
      narrative:
        "The team reviewed which office owns billing, moved it to Porto, and fixed the support and deploy windows that follow from it.",
      participants: ["Ana Ferreira", "Marco Silva"],
      topics: ["billing", "offices", "support"],
      durationMinutes: 25,
      linkedFactIds: [replyFactId, deployFactId],
    }),
    "episode"
  );

  // A fact that was true, then replaced: a second write under the same topicKey
  // closes the first and links the two (the new row inherits the episode), which
  // is what the catalog's two clocks and provenance chain are drawn from.
  const supersededStatement = "The Lisbon office handles all billing for the team.";
  const currentStatement = "Since March the Porto office handles all billing for the team.";
  const supersededFactId = remember(
    {
      statement: supersededStatement,
      topicKey: "e2e/billing-office",
      tags: ["billing", "offices"],
      episodeId,
    },
    "superseded fact"
  );
  const currentFactId = remember(
    { statement: currentStatement, topicKey: "e2e/billing-office", tags: ["billing", "offices"] },
    "current fact"
  );

  // A decision, then its replacement: decision events on the timeline.
  const oldDecisionTitle = "Keep the ledger in PostgreSQL";
  const newDecisionTitle = "Move the ledger to CockroachDB";
  const oldDecisionId = remember(
    {
      kind: "decision",
      subtype: "architecture",
      title: oldDecisionTitle,
      statement: "The billing ledger stays in PostgreSQL with one primary and two replicas.",
      topicKey: "e2e/ledger-store-old",
    },
    "old decision"
  );
  const newDecisionId = remember(
    {
      kind: "decision",
      subtype: "architecture",
      title: newDecisionTitle,
      statement: "The billing ledger moves to CockroachDB so that every region can write.",
      topicKey: "e2e/ledger-store",
    },
    "new decision"
  );
  call(key, "PATCH", `/decisions/${oldDecisionId}`, { supersededById: newDecisionId });

  // An open conflict pair: two facts that cannot both hold.
  const conflictStatements: [string, string] = [
    "The staging database is rebuilt from production every night.",
    "The staging database is never rebuilt from production automatically.",
  ];
  const conflictA = remember(
    { statement: conflictStatements[0], topicKey: "e2e/staging-rebuild-a", tags: ["staging"] },
    "conflict fact A"
  );
  const conflictB = remember(
    { statement: conflictStatements[1], topicKey: "e2e/staging-rebuild-b", tags: ["staging"] },
    "conflict fact B"
  );
  call(key, "POST", "/relations", {
    sourceKind: "fact",
    sourceId: conflictA,
    targetKind: "fact",
    targetId: conflictB,
    relation: "conflicts_with",
    confidence: 0.82,
    judgmentStatus: "pending",
    markedByKind: "agent",
  });

  // Entities and the relations between them: the constellation.
  const entityNames = ["Acme Corp", "Porto office", "Billing service", "Ana Ferreira"];
  const [acme, porto, billing, ana] = [
    ["Acme Corp", "organization"],
    ["Porto office", "place"],
    ["Billing service", "project"],
    ["Ana Ferreira", "person"],
  ].map(([name, subtype]) =>
    remember(
      {
        kind: "entity",
        subtype,
        subject: name,
        statement: `${name} appears in the billing office review.`,
      },
      `entity ${name}`
    )
  ) as [string, string, string, string];
  relate(["entity", acme], ["entity", billing], "related", 0.9);
  relate(["entity", porto], ["entity", billing], "part_of", 0.8);
  relate(["entity", ana], ["entity", porto], "member_of", 0.7);
  relate(["entity", ana], ["entity", acme], "related", 0.6);
  relate(["decision", newDecisionId], ["entity", billing], "related", 0.85);
  relate(["episode", episodeId], ["entity", ana], "related", 0.75);

  return {
    supersededFactId,
    supersededStatement,
    currentFactId,
    currentStatement,
    episodeId,
    episodeTitle,
    producedStatement: replyStatement,
    oldDecisionTitle,
    newDecisionTitle,
    conflictStatements,
    recallQuery: "billing office",
    entityNames,
    seededOn: new Date().toISOString().slice(0, 10),
  };
}
