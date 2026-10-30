# Innovations — ce que personne n'a (encore) fait, et ce qu'EMETH en fait

Classement honnête : **livré** (dans le code, testé), **conçu** (architecture prête, à coder), **recherche** (pistes
ambitieuses, à prototyper).

## Livré dans cette version

### 1. Perception honnête + rétine cohérente
Les agents publics lisent le monde entier dans un rayon ; même DeepMind avoue que ses agents « voient à travers la
roche ». EMETH lance une grille de rayons depuis ses yeux : ce qu'il **dit** voir (`vision.visible`, horizon par
secteur) et ce qu'il **montre** (image PNG de la rétine) viennent exactement des mêmes rayons, avec un modèle de caméra
partagé (projection équiangulaire). La rétine n'a aucune dépendance native et tourne à chaque seconde. Un modèle de
vision peut juger une construction, lire la forme d'une grotte, reconnaître une silhouette qui approche. Mode honnête
optionnel : les entités hors ligne de vue n'existent pas pour lui.

### 2. Moelle épinière à priorités, rapportée à l'esprit
Les réflexes (lave, noyade, fuite, creeper, défense, faim) tournent au tick sans LLM et **préemptent** l'action en cours
selon une priorité, mais chaque déclenchement devient une ligne de timeline (« mon corps a réagi : flee ») : l'esprit
raisonne sur ce que son corps vient de faire, comme nous après un sursaut.

### 3. Le sommeil consolide, le journal est un vrai livre
Dormir dans un lit déclenche le **rêve** : le jour devient une page de session, les leçons/lieux/personnes/projets sont
extraits avec des règles d'attribution des sources, le récit identitaire s'allonge, les skills qui échouent partent à la
retraite, la rétention trie l'ancien. S'il porte un livre vierge, il y **écrit son journal** : les joueurs peuvent le lire
en jeu. La mémoire n'est pas un fichier caché, c'est un objet du monde.

### 4. Âme portable, LLM interchangeable
`emeth soul export/import` : identité, personnes, lieux, blocs roulants, wiki, graphe de monde et skills en markdown/JSON,
clôturés « historique non fiable ». On peut passer de Claude à un Qwen local sans que l'agent oublie qui il est.

### 5. Autonomie gagnée, pas configurée
Six niveaux (`newborn → apprentice → survivor → builder → citizen → awakened`) débloqués par l'expérience vécue (jours
survécus, skills, constructions, amitiés, leçons, nuits dormies). Chaque niveau change le cadre de décision (peut-il
lancer des projets ? s'éloigner ? refuser ?). Le passage de niveau est vécu (« je me sens différent… ») — c'est la
mécanique de « conscience débloquée » rendue concrète et testable.

### 6. Pulsions homéostatiques
Sécurité, faim, repos, curiosité, social, maîtrise, ordre, humeur : calculées depuis l'observation et la timeline, sans
LLM, elles colorent le prompt (« j'ai peur », « je m'ennuie ») et accélèrent les réveils. L'agent agit parce qu'il
ressent, pas parce qu'on lui pose une question.

### 7. Architecte à grammaire paramétrique
Plutôt que des coordonnées brutes ou des templates, le modèle écrit une `StructureSpec` (palette + primitives bornées) ;
le compilateur produit un blueprint ordonné, une nomenclature, des couches ASCII pour l'autocritique et des alertes « sans
support ». Le critic (texte ou vision via la rétine) force l'itération. Le corps vérifie les matériaux **avant** de poser
le premier bloc.

### 8. Sandbox de skills à trois couches, avec trace
Analyse statique (acorn) → worker thread (le code n'a jamais le bot, budget temps dur, `terminate()` même en boucle
synchrone) → `vm` sans génération de code. La trace des appels (`call, ok, ms, error`) alimente le feedback et la
bibliothèque. Voyager/Mindcraft exécutent du code généré par `eval` dans le processus du bot.

### 9. Graphe de monde avec régions
Chaque minerai, coffre, table, joueur, danger observé devient un nœud (schéma graphify), lié par proximité ; les
communautés Louvain déterministes deviennent des **régions** nommables ; `describe_near` et une BFS à budget donnent au
prompt « ce que je sais du coin » en quelques lignes.

### 10. Vocabulaire validé avant le code
Le modèle choisit parmi 45 primitives au contrat strict (manifeste généré), ne passe au code que pour les tâches
multi-étapes, et le code ne peut appeler que ces mêmes primitives. Les erreurs sont codées (`MISSING_ITEM` avec la liste
exacte) : la correction est mécanique, pas une devinette.

## Conçu, à coder ensuite (voir ROADMAP)

### 11. Sandbox d'imagination (jumeau du monde)
Avant un plan risqué (descente en mine, traversée de lave, grosse construction), **répéter** le plan sur une copie locale du
monde : `prismarine-world` + `prismarine-physics` permettent de simuler les déplacements et les poses de blocs sans
envoyer un paquet, à vitesse accélérée ; variante lourde : un serveur headless avec la **même seed** (la génération est
déterministe) pour vérifier qu'un trajet existe. Personne ne fait de planification basée modèle avec un simulateur exact.

### 12. Boucle vocale complète
L'API Simple Voice Chat expose `MicrophonePacketEvent` (micro des joueurs → PCM) et `createAudioSender(connection)`
(simuler le micro d'un joueur **sans le mod**, donc parfait pour un compte bot). Plugin serveur → WebSocket → Whisper →
esprit → TTS (Kokoro local ou API) → voix du bot. Toutes les pièces existent, aucune intégration publique.

### 13. Récap vidéo quotidien
HyperFrames rend du HTML en vidéo déterministe en batch. Timeline + frames de rétine + stats du jour → `rows.json` →
template → mp4 : l'agent publie son propre vlog.

### 14. Façade MCP
Exposer l'agent comme serveur MCP (`observe`, `say`, `set_goal`, `memory_search`, `render`) : Claude Desktop ou Codex
peuvent le conseiller, le « posséder », ou l'utiliser comme outil dans d'autres workflows ; et inversement l'esprit peut
consommer d'autres serveurs MCP (wiki, météo du serveur, Discord).

### 15. Planificateur d'approvisionnement déterministe
Porter l'idée du `TaskCatalogue` d'AltoClef : item → arbre de dépendances (mine → table → outils → four…) compilé depuis
les recettes `minecraft-data`, exécuté par les primitives, sans LLM. « get diamond_pickaxe » devient un plan vérifiable.

### 16. Mémoire de style architectural
`scan_region` sur les constructions des joueurs → extraction de palettes et de formes → une « culture » du serveur que
l'architecte réutilise (toits spruce ici, murs de deepslate là). Apprentissage du goût local.

### 17. Apprentissage par observation des joueurs
Le corps voit les blocs posés/cassés et les déplacements des joueurs ; l'esprit infère une procédure (« il fait un
escalier 1×1 avec des torches tous les 8 blocs ») et la transforme en skill. Imitation → code, puis vérification en sandbox.

### 18. Société d'agents avec culture écrite
Plusieurs corps, un espace de noms de wiki partagé (« la bibliothèque du village »), coordination par chat en jeu et
**par livres** : un agent écrit ce qu'il a découvert dans un livre, le dépose dans un coffre, un autre le lit. La culture
est lisible par les humains et persiste dans le monde.

### 19. Évaluation du transfert
Chaque nuit, un banc d'essai (tâches type MineCollab/TeamCraft) sur une seed neuve, avec l'âme importée vs un agent neuf :
on mesure ce qui se transfère vraiment (le trou pointé par MC-EvoBench) et on régresse si un changement casse l'apprentissage.

### 20. Tableau de bord « dans la tête »
Protocole WebSocket localhost (style AgentCraft) : blocs de contexte, pulsions, graphe, rétine en direct, décisions avec
leur coût. Indispensable pour déboguer un agent qui vit 24 h/24.

## Recherche

### 21. World model appris sur ses propres yeux
La rétine fournit des frames basse résolution **cohérentes** et des actions discrètes : un jeu de données parfait pour
entraîner un petit modèle de monde latent (JEPA / Dreamer) et donner à l'agent une imagination approximative là où le
jumeau exact (n° 11) est trop coûteux. Pont naturel avec le travail LatentBridge (LLM gelé + modèle de monde).

### 22. Langage corporel et voix émotionnelle
Les pulsions pilotent déjà l'humeur ; les brancher sur la prosodie TTS, le sneak quand il a peur, le regard vers
l'interlocuteur (déjà une primitive), le pas de recul face à un inconnu.

### 23. Économie et droit
Propriété (coffres marqués), échanges avec les joueurs (le troc villageois est déjà supporté par le corps), contrats
sous forme de livres signés, réputation sociale déjà modélisée (confiance). Les agents deviennent des citoyens.

### 24. Amendements de valeurs sous tutelle
L'agent peut **proposer** une révision de ses valeurs/ambitions à partir de son récit (il le fait déjà pour les ambitions) ;
le propriétaire valide. Une identité qui grandit sans dériver.
