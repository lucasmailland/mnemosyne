import type { PoisoningScanResult } from "./detect";
import { MIN_POISON_SEVERITY } from "./detect";
import type { PoisoningCategory } from "./patterns";

export class PoisoningRejectedError extends Error {
  readonly scan: PoisoningScanResult;
  /**
   * SEC-7: a stable discriminator for the HTTP layer, which maps this policy
   * rejection to a 4xx instead of a 500. Deliberately no evidence here — the
   * matched text can itself be sensitive; `scan.findings` keeps it for logs.
   */
  readonly code = "poisoning_rejected" as const;
  /** The categories that blocked the write (severity at or above the gate). */
  readonly categories: PoisoningCategory[];
  constructor(scan: PoisoningScanResult) {
    super(`Fact rejected: poisoning gate matched ${scan.findings.length} finding(s)`);
    this.name = "PoisoningRejectedError";
    this.scan = scan;
    this.categories = [
      ...new Set(
        scan.findings.filter((f) => f.severity >= MIN_POISON_SEVERITY).map((f) => f.category)
      ),
    ];
  }
}
