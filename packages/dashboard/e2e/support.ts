import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Browser, type Locator, type Page } from "@playwright/test";
import type { PalaceSeed } from "./seed";

/** Written by global-setup.ts for the run; gitignored. */
export const STATE_FILE = resolve(__dirname, ".state.json");
/** The admin session the gate specs share; written on first use, removed by global-setup. */
export const ADMIN_SESSION_FILE = resolve(__dirname, ".admin-session.json");
/** The session of an account whose workspace holds no memory (the empty pass); same lifecycle. */
export const EMPTY_SESSION_FILE = resolve(__dirname, ".empty-session.json");
/** The session of a viewer who is not a superadmin (the reader's not-found probe); same lifecycle. */
export const READER_SESSION_FILE = resolve(__dirname, ".reader-session.json");

export interface E2EState {
  apiKey: string;
  teamWorkspaceId: string;
  teamWorkspaceName: string;
  ownerWorkspaceName: string;
  multiPersonalWorkspaceName: string;
  /** Workspace whose only owner is the `leaver` account (heir is a member). */
  leaverTeamId: string;
  leaverTeamName: string;
  /** What the palace specs look for in the E2E Team workspace (see seed.ts). */
  palace: PalaceSeed;
}

export const state = (): E2EState => JSON.parse(readFileSync(STATE_FILE, "utf8")) as E2EState;

/**
 * One account per concern, so a lockout or a password change in one spec
 * never leaks into another. Test-only values for a throwaway stack.
 */
export const ACCOUNTS = {
  /** First superadmin, created by the bootstrap itself. */
  admin: { email: "admin@e2e.test", password: "admin e2e password", bootstrapAdmin: true },
  /** Owner of its own Personal workspace: a single membership. */
  owner: { email: "owner@e2e.test", password: "owner e2e password" },
  /** Read-only member of the E2E Team workspace, nothing else. */
  reader: { email: "reader@e2e.test", password: "reader e2e password", readerOfTeam: true },
  /** Owner of a Personal workspace and writer in E2E Team. */
  multi: { email: "multi@e2e.test", password: "multi e2e password" },
  /** Read-only member of E2E Team whose role the Members spec changes. */
  roleChanged: {
    email: "rolechanged@e2e.test",
    password: "rolechanged e2e password",
    readerOfTeam: true,
  },
  /** Existing account (own Personal workspace) that accepts an invitation to E2E Team. */
  joiner: { email: "joiner@e2e.test", password: "joiner e2e password" },
  /** Changes its password; nobody else signs in with it. */
  changer: { email: "changer@e2e.test", password: "changer e2e password" },
  /**
   * Ordinary owner of a Personal workspace: must not see the Installation section. Nothing is
   * ever written to that workspace, so the gate specs' empty pass measures the rooms in it.
   */
  plain: { email: "plain@e2e.test", password: "plain e2e password" },
  /** Target of the superadmin grant and revoke in the Installation spec. Never signs in. */
  grantee: { email: "grantee@e2e.test", password: "grantee e2e password" },
  /** Owner of a Personal workspace with one fact; a superadmin opens it read-only. */
  vault: { email: "vault@e2e.test", password: "vault e2e password" },
  /** Signed in elsewhere while a superadmin disables, then enables, the account. */
  sleeper: { email: "sleeper@e2e.test", password: "sleeper e2e password" },
  /** Only owner of Leaver Team; offboarded by the Offboarding spec. */
  leaver: { email: "leaver@e2e.test", password: "leaver e2e password" },
  /** Member of Leaver Team, chosen as its new owner. Never signs in. */
  heir: { email: "heir@e2e.test", password: "heir e2e password" },
  /** Gets a password reset link from a superadmin. */
  forgetful: { email: "forgetful@e2e.test", password: "forgetful e2e password" },
  /** Gets locked out on purpose. */
  locked: { email: "locked@e2e.test", password: "locked e2e password" },
  /** Owner of a Personal workspace who tries to change the model (workspace-model spec). */
  modeler: { email: "modeler@e2e.test", password: "modeler e2e password" },
  /** Creates team workspaces of its own (own-workspaces spec). */
  creator: { email: "creator@e2e.test", password: "creator e2e password" },
  /** Made owner of the ownerless Orphan Team by a superadmin (workspace-admin spec). */
  adopter: { email: "adopter@e2e.test", password: "adopter e2e password" },
  /** Owner of a Personal workspace whose keys the API Keys spec lists, rotates and revokes. */
  keyholder: { email: "keyholder@e2e.test", password: "keyholder e2e password" },
} as const satisfies Record<
  string,
  { email: string; password: string; readerOfTeam?: boolean; bootstrapAdmin?: boolean }
>;

export const INVALID_LINK = "This link is no longer valid. Ask for a new one.";

/** Signs in an account with several workspaces and enters the named one ("E2E Team — Owner"). */
export async function signInToWorkspace(
  page: Page,
  email: string,
  password: string,
  workspaceLabel: string
): Promise<void> {
  await fillLogin(page, email, password);
  await page.getByLabel("Workspace").selectOption({ label: workspaceLabel });
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/dashboard\/?$/);
}

export const INVALID_LOGIN = "Invalid email or password. Try again.";

/**
 * The form's error. Scoped to the form: Next.js mounts its own role="alert"
 * route announcer on every page, so a page-wide getByRole("alert") is ambiguous.
 */
export const formAlert = (page: Page) => page.locator("form").getByRole("alert");

export async function fillLogin(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/dashboard/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** Signs in an account with a single membership and waits for Home. */
export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await fillLogin(page, email, password);
  await expect(page).toHaveURL(/\/dashboard\/?$/);
}

/** The sidebar's role badge and workspace name, side by side under the wordmark. */
export function sidebarIdentity(page: Page) {
  const navigation = page.locator("aside");
  return {
    role: (role: string) => navigation.getByText(role, { exact: true }),
    workspace: (name: string) => navigation.getByText(name, { exact: true }),
  };
}

const REPO_ROOT = resolve(__dirname, "../../..");
export const COMPOSE_FILE = resolve(REPO_ROOT, "docker/docker-compose.e2e.yml");

/**
 * One request to the server's own API (the port is not published, as in
 * production) from inside the server container, with an API key. Request and
 * key go in on stdin, never on a command line.
 */
export function serverRequest(
  key: string,
  method: string,
  path: string,
  body?: unknown
): { status: number; body: unknown } {
  const script =
    "let i='';process.stdin.on('data',d=>i+=d).on('end',async()=>{const r=JSON.parse(i);" +
    "const res=await fetch('http://localhost:3939'+r.path,{method:r.method," +
    "headers:{authorization:'Bearer '+r.key,'content-type':'application/json'}," +
    "body:r.body===undefined?undefined:JSON.stringify(r.body)});" +
    "console.log(JSON.stringify({status:res.status,body:await res.text()}))})";
  const out = execFileSync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "exec", "-T", "server", "node", "-e", script],
    { input: JSON.stringify({ key, method, path, body }), encoding: "utf8" }
  );
  const parsed = JSON.parse(out) as { status: number; body: string };
  let json: unknown = parsed.body;
  try {
    json = JSON.parse(parsed.body);
  } catch {
    /* not JSON */
  }
  return { status: parsed.status, body: json };
}

/** Signs in an account with several workspaces and enters the one that is not a "... Team". */
export async function signInToPersonal(page: Page, email: string, password: string): Promise<void> {
  await fillLogin(page, email, password);
  const select = page.getByLabel("Workspace");
  await expect(select).toBeVisible();
  const labels = await select.locator("option").allTextContents();
  const personal = labels.find((label) => !/Team/.test(label));
  if (!personal) throw new Error(`no personal workspace among: ${labels.join(" | ")}`);
  await select.selectOption({ label: personal });
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/dashboard\/?$/);
}

/** The Installation pages must not scroll sideways on a phone. */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
}

/** An unknown path under a room: the Lethe not-found page, which the gate specs measure like a room. */
export const NOT_FOUND_UNDER_A_ROOM = "/browser/this-does-not-exist";

/** An Installation page opened by a reader (requireSuperadmin → notFound): the same in-shell 404. */
export const NOT_FOUND_FOR_A_READER = "/installation/users";

/**
 * What keeps a page from being Lethe's not-found inside the shell: a 404, the sidebar around it
 * (the root not-found has none), exactly one h1 and it is Lethe's, and no room header over it.
 * Empty when the page is right.
 */
export async function inShellNotFoundProblems(
  page: Page,
  status: number | undefined
): Promise<string[]> {
  const out: string[] = [];
  if (status !== 404) out.push(`HTTP ${status}, not 404`);
  if ((await page.locator("aside#dashboard-navigation").count()) !== 1)
    out.push("no sidebar: the not-found is outside the shell");
  // The room header stays in the DOM under display:none (globals.css), out of the
  // accessibility tree: one h1 means one rendered h1.
  const h1s = await page.locator("h1:visible").count();
  if (h1s !== 1) out.push(`${h1s} rendered h1 elements, not exactly one`);
  if ((await page.locator("main [data-lethe] h1:visible").count()) !== 1)
    out.push("the h1 is not Lethe's inside main");
  if (await page.locator("main > header").first().isVisible())
    out.push("the room header shows on the not-found page");
  // The sidebar's room card names the room from the path: hidden while Lethe owns the page.
  if (await page.locator("[data-room-card]").first().isVisible())
    out.push("the sidebar's room card names a room on the not-found page");
  return out;
}

/** Every room of the dashboard, for the quality-gate specs. `/login` is the one signed-out page. */
export const ROOMS = [
  "/",
  "/browser",
  "/recall",
  "/sessions",
  "/relations",
  "/config",
  "/workspaces",
  "/account",
  "/admin/members",
  "/admin/keys",
  "/admin/health",
  "/admin/audit",
  "/installation/users",
  "/installation/workspaces",
  "/installation/settings",
  "/installation/audit",
  // Not a room: an unknown path under one. Lethe owns the page (one h1, no room header, a 404).
  NOT_FOUND_UNDER_A_ROOM,
] as const;

/** The palace rooms whose empty state the gate specs measure (an empty workspace, see EMPTY_SESSION_FILE). */
export const EMPTY_ROOMS = ["/", "/browser", "/sessions", "/relations"] as const;

async function storedSession(
  browser: Browser,
  baseURL: string,
  file: string,
  enter: (page: Page) => Promise<void>
): Promise<string> {
  if (existsSync(file)) return file;
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await enter(page);
  writeFileSync(file, JSON.stringify(await context.storageState()));
  await context.close();
  return file;
}

/**
 * `ACCOUNTS.admin` signed in (E2E Team workspace), once per run: logins are
 * rate-limited per IP and the gate specs would otherwise each spend one.
 * Returns the storage state to hand to `browser.newContext`.
 */
export const adminStorageState = (browser: Browser, baseURL: string) =>
  storedSession(browser, baseURL, ADMIN_SESSION_FILE, (page) =>
    signInToWorkspace(page, ACCOUNTS.admin.email, ACCOUNTS.admin.password, "E2E Team — Owner")
  );

/** `ACCOUNTS.plain` signed in (its own Personal workspace, which holds nothing), once per run. */
export const emptyStorageState = (browser: Browser, baseURL: string) =>
  storedSession(browser, baseURL, EMPTY_SESSION_FILE, (page) =>
    signIn(page, ACCOUNTS.plain.email, ACCOUNTS.plain.password)
  );

/** `ACCOUNTS.reader` signed in (a viewer of E2E Team, not a superadmin), once per run. */
export const readerStorageState = (browser: Browser, baseURL: string) =>
  storedSession(browser, baseURL, READER_SESSION_FILE, (page) =>
    signIn(page, ACCOUNTS.reader.email, ACCOUNTS.reader.password)
  );

/**
 * Image bytes a page fetches while it loads (lazy images below the fold are not fetched), and
 * its largest contentful paint: the performance budget's two numbers.
 */
export async function measureLoad(
  page: Page,
  path: string
): Promise<{ lcp: number; images: number }> {
  let images = 0;
  const pending: Promise<void>[] = [];
  page.on("response", (response) => {
    if (response.request().resourceType() !== "image") return;
    const length = Number(response.headers()["content-length"]);
    if (length > 0) images += length;
    else
      pending.push(
        response.body().then(
          (b) => void (images += b.length),
          () => {}
        )
      );
  });
  await page.goto(path);
  await page.locator("h1").first().waitFor();
  // The LCP is final once the page has loaded and painted: read it after load, then let one more
  // second of candidates in (an image that finishes after load still counts).
  await page.waitForLoadState("load");
  const lcp = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let last = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) last = e.startTime;
        }).observe({ type: "largest-contentful-paint", buffered: true });
        setTimeout(() => resolve(last), 1000);
      })
  );
  await Promise.all(pending);
  return { lcp, images };
}

/**
 * The palette's shortcut as the page reads it: ⌘ where the page reports an Apple platform, Ctrl
 * elsewhere (palette-trigger's isApple). Not ControlOrMeta, which follows the machine running the
 * tests: "Desktop Chrome" reports Windows, so on a Mac host ControlOrMeta+K would press ⌘K, which
 * the page rightly ignores off macOS.
 */
export async function paletteKey(page: Page, key: string): Promise<string> {
  const apple = await page.evaluate(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = nav.userAgentData?.platform || nav.platform || "";
    return !platform || /mac|iphone|ipad/i.test(platform);
  });
  return `${apple ? "Meta" : "Control"}+${key}`;
}

/**
 * Opens the ⌘K palette over the current page and lets a search settle on a seeded fact, so the
 * gate specs measure and audit it with a results list in it (works in either language).
 */
export async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press(await paletteKey(page, "k"));
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").fill("Porto");
  await dialog.getByRole("option").first().waitFor();
}

/**
 * A row's actions sit in its "⋯" RowMenu (components/ui/row-menu.tsx): open the menu named
 * "Actions for {row}" inside `scope`, pick the item by its full name, and return the menu button
 * (the dialog an item opens hands focus back to it).
 */
export async function rowAction(
  scope: Page | Locator,
  row: string,
  item: string,
  actions = "Actions for"
): Promise<Locator> {
  const trigger = scope.getByRole("button", { name: `${actions} ${row}`, exact: true });
  await trigger.click();
  await scope.getByRole("menuitem", { name: item, exact: true }).click();
  return trigger;
}

/** The security audit's Action FilterMenu: open it and pick the action by its code. */
export async function pickAuditAction(page: Page, code: string): Promise<void> {
  await page.getByRole("button", { name: /^Action:/ }).click();
  await page.locator(`input[name="action"][value="${code}"]`).check();
}

/** A DateRangeMenu: open it, set From and To (an empty string clears one), and Apply. */
export async function setDays(page: Page, from: string, to: string): Promise<void> {
  await page.getByRole("button", { name: /^Dates:/ }).click();
  await page.getByLabel("From", { exact: true }).fill(from);
  await page.getByLabel("To", { exact: true }).fill(to);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
}
