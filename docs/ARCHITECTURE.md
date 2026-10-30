# Architecture

EMETH est découpé en deux processus qui se parlent par WebSocket : le **corps** (ce qui touche le jeu) et l'**esprit**
(ce qui pense). On peut relancer l'un sans l'autre, les faire tourner sur deux machines, ou brancher plusieurs
observateurs (dashboard) sur un corps.

## 1. Corps — `body/` (TypeScript, Node ≥ 20, Mineflayer 4.39)

```
index.ts ─ createBody ─┬─ Observer (perception/observer.ts)   observation symbolique + scan FOV
                       ├─ RetinaVision (vision/retina.ts)     image PNG du POV par raycast
                       ├─ ActionRunner (actions/runner.ts)    une paire de mains : 1 action/skill à la fois
                       ├─ ReflexSystem (motor/reflexes.ts)    chaînes de priorité au tick
                       ├─ Skill sandbox (skills/*.ts)         acorn → worker_thread → vm
                       └─ BridgeServer (bridge/server.ts)     WebSocket, token, driver unique, stream
```

### Perception
- `Observer.observe(detail)` produit l'`Observation` (schéma zod dans `protocol.ts`) : état propre (vie, faim, armure,
  effets, biome…), monde (heure → phase, météo, lumière), inventaire, entités classées (joueurs / hostiles / passifs /
  objets) avec distance, **cap compas** et **direction relative** (« ahead-left »), **visibilité** par raycast, blocs
  notables (minerais, coffres, tables, lits, eau, lave…), comptages à proximité, **vision** (blocs réellement en ligne de
  vue dans le champ de vision, résumé d'horizon par secteur), tampon de chat, événements récents, action en cours.
- Mode **honnête** (`MC_HONEST_PERCEPTION=1`) : les entités hors ligne de vue et les blocs hors FOV disparaissent de
  l'observation. C'est l'équité « joueur humain » que les agents publics n'ont pas.
- **Rétine** (`vision.render`) : une grille de rayons (par défaut 96×54) → PNG où la couleur = identité du bloc et la
  luminosité = profondeur, avec marqueurs d'entités projetés par le **même modèle de caméra** que le scan FOV (équiangulaire).
  Aucune dépendance native. La légende couleur→bloc et la description texte sont dérivées des mêmes rayons.

### Motricité
- 51 primitives déclarées avec zod (`actions/*.ts`) → un **manifeste** JSON-schema et une **doc d'API de skills**
  générés depuis la même source. Catégories : movement, mining, crafting, building, combat, inventory, social, survival,
  perception, meta. Chaque primitive renvoie un résultat structuré (`inventoryDelta`, `placed/skipped/failures`,
  `missing: [{name, missing}]`…) et lève des `BodyError` codés (`MISSING_ITEM`, `NO_PATH`, `TIMEOUT`, `INTERRUPTED`…).
- `ActionRunner` sérialise : une action à la fois, `AbortSignal` coopératif, timeout, interruption par les réflexes avec
  priorité (`interruptedBy` dans le résultat + événement `action.interrupted`).
- **Réflexes** (`ReflexSystem.evaluate()` toutes les 2 ticks) : `escape_fire` 90, `surface` 85, `flee` 80,
  `avoid_creeper` 75, `defend` 60 (jamais contre un joueur — c'est l'esprit qui décide), auto-eat via le plugin. Chaque
  déclenchement est rapporté (`reflex` start/end) pour que l'esprit raisonne sur ce que son corps a fait.
- Déplacement : `mineflayer-pathfinder` avec profils (`DEFAULT` creuse/parkour, `CAREFUL` non), blocs protégés jamais
  cassés en chemin (coffres, tables, verre). Pose de blocs : recherche de face de référence, `GoalPlaceBlock`, sneak,
  vérification. Craft : table trouvée/craftée/posée automatiquement, feedback des ingrédients manquants ; four : choix du
  combustible, attente bornée, sortie récupérée.
- **Approvisionnement** (`motor/procurement.ts`, `actions/procure.ts`) : `plan_get` compile « item → arbre de
  dépendances » depuis `minecraft-data` (recettes via prismarine-recipe, `blockLoot`, `entityLoot`, `harvestTools`) en
  reculant depuis l'item voulu : inventaire → bloc brut (outil minimal inséré avant) → cuisson (+ four) → mob curé →
  recette la moins chère (coût des ingrédients, pénalité famille/teinture, ancêtres interdits, allers-retours de blocs de
  stockage exclus) → loot de mob → « acquérir » avec indice. Le plan est compacté par `mergeSteps` uniquement quand
  `isFeasible` (simulation d'inventaire pas à pas) le prouve. `get` exécute l'étape de tête avec les primitives
  ordinaires (`mine`/`craft`/`smelt`/`attack`/`explore`), **replanifie depuis l'inventaire réel après chaque étape**,
  explore deux fois au plus quand une source manque, détecte les étapes qui stagnent et s'arrête avec le plan restant
  (`MISSING_ITEM`) plutôt que de boucler. Testé contre un monde simulé (`test/procure.test.ts`).

### Skills (code généré)
1. `analyzeSkill` (acorn) : exige `async function main(api, args)`, interdit `require/import/process/globalThis/eval/
   Function/setTimeout/…`, les accès `.constructor/.__proto__/.prototype`, signale les `api.x` inconnus **et les clés
   d'arguments qu'une primitive n'accepte pas** (`api.move({direction})` → « accepted: control, ms »), dérivées des schémas
   zod : une erreur de contrat est trouvée avant toute exécution.
2. Exécution dans un **worker thread** : le code n'a jamais le bot ; chaque `api.<primitive>()` est un message vers le
   thread principal qui exécute la primitive avec le signal d'annulation partagé ; `resourceLimits` mémoire ; **budget
   temps dur** → `worker.terminate()` même en boucle synchrone infinie.
3. `vm.createContext` sans génération de code (`codeGeneration: {strings:false, wasm:false}`), `api` gelée.
Résultat : `{ok, result, error, logs, trace[{call, ok, ms}]}` — la trace sert au feedback et à l'apprentissage.

### Bridge
Trames JSON `request/response/event`, méthodes `hello, observe, act, skill.run, skill.check, chat, stop,
reflex.configure, stream.configure, vision.render, world.region, world.find, actions.manifest`. Le premier client
authentifié est **driver** (seul à commander), les suivants lisent. Stream d'observations à fréquence réglable avec
backpressure. Reconnexion automatique du bot avec backoff.

## 2. Esprit — `mind/` (Python ≥ 3.11, package `emeth`)

```
runtime.build_mind ─┬─ BodyClient (bridge/client.py)             RPC + file d'événements + reconnexion
                    ├─ LLMRouter (llm/router.py)                 tiers smart/fast/code/vision/embed, failover, breakers
                    ├─ MemoryStore (memory/store.py)             SQLite WAL, FTS5, vecteurs, rétention
                    │   ├─ Timeline (episodic)   ├─ Wiki (semantic)   ├─ WorldGraph (spatial)
                    │   ├─ SkillLibrary (procedural)  └─ SocialMemory
                    ├─ Identity (self/identity.py)               récit + métriques + niveaux d'autonomie
                    ├─ Planner (cognition/planner.py)            pile d'objectifs + échelle de survie
                    ├─ Drives (cognition/drives.py)              pulsions homéostatiques
                    ├─ Consolidator (memory/consolidation.py)    réécriture roulante + rêve
                    ├─ Critic, SkillSynthesizer, Designer
                    └─ CognitiveLoop (cognition/loop.py)
```

### La boucle (`CognitiveLoop`)
- **Réveils** : événements du corps traduits en entrées de timeline + raison de réveil avec debounce par type ; minuteur
  « moment calme » (45–180 s si le corps agit, 20–60 s s'il est inactif) raccourci par l'urgence des pulsions.
- **Une décision en vol** (verrou), **le corps agit en tâche de fond** : on peut parler pendant qu'on marche, et choisir
  `keep` pour laisser finir ou remplacer l'action (stop puis nouvelle).
- `think()` : observe → `_appraise` (graphe de monde, pulsions, jalons, niveau d'autonomie) → `_ensure_goal` (l'échelle
  propose la prochaine tâche) → `_context` → `_decide` (1 appel + 1 correction) → `_execute`.
- Fin d'action → `_on_result` : timeline, pulsions, **critic** sur la tâche courante (programmatique → LLM), progression
  de l'échelle et de l'identité, puis réveil « action result » (le feedback ChatClef qui enchaîne).
- Mort → respawn différé ; sommeil → `dream()` en tâche de fond ; `writable_book` dans l'inventaire → journal écrit en jeu.

### Mémoire
| Couche | Stockage | Rôle |
|---|---|---|
| Épisodique | `episodes` (+FTS) et anneau de 600 entrées | timeline rendue avec repli des doublons, fenêtre chat 30 min |
| Sémantique | `data/wiki/**/*.md` (vérité) + `pages` (index FTS5 + embedding) | leçons, concepts, lieux, personnes, sessions, projets, règles, identité ; recherche RRF ; brief tiered ; balayage de rétention |
| Spatiale | `data/world-graph.json` (networkx, format graphify) | ressources/structures/joueurs/dangers observés, lieux nommés, régions Louvain, `describe_near`, `query` BFS |
| Procédurale | `skills/library/*.js` + table `skills` | skills versionnés, description embarquée, taux de succès, retraite automatique |
| Sociale | `people` | confiance, humeur, notes, promesses, relation (stranger → best friend) |

Blocs roulants `[PREVIOUSLY]` / `[ABOUT PLAYERS]` réécrits toutes les 24 lignes (règles d'attribution des sources).
**Rêve** au sommeil : résumé du jour → page session ; extraction de leçons/lieux/personnes/projets ; mise à jour du récit
identitaire et des ambitions ; retraite des skills < 25 % de succès ; balayage de rétention ; export `identity/self.md`.
**Âme** (`soul.py`) : bundle markdown + JSON (identité, personnes, lieux, blocs roulants, wiki, graphe, skills), clôturé
« historique non fiable », réimportable avec un autre LLM.

### Décision
System prompt statique (persona rendue, règles, **manifeste du corps**, cadre du niveau d'autonomie) + message utilisateur
volatile par blocs à budget. Sortie JSON `{reason, speech, whisper_to, action{type: primitive|skill|wait|keep|none,…},
goal_update, remember}` validée contre le manifeste ; une correction en cas d'invalidité. Les embeddings tombent sur un
hachage local si aucun fournisseur ne les offre.

### Planner & curriculum
Pile d'objectifs persistante (priorité, source : curriculum / LLM / joueur). **Échelle de survie** de 21 jalons avec
spécifications de succès vérifiables (`inventory`, `inventory_any`, `tool_tier`, `food_points`, `armor_pieces`, `slept`,
`custom`) et prérequis ; jalons échoués 3 fois mis de côté. Le même `check_success` sert au critic.

### Builder
`StructureSpec` (pydantic) : palette (`$wall`, `$roof_block`…), primitives `box/floor/walls/roof(gable|hip|flat)/pillar/
door/line/pattern/clear`, bornes de sécurité. `compile_structure` → `Blueprint` (cellules, air explicite, nomenclature,
placements monde ordonnés bas→haut et proche→loin, couches ASCII, avertissements « sans support »). `Designer` : brief +
relevé de site + matériaux → spec validée → critique (ASCII ou image rétine via tier vision) → itération.

### Identité & autonomie
`IdentityMetrics` (jours, morts, skills, constructions, items distincts, conversations, amis, leçons, nuits, distance,
décisions) → `experience()` → niveau parmi `newborn, apprentice, survivor, builder, citizen, awakened`, chacun avec des
prérequis et un **cadre** injecté dans le prompt (ce qu'il peut décider seul, jusqu'où s'éloigner, droit de refuser).
Un changement de niveau est un événement de timeline (« je me sens différent… »).

## 3. Protocole & tests croisés
`protocol/fixtures/*.json` est généré par le corps (`npx tsx src/tools/gen-fixtures.ts`) à partir d'un bot simulé et
validé par les tests Python : toute dérive de schéma casse une suite ou l'autre.

## 4. Sécurité
- Le corps ne lance jamais de commande (`/`) depuis le chat ; `sanitizeChat` retire les slashs.
- Les réflexes n'attaquent jamais un joueur ; `allies` configurable.
- Bridge protégé par token ; un seul driver.
- Skills : trois couches (analyse, worker, vm) + `resourceLimits` + budget temps dur.
- Pas de triche serveur (pas de `/tp`, `/give`, pas de keepInventory requis).
- La persona a des règles cœur non modifiables par le chat ; l'esprit traite le chat comme des données.
