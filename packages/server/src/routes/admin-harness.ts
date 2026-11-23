import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { HttpError } from "../errors.js";

export function mountAdminHarness(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.post("/admin/harness/quiesce", async (c) => {
    const scopes = c.get("scopes") ?? [];
    if (
      !scopes.includes("admin:workspace") &&
      !scopes.includes("memory:admin") &&
      !scopes.includes("*")
    )
      throw new HttpError(403, "forbidden", "Administrative workspace scope is required");
    const storage = deps.storage;
    if (!storage?.disableHarnessIngestion || !storage.quiesceManagedLifecycle)
      throw new HttpError(
        503,
        "harness_storage_unavailable",
        "Managed lifecycle storage is unavailable"
      );
    const workspaceId = c.get("workspaceId");
    // A committed disable fences earlier ingestion before lifecycle quiescence.
    const control = await storage.disableHarnessIngestion({ workspaceId });
    const counts = await storage.quiesceManagedLifecycle({ workspaceId });
    const quiesced = counts.pendingCount === 0 && counts.liveLeaseCount === 0;
    return c.json(
      { ...control, ...counts, inFlightCount: counts.liveLeaseCount, quiesced },
      quiesced ? 200 : 202
    );
  });
}
