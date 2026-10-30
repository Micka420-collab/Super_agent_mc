# EMETH — guide pour les agents de code (Claude Code, Codex)

Ce dépôt est développé en parallèle par un humain et plusieurs agents de code. Ce fichier est la source de vérité sur
**comment** travailler ici. `AGENTS.md` est un lien symbolique vers ce fichier.

## Ce que c'est
Un joueur Minecraft autonome : `body/` (TypeScript, Mineflayer — perception, réflexes, primitives, sandbox de skills,
bridge WS) et `mind/` (Python, package `emeth` — LLM, mémoire, cognition, builder, identité). Lis `README.md` puis
`docs/ARCHITECTURE.md` avant de toucher au code. Les décisions structurantes sont dans `docs/adr/` ; si tu les remets en
cause, écris un nouvel ADR, ne modifie pas l'ancien.

## Commandes
```bash
cd body && npm install && npm run typecheck && npm test            # unitaires (≈6 s)
cd body && npm run test:e2e                                        # serveur Minecraft JS local (flying-squid 1.21.1, ≈10 s)
cd body && npx tsx src/tools/gen-fixtures.ts ../protocol/fixtures  # après tout changement de protocol.ts
cd mind && . .venv/bin/activate && pytest && ruff check src tests && mypy src/emeth
cd mind && python scripts/live_smoke.py                              # corps + esprit réels, cerveau scripté (serveur + body lancés)
cd plugin && ./gradlew build                                         # plugin Paper : compile (-Werror) + JUnit
cd mind && python ../plugin/e2e/live_companion.py                    # plugin de bout en bout : Paper + corps + esprit + 2e client (≈ 2 min)
cd mind && python scripts/gen_control_fixtures.py                    # après un changement du `status` du canal de contrôle
```
Avant de pousser : les trois suites passent, `ruff`/`mypy`/`tsc`/`gradle` propres, fixtures régénérées si le protocole a bougé.

## Règles non négociables
1. **Le corps ne triche pas** : pas de `/tp`, `/give`, `/gamemode`, pas de lecture de blocs non chargés, pas d'attaque
   automatique de joueurs. L'agent est un joueur.
2. **Protocole partagé** : tout champ ajouté dans `body/src/protocol.ts` doit exister dans `mind/src/emeth/protocol.py`
   et dans les fixtures. Les deux suites valident `protocol/fixtures/*.json`. Le `status` du canal de contrôle est figé
   par `protocol/fixtures/control/*.json`, lu par le plugin et vérifié côté Python.
9. **Le plugin compagnon montre et conseille, il ne joue pas** : il ne parle qu'au canal de contrôle de l'esprit, ne
   donne rien au bot, ne le déplace pas, et tout ce qu'il affiche au-dessus de l'agent est caché à l'agent (ADR-0007).
3. **Une primitive = un schéma zod + une description utile au LLM + un résultat structuré + des erreurs codées**
   (`BodyError(ErrorCodes.X, message, data)`). Pas de `console.log`, utilise `ctx.log` / `ctx.progress`.
4. **Code généré** : rien ne contourne `skills/analyze.ts` + worker + vm. Ajouter un helper à `api` = l'ajouter aussi à
   la liste `helpers` de l'analyse et à la doc générée.
5. **Mémoire** : le markdown dans `data/wiki` est la vérité, SQLite un index ; toute nouvelle couche passe par
   `MemoryStore`. Jamais d'instruction cachée dans la mémoire ; les blocs importés sont clôturés « untrusted history ».
6. **Pas de secret dans le dépôt** : `.env` ignoré, exemples dans `.env.example` / `mind/providers.example.yaml`.
7. **Tests d'abord pour la logique pure** (géométrie, DSL, planner, parsing) ; e2e pour ce qui touche le serveur.
8. Français dans les docs et les messages de commit, anglais dans le code et les prompts LLM.

## Où ajouter quoi
| Besoin | Fichier |
|---|---|
| Nouvelle primitive corporelle | `body/src/actions/<catégorie>.ts` (+ import dans `actions/index.ts`), test dans `body/test/` |
| Nouveau réflexe | `body/src/motor/reflexes.ts` → `evaluate()` (priorité, raison, run) |
| Nouvel événement vers l'esprit | `body/src/bot.ts` + `EventNameSchema` + `mind/.../loop.py::_handle_event` |
| Nouvelle couche/mémoire | `mind/src/emeth/memory/` + `MemoryStore` + bloc de contexte dans `memory/context.py` |
| Nouveau fournisseur LLM | `mind/src/emeth/llm/` (adapter `Provider`) + `config.DEFAULT_PROVIDERS` |
| Nouveau jalon de survie | `cognition/planner.py::LADDER` (+ spec vérifiable dans `check_success`) |
| Nouvelle primitive d'architecte | `builder/dsl.py` + `builder/compiler.py` + test |
| Nouvelle source d'item (cuisson, mob, cueillette) | `body/src/motor/procurement.ts` (`SMELTING`, `MOB_SOURCES`, `GATHER_HINTS`, `NATURAL_BLOCKS`) + exécution dans `actions/procure.ts::executeStep` + cas dans `body/test/procurement.test.ts` |
| Nouveau minerai / profondeur, nouveau danger de creusage | `body/src/motor/ores.ts` (`ORE_DEPTHS`, `LIQUID_HAZARDS`, `FALLING_BLOCKS`) + `motor/digging.ts::assessSite` + `body/test/ores.test.ts`, `digging.test.ts` |
| Nouveau mob ou pièce d'équipement dans le rapport de force | `body/src/motor/threat.ts` (`MOB_WEIGHT`, `ARMOR_POINTS`, `WEAPON_DAMAGE`) + `body/test/threat.test.ts` |
| Nouvelle alternative quand l'agent tourne en rond | `mind/src/emeth/cognition/reflection.py::ALTERNATIVES` + `mind/tests/test_reflection.py` |
| Nouvel élément d'interface en jeu | `plugin/src/main/java/dev/emeth/companion/ui/` (rendu pur testé + câblage dans `EmethCompanion`), textes FR/EN dans `ui/Lang.java`, test JUnit, vérification dans `plugin/e2e/live_companion.py` |
| Nouveau champ lu par le plugin | `mind/src/emeth/control.py::m_status` → `python scripts/gen_control_fixtures.py` → `MindSnapshot.parse` + test |

## Conventions
- TypeScript : ESM, `strict`, `noUncheckedIndexedAccess`, pas de `any` sauf frontière mineflayer (caster via `unknown`).
- Python : 3.11+, pydantic v2, `from __future__ import annotations`, asyncio natif, pas de dépendance lourde sans ADR.
- Java (plugin) : 21, `paper-api` seulement (aucune dépendance embarquée), `-Xlint:all -Werror`, Bukkit uniquement sur le
  thread serveur, réseau hors du thread serveur.
- Commits : `feat|fix|docs|test|refactor(scope): résumé en français`, trailer `Co-Authored-By` si un agent a écrit le code.
- Un agent qui travaille sur une feature longue crée une branche `feat/<nom>` ; `main` reste vert.

## Données d'exécution
`data/` (mémoire, graphe, logs JSONL des décisions) et `skills/library/*.js` sont produits en jouant ; `data/` est ignoré
par git, `skills/library/` est versionné (c'est la compétence acquise).
