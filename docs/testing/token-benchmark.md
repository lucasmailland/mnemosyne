# Token benchmark

What one turn of an agent session puts into the model's context with
Mnemosyne, against pasting every memory into every request, against no
memory. Reproduce with:

```bash
pnpm build
pnpm bench:tokens
```

## Result (2026-11-22)

| Corpus                                                                                                                                                                                                                                                                                    | Live memories | Full dump / turn | Mnemosyne served / turn (avg · p95) | Mnemosyne incl. fixed surface: 37 tools · core | Answer in context: dump · Mnemosyne · none |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------: | ---------------: | ----------------------------------: | ---------------------------------------------: | ------------------------------------------ |
| recall                                                                                                                                                                                                                                                                                    |           140 |           10,378 |                           280 · 427 |                                47,051 · 13,229 | 100% · 97% · 0%                            |
| agentsim                                                                                                                                                                                                                                                                                  |            54 |            7,558 |                           339 · 617 |                                47,110 · 13,288 | 100% · 95% · 0%                            |
| All sizes are characters per request.                                                                                                                                                                                                                                                     |
| Fixed surface on every request: MCP instructions 1,887 + tools/list 44,884 with all 37 tools (default) = 46,771, or 11,062 with MNEMO_MCP_TOOLS=core = 12,949.                                                                                                                            |
| Break-even: with memories averaging 74 characters (recall corpus), pasting everything costs less than Mnemosyne below about 635 memories with all 37 tools, or 179 with the core profile; above that the served context stays near 280 characters while the dump grows with every memory. |

## What this shows

- **Served context is small and flat.** Recall injects about 280–340 characters per
  turn on average (hits under the relevance floor are dropped), and that does not grow
  with the number of memories.
- **Answers stay in context.** 95–97% of the answerable questions have their labelled
  memory among what was served (full dump: 100% by construction).
- **The fixed surface dominates on small memories.** The MCP instructions and the tool
  schemas are about 46,800 characters on every request with all 37 tools (the default),
  or about 12,900 with `MNEMO_MCP_TOOLS=core`. Below roughly 635 memories of this size
  (180 with core), pasting everything is smaller. Above it, Mnemosyne's per-request
  context stays near the fixed surface while a dump grows linearly.
- Both the fixed surface and an unchanged dump are identical from request to request, so
  a host with prompt caching pays them at the cached rate; hosts that defer tool schemas
  (Claude Code loads MCP tools on demand) pay only for the tools they load. The
  benchmark reports sizes, not prices.

## Method

- Corpora: the two labelled corpora of the relevance gate
  (`packages/core/src/benchmark/relevance/corpus.json`, real bge-m3 vectors
  frozen in `vectors.json`), run through the real recall facade. No model,
  no network, deterministic.
- Mnemosyne per turn: the plugin hook's request (top 5, compact projection,
  each hit at most 300 characters; nothing when the response says
  `nothingRelevant`), plus the fixed surface measured from the built MCP
  server by `scripts/measure-tool-surface.mjs`.
- Full dump per turn: every live memory of the corpus.
- Sizes are exact characters. Tokens are not estimated: Claude's tokenizer is
  not available offline, and a tiktoken-style figure would look measured while
  being wrong. Ratios hold whatever the characters-per-token rate.
- Not covered: a 500-memory corpus with labelled answers (the break-even line
  is extrapolated from the recall corpus), answer quality as judged by a
  model, and the cost of tool calls the agent makes on its own.
