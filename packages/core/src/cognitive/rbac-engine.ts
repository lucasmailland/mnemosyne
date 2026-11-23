import type { AgentMemoryAccess, ApprovalTrigger, SpecScope } from "@mnemo-ai/types";

export type AccessPolicy = AgentMemoryAccess & { namespaces?: string[] };

export interface AccessRequest {
  scope: SpecScope;
  action: "read" | "write";
  trigger?: ApprovalTrigger;
  namespace?: string;
  federation?: boolean;
}

export type AccessDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "approval_required"; trigger: ApprovalTrigger };

function matchesNamespace(ns: string, allow: string[]): boolean {
  return allow.some((p) =>
    p.endsWith("*") ? ns.startsWith(p.slice(0, -1)) : ns === p,
  );
}

export function evaluateAccess(policy: AccessPolicy, req: AccessRequest): AccessDecision {
  const granted = req.action === "read" ? policy.readScopes : policy.writeScopes;
  if (!granted.includes(req.scope)) {
    return { decision: "deny", reason: `scope '${req.scope}' not granted for ${req.action}` };
  }

  if (policy.namespaces && policy.namespaces.length > 0 && req.namespace !== undefined) {
    if (!matchesNamespace(req.namespace, policy.namespaces)) {
      return { decision: "deny", reason: `namespace '${req.namespace}' outside policy allow-list` };
    }
  }

  if (req.federation) {
    const need = req.action === "write" ? "read_write" : "read";
    const have = policy.federationAccess;
    const ok = have === "read_write" || (need === "read" && have === "read");
    if (!ok) return { decision: "deny", reason: `federationAccess '${have}' insufficient` };
  }

  if (req.trigger && policy.requireApprovalFor.includes(req.trigger)) {
    return { decision: "approval_required", trigger: req.trigger };
  }

  return { decision: "allow" };
}
