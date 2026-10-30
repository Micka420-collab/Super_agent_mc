# Research report — VoxelMind, CraftyAI, AgentCraft, mc_aiplayer (AIBot)

> Rapport brut de recherche (agent de recherche, 30/10/2026, en anglais). ~60 fichiers source lus via
> raw.githubusercontent.com. La synthèse exploitable (en français) est dans `docs/RESEARCH.md`.

## TL;DR (what to steal for a "real player" agent)

- **Embodiment**: the two serious "player" projects (VoxelMind, AIBot) both use a **server-side fake `ServerPlayer`** with a
  packet-dropping fake `Connection` (Carpet-mod lineage), **not** Mineflayer and **not** an NPC entity. This gives real
  physics, inventory, damage, death, skin, tab-list presence, and works on dedicated servers. AgentCraft uses **client-only
  `Avatar` entities** (pure visualization); CraftyAI has **no body at all** (chat oracle + admin commands).
- **Decision model**: VoxelMind = one event-driven LLM call → exactly one body tool (+ optional `say`), with code-written
  observed results fed back as facts; AIBot = LLM picks from 63 tools but **deterministic goal planner + 34 task state
  machines** own execution and a typed postcondition decides success. Both explicitly forbid per-tick LLM control.
- **Perception**: compact text facts (VoxelMind `[SENSORY]`) or JSON snapshot with "highlights" (AIBot); scan radius
  ~20x10x20 / 16; never raw voxels. VoxelMind tracks *who placed each block* and feeds it to perception and pathfinding
  (avoids griefing player builds).
- **Memory**: VoxelMind's model-rewritten two-block memory (`[PREVIOUSLY]` + `[ABOUT OWNER]`, rewritten every 24 events
  with strict source-attribution rules) is the best persona-memory design seen. AIBot has key/value facts + named places +
  stepwise goals injected as a system message.
- **Building**: VoxelMind Builder = separate LLM "geometry call" emitting only `fill`/`setblock` lines in a local 32x32x24
  box, parsed/validated, site cleared, placed layer-by-layer with undo snapshots. AIBot = JSON blueprints (or
  `custom:WxDxH:material`) expanded to ≤4096 placements, survival-built (gather → flatten → place → verify exact match).

## 1. VoxelMind (Nyvoro/voxelmind) — https://github.com/Nyvoro/voxelmind

**Facts**: Fabric mod, MC 1.21 → 26.2 (16 jars from one Stonecutter tree; 1.21.x = Java 21, 26.x = Java 25). MIT. Latest
0.5.1 dated 2026-10-26; hosted service shut down (ends 2026-11-08), mod remains free with Player2 / OpenRouter / local.
CurseForge ~13.8K downloads. Very actively maintained.

**Three beings**: Companion (player body), Builder (NoAI allay/bee/vex/parrot/bat `SpiritBody` at owner's shoulder, console
power), God (bodiless game master).

**Embodiment** — `body/CompanionPlayer extends ServerPlayer`: no client; runs the player's own physics each tick from a
`Motor` (forward/strafe/jump/sprint/sneak, yaw rotated ≤45°/tick, pitch ≤30°/tick); `CompanionConnection extends Connection`
drops all outbound packets except `ClientboundSetEntityMotionPacket` for its own id (so knockback works). Joins scoreboard
team `voxelmind_ai` with `[AI] ` prefix ("Art. 50 AI Act"). Skins via Mojang account or MineSkin.

**Navigation** — A* over standing positions; walk, diagonal, 1-block jump, drops ≤3, swimming (≤6 consecutive underwater
steps), doors/fence gates, digging mode with real break-time cost + pillar-up; never digs player-placed blocks. `Navigator`:
≤6 replans, opens/closes doors, mines obstacles.

**Action vocabulary** (OpenAI function schemas; every body tool also accepts `say`/`say_to`): `go_to(target, through)`,
`follow`, `explore(target, direction, scope)`, `mine_block(target, include_placed)`, `gather(resource, amount 1-64)`,
`dig(direction, distance)`, `collect(item)`, `craft(item, amount)`, `smelt(item, amount, fuel)`, `collect_furnace(pos)`,
`use_chest(action view|store|retrieve, item, count, pos)`, `use_block(x,y,z)`, `attack(target)`, `eat(item)`, `equip(item)`,
`drop(item,count,target)`, `place_block(block, pos|in_front|under_feet)`, `place_blocks(blocks[≤128])`,
`build_shelter(material, center)`, `survey(center, radius 1-8)`, `sleep`, `stop`, `wait(seconds 1-300, for_what)`,
`keep_current_action` (only offered when something runs, appended last to keep the prompt-cache prefix stable), `say(text
≤256, mode say|whisper|yell, target)`. Tool descriptions are written as *contracts*: mechanical effect, what it consumes,
what the result reports. Each tool → a `BodyAction` ticked over game ticks ending in `done|failed|preempted` with result
text "written from what the world shows".

**Perception / context** — `PromptBuilder.context()`: `[IDENTITY]` → `[SENSORY]` → `BODY INTERFACE` → `CLOCK` → `LAST ACTION`
(≤120 s) → `WAIT` → `[PREVIOUSLY]` → `[ABOUT OWNER]` → `[TIMELINE]` → `[DECISION]`. `Sensory.render()`: "Woke by:",
HP/Food/Armor/XP + flags, water-column analysis with BFS to nearest air, pos+facing+biome+dimension, time phase with minutes
to dusk/dawn, weather, ground flatness within 6 blocks, column above head, standing-on/front block (+placer), placed blocks
within 8, hands/armor, inventory, Players (≤64 m, owner flagged, distance, direction, holding), Threats (≤8 hostile, HP,
"targeting you/owner"), Creatures grouped ×count, Dropped items (≤16 m), "Resources you can see within 20 blocks" (only
*exposed* blocks, top 14 by distance, player-placed counted apart), "Nearby:" features, `BODY ACTION:`.

**Timeline** — ring of 600 events, kinds `chat_in, whisper_in, chat_out, said, action, result, damage, death, respawn,
presence, threat, note`; window = last 30 min of chat (≥24 lines, ≤6000 chars) + last 30 other rows, identical consecutive
rows collapsed "(x3, first 2m ago)".

**Decision loop timing** — purely event-driven, one decision in flight; debounce: chat from owner/whisper/mention 300 ms,
hurt 150 ms, hostile targeting 150 ms, action result 400 ms, respawn 500 ms, arrival 1500 ms; timer "quiet moment" every
45–240 s while owner within 48 blocks (`idleOwnerAwayMinutes`=5 pauses thinking), 20–60 s when body idle; global
`maxRequestsPerMinute`=20 shared by all companions and memory rewrites; `tool_choice=required` with one retry; rule "one say
+ one body tool per decision", extras logged as notes; plain assistant text is *not* delivered and becomes a note.

**Prompt frames** — system = frame ("evidence has five blocks… function schema is your real mechanical capability…
distinguish attempts from observed results… you may surprise, disagree, bluff, joke") + `CORE_RULES` (AI label + safety) +
SURVIVAL progression hint + `CONVERSATION_FRAME` (anti-repetition, "timer wake is an opportunity not an obligation") +
`[LANGUAGE]` (auto from owner's locale); user = context + `[DECISION]` with a `{continuity}` sentence.

**Persona system ("brains")** — data-only folder `brains/<id>/{brain.json, frame.md, conversation.md, decision.md,
identity.md, memory.md}`; fields `temperature`, `maxTokens`, `tools.include/exclude`, `timeline.{…}`, `blocks.{…}`;
hot-reload. Shipped `lite` brain for 8–20B local models. Per-companion owner-written `persona` free text.

**Long-term memory** (`MemoryWriter`): every 24 timeline events (min 60 s apart), a JSON-mode call rewrites two
full-replacement strings `previously` (≤4500 chars, "Shared past" / "Recent developments") and `knowingOwner` (≤1800 chars);
oversize → asked again with the length as a fact; memory guide insists on source attribution ("go_to reported reaching the
farm" ≠ "gave the owner bread"), no inferring preferences from repeated tool use. `world/Placed`: per-dimension map of
player-placed blocks with placer + time.

**Provider abstraction** (`LlmClient`): OpenAI-compatible chat completions; OpenRouter `provider.order` failover; Player2
header; per-model learned quirks (`tool_choice:required` refused → auto, reasoning cannot be disabled → lowest effort,
`response_format` refused → drop); default `deepseek/deepseek-v4-flash-0731`, temp 0.7, 25 s timeout (120 s local). Every
decision logged as JSONL (`DecisionLog`: woke_by, applied, prompt_chars, tool_calls, latency, tokens, cost);
`tools/e2e/owner-bot.cjs` drives scenarios with a Mineflayer *owner* bot.

**Builder** — one call per turn, several tool calls allowed, acts only on request; tools `registry, summon_entity,
name_entity, say, run, fill, build, undo, find_blocks, body, lookup(wiki), observe, note`. `build(what, w/d/h ≤32/32/24,
distance 1-16)`: separate LLM call (temp 0.4, no tools) demanding only `fill x1 y1 z1 x2 y2 z2 BLOCK` / `setblock x y z
BLOCK` lines relative to origin, doors as two halves, forbidden tnt/lava/fire/spawners/command blocks/bedrock; parsed,
rejected lines reported back (≤2 attempts), placed with site clear + floor, layer by layer (8 ticks between layers);
`EditHistory` snapshots for `undo`; daily `WorldBackup`; `CommandPolicy` allow-list.

**God**: tools `registry, summon_entity, name_entity, say, run, move_entity, sequence, rule, clear_rule, rain, cleanup,
observe, note`; campaigns `sandbox|trials|living|chaos`.

**Limitations**: no vision; one action per decision; companion building is coordinate-list only; combat = "attack nearest
hostile within 5 blocks"; teleports to owner >64 m — breaks "real player" fairness; chat heard only within 48 blocks; LLM
latency 1–5 s; ~$0.20/h on OpenRouter default.

## 2. CraftyAI client — https://github.com/DemonZ-Development/craftyai-client

Apache-2.0 client, closed backend (Cloudflare Worker gateway). **No embodiment**: chat persona triggered by `@crafty`. Context =
permissions/environment/player status. Actions = string codes (`TIME_DAY`, `HEAL`, `GIVE:`, `TP:` …) executed by the plugin,
destructive ones need `/crafty confirm` within 30 s; "execute then narrate" follow-up turn; remote control plane can push
config/commands to servers (trust pitfall). Verdict: admin-assistant chatbot. Reusable: permission gating per action,
confirm-within-30s, execute-then-narrate, version-matrix build.

## 3. AgentCraft — https://github.com/blendi-remade/agentcraft

MIT, 750 ★, MC **26.3 singleplayer only**, Fabric, Java 25; Foreman = Node 22 + `@anthropic-ai/claude-agent-sdk`. Minecraft as a
*UI* for a team of coding agents. Foreman is a WebSocket server `ws://127.0.0.1:7878`, protocol v1, one JSON object per
frame `{v:1, type, id?, ...}`; rejects any `Origin` header or non-localhost Host; `hello` → full `snapshot` then upserts.
Agent model: `state ∈ {idle, thinking, reading, editing, running, testing, waiting_user, blocked, done, error}`, `station ∈
{desk, library, terminal, testbench, mergestation, meeting, lounge, user}`; decisions `kind ∈ {question, permission,
merge}`; protocol doc generated from zod schemas with CI freshness check. Embodiment: **client-only** `Avatar` entities
(visualisation only). Safety ideas: policy classifier for Bash, `git push` never allowable, off-tree merges, atomic
`state.json` + JSONL logs. Pitfalls: 26.3-only, singleplayer, no world agency.

## 4. mc_aiplayer = AIBot by zoyluoblue — https://github.com/zoyluoblue/mc_aiplayer

MIT © 2026 zoyluo; Fabric mod, **MC 1.21.3 only**, Java 21; ~32K lines / 197 classes; bilingual docs; default LLM DeepSeek
(`deepseek-v4-flash`, reasoning low, temp 0.3); "Mining First" north star (64 diamonds / 32 obsidian from zero, ≥90 % over 20
seeds); 211 ★ (Oct 2026).

**Embodiment**: `AIPlayerEntity extends ServerPlayerEntity` with offline `GameProfile` and `FakeClientConnection` via
`PlayerManager.onPlayerConnect` (Carpet-style); movement through an `ActionPack`.

**Architecture**: `Brain (OpenAI tool calls) → typed Goal + GoalPlanner → GoalExecutor + postcondition → 34 Task state
machines → Actions + A* → world → PerceptionSnapshot → Brain`. Goals: `HaveItem, HavePickaxeTier, MineOre, HarvestCrop,
Armor, Workstation, Stockpile, Food, Build(blueprint)`. `GoalPlanner` (125 KB) and `GoalExecutor` (325 KB) do backward
chaining (ore → pickaxe tier → wood → …).

**Tool vocabulary (63)**: goal-level `achieve_goal, mine_ore, harvest_crop, provision_food, achieve_armor,
achieve_workstation, stockpile, mine_and_stockpile, build_house, set_goal/advance_goal/goal_status`; task-level `assign_task,
craft, plan_craft, smelt, eat, sleep, farm, harvest, forage, fish, trade, breed, guard, attack, attack_entity, follow,
goto_place, strip_mine, mine_vein, resume_mining, recover_drops, light_area, deposit(_all), withdraw, find_container,
equip_armor, equip_best_tool`; low-level `move_to, mine_block, place_block, select_hotbar, look_at, hold, inventory`; control
`stop, abort_task, cancel_all, pause, resume, get_task_status`; memory `remember, recall, forget, mark_place, set_base`;
multi-bot `post_job, list_jobs, tell_bot`; `say`. Caps `maxToolCallsPerTurn`=6, `maxTurnsPerRequest`=12,
`maxHistoryMessages`=36.

**Perception**: JSON `PerceptionSnapshot{self{…}, task{…}, highlights{nearest_tree, nearest_stone, nearest_ore, nearest_water,
nearest_furnace, nearest_chest, nearest_bed, nearest_crafting_table, nearest_hostile}, blocks[], entities[], items[],
time{…}}`; radius 16 (block scan 8). In `strict_survival`, `ObservableWorldQuery` raycasts to 9 face sample points so the bot
only "sees" exposed, line-of-sight blocks (no x-ray). Profiles `strict_survival` (default) vs `operator`.

**Loop**: chat `@Bob <text>` → `handleMessage` appends `"[sender] says: … \n\nCurrent state:\n<json>"`; "latest-wins decision
epoch" discards stale API responses; idle-watcher wakes the brain when a task finishes/fails. System prompt: "Prefer
high-level deterministic tasks… a single mine_ore/achieve_goal call runs the ENTIRE plan… after you call it, STOP…". Memory:
facts map (≤8), named `places` (≤10), goal title + steps + cursor. `ReplayRecorder` keeps (perception digest, tool calls,
result) tuples for replay/eval.

**Pathfinding**: weighted A* (ε=3), 10,000 nodes / 50 ms budget, result cache. **Building**: `BlueprintLoader` JSON `ops` /
`placements` `{dx,dy,dz,block}` sorted by y then x,z, ≤4096 blocks; `custom:7x5x4:stone`; `BuildTask` phases `SITE →
FLATTEN → BUILD`, final exact-match verification; `Goal.Build` auto-gathers materials first.

**Honesty about reliability** (capability matrix): wood 4/4, cooked food 8/10, iron armor 10/12, diamond-from-zero 6/10,
hut 7/10, wheat→bread 1/5, 100 iron 2/12, 120-block navigation 0/4, combat untested.

**Pitfalls**: single MC version; no persona/dialogue layer (Chinese-only replies to a panel); monolithic planner files.

## Cross-project synthesis for the new agent

1. **Body**: fake `ServerPlayer` + no-op `Connection` (keep knockback packet), own physics (VoxelMind) — or a protocol client
   (Mineflayer) for portability. Exclude from sleep count; handle respawn.
2. **Two-tier control**: VoxelMind's "one decision → one body tool with observed result" *plus* AIBot's deterministic goal
   planner/state machines behind high-level tools (`achieve_goal`, `mine_ore`, `build_house`). Typed postconditions.
3. **Context format**: text blocks `[IDENTITY] [SENSORY] [PREVIOUSLY] [ABOUT OWNER] [TIMELINE] [DECISION]`, duplicate
   collapsing, CLOCK, LAST ACTION, "Woke by:", results phrased as observations; AIBot `highlights`; line-of-sight filtering.
4. **Tool contracts**: effect/consumption/result; `say` on every body tool; `keep_current_action` last; `wait(seconds,
   for_what)`; reject invalid calls as timeline facts and retry once; one say + one action per decision.
5. **Memory**: periodic full-rewrite of `previously`/`knowingOwner` with attribution rules; structured `places`/`facts`/goal
   cursor; placed-block provenance.
6. **Building**: geometry-call (`fill`/`setblock` in a local box, validated, layer-scheduled, undoable) for creative; blueprint
   expansion + gather→flatten→place→verify for survival. Hybrid: LLM geometry → blueprint → survival BuildTask.
7. **Persona**: data-only brain folders hot-reloadable; un-removable core rules; "timer wake is an opportunity, not an
   obligation"; language auto from locale.
8. **Ops/eval**: JSONL decision log with tokens/latency/cost, replay recorder, Mineflayer owner-bot e2e scenarios, capability
   matrix. Shared request budget; owner-away pause; per-model quirk learning.
9. **UI as a world**: AgentCraft's zod-defined localhost WebSocket protocol (hello→snapshot→upserts) is a clean template.
