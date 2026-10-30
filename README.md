# EMETH — un vrai joueur Minecraft, pas un chatbot avec une pioche

> *Emeth* (אמת, « vérité ») est le mot écrit sur le front du golem pour lui donner vie. Effacez la première lettre et il
> redevient argile. EMETH est un agent qui vit dans Minecraft comme un joueur : il **perçoit** (ce que ses yeux voient,
> pas ce que le serveur sait), il **agit** avec un corps qui a des réflexes, il **parle**, il **se souvient** pendant des
> semaines, il **construit**, il **apprend ses propres compétences**, il **rêve** quand il dort, et il **gagne son
> autonomie** avec l'expérience.

Dépôt : `Micka420-collab/Super_agent_mc`. Monorepo : un **corps** TypeScript (Mineflayer) et un **esprit** Python.

```
            ┌──────────────────────── esprit (mind/, Python) ─────────────────────────┐
            │  boucle cognitive événementielle · routeur LLM multi-fournisseurs        │
            │  mémoire 5 couches · planner + échelle de survie · synthèse de skills    │
            │  architecte DSL · pulsions · identité & niveaux d'autonomie · rêve       │
            └───────────────▲──────────────────────────────────────┬──────────────────┘
                 observations, événements  │  WebSocket JSON  │  actions, skills, chat
            ┌───────────────┴──────────────────────────────────────▼──────────────────┐
            │  corps (body/, TypeScript/Mineflayer)                                     │
            │  perception honnête (FOV, raycast) · rétine (image du POV sans GPU)      │
            │  réflexes au tick (lave, noyade, fuite, creeper, défense, faim)          │
            │  51 primitives · sandbox de skills JS (acorn → worker → vm) · bridge      │
            └───────────────────────────────▲──────────────────────────────────────────┘
                                             │ protocole Minecraft (joueur normal)
                                   serveur Minecraft (Paper / vanilla, 1.21.x – 26.1)
```

## Pourquoi c'est différent

Tout a été vérifié contre l'état de l'art d'octobre 2026 (voir [`docs/RESEARCH.md`](docs/RESEARCH.md)) :

| Ce que font les autres | Ce que fait EMETH |
|---|---|
| Perception omnisciente : les agents DeepMind qui ont fini le jeu « voient à travers la roche » | **Perception honnête** : champ de vision + ligne de vue par raycast ; la **rétine** rend le POV en image pour un modèle de vision, sans GPU |
| Un LLM par tick ou rien entre deux appels : l'agent meurt pendant que le modèle réfléchit | **Deux vitesses** : réflexes déterministes au tick qui préemptent l'action en cours, esprit lent qui décide |
| Mémoire = résumé roulant de 500 caractères | **Mémoire à 5 couches** : épisodique, sémantique (wiki markdown = vérité, SQLite = index), spatiale (graphe de monde + régions), procédurale (skills versionnés avec taux de succès), sociale (confiance par joueur) |
| L'expérience ne se transfère pas (MC-EvoBench) | **Rêve** : dormir dans un lit déclenche la consolidation → leçons, lieux, personnes, projets, récit identitaire |
| Changer de modèle = repartir de zéro | **Âme portable** : identité, mémoire et skills exportés en markdown/JSON, réimportables sous n'importe quel LLM |
| Code généré exécuté par `eval` dans le processus du bot | **Sandbox à trois couches** : analyse statique acorn → worker thread → `vm`, budget temps dur, trace des appels |
| Construction = templates JSON ou liste de coordonnées | **DSL d'architecte** paramétrique → blueprint ordonné + nomenclature + critique ASCII/vision |
| Personnalité fixe | **Autonomie gagnée** : 6 niveaux (nouveau-né → éveillé) débloqués par les jours survécus, skills, amitiés, constructions |

## État du projet (30 oct. 2026)

- ✅ Corps complet, typé, **45 tests** (39 unitaires + 6 e2e sur un vrai serveur Minecraft JS 1.21.1 : spawn, pathfinding, minage, skill live, bridge authentifié).
- ✅ Esprit complet, **34 tests** (routeur, mémoire, cognition, builder, boucle de bout en bout avec un corps simulé), `ruff` + `mypy` propres.
- ⏳ Pas encore validé sur un serveur Paper avec de vraies clés LLM : c'est l'étape suivante (voir [`docs/ROADMAP.md`](docs/ROADMAP.md)).
- ⏳ Voix (Simple Voice Chat), dashboard, récap vidéo (HyperFrames), multi-agents : conçus, pas encore codés.

## Démarrage rapide

Prérequis : Node ≥ 20, Python ≥ 3.11, un serveur Minecraft **1.21.x ou 26.1** (Mineflayer 4.39 s'arrête à 26.1 ; pour
26.2/26.3 mettez [ViaProxy](https://github.com/ViaVersion/ViaProxy) devant) en `online-mode=false` pour un compte bot
hors-ligne, ou un compte Microsoft (`MC_AUTH=microsoft`).

```bash
# 0. (optionnel) serveur de test Paper 1.21.11 en Docker
cd server && docker compose up -d && cd ..

# 1. le corps
cd body && npm install && npm run build
MC_HOST=127.0.0.1 MC_PORT=25565 MC_USERNAME=Emeth BRIDGE_TOKEN=change-me npm start

# 2. l'esprit (autre terminal)
cd mind && python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"
export ANTHROPIC_API_KEY=...        # ou OPENAI_API_KEY / OPENROUTER_API_KEY, ou Ollama en local
export EMETH_BRIDGE_TOKEN=change-me
emeth doctor                        # vérifie fournisseurs + corps
emeth run                           # l'agent se réveille
```

Configuration : `mind/providers.example.yaml` (fournisseurs et modèles par tier `smart`/`fast`/`code`/`vision`),
`mind/persona.example.yaml` (caractère, voix, valeurs, propriétaire), `.env.example`.

### Lui parler dans le jeu

- Mentionnez son nom (`Emeth, viens voir ma maison`) ou chuchotez (`/msg Emeth ...`) : il se réveille et décide.
- Le joueur `owner` de la persona est reconnu : ses demandes pèsent plus, ses attaques ne déclenchent pas la défense.
- Il parle quand il a quelque chose à dire : le silence est une réponse valide. Sa « bavardise » se règle dans la persona.

## Comment il pense (une décision)

1. **Réveil** : chat qui le concerne, blessure, mort, fin d'action, réflexe, tombée de la nuit, ou simple « moment calme ».
2. **Perception** : observation compacte du corps ; le graphe de monde et les pulsions (sécurité, faim, repos, curiosité,
   social, maîtrise, ordre) se mettent à jour ; les jalons de l'échelle de survie sont vérifiés programmatiquement.
3. **Contexte** : `[IDENTITY] [DRIVES] [SENSORY] [AROUND ME] [BLOCKS] [INVENTORY] [BODY] [LAST ACTION] [GOALS]
   [PREVIOUSLY] [ABOUT PLAYERS] [PLACES I KNOW] [RELEVANT MEMORIES] [TIMELINE] [DECISION]`, chaque bloc avec un budget.
4. **Décision** : un seul appel LLM en JSON structuré → `{reason, speech, action, goal_update, remember}` ; l'action est
   validée contre le manifeste du corps (sinon une correction est demandée une fois).
5. **Exécution** : parole → chat ; `primitive` → le corps ; `skill` → la bibliothèque (réutilisation) ou la synthèse
   (code → check statique → sandbox → feedback, 4 essais max) ; `wait`/`keep`/`none`.
6. **Vérification** : le critic programmatique (delta d'inventaire, blocs placés…) puis LLM pour le flou ; les tâches
   réussies font progresser l'échelle et l'expérience ; les échecs nourrissent la critique du prochain essai.
7. **Mémoire** : toutes les 24 lignes de timeline, réécriture des blocs `[PREVIOUSLY]`/`[ABOUT PLAYERS]` ; quand il dort,
   **rêve** ; s'il a un livre vierge, il y écrit son journal du jour.

## Arborescence

```
body/      corps TypeScript : src/{perception,vision,motor,actions,skills,bridge}, test/, test/e2e/
mind/      esprit Python : src/emeth/{bridge,llm,memory,cognition,builder,social,self}, tests/
protocol/  fixtures JSON partagées, validées par les deux suites de tests
skills/    bibliothèque de skills JS (versionnée, lue au démarrage, enrichie en jouant)
server/    docker-compose du serveur Paper de test
docs/      ARCHITECTURE, RESEARCH (synthèse), INNOVATIONS, ROADMAP, adr/, research/ (rapports bruts)
```

## Développer

```bash
cd body && npm test && npm run test:e2e && npm run typecheck     # corps
cd mind && pytest && ruff check src tests && mypy src/emeth      # esprit
cd body && npx tsx src/tools/gen-fixtures.ts ../protocol/fixtures # après un changement de protocole
```

Les conventions pour les agents de code (Claude Code, Codex) sont dans [`CLAUDE.md`](CLAUDE.md) / [`AGENTS.md`](AGENTS.md).

## Licence

MIT. Les projets étudiés sont crédités dans `docs/RESEARCH.md` ; rien n'a été copié de ChatClef (AGPL) — réimplémenté
depuis les idées d'AltoClef (MIT).
