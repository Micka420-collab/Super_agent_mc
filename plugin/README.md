# EMETH Companion — plugin Paper

Une fenêtre dans la tête d'EMETH, **dans le jeu**, pour les joueurs qui vivent à côté de lui. Rien à installer côté
client : tout est fait d'éléments Minecraft vanilla. Le plugin **ne touche jamais au corps** : il lit l'esprit et lui
transmet des conseils, que l'agent pèse librement (ADR-0006, [ADR-0007](../docs/adr/0007-plugin-compagnon-paper.md)).

| Élément | Ce qu'on voit |
|---|---|
| **Carte flottante** au-dessus de l'agent | nom et stade d'autonomie, ce qu'il fait (⛏ ⚔ ⌂ ⚒ ☾ ➜), sa dernière pensée pendant 12 s, le rapport de force (☠ 33 % ➜ combattre), « tourne en rond », « instinct ». Invisible pour l'agent lui-même. |
| **Barre de boss** | le but courant et l'échelle de survie (2/21), colorée par le danger |
| **Barre d'action** | ❤ vie · ✚ faim · ☀ jour 3 · ☠ danger · ce qu'il fait |
| **Tableau latéral** | humeur, les quatre pulsions les plus fortes, danger, tâche, pensée |
| **Menu `/emeth`** | « Dans la tête d'Emeth » : état, sept pulsions, ce qu'il pense, ce qu'il fait, rapport de force, réflexion, objectifs, journal, moniteur, conseiller, proposer un but. Rafraîchi en direct. |
| **Livres** | `/emeth goals` et `/emeth journal` ouvrent ses objectifs et sa timeline, mis en page |
| **Moniteur rétine** | une carte (ou un mur 2×1) qui montre ce que voient ses yeux, toutes les secondes |
| **Annonces** | jalons et morts dans le chat des suiveurs ; quand il tourne en rond, une ligne cliquable « [Le conseiller] » pour les mentors |

## Installation

```bash
cd plugin && ./gradlew build                       # → build/libs/emeth-companion-0.1.0.jar
cp build/libs/emeth-companion-*.jar ../server/data/plugins/   # serveur Docker du dépôt (server/docker-compose.yml)
```

Le plugin lit le jeton du canal de contrôle dans `../mind/data/control.token` (relatif au dossier du serveur), dans
`EMETH_CONTROL_TOKEN`, ou dans `mind.token` de `plugins/EmethCompanion/config.yml`. Lancez l'esprit (`emeth run`) :
le plugin s'y connecte tout seul et se reconnecte s'il redémarre.

## Commandes et permissions

| Commande | Permission (défaut) | Effet |
|---|---|---|
| `/emeth` · `/emeth menu` | `emeth.use` (tous) | ouvre le menu « dans sa tête » |
| `/emeth status` | `emeth.use` | état en texte (marche aussi en console / RCON) |
| `/emeth hud` | `emeth.use` | affiche ou masque barre de boss, barre d'action et tableau latéral (mémorisé sur le joueur) |
| `/emeth goals` · `/emeth journal` | `emeth.use` | livres des objectifs et du journal |
| `/emeth tell <conseil>` | `emeth.mentor` (op) | un conseil pesé à sa prochaine pensée (aussi : clic sur la plume du menu, puis le chat) |
| `/emeth goal <but>` | `emeth.mentor` (op) | proposer un but qu'il peut accepter ou abandonner |
| `/emeth monitor [wall]` | `emeth.monitor` (op) | carte-moniteur de la rétine (ou deux cartes pour un mur 2×1) |
| `/emeth say <texte>` | `emeth.admin` (op) | le faire parler (comme le tableau de bord) |
| `/emeth reload` | `emeth.admin` (op) | recharger la configuration et se reconnecter |

## Configuration (`plugins/EmethCompanion/config.yml`)

| Clé | Défaut | Rôle |
|---|---|---|
| `language` | `fr` | `fr` ou `en` |
| `mind.url` | `ws://127.0.0.1:8766` | canal de contrôle de l'esprit |
| `mind.token` / `mind.token-file` | `""` / `../mind/data/control.token` | jeton (jamais journalisé) |
| `mind.allow-remote` | `false` | refuse tout hôte non local sauf choix explicite (préférez `wss://` derrière un proxy TLS) |
| `mind.poll-seconds` | `2` | fréquence de lecture de l'esprit |
| `hologram.enabled` · `thought-seconds` | `true` · `12` | carte flottante, durée d'une nouvelle pensée |
| `hud.default-on-join` | `false` | HUD actif par défaut pour les nouveaux joueurs |
| `monitor.refresh-seconds` | `3` | rafraîchissement de la rétine sur les cartes |
| `announce.kinds` · `audience` | `[achievement, death]` · `followers` | ce qui est annoncé, et à qui (`followers` ou `all`) |
| `announce.stuck-alert` | `true` | alerter les mentors quand l'agent tourne en rond |
| `mentor.cooldown-seconds` · `max-length` | `5` · `600` | anti-spam : chaque conseil réveille une pensée |

## Développer

```bash
./gradlew test        # JUnit, lit les fixtures du canal de contrôle (../protocol/fixtures/control)
./gradlew build       # jar + tests ; le compilateur traite chaque avertissement comme une erreur
cd ../mind && . .venv/bin/activate && python ../plugin/e2e/live_companion.py   # bout en bout réel (Paper + corps + esprit + un 2e client)
```

| Fichier | Rôle |
|---|---|
| `mind/MindClient.java` | client JSON-RPC du canal de contrôle (WebSocket du JDK, délais, reconnexion) |
| `mind/MindLink.java` | interrogation périodique hors du thread serveur, état en ligne / hors ligne, attente exponentielle |
| `mind/MindSnapshot.java` | lecture tolérante de `status` |
| `ui/Hologram.java` · `Hud.java` · `MenuModel.java` | rendus purs (testés) de la carte flottante, du HUD et du menu |
| `ui/Monitors.java` · `RetinaImage.java` | cartes-moniteurs : rétine → tuiles 128×128, légendes à la police des cartes |
| `ui/Mentor.java` · `Announcer.java` | conseils par le chat ou les commandes, annonces |
| `e2e/live_companion.py` · `observer.mjs` | test de bout en bout réel avec un second client Minecraft |

Après un changement délibéré du `status` de l'esprit : `cd mind && python scripts/gen_control_fixtures.py`.
