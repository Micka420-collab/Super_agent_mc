# Première vie sur un vrai serveur (M1) — guide pas à pas

Objectif : une heure d'EMETH sur Paper 1.21.11 avec un vrai modèle, observée depuis le tableau de bord et coachée
depuis Claude Code, pour en tirer une **matrice de capacités honnête** (`docs/CAPABILITIES.md`).

## 0. Prérequis
- Docker (serveur), Node ≥ 20 (corps), Python ≥ 3.11 (esprit), ~2 Go de RAM libres.
- Une clé : `ANTHROPIC_API_KEY` (recommandé : Sonnet pour `smart`/`code`, Haiku pour `fast`), ou OpenRouter, ou Ollama local
  (qwen3 14b suffit pour commencer ; la vision est alors `qwen3-vl`). Voir `mind/providers.example.yaml`.
- Optionnel : un client Minecraft 1.21.11 pour le rejoindre en jeu (ou 26.x via ViaProxy, `server/README.md`).

## 1. Le serveur
```bash
cd server && docker compose up -d && docker compose logs -f   # attendre « Done »
docker exec -i emeth-mc rcon-cli time set day                  # commencer de jour, c'est plus doux
```
Monde persistant dans `server/data/`, seed `emeth-2026`, mode hors-ligne (le bot n'a pas de compte Microsoft).

## 2. Le corps
```bash
cp .env.example .env                       # MC_HOST/PORT, MC_USERNAME=Emeth, BRIDGE_TOKEN=<un secret>
cd body && npm install && npm run typecheck && npm test
npm run build && npm start                  # ou, sans build : npx tsx src/index.ts (ou npm run dev avec rechargement)
```
Le corps se connecte au serveur, ouvre le bridge WebSocket (`ws://127.0.0.1:8765`) et attend un esprit.
Journal JSON sur stdout ; `LOG_LEVEL=debug` pour tout voir.

## 3. L'esprit
```bash
cd mind && python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"
cp providers.example.yaml providers.yaml   # garder les fournisseurs que vous avez, dans l'ordre de préférence
cp persona.example.yaml persona.yaml       # nom, caractère, langue, et surtout `owner: <votre pseudo en jeu>`
emeth doctor                               # clés trouvées ? corps joignable ? esprit déjà en marche ?
emeth prompt-stats                         # ce qu'une pensée coûte avant de dépenser quoi que ce soit
emeth run
```
Au premier réveil il salue, regarde autour de lui, et l'échelle de survie lui donne son premier but (6 bûches).

## 4. Regarder dans sa tête
- Tableau de bord : `http://127.0.0.1:8766/?token=$(cat mind/data/control.token)` — santé, pulsions, rétine en direct,
  buts, timeline, carte des lieux, coûts LLM. La boîte « Mentor » parle à son esprit (pas une commande : un conseil
  qu'il pèse à sa prochaine pensée).
- Depuis Claude Code : `claude mcp add emeth -- emeth mcp` (dans `mind/`, venv activé) puis « regarde ce qu'Emeth voit »,
  « dis-lui de rentrer avant la nuit », « qu'a-t-il appris aujourd'hui ? ».
- En jeu : parlez-lui par son nom (`Emeth, viens voir`) ou en privé (`/msg Emeth …`). Le `owner` de la persona pèse plus.

## 5. Ce qu'il faut noter pendant l'heure
Tenir `docs/CAPABILITIES.md` (à créer) avec, pour chaque capacité, *tenté / réussi / échoué / cause* :

| Capacité | Où regarder |
|---|---|
| Bûches → planches → table → pioche en bois (`get wooden_pickaxe`) | timeline `result`/`failure`, `remainingPlan` dans l'erreur |
| Pierre, four, fer (`get iron_pickaxe`) — craft réel, cuisson, carburant | idem + `inventoryDelta` |
| Nuit : abri (`emergency_shelter`), lit, sommeil, rêve au réveil | timeline `dream`, pages `lessons/` du wiki |
| Construction (`design` → cottage) — portes, torches, débords, terrain inégal | `plan_build` texte, `failures` du `build` |
| Combat/fuite : réflexes qui préemptent, pas d'attaque de joueur | événements `reflex` |
| Dialogue : répond quand on lui parle, se tait sinon, tient ses promesses | `said`, `chat_in`, mémoire sociale |
| Mémoire : lieux et leçons retrouvés le lendemain (`emeth memory search`) | wiki + `memory_search` |
| Coût : tokens/décision, décisions/heure, $/heure par tier | panneau « Esprit », `data/logs/decisions.jsonl` |

Ce qui casse se corrige d'abord dans le corps (primitives à l'épreuve du réel), ensuite dans les prompts.

## 6. Quand ça déraille
- Rien ne bouge, timeline « my language mind is unavailable » : l'instinct a pris le relais ; vérifiez la clé/quota
  (`emeth doctor`), il reprendra tout seul.
- Il boucle sur une action : `emeth_tell` « arrête, change de plan » depuis Claude Code, ou `stop` dans le tableau de bord
  (à venir) ; en dernier recours `docker exec -i emeth-mc rcon-cli kick Emeth` puis relancer le corps.
- Il a fait une bêtise sur une construction de joueur : c'est un bug de perception/règles — notez les coordonnées et
  l'heure (`decisions.jsonl` a la décision), ça devient un test.
- Exporter l'âme avant toute expérience destructive : `emeth soul export ./soul-jour1`.
