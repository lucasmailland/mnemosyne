# @mnemo-ai/dashboard

**English** · [Español](README.es.md)

Web dashboard for Mnemosyne — observability, configuration, and interactive
recall against a running `@mnemo-ai/server` instance. Next.js 16 App Router,
session-cookie auth (`mnemo_dash_token`) via `/dashboard/auth/*`, all data
reads/writes go through the `/dashboard/api/*` bridge (`packages/server/src/routes/dashboard-api.ts`).

Private package — not published to npm (`"private": true`).

## Run it

```bash
# from the repo root, after `pnpm install`, against a server already running (see docker/README.md)
MNEMO_SERVER_URL=http://localhost:3939 pnpm --filter @mnemo-ai/dashboard dev
```

`dev` first builds the workspace packages the dashboard imports (`@mnemo-ai/types`: its
`exports` point at `dist/`), then starts `next dev`, so it works from a fresh clone with no
prior `pnpm build`.

Then open `http://localhost:3000/dashboard` and sign in with an `mns_live_...` API key.

`MNEMO_SERVER_URL` defaults to `http://localhost:3939` if unset
(`lib/server-api.ts`).

## Build

```bash
pnpm --filter @mnemo-ai/dashboard build
pnpm --filter @mnemo-ai/dashboard start
```

See [`docker/README.md`](../../docker/README.md) for the backend it talks to, and
[`docs/guides/PRODUCTION_DEPLOY.md`](../../docs/guides/PRODUCTION_DEPLOY.md) to run it in
production (image, edge proxy, HTTPS).

## Design system and languages

- **Tokens.** Colors, type, spacing, radius and motion live as CSS variables in
  `app/globals.css` (light by default, dark under `data-theme="dark"`). Use the
  token classes; Tailwind arbitrary values (`foo-[...]`) and half-step spacing or
  size utilities (`p-1.5`, `-mt-0.5`, `sm:gap-2.5`: off the 4 px scale) fail
  `pnpm lint` unless listed, with a reason, in `lib/tokens-allowlist.json`.
- **Motion.** Only `opacity` and `transform` animate, with the shared durations
  and one easing curve from the tokens. `prefers-reduced-motion: reduce` sets
  every duration to 0 and drops stagger, drift and pulse.
- **Rooms.** Each page is a room defined in `lib/rooms.ts` (sidebar entry plus
  the header's title); add a page there so the shell and header pick it up.
- **Languages.** `en-US` and `es-419`; the `mnemo_locale` cookie wins, then
  `Accept-Language`, then `en-US`. `mnemo_theme` is `light`, `dark` or `system`.
- **Adding a string.** Add the key to both dictionaries in `lib/i18n/messages/`
  (`en.ts`, `es.ts`; `es.ts` is typed against `en.ts`, so a missing key fails
  typecheck) and read it with `useT()` (client) or `getT()` (server). No
  hard-coded user-visible text in `app/` or `components/`.

## The palace (the five memory rooms)

Home, Browser, Recall, Sessions and Graph are the five rooms of the "palace of
memory". Home and Graph are scenes: no room header strip, the heading drawn in
the scene itself. Browser, Recall and Sessions keep the room header. All five
read the server through the same bridge and draw only what it returns; where a
number has no source, the room leaves it out.

| Room (route)           | Name                | Notes                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home (`/`)             | The atrium          | Narrative sentence (memories written today, decisions superseded, conflicts), ledger tiles (hatched 14-day bars), the day's events, and the first open conflict. Writers can keep the newer or keep both (`/conflicts/{id}/resolve`); everyone can follow the lineage. With no conflict the archive card shows instead.                     |
| Browser (`/browser`)   | The catalog         | Cards on the left, the open memory on the right (`?open=<factId>`, rendered on the server, so a link is shareable): the two clocks (true in the world, known to Mnemosyne) and the provenance chain (session, episode, what it supersedes, what superseded it).                                                                             |
| Recall (`/recall`)     | The waters of Lethe | One metered `/recall` call per click of Recall, never on load or while typing. The pipeline strip shows each stage's candidates and time; a count the caller's access level hides is an em dash with a text explanation. "Why this result" makes one `/recall/explain` call per query, on the first expand.                                 |
| Sessions (`/sessions`) | The columbarium     | One niche per episode; `?open=<episodeId>` shows the narrative, participants, the episode timeline and up to 10 memories it produced.                                                                                                                                                                                                       |
| Graph (`/relations`)   | The constellation   | Entities, episodes and decisions as stars, relations as lines (dashed = inferred by meaning), on a live force layout (react-force-graph): drag, pan, zoom, enter an entity's neighbourhood and come back, 2D or 3D. One tab stop; arrow keys move between stars, Enter selects, Escape clears or goes back, and the selection is announced. |

Writes from the UI (resolving a conflict) appear only for sessions whose scopes
include `memory:write`. Engravings are drawn at 180 px or more on their short
side; crops are fine, shrunken panoramas are not.

Gates over these rooms live in `e2e/` (`layout`, `a11y`, `motion`, `locale`,
`palace`, `palette`). `global-setup.ts` seeds the shared E2E Team workspace through the
API (`e2e/seed.ts`: facts, one supersede, a decision superseded, an open
conflict, an episode, entities and relations), so the gates measure the rooms
with data, and `palace.spec.ts` walks them in English and Spanish.

## The keepers

Config, My workspaces, Account, Members, API keys, Health, Audit and the
Installation pages (users, workspaces, settings, audit) are the keepers: the
rooms where people look after the instance. They share one visual language from
`components/keeper.tsx` and `components/form-bits.tsx`: a section is an
`.eyebrow` heading over a 1 px rule; records are hairline rows in a bordered
panel (never stacked cards); status and scope tags are quiet outline tags
(`StatusTag`); inputs, selects, checkboxes, buttons and alerts come only from
those primitives; destructive actions confirm in a `Dialog` (never
`window.confirm`; while the action runs the dialog cannot be cancelled). They
keep their API calls, payloads and accessible names, so the e2e specs that drive
them (`workspace-model`, `own-workspaces`, `account`, `locale`, `members`,
`invitation`, `keys`, `installation`, `offboarding`, `mobile`) changed only where
an action now confirms in that dialog (`invitation`'s revoke, `keys`' rotate and
revoke click its button). The Installation rooms show only to superadmins; the
admin rooms and the "New API key" action only to admins, and "Invite a member"
only to admins of a workspace that takes members (not a personal one).

## The ⌘K palette

⌘K (Ctrl+K off macOS) opens a search from any signed-in page, as does the
sidebar's search bar. It is a modal dialog over a combobox and a grouped listbox
(rooms, actions, facts, entities) and is not in the DOM while closed. Typing
only filters rooms and actions and, from two characters and 200 ms after the
last keystroke, searches facts and entities through `/dashboard/api/facts` and
`/dashboard/api/entities`. **Typing never sends a recall**: ⌘↵ (Ctrl+↵) does,
by arming a one-shot token in `sessionStorage` and opening `/recall?q=…&run=1`;
the Recall page makes its single metered call only when the token matches `q`
and spends it, so a shared or hand-built `?run=1` link only prefills. Enter opens the highlighted result, arrows move, Escape closes and
returns focus to whatever opened it, and the result count is announced in a
polite live region. Source: `components/palette/`, with the room and action
lists in `lib/palette-items.ts`.

## Error pages

Every unknown path lands on `app/(dashboard)/[...missing]`, which calls
`notFound()`: the group layout runs first, so a signed-out visitor goes to the
login, and a signed-in one gets the Lethe not-found page inside the shell
(sidebar and palette stay) with HTTP 404, as does an Installation page opened by
someone who is not a superadmin. The scene owns the page: one h1, and the room's
own header is hidden when a Lethe page is inside `main`. A failure inside a room shows
the same page's error variant with a retry; `app/global-error.tsx` covers a
failure of the root layout, reads the language and theme cookies synchronously
and carries its six strings inline (a test pins them to the dictionaries); its way back is a plain link to the dashboard. The
gate specs measure that page like a room twice, `/browser/this-does-not-exist`
signed in as an admin and `/installation/users` signed in as a reader: a 404,
the sidebar around it, exactly one h1 (Lethe's), no room header, no overflow, no
serious accessibility violation, in both themes.
