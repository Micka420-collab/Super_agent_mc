# Synthèse de recherche — ce que les 12 projets (et l'état de l'art 2026) nous apprennent

Rapports bruts, avec URLs et détails : [`docs/research/`](research/). Cette page est la lecture exploitable : pour chaque
projet, ce qu'on **reprend**, ce qu'on **évite**, et où ça se retrouve dans EMETH.

## Contexte 2026 à connaître

- Minecraft Java a abandonné la numérotation 1.x après 1.21.11 : **26.1** (mars 2026), **26.2** (juin), **26.3**
  (sept.). Mineflayer 4.39 (sept. 2026) supporte jusqu'à **26.1** ; 26.2 est en PR (`pc26_2`), 26.3 n'a rien. Tout le
  monde met **ViaProxy** devant le serveur pour jouer sur 26.2+. Azalea (Rust) est sur 26.2 en main, Baritone sur 26.3.
- **DeepMind, 15 oct. 2026** : quatre agents Gemini 4 Argon finissent le jeu (dragon) en 27 h via Mineflayer, 2 783
  programmes JS auto-écrits (async, timeout 60 s, globals persistants), texte seul, 605 morts, 22 % d'erreurs de code.
  Limites avouées : perception « à travers la roche », difficulté Easy, une seule run. → La **perception honnête** est un
  vrai différenciateur ; les « programmes comme actions » marchent ; il faut tolérer l'erreur de code et la corriger.
- **MC-EvoBench (oct. 2026)** : l'« expérience » sauvegardée par les agents actuels ne se transfère pas. → Notre
  consolidation en rêve + skills avec taux de succès visent exactement ce trou.
- Trous que personne n'a comblés : corps à jour 26.2/26.3, boucle vocale complète (l'API Simple Voice Chat
  `createAudioSender` existe, jamais intégrée à un bot Mineflayer), construction créative au-delà des templates, survie
  longue en Normal/Hard, implémentation ouverte de PIANO, corps Python natif.

## Les 12 projets

### Voyager (MineDojo, MIT, figé 2023)
**Repris** : curriculum automatique, bibliothèque de skills (code JS + description embarquée), prompting itératif avec
feedback d'exécution, self-verification par un critic, warm-up des champs d'observation, garde-fou « inventaire plein →
déposer », primitives `mineBlock/craftItem/smeltItem/placeItem/killMob/exploreUntil`, `failedCraftFeedback` (recette
avec le moins d'items manquants via `recipe.delta`). → `mind/cognition/skills.py`, `memory/procedural.py`,
`cognition/planner.py`, `body/actions/crafting.ts` (`describeRecipes`).
**Évité** : `eval` sans sandbox ni timeout, triche serveur (`/tp`, `/give`, `keepInventory`, peaceful), MC 1.19 figé,
texte seul, 50 $/160 itérations en GPT-4.

### MineDojo (+ MineCLIP) (MIT, non maintenu)
**Repris** : le **schéma d'observation** comme checklist (delta d'inventaire, lumière, source de dégâts, outils proches),
la taxonomie des tâches comme future suite d'évaluation. MineCLIP reste une option de scoring vidéo gratuite.
**Évité** : le simulateur (Malmo, MC 1.11.2, JDK 8), le dump wiki 2022 (pré-1.19, CC BY-NC-SA).

### ChatClef / AltoClef / Baritone (AGPL-3.0 — **pas copié**)
**Repris (réimplémenté depuis AltoClef MIT)** : **chaînes de priorité réévaluées à chaque tick** (défense 50–100,
nourriture, chute, déblocage, tâche utilisateur 50) qui préemptent la tâche en cours ; état volatile dans le message
utilisateur et system prompt statique (cache de prompt) ; réponse `{reason, command, message}` ; feedback « X finished /
FAILED → what next? » qui fait enchaîner les objectifs ; `TaskCatalogue` item → arbre de dépendances déterministe (à
porter en TS, voir roadmap). → `body/motor/reflexes.ts`, `cognition/decide.py`, `cognition/loop.py`.
**Évité** : AGPL, dépendance à l'app propriétaire Player2, client complet (GPU) par agent.

### VoxelMind (Fabric, MIT, très actif, 1.21 → 26.2)
**Repris** : décision purement événementielle avec debounce (chat 300 ms, blessure 150 ms, résultat 400 ms), « un dire +
une action par décision », résultats d'action **rédigés comme des observations**, `keep_current_action` en dernier pour la
stabilité du cache, `wait(seconds, for_what)`, timeline en anneau avec repli des doublons « (x3) », mémoire en deux blocs
réécrits toutes les 24 lignes avec **règles d'attribution des sources**, persona = dossier de données rechargeable à chaud,
quirks appris par modèle (`tool_choice` refusé → auto, `response_format` refusé → prompt), journal JSONL des décisions,
budget de requêtes/minute partagé, provenance des blocs posés par les joueurs. → `memory/episodic.py`,
`memory/consolidation.py`, `social/persona.py`, `llm/openai_compat.py`, `cognition/loop.py`.
**Évité** : téléportation vers le propriétaire au-delà de 64 blocs, une action par décision sans parallélisme.

### CraftyAI (Apache-2.0 client, backend fermé)
**Repris** : confirmation dans les 30 s pour les actions destructrices, « exécuter puis narrer ». **Évité** : pas de corps,
plan de contrôle distant.

### AgentCraft (MIT, 26.3 solo)
**Repris** : protocole WebSocket localhost défini en zod (`hello → snapshot → upserts`), décisions avec options fixes,
refus des connexions avec `Origin`. → `body/bridge/server.ts`, dashboard à venir. **Évité** : avatars client-only sans
agentivité.

### mc_aiplayer / AIBot (MIT, Fabric 1.21.3)
**Repris** : LLM choisit dans un vocabulaire d'outils **validés**, exécution déterministe par des machines à états avec
**postconditions typées**, perception `strict_survival` par raycast (pas de x-ray), `highlights` (plus proche de chaque
ressource clé), matrice de capacités honnête, enregistreur de replays, snapshots atomiques. → `cognition/planner.py`
(`check_success`), `body/perception/fov.ts`. **Évité** : une seule version de MC, pas de dialogue.

### Minecraft Survival MCP Server (MIT)
**Repris** : granularité « transaction », pré-vérification des ressources avant de bâtir (`required/available/missing`),
watchdog de progrès, compteurs `placed/skipped/failed`, exposition MCP (à venir côté esprit). → `body/actions/building.ts`.
**Évité** : retours en texte brut, promesses jamais annulées, pas de mutex d'actions.

### ai-memory (MIT, Rust, très actif)
**Repris** : **markdown = vérité, SQLite = index** reconstructible, FTS5 + vecteurs fusionnés par RRF, formule de rétention
`salience·e^(−λt) + σ·log(1+accès)·e^(−μ·jours)·(…)`, brief de session tiered avec budget d'octets et **clôture
« historique non fiable »**, handoff « offre, pas revendication » entre fournisseurs, chaîne de fallback LLM avec classes
d'erreurs transitoires/déterministes. → `memory/store.py`, `memory/semantic.py`, `memory/soul.py`, `llm/router.py`.

### graphify (Apache/MIT, Python, très actif)
**Repris** : schéma `graph.json` (networkx node_link), communautés Louvain déterministes (seed 42) = **régions**, requête
BFS à budget de tokens, confiance `EXTRACTED/INFERRED/AMBIGUOUS`. → `memory/spatial.py`.

### cc-switch (MIT, Tauri)
**Repris** : modèle de fournisseur (`api_format`, `base_url`, `api_key_env`, `models{tier→model}`), **un format interne
unique** + adaptateurs, file de failover ordonnée (une tentative par fournisseur), circuit breaker 4/2/60 s/0.6/10, jamais
de failover en cours de stream. → `llm/router.py`, `config.py`.

### HyperFrames (Apache-2.0)
**Repris (roadmap)** : rendu HTML → vidéo déterministe en batch (`render --batch rows.json`) pour un **récap vidéo
quotidien** de l'agent à partir de la timeline et des frames de la rétine. Non codé pour l'instant.

## Décisions prises (résumé des ADR)

1. **Corps Mineflayer**, pas mod serveur : fonctionne sur n'importe quel serveur sans installation, l'API est connue des
   LLM (le code généré marche), écosystème riche ; interface `BodyAPI` fine pour pouvoir brancher azalea (Rust) ou un
   faux `ServerPlayer` Fabric plus tard. (ADR-0001)
2. **Contrôle à deux vitesses** : réflexes déterministes au tick dans le corps, esprit événementiel. (ADR-0002)
3. **Perception honnête + rétine** par raycast, cohérentes entre texte et image. (ADR-0003)
4. **Mémoire wiki/SQLite** en 5 couches, consolidation au sommeil, âme portable. (ADR-0004)
5. **Sandbox de skills à trois couches** et vocabulaire de primitives validées avant tout code généré. (ADR-0005)
