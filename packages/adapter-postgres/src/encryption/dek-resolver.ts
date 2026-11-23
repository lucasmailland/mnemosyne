// Matches confidential/restricted from Sensitivity union in @mnemo-ai/types
const ENCRYPTED: ReadonlySet<string> = new Set(["confidential", "restricted"]);

export interface ResolveDekArgs {
  sensitivity: string;
  workspaceId: string;
  actorId: string;
  existingWrapped: string | null;
  unwrap: (wrapped: string) => Buffer;
  provision: () => Buffer | null;
}

export interface ResolvedDek {
  dek: Buffer | null;
  provisioned: boolean;
}

export function resolveActorDek(args: ResolveDekArgs): ResolvedDek {
  if (!ENCRYPTED.has(args.sensitivity)) {
    return { dek: null, provisioned: false };
  }
  if (args.existingWrapped) {
    return { dek: args.unwrap(args.existingWrapped), provisioned: false };
  }
  const fresh = args.provision();
  if (!fresh) {
    // APP-073: coded so the HTTP layer answers 422 with the reason, not 500.
    throw Object.assign(
      new Error(
        `C1 fail-closed: cannot encrypt ${args.sensitivity} fact for actor=${args.actorId} ` +
          `in workspace=${args.workspaceId}; no DEK available and provisioning is disabled. Refusing to store plaintext.`,
      ),
      { code: "encryption_not_configured" as const },
    );
  }
  return { dek: fresh, provisioned: true };
}
