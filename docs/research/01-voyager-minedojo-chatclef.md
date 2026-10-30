# Research report — Voyager, MineDojo, ChatClef/AltoClef

> Rapport brut de recherche (agent de recherche, 30/10/2026). Sources lues : READMEs + fichiers source bruts via
> raw.githubusercontent.com. Les dates de dernier commit viennent d'ecosyste.ms / CurseForge.
> La synthèse exploitable est dans `docs/RESEARCH.md`.

## 1. Voyager (MineDojo/Voyager) — MIT, dernier push 2024-04-03, ~6k ★

Sources : https://github.com/MineDojo/Voyager · voyager/voyager.py · voyager/agents/{action,curriculum,critic,skill}.py ·
voyager/env/bridge.py · voyager/env/mineflayer/index.js · https://arxiv.org/pdf/2305.16291

### Architecture (boucle exacte, voyager.py)
`Voyager` câble `VoyagerEnv` + 4 agents LLM + `EventRecorder`. `learn()` : hard reset → `env.step("")` pour une première
observation → boucle jusqu'à `max_iterations` (160) : `CurriculumAgent.propose_next_task(events, chest_observation)` →
`rollout(task, context)` = `reset()` (soft reset, difficulté "peaceful" jusqu'à 15 tâches puis "easy", récupération top-k
skills avec `query=context`) puis `step()` jusqu'à `action_agent_task_max_retries=4` → succès → `SkillManager.add_new_skill`
→ `curriculum.update_exploration_progress`. Exception dans rollout : sleep 3 s, tâche marquée échouée, **hard reset qui
restaure inventaire/équipement/position**. Reward toujours 0 ; le succès vient uniquement du critic. Défauts : gpt-4 temp 0
sauf QA/description de skill sur gpt-3.5 ; `env_wait_ticks=20`, `env_request_timeout=600`, `retrieval_top_k=5`.

### Prompts (voyager/prompts/*.txt)
- **action_template** : rôle = assistant qui écrit du JS Mineflayer ; placeholders `{programs}` (stubs de primitives + code
  des skills récupérés) et `{response_format}` ; 16 champs d'entrée (code du tour précédent, erreur d'exécution, chat log,
  biome, time, nearby blocks, nearby entities, health, hunger, position, equipment, inventory xx/36, chests, task, context,
  critique) ; 11 règles : une fonction async prenant uniquement `bot` ; réutiliser les primitives (`mineBlock` pas `bot.dig`,
  `craftItem` pas `bot.craft`, `smeltItem`, `placeItem`, `killMob`) ; fonctions génériques qui vérifient l'inventaire ;
  `bot.chat` pour le progrès ; `exploreUntil` si quelque chose manque ; `maxDistance` 32 pour findBlock(s) ; pas de boucles
  infinies ; pas de `bot.on/once`.
- **action_response_format** : `Explain:` → `Plan:` numéroté → `Code:` un bloc JS, helpers optionnels puis `async function name(bot)`.
- **curriculum** : "mentor" dont le joueur veut découvrir le plus de choses diverses ; 8 règles : quantités précises,
  format "Mine [qty] [block]/Craft/Smelt/Kill/Cook/Equip", faisable maintenant, nouveau, jamais construire d'abri, éviter
  les tâches nécessitant une confirmation visuelle. Sortie `Reasoning:` puis `Task:`.
- **critic** : juge à partir de l'état post-tâche ; l'inventaire est la vérification principale ; JSON `{reasoning, success, critique}` ; 7 few-shots.
- **skill** : décrire la fonction principale en ≤6 phrases.
- **curriculum_task_decomposition** : sous-buts ordonnés en JSON.

### Curriculum (curriculum.py)
Tâche d'amorçage fixe ("Mine 1 wood log") ; si `inventoryUsed >= 33` le LLM est court-circuité (deposit/craft chest/place
chest). **Warm-up** : champs d'observation déverrouillés par `progress=len(completed_tasks)` (context 15, biome 10, time 15,
other_blocks 10, nearby_entities 5, health/hunger 15, optional_inventory_items 7) avec p=0.8 d'inclusion. **QA** : questions
sur la situation + 3 questions biome fixes ; réponses cachées dans `qa_cache.json` + Chroma (réutilisation si distance cos < 0.05) ;
`get_task_context(task)` → "How to … in Minecraft?" → contexte passé à l'agent d'action et requête de récupération de skills.

### Skill library (skill.py)
`ckpt/skill/{code/*.js, description/*.txt, vectordb/, skills.json}` ; Chroma `skill_vectordb` avec `OpenAIEmbeddings()`,
**embedding de la description générée**, id = nom du programme. Collision de nom → `nameV2.js`. `retrieve_skills(query)` =
`similarity_search_with_score(k≤5)`. **Tout** le code des skills + primitives est envoyé au côté JS à chaque `/step`, seuls
les skills récupérés vont dans le prompt.

### Env bridge et serveur Mineflayer
Python lance `node index.js <port>` ; HTTP `POST /start` {reset hard|soft, inventory, equipment, position…}, `POST /step`
{code, programs}, `/pause`, `/stop`. Mods Fabric (Multi Server Pause pour geler le serveur pendant les appels LLM), MC **1.19**.
`/step` exécute `eval("(async () => {" + programs + code + "})()")` (**pas de sandbox, pas de timeout**), remappe les numéros de
ligne, détection de blocage (100 ticks, 5 échantillons, <1.5 bloc → `/tp`), `returnItems()` re-donne table/four via `/give`.
Deps : mineflayer ^4.8.1, pathfinder ^2.4.2, pvp ^1.3.2, tool ^1.2.0, hawkeye ^1.3.6.

### Observation (lib/observation/*.js)
`inject(bot, [OnChat, OnError, Voxels, Status, Inventory, OnSave, Chests, BlockRecords])` ; `bot.observe()` → JSON
`[[event_name, {...}], …, ["observe", {...}]]`. `voxels` = noms uniques dans une boîte 17×5×17 ; `blockRecords` cumule les
noms vus toutes les 100 ticks ; `status` = health, food, saturation, oxygen, position, velocity, yaw, pitch, onGround,
equipment, isInWater/Lava/Web, collisions, biome, `entities` {name: distance la plus proche <32}, `timeOfDay` bucketisé,
inventoryUsed, elapsedTime ; `nearbyChests` = {pos: items|"Unknown"} dans 16 blocs ; `onChat`, `onError`.

### Primitives de contrôle (voyager/control_primitives/*.js)
`mineBlock(bot,name,count=1)` → findBlocks maxDistance 32 → `collectBlock.collect` ; `craftItem(bot,name,count)` → table
(GoalLookAtBlock) → `recipesFor` → `bot.craft`, sinon `failedCraftFeedback` calcule la recette avec le moins d'items manquants
via `recipe.delta` → "I cannot make X because I need: N more Y" ; `smeltItem(bot,item,fuel,count)` → four dans 32, 240 ticks
par item ; `placeItem(bot,name,Vec3)` → premier voisin non-air comme référence, `GoalPlaceBlock`, `bot.placeBlock` ;
`killMob(bot,mob,timeout=300)` → `nearestEntity` <48, hawkeye à distance sinon `pvp.attack`, puis collecte du drop ;
`exploreUntil(bot,direction,maxTime=60,callback)` → toutes les 2 s `GoalNearXZ` 10–29 blocs dans la direction ;
`useChest.js` (téléporte si >32 blocs !). Chaque primitive incrémente un compteur d'échecs et lève après >10 échecs avec un
message actionnable.

### Gestion d'échec et limites
Parse du code : Babel AST, dernière fonction async top-level à un paramètre `bot` ; 3 retries de parse. Limites (papier) :
~15× le coût de GPT-3.5, ~50 $ pour 160 itérations ; items hallucinés ; APIs inexistantes ; **texte uniquement, pas de
vision** ; ablations : curriculum aléatoire −93 % d'items, sans self-verification −73 %. Le bot quitte/rejoint à chaque tâche
pour resynchroniser l'inventaire. Triche serveur massive (/tp, /give, /setblock, keepInventory, peaceful) → pas un
"vrai joueur". Dernier push 2024-04-03, issues auto-fermées.

## 2. MineDojo (+ MineCLIP) — MIT, dernier push 2024-03-18

Sources : https://github.com/MineDojo/MineDojo · docs.minedojo.org (obs_space, action_space, sim) · MineCLIP README/run.py ·
https://arxiv.org/abs/2206.08853

**Simulateur** : Gym `minedojo.make(task_id, image_size, …)`, 3 142 tâches (1 581 programmatiques auto-notées, 1 560
créatives, 1 playthrough). Personnalisation : seed, position/temps de départ, inventaire initial, météo, village,
`drawing_str`, santé/faim, mobs, type de monde. **Observation** : `rgb` (3,H,W) ; `equipment`/`inventory` (nom, quantité,
variante, durabilité) ; `delta_inv` (items gagnés/perdus — signal de succès programmatique propre) ; `voxels` 3×3×3 avec flags
(collidable, liquid, solid, can_burn, blocks_light, cos_look_vec_angle) ; `life_stats` ; `location_stats` (pos, yaw, pitch,
biome, rainfall, temperature, can_see_sky, is_raining, light_level, sky_light_level, sun_brightness, sea_level) ;
`nearby_tools` {table, furnace} ; `damage_source` ; lidar `rays`. **Actions** : `MultiDiscrete([3,3,4,25,25,8,244,36])`.

**Réalité** : backend Malmo/MineRL en Minecraft **1.11.2**, JDK 8, xvfb ; issues d'installation récurrentes (oct. 2025) sans
correctifs ; pas de multijoueur. Réutilisable : (a) taxonomie des tâches comme suite d'évaluation ; (b) schéma d'observation
(delta_inv, flags voxel, damage_source, light) comme checklist ; (c) **MineCLIP** : `(B,16,3,160,256)` → `encode_video` 512-d,
`encode_text`, `forward_reward_head` → `logits_per_video` ; checkpoints Google Drive ; MIT ; signal faible mais gratuit ;
(d) **base de connaissances** : YouTube 730K+ vidéos (CC BY 4.0), Wiki ~7K pages (CC BY-NC-SA 3.0 — non commercial),
Reddit 340K posts (CC BY 4.0), sur Zenodo. Pour un RAG "how-to", scraper le wiki actuel (le dump 2022 est pré-1.19).

## 3. ChatClef (elefant-ai) sur AltoClef + Baritone — AGPL-3.0

Sources : README chatclef · settings.gradle.kts / build.gradle · AltoClef.java · player2api/AICommandBridge.java,
Player2APIService.java, ConversationHistory.java, status/{StatusUtils,AgentStatus,WorldStatus}.java · AltoClefCommands.java ·
tasksystem/{Task,TaskRunner,TaskChain}.java · chains/{SingleTaskChain,UserTaskChain,MobDefenseChain}.java · TaskCatalogue.java ·
https://blog.player2.game/p/building-ai-npcs-with-player2-api · https://github.com/gaucho-matrero/altoclef (MIT, archivé 2024-06-28) ·
fork MiranCZ/altoclef (vivant, 1.16.5–1.21.1).

**Nature** : mod Fabric **côté client** qui embarque AltoClef + Baritone et ajoute un pont "Player2" ; l'app desktop Player2
(propriétaire) sert LLM/STT/TTS sur `http://127.0.0.1:4315`. Il "joue pour vous" parce que le LLM **choisit seulement des
commandes AltoClef** ; l'arbre de tâches déterministe + Baritone jouent réellement (`@gamer` = finir le jeu). Multi-version
1.17.1 → 1.21.1 via préprocesseur ; CurseForge 0.18.23 (2025-05-09), 13K téléchargements.

**Pont LLM ↔ tâches (AICommandBridge)** : system prompt = instructions générales + `{{characterName}}/{{characterDescription}}`
+ format du message utilisateur + format de réponse + `{{validCommands}}`. **L'état va dans le message utilisateur, pas le
system prompt** (compatible prompt-cache) : `{"userMessage","worldStatus","agentStatus","gameDebugMessages"}`. Réponse :
`{"reason","command","message"}` (≤250 caractères). File d'entrée plafonnée à 10, dédup, **batchée en un seul appel LLM** ;
`onFinish` → "Command feedback: X finished running. What shall we do next?", `onError` → "Command feedback: X FAILED…" —
cette boucle de feedback permet d'enchaîner des objectifs multi-étapes.

**Statut** : monde = dimension, météo, temps, spawn, difficulté, **comptes de blocs dans un cube de 12** (air exclu), hostiles
dans 32 avec coordonnées, autres joueurs ; agent = santé/faim/saturation, inventaire, armure, oxygène, tâche courante,
gamemode. Pas de position de l'agent, pas de lumière, pas d'item tenu.

**Mémoire (ConversationHistory)** : `MAX_HISTORY=64` ; au-delà, les 48 plus anciens sont résumés (≤500 caractères) et
réinsérés ; persistée en JSONL par personnage, écrite tous les 8 messages assistant.

**Vocabulaire de commandes (19)** : `get <items[:count]>`, `equip`, `deposit`, `goto x y z [dim]`, `idle`, `hero`,
`locate_structure`, `stop`, `food`, `meat`, `gamer`, `follow`, `give`, `scan`, `attack`, … chaînables avec `;`.

**Arbre de tâches** : `Task` = `onStart/onTick→subtask/onStop/isFinished/isEqual` ; **tout l'arbre est réévalué à chaque
tick**. `TaskRunner` choisit la chaîne de priorité max : `UserTaskChain` 50 ; `MobDefenseChain` 50+fuse×50 pour un creeper,
60 bouclier vs projectile, 65 attaque/esquive, 70 mob dangereux avec ≤10 HP, 80 fuite ; FoodChain, MLGBucketFallChain,
WorldSurvivalChain, UnstuckChain, DeathMenuChain… `TaskCatalogue` : ~500–700 entrées item → `ResourceTask` (mine, smelt,
mob, shapedRecipe2x2/3x3, smith, crop, woodTasks, tools/armor par matériau) ; `getItemTask(name,count)` résout "get
diamond_pickaxe" en arbre de dépendances déterministe.

**Pièges** : AGPL-3.0 (ne pas copier ; porter les idées depuis AltoClef MIT) ; dépendance à l'app Player2 ; client complet
(GPU) par agent.

## 4. Patterns réutilisables et recommandations (corps Mineflayer/TS + esprit Python)

1. **Contrôle à deux vitesses** : Voyager n'a pas de couche réactive ; la qualité de ChatClef vient des chaînes de priorité
   au tick. → `TaskRunner` TS avec chaînes (MobDefense 50–100, Food, Fall, Unstuck, Sleep, UserTask 50) réévaluées à chaque
   tick ; l'esprit Python ne fait que soumettre/remplacer la UserTask. La sémantique d'interruption compte plus que les prompts.
2. **Couche commandes d'abord, couche code ensuite** : porter `TaskCatalogue` en TS (résolveur item → mine|craft|smelt|mob
   via les recettes minecraft-data ; `failedCraftFeedback` de Voyager est l'algorithme prêt). Vocabulaire réduit (`get`,
   `goto`, `follow`, `equip`, `deposit`, `attack`, `explore`, `place`, `scan`, `stop`). Repli sur des **skills JS écrits par
   le LLM** seulement quand aucune tâche cataloguée n'existe, puis stockage du skill vérifié → le vocabulaire grandit.
3. **Contrat des primitives** : signatures Voyager mais résultats structurés `{ok, reason, missing}`, compteurs d'échecs,
   **zéro triche** (pas de `/tp`, `/give`).
4. **Sécurité d'exécution** : validation statique (une fonction async), isolat/worker avec budget temps et annulation
   coopérative ; interdire `bot.on/once` et `bot.chat('/…')`.
5. **Schéma d'observation** : fusion Voyager status + ChatClef world status + checklist MineDojo (delta_inv, lumière,
   damage_source, nearby_tools). État volatile dans le message utilisateur, system prompt statique (cache).
6. **Format de réponse** : `{reason, speech (≤250, vide = silence), action: {type: command|code|none}}` en sortie structurée native.
7. **Vérification** : programmatique d'abord (inventaire/delta, bloc posé, entité disparue) ; critic LLM pour le flou ;
   critique réinjectée ; 4 retries max.
8. **Pile mémoire** : dialogue (résumé roulant + épisodique), skills (embedding de la description, code sur disque),
   mémoire du monde (POIs par dimension+position), connaissances (`qa_cache` question→réponse avec dédup vectorielle).
9. **Curriculum** : warm-up, templates, garde-fou "inventaire ≥33 → déposer", listes complétées/échouées, feedback de commandes.
10. **Perception** : Mineflayer ne donne pas de pixels → viewer headless + VLM, ou mod "yeux". L'esprit doit fonctionner
    sur l'observation symbolique, la vision est un enrichissement.
11. **Versions** : tout épingler.
12. **Licences** : Voyager MIT, MineDojo/MineCLIP MIT, AltoClef original MIT, ChatClef **AGPL-3.0** → réimplémenter.
