# Research report — Minecraft Survival MCP Server, ai-memory, graphify, cc-switch, HyperFrames

> Rapport brut de recherche (agent de recherche, 30/10/2026, en anglais). README + sources via raw.githubusercontent.com.
> La synthèse exploitable (en français) est dans `docs/RESEARCH.md`.

## 0. Metadata snapshot (2026-10-30)

| Project | License | Last commit | Stars | Stack | Status |
|---|---|---|---|---|---|
| netherite-stack/minecraft-survival-mcp-server | MIT | 2026-07-09; created 2026-03-09; 46 commits; v1.0.0 | 2 | TypeScript, mineflayer ^4.35.0, pathfinder ^2.4.5, @modelcontextprotocol/sdk ^1.27.1, zod ^4, express ^5, pino, prismarine-viewer ^1.33 | Hobby project, stale ~4 months |
| akitaonrails/ai-memory | MIT | 2026-10-30 | 13.7k | Rust single binary, SQLite, git2 | Very active (4,774 commits) |
| Graphify-Labs/graphify | Apache-2.0 + MIT (dual) | 2026-10-27 (0.9.97); branch `v8` | ~131–139k | Python ≥3.10, networkx, tree-sitter, rapidfuzz; PyPI `graphifyy` | Very active |
| farion1231/cc-switch | MIT | 2026-10-30 | ~150k | Tauri 2 + Rust (axum/hyper proxy) + React 18/TS | Very active |
| heygen-com/hyperframes | Apache-2.0 | 2026-10-16 | 42–76k | TypeScript monorepo (bun), Puppeteer/CDP, FFmpeg, Node ≥22 | Active |

## 1. Minecraft Survival MCP Server (the "Body" reference)

**Architecture** ("Helix approach"): LLM = Mind, MCP server = Body. Tools are "transactions": high-level intents. Single
shared `bot` per process, auto-connect at startup. `mineflayer.createBot({host, port, username, respawn: false})` — no
`version`, no `auth` (offline). Plugins: `pathfinder`, `prismarine-viewer` on `spawn`. Reconnect 5000 ms. Transport:
`MCP_TRANSPORT=stdio` (default) or `remote` = Streamable HTTP (`/mcp`).

**Tool list**: every tool returns `{content:[{type:"text",text}]}` + `isError`; **no JSON observations**, only strings.
- Movement: `get_own_position`, `move_to_coordinates(x,y,z; timeout_ms 1000–300000 def 30000; allow_block_breaking;
  allow_block_placement)`, `move_to_player(username; range 1–16)` (GoalNear from a one-shot read), `open/close_door_or_trapdoor`.
  Per call: `new Movements(bot)`, `canDig = allow_block_breaking`, `allow1by1towers=false`, `allowParkour=false`. **Stall
  detector** `runGoalWithTimeout`: polls 250 ms, progress = squared displacement ≥ 0.01; `timeout_ms` is a *no-progress*
  timer, not a total cap.
- Mining: `mine_block_by_coords`, `mine_room(start, length,width,depth ≤128)` top-down serpentine, `break_tree(x,y,z)` BFS over
  26 neighbours on `log|stem|hyphae` (cap 512), `mine_stairs(depth)`. Tool gating via `block.diggable`, `bot.canDigBlock`,
  `harvestTools`, `bestHarvestTool`. Returns `mined=N, skipped=N, failed=N`.
- Building: `place_block_at`, `place_wall(block_name; start; x_length,y_height,z_length; directions)`, `place_ceiling`.
  **Resource precheck**: `required = targets not already that block`, abort with `required=N, available=N, missing=N`.
  Placement: first non-replaceable face neighbour as reference, pathfind `GoalNear` 2, equip, sneak, `placeBlock`, verify.
- Inventory: `get_inventory_contents`, `get_inventory_status`, `drop_inventory_item(query,count)`, chest put/take/contents
  (chest found ≤4 blocks, never moves).
- Crafting: `craft_item(item; amount)`: `recipesFor` then `recipesAll` for the missing list; table via `findBlock` ≤4.
  `smelt_item(item; amount; fuel_query?)`: furnaces ≤4, skip busy, fuel ranking table `FUEL_ITEMS_PER_UNIT`, timeout 20 s
  since last output.
- Vision: `capture_bot_view(width,height,view_distance,quality, look_at)` with `node-canvas-webgl` + THREE + prismarine-viewer
  → JPEG image block (only if `ENABLE_IMAGES`); `get_biome_info`, `get_daytime_info` (sleep window 12542–23458),
  `sleep_in_bed`, `locate_blocks_in_area(query; radius ≤128; max_results)`, `locate_dropped_items`.
- Wiki: `search_blocks_wiki`, `search_items_wiki`, `get_crafting_recipe(item; amount)` from `bot.registry` / `recipesAll`.
- Multiplayer: `list_players`, `find_player`, `get_player_coordinates`, `distance_to_player`, `find_nearest_players`.
  **No chat tool, no combat, no eating, no equip, no event stream.**
- Shared `matchQuery(query, candidates)`: `*`/empty = all; OR on `|`/`,`; numeric id exact; `*` wildcard regex; substring.

**REST (remote mode)** `GET /api/status`, `GET /api/inventory`, `POST /api/respawn`. **Safety/limits**: none (no mutex, no
queue, no rate limit). **Pitfalls**: string returns; `runWithTimeout` never cancels the underlying promise; `move_to_player`
doesn't track; native `canvas` deps fragile.

**Take**: transaction granularity + resource-precheck / progress-watchdog / summary-counter pattern; replace strings with
structured JSON `{ok, summary, counters, failures[], world_delta}`; add an action mutex/queue; add missing primitives.

## 2. ai-memory (long-term memory + vendor handoff)

**Core model**: Markdown wiki is source of truth (git repo, commit per consolidation/session end); SQLite (WAL, **one writer
actor**, read pool) is a derived, rebuildable index. "Compile, don't just retrieve". Data dir: `wiki/`,
`raw/workstreams/<id>/segments/*.jsonl` (immutable sanitized transcripts), `db/`, `logs/`, `models/`, `config.toml`.

**Page format**: `wiki/<workspace>/<project>/{concepts,decisions,gotchas,procedures,_rules,sessions,_slots,_prompts,_global,
_pending,_lint}/*.md`; frontmatter `title`, `entities` (≤10), `pinned`, `expires_at`, `abstract`, `summary`, `tags`
(authority tags `canonical|active|source-of-truth|superseded|historical|test-fixture|do-not-answer-from`), `slot_kind:
state|invariant`, `session_id`, `agent`, `relations: {causes|fixes|contradicts: [targets]}`.

**Key tables**: `pages` (`is_latest`, `supersedes`, `last_accessed_at`, `access_count`, `expires_at`, `salience`, embedding
provider/model/dim), `pages_fts` (FTS5), `sessions`, `observations` (+fts), `links`, `entities`, `page_embeddings` keyed
`(provider, model, dim)`, `page_feedback`, `page_access`, `page_evidence`, `handoffs`, `agent_messages`, `workstreams`,
`audit_log`.

**Tiers & decay**: Working (session; dropped) / Episodic (30 d hot, 180 d cold, evict) / Semantic (indefinite, LLM-rewrite
only) / Procedural (frequency decay). Retention = `salience·exp(−λ·dt) + σ·log(1+access_count)·exp(−μ·days_since_access)·
(1+breadth_weight·ln(1+max(actors−1,0)))`, λ=0.02, σ=0.6, μ=0.04, `cold_threshold=0.20`, `hard_delete_after_days=180`.
Pinned and `_slots/` exempt. Feedback `helpful|not_helpful|stale|wrong` adjusts salience.

**Capture → compile**: hooks (`SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, Stop, SessionEnd`) POST
sanitized payloads; SessionEnd: rule-based summary → `sessions/<id>.md` + `Handoff` row in one transaction (no LLM needed).
Optional `memory_consolidate` (LLM) fans out to `concepts/ decisions/ gotchas/`.

**Retrieval**: RRF fusion of FTS5 + entity match + link-neighbour expansion + optional vector cosine, bounded authority
multiplier, optional LLM rerank (≤30), raw-observation fallback; `explain=true` returns `score_details`.

**Session brief**: core set ≤24 pages (pinned, `_rules/`, `_slots/`) + ≤10 recent titles; tiers L0 (`abstract` ≤256 B) / L1
(`summary` ≤500 B) / L2 (full body if fits); `max_chars` default 4000; wrapped in untrusted-history fences.

**Handoff protocol**: `id, from_session_id, to_agent, owner, shared, cwd, summary, state ∈ open|accepted|cancelled|expired`;
automatic at SessionEnd; exactly-once claim; "offer mode" delivers a non-consuming notice and the agent accepts to receive
the body as *evidence, not instructions*. Cross-vendor: plain markdown summary.

**Cross-vendor workstreams**: `ai-memory run <harness>` holds a lease, reads native transcripts read-only, normalizes into an
append-only ledger (`event_id` dedup, `agent`, `kind`, role, ts, seq, content, provenance, metadata allowlist, 512 B caps);
next harness gets a bounded "context packet" with versioned origin marker.

**LLM abstraction**: `LlmProvider` trait `complete`, `complete_structured_raw`; providers `anthropic|openai|codex|copilot|
gemini|openai-compat|opencode`; `[[llm_fallbacks]]` chain; transient = 429/5xx/timeouts → next; deterministic =
400/401/403/404/422/schema → stop; 30 s circuit per entry (extended by `Retry-After`, cap 1 h). Structured output via
native JSON-schema only.

**MCP surface (23 tools)**: `memory_query, memory_recent, memory_read_page, memory_briefing, memory_explore,
memory_handoff_*, memory_message_*, memory_consolidate, memory_write_page, memory_delete_page, memory_forget_sweep,
memory_lint, memory_feedback, memory_auto_improve`, …

**Take**: "markdown wiki = truth, SQLite = index", the retention formula, tiered brief with byte budget and untrusted fencing,
exactly-once handoff with offer mode, provider fallback-chain semantics. Map tiers to Minecraft: Working = current
excursion; Episodic = `sessions/<day>.md` adventure logs; Semantic = `places/`, `players/`, `recipes-learned/`; Procedural =
`procedures/` (skills that worked). Reimplement in Python (FTS5 + optional sqlite-vec); writer-actor pattern essential.

## 3. graphify (knowledge graph → world graph)

**Pipeline**: `detect() → extract() → build() → cluster() → analyze.* → report.generate() → export.to_*()`, plain dicts +
`nx.Graph`, outputs in `graphify-out/`. Pass 1 tree-sitter AST (no LLM); Pass 2 faster-whisper for media; Pass 3 LLM
subagents for docs; SHA-256 per-file cache.

**Schema**: node `{id, label, file_type ∈ code|document|paper|image|rationale, source_file, source_location, community,
community_name?, norm_label}`; edge `{source, target, relation, confidence ∈ EXTRACTED|INFERRED|AMBIGUOUS, confidence_score,
context?, weight?}`; `graph.graph = {schema_version: 1, graphify_version, hyperedges[]}`; file is networkx
`node_link_data`. `to_json` atomic, refuses to shrink unless `force`. Exporters: html, obsidian, svg, graphml, canvas,
cypher (Neo4j), FalkorDB, wiki.

**Clustering**: `graspologic leiden` → `nx louvain_communities(seed=42)` fallback; deterministic; community 0 = largest;
oversize split at `max(10, 0.25·N)`; `cohesion_score`; `exclude_hubs_percentile`; `AMBIGUOUS` edges ×0.5. Labels by hub or
LLM in batches, persisted with member signatures (first 16 hex of SHA-256(sorted member ids)).

**Query engine**: terms → IDF → trigram prefilter → scoring tiers (exact 1000, prefix 100, substring 1, source 0.5, rationale
0.75) scaled by `(matched/n_terms)²` → seeds (max 3) → BFS/DFS depth 3, hubs not expanded → induced edges → token budget
(`char_budget = tokens×3`, default 2000 tokens) → lines `NODE {label} [src=… community=…]` / `EDGE {src} --{relation}
[{confidence}]--> {tgt}`. Exit codes 3 ambiguous, 4 no match. Learning overlay: `save-result useful|dead_end|corrected` →
`.graphify_learning.json` tags `preferred|tentative|contested`.

**MCP server**: `query_graph(question, mode, depth, token_budget, context_filter)`, `get_node`, `get_neighbors`,
`get_community`, `god_nodes`, `graph_stats`, `shortest_path`.

**World-graph transposition**: node `file_type` → `place|resource_vein|structure|player|mob_spawn|event|item_cache|route`;
`source_location` → `dim:x,y,z` + tick; relations `located_in, adjacent_to, contains, built_by, traded_with, dropped_at,
hostile_to, path_to (weight=blocks), observed_at`; confidence EXTRACTED = directly observed, INFERRED = deduced (village from
bell+beds), AMBIGUOUS = hearsay from chat. Reuse `graph.json` format verbatim, deterministic communities = "regions" with
LLM-labelled names, budgeted BFS as the Mind's spatial recall tool, learning overlay for "routes that worked".

## 4. cc-switch (provider router lessons)

**Storage**: SQLite `~/.cc-switch/cc-switch.db`, `settings.json`, `live-state.json`, atomic writes. **Provider model**:
`Provider {id, name, settingsConfig, websiteUrl?, category?, meta?: ProviderMeta, inFailoverQueue}`; `ProviderMeta`:
`apiFormat ∈ anthropic|openai_chat|openai_responses`, `apiKeyField`, `isFullUrl`, `maxOutputTokens`, `customUserAgent`,
`localProxyRequestOverrides {headers, body}`, `limitDailyUsd/limitMonthlyUsd`, `promptCacheKey/Routing`, `authBinding`,
`stackModels[]`. Per-app `settingsConfig` (Claude env `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`,
`ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`; Codex TOML; Gemini env; OpenCode options).

**Modes**: `Direct | Proxy`; "Aggregation" = Proxy + stack. Proxy (axum/hyper, 200 MB body limit) routes `/v1/messages`,
`/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/v1beta/*` (Gemini); format detection **by route**; conversion modules
openai↔anthropic↔gemini, streaming SSE conversion; "rectifiers" patch provider quirks with one same-provider retry.

**Failover**: failover-queue order skipping open breakers; **one attempt per provider**, `max_attempts = max_retries+1` (3);
`Retryable` (timeouts, upstream ≥500) → next; `NonRetryable|ClientAbort` → return. Success on a non-current provider →
background switch + `provider-switched` event. **No mid-stream failover**. Circuit breaker `{failure_threshold:4,
success_threshold:2, timeout_seconds:60, error_rate_threshold:0.6, min_requests:10}`, Closed/Open/HalfOpen, health
persisted `ProviderHealth {provider_id, is_healthy, consecutive_failures, last_success_at, last_failure_at, last_error}`.
Timeouts: first byte 60 s, idle 120 s, non-streaming 600 s. Model mapping: tier substring `fable|haiku|opus|sonnet` →
`ANTHROPIC_DEFAULT_*_MODEL`, else passthrough.

**MCP management**: `McpServer {id, name, server, apps{claude,codex,gemini,opencode,…}, tags[]}`; validation `type ∈
stdio|http|sse`; per-app sync/import.

**Router design for the mind**: provider record `{id, name, api_format, base_url, api_key_env, models{tier→model},
max_output_tokens, headers_override, cost_limits, in_failover_queue, health}`; **one canonical internal message format**
with adapters per `api_format`; route by capability tier (`fast|strong|vision|local`); ordered failover queue + per-(provider,
model) circuit breaker with cc-switch defaults; transient vs deterministic error classes; never fail over mid-stream;
persist health; emit `provider-switched`.

## 5. HyperFrames (HTML → deterministic video)

**Mechanism**: local file server → Puppeteer `chrome-headless-shell` pool → per-frame seek via CDP
`HeadlessExperimental.beginFrame` → frames piped to FFmpeg → audio mixed. Engine API `acquireBrowser`,
`createCaptureSession`, `captureFrame`; Producer API `createRenderJob(RenderConfig)`, `executeRenderJob`, `startServer` with
`POST /render`; `RenderConfig {inputPath, outputPath, width=1920, height=1080, fps=30, quality ∈ draft|standard|high,
format ∈ mp4|webm|mov|png-sequence}`. Packages `hyperframes` (CLI), `@hyperframes/core|engine|producer|studio|player`.

**Authoring format**: root with `data-composition-id`, `data-start`, `data-duration`, `data-width`, `data-height`; timed
elements `class="clip" data-start data-duration`; `data-track-kind ∈ graphics|captions`; sub-compositions via
`data-composition-src`; media `data-media-start`, `data-playback-rate`, `data-volume`, `data-fade-in/out`; variables
`data-composition-variables` on `<html>` (JSON `[{id,type,label,default}]`), `data-var-text`, `data-var-src`. Timeline
contract: `window.__timelines["<id>"] = gsap.timeline({paused:true})`; engine dispatches `hf-seek` with `e.detail.time`;
determinism rules: no `Date.now`, no unseeded random, no rAF/timers, no `repeat:-1`.

**CLI**: `npx hyperframes init`, `preview`, `lint --json`, `check --json`, `render [-c composition] [-o out.mp4] [--fps]
[--quality] [--format] [--variables '{…}']`, **batch** `render --batch rows.json --output "renders/{name}.mp4"`,
`snapshot --at`, `compare`, `doctor --json`. Skills `/hyperframes`, `/hyperframes-cli`, `/hyperframes-registry`.

**Daily-recap pipeline**: (1) body logs structured events + POV frames to `assets/day-N/`; (2) mind selects highlights from
the episodic ledger, writes `rows.json`; (3) fixed template `index.html` with variable slots + captions track + GSAP
timeline; (4) `npx hyperframes check --json && npx hyperframes render --batch rows.json --output "renders/{name}.mp4"
--quality draft` (needs Chrome + FFmpeg, ~256 MB/worker; `--docker` for reproducibility).

## 6. Integration blueprint (Node/TS body + Python mind)

- **Body (TS, mineflayer)**: module shape of the MCP server (zod schemas, transactional tools with watchdog + counters) but
  structured JSON results, one action queue, add chat/combat/eat/equip/follow/look, periodic `observe()` snapshot; optional
  MCP Streamable HTTP façade so any MCP client can drive the body.
- **Mind (Python)**: memory = ai-memory data model (md wiki + SQLite FTS5 + entities + links, RRF, decay, tiered brief,
  offer-mode handoffs between model vendors); world knowledge = graphify `graph.json` + Leiden + budgeted BFS tool; LLM router
  = cc-switch semantics (queue + breaker 4/2/60s/0.6/10, error classes, tier→model map, canonical message format); recap =
  HyperFrames batch render triggered nightly from the ledger.
- **Model swap with persistent memory**: each LLM vendor is a "harness"; keep the ledger/wiki vendor-neutral (markdown + JSON);
  inject the brief/handoff as fenced untrusted context at every new session.
