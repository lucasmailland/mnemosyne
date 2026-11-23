import { rmSync } from "node:fs";

import { ADMIN_SESSION_FILE, EMPTY_SESSION_FILE, READER_SESSION_FILE } from "./support";

/**
 * The gate specs keep signed-in sessions on disk for the run (support.ts). They are worthless
 * once the stack is gone, and they hold live session cookies: remove them when the run ends,
 * not only at the next global-setup.
 */
export default function globalTeardown(): void {
  for (const file of [ADMIN_SESSION_FILE, EMPTY_SESSION_FILE, READER_SESSION_FILE])
    rmSync(file, { force: true });
}
