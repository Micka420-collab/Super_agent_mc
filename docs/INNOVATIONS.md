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
Le modèle choisit parmi 51 primitives au contrat strict (manifeste généré), ne passe au code que pour les tâches
multi-étapes, et le code ne peut appeler que ces mêmes primitives — l'analyse statique vérifie aussi les clés d'arguments
littérales contre les schémas zod (`api.move({direction})` est refusé avec la liste acceptée). Les erreurs sont codées
(`MISSING_ITEM` avec la liste exacte) : la correction est mécanique, pas une devinette.

### 11. Planificateur d'approvisionnement avec preuve de faisabilité
L'idée du `TaskCatalogue` d'AltoClef, reconstruite sur `minecraft-data` (recettes, loot tables des blocs et des mobs,
outils de récolte) : `get <item>` devient un plan ordonné — mine → table → outils → four → chasse — sans LLM. Deux
choses que les autres ne font pas : le plan est **compacté** (une seule sortie minage pour 11 cobblestone, un seul lot
de planches) seulement si une simulation d'inventaire prouve que chaque étape a ses entrées au moment où elle s'exécute
(`isFeasible`), et il est **recalculé après chaque étape** depuis l'inventaire réel, donc un mob qui fuit ou un filon
plus petit que prévu ne déraille rien. Il préfère l'essence de bois que le corps *voit*, refuse les allers-retours de
blocs de stockage (bloc de fer → lingots), n'est pas dupe des recettes de teinture, et déclare honnêtement ce qu'il ne
sait pas obtenir. `mine` ne récolte que les cultures mûres, comme un joueur patient.

### 12. Un mentor à l'oreille : la façade MCP qui ne télécommande pas
L'agent est un serveur MCP (`emeth mcp`, sans dépendance) : depuis Claude Code, Claude Desktop ou Codex on voit par ses
yeux (`emeth_look` renvoie la rétine en image), on fouille sa mémoire et sa timeline, on lit ses buts — et on lui
**parle** (`emeth_tell`). Ce qui est dit arrive dans sa pensée suivante comme un bloc `[MENTOR]`, pesé comme le conseil
d'un ami, consommé une fois, et laisse un épisode `mentor_in` dans sa mémoire : il peut remercier, ignorer, discuter.
Aucun outil ne commande le corps. C'est la relation maître/apprenti plutôt que la manette. Le **tableau de bord
« dans la tête »** vit sur le même canal : santé, pulsions, rétine en direct, buts, timeline, mémoire, coûts LLM et la
même boîte « mentor », servi par l'esprit lui-même à `http://127.0.0.1:8766/` (une page, zéro build). Prochaine étape naturelle : l'esprit consommant à son tour
d'autres serveurs MCP (wiki du serveur, Discord) comme des sens supplémentaires.

### 13. L'instinct : vivre quand le modèle de langage se tait
Panne d'API, quota, clé expirée — la plupart des agents s'arrêtent net et la nuit les emporte. EMETH a un instinct :
une politique déterministe (`cognition/instinct.py`) qui, sur la même observation, mange, s'abrite, dort, poursuit
l'échelle de survie avec le planificateur (`get stone_pickaxe`), ou attend. Elle emprunte le même chemin d'exécution
et la même mémoire que les décisions du modèle ; quand l'esprit revient, il lit « instinct : … » dans sa timeline et
reprend là où son corps en était. Testé avec un fournisseur qui échoue à chaque appel : l'agent agit quand même.

## Conçu, à coder ensuite (voir ROADMAP)

### 13. Sandbox d'imagination (jumeau du monde)
Avant un plan risqué (descente en mine, traversée de lave, grosse construction), **répéter** le plan sur une copie locale du
monde : `prismarine-world` + `prismarine-physics` permettent de simuler les déplacements et les poses de blocs sans
envoyer un paquet, à vitesse accélérée ; variante lourde : un serveur headless avec la **même seed** (la génération est
déterministe) pour vérifier qu'un trajet existe. Personne ne fait de planification basée modèle avec un simulateur exact.

### 14. Boucle vocale complète
L'API Simple Voice Chat expose `MicrophonePacketEvent` (micro des joueurs → PCM) et `createAudioSender(connection)`
(simuler le micro d'un joueur **sans le mod**, donc parfait pour un compte bot). Plugin serveur → WebSocket → Whisper →
esprit → TTS (Kokoro local ou API) → voix du bot. Toutes les pièces existent, aucune intégration publique.

### 15. Récap vidéo quotidien
HyperFrames rend du HTML en vidéo déterministe en batch. Timeline + frames de rétine + stats du jour → `rows.json` →
template → mp4 : l'agent publie son propre vlog.

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

## Recherche

### 20. World model appris sur ses propres yeux
La rétine fournit des frames basse résolution **cohérentes** et des actions discrètes : un jeu de données parfait pour
entraîner un petit modèle de monde latent (JEPA / Dreamer) et donner à l'agent une imagination approximative là où le
jumeau exact (n° 11) est trop coûteux. Pont naturel avec le travail LatentBridge (LLM gelé + modèle de monde).

### 21. Langage corporel et voix émotionnelle
Les pulsions pilotent déjà l'humeur ; les brancher sur la prosodie TTS, le sneak quand il a peur, le regard vers
l'interlocuteur (déjà une primitive), le pas de recul face à un inconnu.

### 22. Économie et droit
Propriété (coffres marqués), échanges avec les joueurs (le troc villageois est déjà supporté par le corps), contrats
sous forme de livres signés, réputation sociale déjà modélisée (confiance). Les agents deviennent des citoyens.

### 23. Amendements de valeurs sous tutelle
L'agent peut **proposer** une révision de ses valeurs/ambitions à partir de son récit (il le fait déjà pour les ambitions) ;
le propriétaire valide. Une identité qui grandit sans dériver.
