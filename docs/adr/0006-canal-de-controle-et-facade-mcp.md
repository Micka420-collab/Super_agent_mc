# ADR-0006 — Canal de contrôle local et façade MCP écrite à la main

**Statut** : accepté (30 oct. 2026)

## Contexte
L'esprit tourne comme un processus long (`emeth run`). On veut pouvoir le regarder et lui parler depuis l'extérieur du
jeu — Claude Code, Claude Desktop, Codex, un tableau de bord — sans jamais le télécommander : l'agent reste celui qui
décide (ADR-0002, identité et autonomie gagnée). Le Model Context Protocol est le standard de fait pour exposer des
outils à ces clients. Le SDK Python officiel (`mcp`) tire starlette, uvicorn, sse-starlette, anyio, jsonschema… pour un
serveur qui n'expose que des *tools* ; et il faudrait de toute façon un canal entre le processus MCP (stdio, lancé par
le client) et le processus de l'esprit.

## Décision
1. **Canal de contrôle** (`emeth/control.py`) : un serveur WebSocket JSON-RPC minimal, `127.0.0.1:8766`, jeton
   obligatoire (`?token=`, même convention que le bridge du corps ; généré et écrit dans `data/control.token` en 0600 si
   absent). Méthodes : `status, observe, render, identity, goals, timeline, memory_search, skills` (regarder) et
   `say, tell, set_goal, abandon_goal, wake` (influencer). Chaque méthode passe par les objets de la boucle cognitive :
   un but posé apparaît dans `[GOALS]`, un message devient un épisode `mentor_in` et un bloc `[MENTOR]` dans la pensée
   suivante — **une fois**, comme un conseil, pas comme un ordre —, une parole est un `said` ordinaire envoyée par le
   corps (donc jamais une commande serveur).
2. **Façade MCP** (`emeth/mcp/server.py`, `emeth mcp`) : serveur stdio écrit à la main — JSON-RPC 2.0 délimité par des
   sauts de ligne, sous-ensemble `initialize` / `notifications/initialized` / `ping` / `tools/list` / `tools/call`
   (+ listes vides pour `resources` et `prompts`), négociation de version parmi 2024-11-05, 2025-03-26, 2025-06-18.
   Dix outils préfixés `emeth_` ; `emeth_look` renvoie une image (`type: image`, PNG de la rétine). Les erreurs
   fonctionnelles sont des résultats d'outil (`isError`), les erreurs de protocole des erreurs JSON-RPC. Le processus
   MCP est un client du canal de contrôle (une connexion par appel : sans état, robuste aux redémarrages de l'esprit).
3. Pas de dépendance ajoutée. Si un jour il faut des *resources*, des *prompts*, le transport HTTP streamable ou
   l'élicitation, on bascule sur le SDK officiel derrière la même `ControlAPI` — la façade est volontairement une
   traduction mince.

## Conséquences
- `claude mcp add emeth -- emeth mcp` suffit pour que Claude Code voie par les yeux de l'agent et lui parle en mentor.
- Le tableau de bord (ROADMAP M3) réutilisera `ControlAPI` tel quel (WebSocket déjà en place).
- Le sous-ensemble MCP est testé contre des trames réelles (`tests/test_control_mcp.py`) et validé en direct dans
  `scripts/live_smoke.py` ; il devra être relu à chaque nouvelle révision du protocole.
- Risque assumé : le canal est en clair sur localhost ; l'exposer au-delà demande un reverse proxy TLS et un jeton fort.
