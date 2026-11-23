/**
 * Installation settings (accounts stage A, spec §2).
 *
 * Each setting has an environment variable as its initial value; a value
 * saved from the dashboard wins. Saved values live in mnemo_workspace_config
 * under GLOBAL_SENTINEL_ID, encrypted with the key ring like every other
 * config row (context "instance-settings"). Every read reports where each
 * value came from: "global" (saved), "env" or "default".
 *
 *   invitationsEnabled  instance_invitations_enabled  MNEMO_INVITATIONS_ENABLED  default true
 *   publicBaseUrl       instance_public_base_url      MNEMO_PUBLIC_BASE_URL      default null
 *                       (null: links use the request's origin)
 *   registrationMode    always "closed" in stage A, not writable
 *   workspaceLimitPerUser instance_workspace_limit_per_user MNEMO_WORKSPACE_LIMIT_PER_USER default 5
 *                       (team workspaces a user who is not a superadmin may own;
 *                       0 lets nobody but superadmins create one)
 *   workspaceLlmOverride  instance_workspace_llm_override  MNEMO_WORKSPACE_LLM_OVERRIDE  default false
 *                       (true: workspace owners and admins may set their own
 *                       LLM provider, model and key for their workspace;
 *                       false: only installation admins may)
 */
import type { ServerDeps } from "./deps.js";
import { GLOBAL_SENTINEL_ID } from "./config/WorkspaceConfigStore.js";
import { createKeyRingAdapter } from "./encryption/KeyRingAdapter.js";
import { logger } from "./logging.js";

export type SettingSource = "global" | "env" | "default";

export interface InstanceSettings {
  invitationsEnabled: boolean;
  publicBaseUrl: string | null;
  registrationMode: "closed";
  workspaceLlmOverride: boolean;
  workspaceLimitPerUser: number;
}

/** The settings with the source of each value. */
export type InstanceSettingsView = InstanceSettings & {
  source: Record<keyof InstanceSettings, SettingSource>;
};

/** The writable settings; null clears a saved URL (env or default again). */
export interface InstanceSettingsPatch {
  invitationsEnabled?: boolean;
  publicBaseUrl?: string | null;
  workspaceLlmOverride?: boolean;
  workspaceLimitPerUser?: number;
}

export const INSTANCE_SETTING_KEYS = {
  invitationsEnabled: "instance_invitations_enabled",
  publicBaseUrl: "instance_public_base_url",
  workspaceLlmOverride: "instance_workspace_llm_override",
  workspaceLimitPerUser: "instance_workspace_limit_per_user",
} as const;

export const DEFAULT_WORKSPACE_LIMIT_PER_USER = 5;
export const MAX_WORKSPACE_LIMIT_PER_USER = 1000;

/** A whole number of workspaces in 0..MAX (a number, or digits as stored), or null. */
export function parseWorkspaceLimit(value: unknown): number | null {
  const n = typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_WORKSPACE_LIMIT_PER_USER
    ? n
    : null;
}

const WRITABLE_FIELDS = new Set([
  "invitationsEnabled",
  "publicBaseUrl",
  "workspaceLlmOverride",
  "workspaceLimitPerUser",
]);

const CONTEXT = "instance-settings";
const MAX_URL_LENGTH = 2048;

export interface SettingsCipher {
  encryptSecret(workspaceId: string, context: string, plaintext: string): string;
  decryptSecret(workspaceId: string, context: string, blobBase64: string): string;
}

export interface SettingsOptions {
  env?: Record<string, string | undefined>;
  /** The key ring; built from MNEMO_MASTER_KEY when left out. */
  cipher?: SettingsCipher;
}

type SettingsDeps = Pick<ServerDeps, "workspaceConfigStore">;

const stripSlashes = (value: string) => value.replace(/\/+$/, "");

/**
 * A public base URL as saved: `https://` anywhere, `http://` only for
 * localhost; no credentials, query or fragment; trailing slashes dropped.
 * Null when the value is not acceptable.
 */
export function parsePublicBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const allowed =
    url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
  if (!allowed || !url.hostname || url.username || url.password || url.search || url.hash)
    return null;
  // The raw text must not carry an empty query or fragment either.
  if (/[?#]/.test(trimmed)) return null;
  return stripSlashes(`${url.origin}${url.pathname}`);
}

/** A PUT body as a patch, or the 400 error to answer. */
export function parseSettingsPatch(
  body: unknown
): { ok: InstanceSettingsPatch } | { error: "invalid_request" | "invalid_public_base_url" } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_request" };
  const fields = body as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length === 0 || keys.some((k) => !WRITABLE_FIELDS.has(k)))
    return { error: "invalid_request" };
  const patch: InstanceSettingsPatch = {};
  if ("invitationsEnabled" in fields) {
    if (typeof fields.invitationsEnabled !== "boolean") return { error: "invalid_request" };
    patch.invitationsEnabled = fields.invitationsEnabled;
  }
  if ("workspaceLimitPerUser" in fields) {
    // A JSON number only: a form's "5" is converted by the client.
    if (typeof fields.workspaceLimitPerUser !== "number") return { error: "invalid_request" };
    const limit = parseWorkspaceLimit(fields.workspaceLimitPerUser);
    if (limit === null) return { error: "invalid_request" };
    patch.workspaceLimitPerUser = limit;
  }
  if ("workspaceLlmOverride" in fields) {
    if (typeof fields.workspaceLlmOverride !== "boolean") return { error: "invalid_request" };
    patch.workspaceLlmOverride = fields.workspaceLlmOverride;
  }
  if ("publicBaseUrl" in fields) {
    if (fields.publicBaseUrl === null) patch.publicBaseUrl = null;
    else {
      const url = parsePublicBaseUrl(fields.publicBaseUrl);
      if (!url) return { error: "invalid_public_base_url" };
      patch.publicBaseUrl = url;
    }
  }
  return { ok: patch };
}

const TRUE = new Set(["true", "1", "yes", "on"]);
const FALSE = new Set(["false", "0", "no", "off"]);

function envBoolean(name: string, raw: string | undefined): boolean | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (TRUE.has(value)) return true;
  if (FALSE.has(value)) return false;
  logger.warn({ variable: name }, "instance_settings.env_ignored — not a boolean");
  return null;
}

/** MNEMO_PUBLIC_BASE_URL as links always read it: trimmed, no trailing slashes. */
function envBaseUrl(raw: string | undefined): string | null {
  const value = raw ? stripSlashes(raw.trim()) : "";
  return value || null;
}

/** The effective settings: saved value, else env, else default. */
export async function readInstanceSettings(
  deps: SettingsDeps,
  options: SettingsOptions = {}
): Promise<InstanceSettingsView> {
  const env = options.env ?? process.env;
  const saved = new Map<string, string>();
  if (deps.workspaceConfigStore) {
    const rows = await deps.workspaceConfigStore.getMany(
      GLOBAL_SENTINEL_ID,
      Object.values(INSTANCE_SETTING_KEYS)
    );
    if (rows.size > 0) {
      const cipher = options.cipher ?? createKeyRingAdapter();
      for (const [key, blob] of rows)
        saved.set(key, cipher.decryptSecret(GLOBAL_SENTINEL_ID, CONTEXT, blob));
    }
  }

  let invitationsEnabled = true;
  let invitationsSource: SettingSource = "default";
  const savedInvitations = saved.get(INSTANCE_SETTING_KEYS.invitationsEnabled);
  if (savedInvitations !== undefined) {
    // Only "true" turns invitations on: anything unreadable counts as off.
    invitationsEnabled = savedInvitations === "true";
    invitationsSource = "global";
  } else {
    const fromEnv = envBoolean("MNEMO_INVITATIONS_ENABLED", env["MNEMO_INVITATIONS_ENABLED"]);
    if (fromEnv !== null) {
      invitationsEnabled = fromEnv;
      invitationsSource = "env";
    }
  }

  let workspaceLlmOverride = false;
  let overrideSource: SettingSource = "default";
  const savedOverride = saved.get(INSTANCE_SETTING_KEYS.workspaceLlmOverride);
  if (savedOverride !== undefined) {
    // Only "true" opens it: anything unreadable keeps the model installation-only.
    workspaceLlmOverride = savedOverride === "true";
    overrideSource = "global";
  } else {
    const fromEnv = envBoolean("MNEMO_WORKSPACE_LLM_OVERRIDE", env["MNEMO_WORKSPACE_LLM_OVERRIDE"]);
    if (fromEnv !== null) {
      workspaceLlmOverride = fromEnv;
      overrideSource = "env";
    }
  }

  let workspaceLimitPerUser = DEFAULT_WORKSPACE_LIMIT_PER_USER;
  let limitSource: SettingSource = "default";
  const savedLimit = parseWorkspaceLimit(saved.get(INSTANCE_SETTING_KEYS.workspaceLimitPerUser));
  if (savedLimit !== null) {
    workspaceLimitPerUser = savedLimit;
    limitSource = "global";
  } else {
    const rawLimit = env["MNEMO_WORKSPACE_LIMIT_PER_USER"];
    if (rawLimit !== undefined && rawLimit.trim() !== "") {
      const fromEnv = parseWorkspaceLimit(rawLimit);
      if (fromEnv === null)
        logger.warn(
          { variable: "MNEMO_WORKSPACE_LIMIT_PER_USER" },
          "instance_settings.env_ignored — not a whole number from 0 to 1000"
        );
      else {
        workspaceLimitPerUser = fromEnv;
        limitSource = "env";
      }
    }
  }

  let publicBaseUrl: string | null = null;
  let urlSource: SettingSource = "default";
  const savedUrl = parsePublicBaseUrl(saved.get(INSTANCE_SETTING_KEYS.publicBaseUrl));
  if (savedUrl) {
    publicBaseUrl = savedUrl;
    urlSource = "global";
  } else {
    const fromEnv = envBaseUrl(env["MNEMO_PUBLIC_BASE_URL"]);
    if (fromEnv) {
      publicBaseUrl = fromEnv;
      urlSource = "env";
    }
  }

  return {
    invitationsEnabled,
    publicBaseUrl,
    registrationMode: "closed",
    workspaceLlmOverride,
    workspaceLimitPerUser,
    source: {
      invitationsEnabled: invitationsSource,
      publicBaseUrl: urlSource,
      registrationMode: "default",
      workspaceLlmOverride: overrideSource,
      workspaceLimitPerUser: limitSource,
    },
  };
}

/** No config store: MNEMO_MASTER_KEY or the database is missing. */
export class InstanceSettingsUnavailable extends Error {
  constructor() {
    super("instance settings storage unavailable");
    this.name = "InstanceSettingsUnavailable";
  }
}

/**
 * Save a patch in one transaction: the fields it names are set (or, for a
 * null URL, deleted); the others are left alone.
 */
export async function writeInstanceSettings(
  deps: SettingsDeps,
  patch: InstanceSettingsPatch,
  updatedBy: string,
  options: Pick<SettingsOptions, "cipher"> = {}
): Promise<void> {
  const store = deps.workspaceConfigStore;
  if (!store) throw new InstanceSettingsUnavailable();
  const cipher = options.cipher ?? createKeyRingAdapter();
  const encrypt = (value: string) => cipher.encryptSecret(GLOBAL_SENTINEL_ID, CONTEXT, value);
  const group: string[] = [];
  const values: Record<string, string> = {};
  if (patch.invitationsEnabled !== undefined) {
    group.push(INSTANCE_SETTING_KEYS.invitationsEnabled);
    values[INSTANCE_SETTING_KEYS.invitationsEnabled] = encrypt(String(patch.invitationsEnabled));
  }
  if (patch.workspaceLimitPerUser !== undefined) {
    group.push(INSTANCE_SETTING_KEYS.workspaceLimitPerUser);
    values[INSTANCE_SETTING_KEYS.workspaceLimitPerUser] = encrypt(
      String(patch.workspaceLimitPerUser)
    );
  }
  if (patch.workspaceLlmOverride !== undefined) {
    group.push(INSTANCE_SETTING_KEYS.workspaceLlmOverride);
    values[INSTANCE_SETTING_KEYS.workspaceLlmOverride] = encrypt(
      String(patch.workspaceLlmOverride)
    );
  }
  if (patch.publicBaseUrl !== undefined) {
    group.push(INSTANCE_SETTING_KEYS.publicBaseUrl);
    if (patch.publicBaseUrl !== null)
      values[INSTANCE_SETTING_KEYS.publicBaseUrl] = encrypt(patch.publicBaseUrl);
  }
  if (group.length === 0) return;
  await store.replaceGroup(GLOBAL_SENTINEL_ID, group, values, updatedBy);
}
