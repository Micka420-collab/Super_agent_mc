# Roadmap

## M0 — Fondations ✅ (30 oct. 2026)
Corps Mineflayer complet et testé (unitaires + e2e sur serveur JS), esprit complet et testé hors ligne, protocole partagé,
docs, CI.

## M1 — Première vie sur un vrai serveur (prochain)
- [ ] Serveur Paper 1.21.11 (`server/docker-compose.yml`), bot hors-ligne, clés LLM → session de 1 h observée.
- [ ] Calibrer : fréquence des réveils, longueur du contexte (tokens/décision), coût/heure par tier.
- [ ] Première tâche de l'échelle (6 bûches → planches → table → pioche) bouclée **sans aide**, puis nuit en abri.
- [ ] Journal de décisions → matrice de capacités honnête (`docs/CAPABILITIES.md`) : ce qui marche, ce qui échoue, combien de fois.
- [ ] Corriger les primitives à l'épreuve du réel (pose de blocs sur pente, four, collecte des drops).

## M2 — Compétence
- [x] Planificateur d'approvisionnement déterministe (item → arbre de dépendances via recettes, loot tables et outils requis), compacté avec preuve de faisabilité, exposé comme primitives `plan_get` (gratuit) et `get` (exécute et replanifie à chaque étape) — 30 oct. 2026.
- [x] Skills de base livrés dans `skills/library/` : `gather_logs`, `bootstrap_tools`, `emergency_shelter`, `torches` (via `get`), `safe_staircase_mine` (relevé lave/eau/gravier avant chaque marche, torches, arrêt santé), `return_home` (puits 1×1 prudent pour sortir de terre, puis marche).
- [x] Construction réelle : décision `design {brief}` → `Constructor` (relevé de site `surface_height`, architecte DSL avec budget indicatif, ancrage devant l'agent, `plan_build` — ordre prouvé, blocs flottants/enfermés/occupés —, `build {procure: true, partial: true}`), lieu + page projet en mémoire. Validé contre le corps simulé ; à confirmer sur Paper.
- [ ] Évaluateur `@miner-org/mineflayer-baritone` vs `mineflayer-pathfinder` (natation, échelles, parkour).
- [ ] ViaProxy documenté pour 26.2/26.3 ; test e2e sur 26.1.

## M3 — Présence
- [x] Façade MCP de l'esprit (`emeth mcp`, ADR-0006) : status/observe/look/memory_search/timeline/goals/skills + tell (mentor)/suggest_goal/say, sur un canal de contrôle local réutilisable par le tableau de bord — validée en direct (30 oct. 2026).
- [x] Tableau de bord « dans la tête » servi par le canal de contrôle (`http://127.0.0.1:8766/?token=…`) : corps, pulsions, rétine en direct, buts, timeline, mémoire, coûts LLM, et la boîte « mentor » — une page, zéro build (30 oct. 2026). Reste : graphe de monde et journal des décisions détaillé.
- [ ] Boucle vocale : plugin Simple Voice Chat → WS → Whisper → esprit → TTS → `createAudioSender`.
- [ ] Récap vidéo quotidien (HyperFrames) depuis la timeline + frames de rétine.

## M4 — Imagination & culture
- [ ] Sandbox d'imagination (copie locale du monde, physique simulée) avant les plans risqués.
- [ ] Mémoire de style architectural (scan des constructions des joueurs).
- [ ] Apprentissage par observation des joueurs → skills.
- [ ] Plusieurs agents, wiki partagé, livres comme culture écrite.

## M5 — Preuve
- [ ] Banc de transfert nocturne (seed neuve, âme importée vs neuf) ; MineCollab / TeamCraft adaptés.
- [ ] Survie 7 jours en **Normal** sans intervention, documentée.
- [ ] Article + vidéo.

## Idées en attente (voir `docs/INNOVATIONS.md` 20–23)
World model appris sur la rétine (LatentBridge), voix émotionnelle, économie/droit, amendements de valeurs sous tutelle.
