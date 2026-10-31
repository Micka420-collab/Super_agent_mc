# Matrice de capacités — ce qui marche vraiment

Tenue à partir des sessions réelles (journal `data/logs/decisions.jsonl` + timeline). Une capacité n'est cochée que si
elle a été observée sur un vrai serveur avec un vrai modèle ; un échec reste écrit tant qu'il n'est pas re-testé.

## Session 1 — 30 oct. 2026 (M1)

- **Serveur** : Paper 1.21.11, monde neuf (seed `emeth-2026`), difficulté normale, survie, aucun joueur connecté.
- **Modèle** : `anthropic/claude-haiku-5.5` via OpenRouter pour tous les tiers, plafond `EMETH_MAX_USD=1.0`.
- **Durée** : 38 min de temps réel, environ deux jours et deux nuits en jeu, en quatre redémarrages de l'esprit pour
  déployer les correctifs ci-dessous.
- **Coût** : 0,113 $ pour 78 appels, soit 0,18 $/h. Une décision coûte en moyenne 0,0012 $ (10 k tokens en entrée,
  360 en sortie) et prend 3,7 s. Répartition : décisions 0,058 $, synthèse de skills 0,041 $, mémoire 0,015 $.

| Capacité | Résultat | Détail |
|---|---|---|
| Bûches → planches → table → bâtonnets → pioche en bois | ✅ sans aide | après le correctif `args_json` ; avant, `craft({})` en boucle |
| Pierre → outils en pierre (pioche, hache, épée) | ✅ sans aide | 12 cobblestone, skill `craft_stone_tools_at_table` écrit et gardé |
| Nuit 1 : abri | ❌ | skill `dig_stone_shelter` « réussi » mais agent à découvert ; fuites réflexes toute la nuit, 20 PV gardés |
| Nuit 2 : abri | ✅ | perception `blocks.enclosure` ; skill `seal_current_pocket` vérifie la coque ; nuit sans fuite ni dégât |
| Retour à la base avant la nuit | ⚠️ | `goto` en timeout à 9 m du but, repli sur un abri sur place (bonne décision) |
| Nourriture (8 portions) | ❌ ×2 | pas de vache en vue, lapin perdu (`attack` timeout), cochon repéré à 91 m mais pas poursuivi |
| Sommeil | ❌ | pas de lit (laine : aucun mouton trouvé) ; attend l'aube dans l'abri à la place |
| Réflexes (fuite, rapport de force) | ✅ | fuites justes à découvert, aucune perte de vie |
| Réflexion sur ses échecs | ✅ | change de méthode après des échecs répétés (`craft` → skill, chasse → exploration) |
| Parole | ✅ après correctif | parlait à chaque pensée sans joueur connecté ; muet sans auditoire désormais |
| Mineur (descente, galerie, minerais) | non testé | |
| Construction (`design` → cottage) | non testé | |
| Dialogue avec un joueur, plugin compagnon en jeu | non testé | aucun joueur humain pendant la session |

## Session 2 — 30 oct. 2026, avec un joueur

- **Cadre** : même monde et même modèle, serveur ouvert sur le réseau local au seul PC du propriétaire, plugin
  compagnon chargé. Le propriétaire (Micka) joue à côté.
- **Durée et coût** : 100 min réelles, environ cinq jours de jeu, 152 appels pour 0,218 $, soit 0,13 $/h. Sept
  redéploiements à chaud pour livrer les correctifs ci-dessous.
- **Dialogue** : 33 messages d'EMETH et 4 du joueur.

| Capacité | Résultat | Détail |
|---|---|---|
| Saluer un joueur qui arrive, répondre dans le chat | ✅ après correctif | le salut restait intérieur (joueur hors de vue) ; réponses en quelques secondes ensuite |
| Tenir compte d'un conseil (« cherche plus loin ») | ✅ | il le pèse et refuse de sortir de nuit sans armure, en le disant |
| Reprendre à l'aube | ✅ après correctif | il a d'abord passé une matinée à « attendre l'aube » ; dès le jour suivant : « Le jour est là » et il part |
| Sortir d'un abri souterrain vers une cible à 64 m | ⚠️ | `goto` immobile pendant 120 s ; ajout de `ascend` et d'un chien de garde à 25 s |
| Fer caché derrière la pierre → `raw_iron` | ✅ après correctif | `mine` disait « miné » alors que le bloc était intact ; il creuse maintenant jusqu'au minerai |
| Fondre le fer, four, cisailles | ✅ | jalon `furnace`, cisailles faites seul (un conseil du mentor pour situer le fer) |
| Plugin compagnon en jeu (HUD, `/emeth`) | ✅ | connecté ; il restait déconnecté après chaque redémarrage de l'esprit, c'est corrigé |
| Abri la nuit | ✅ | nuits passées enfermé, sans dégât |
| Lit (laine) | ❌ | cisailles en main, mais aucun mouton trouvé pour l'instant |

Défauts trouvés et corrigés : parole perdue avec un joueur hors de vue (`world.online`) ; jeton de contrôle
régénéré à chaque démarrage ; l'aube et les conseils de mentor ignorés pendant une attente ; un programme qui
rapportait `sealed: false` gardé comme compétence vérifiée ; aucune primitive pour remonter (`ascend`) ; `goto`
qui brûlait 120 s sans bouger ; `mine` qui comptait des blocs non cassés et ne savait pas creuser jusqu'au
minerai ; `smelt iron_ingot` refusé ; établi ou four injoignable au lieu d'en poser un neuf.

## Session 2, suite — « il casse la pierre à la main »

Signalé par le joueur. En remontant la piste, on a trouvé six défauts, dont un majeur.

- **Pathfinder jamais vraiment arrêté (défaut majeur).** `pathfinder.stop()` ne fait que demander l'arrêt. Sur un
  bot coincé, le but restait posé après l'action, et le pathfinder continuait de diriger et de creuser pendant
  l'action suivante. Le serveur corrigeait alors la position environ 20 fois par seconde : physique gelée,
  `onGround` faux, minage 5 fois plus lent (pénalité vanilla hors du sol), coups annulés (« Digging aborted »).
  Ce défaut expliquait aussi des `goto` immobiles. Diagnostic : compteur de corrections dans le corps, bot sonde
  au même endroit (0 correction), reconnexions. Correctif : `haltPathfinder`, but effacé à la sortie de chaque
  marche, arrêt d'urgence au-delà de 10 corrections par seconde. Après : 0 correction.
- **Usure des outils invisible.** La pioche en pierre s'est usée sans qu'il le remarque. Le contexte affiche
  maintenant l'usure, une alerte sous 20 %, et un « NO PICKAXE » qui nomme le remède (`get stone_pickaxe`).
- **Pierre cassée à la main.** Le pathfinder et `dig` ne cassent plus un bloc dont l'outil manque. Seule exception :
  enfermé sans outil, il creuse jusqu'à l'établi à la main, et seulement à travers le terrain ou ses propres murs.
  Le corps retient sur disque les blocs qu'il pose.
- **Établi hors du plan.** Le planificateur ne voyait les établis qu'à 24 blocs, l'exécution à 32 : le plan
  l'envoyait couper du bois introuvable sous terre. Le rayon est maintenant commun (48), et le plan dit où est
  l'établi.
- **Programmes « réussis » sans effet.** Un programme dont aucun appel réussi ne change le monde est un échec
  (NO_EFFECT).
- **Monstre derrière la roche.** Un creeper de l'autre côté d'un mur déclenchait la fuite en boucle. Sans ligne de
  vue, un monstre ne déclenche plus de réflexe et ne compte que pour 15 % du danger.

Résultat vérifié en jeu : il a creusé à la main de 22 m à 5 m de l'établi, puis a refait sa pioche en pierre.

## Défauts trouvés en vrai et corrigés pendant la session 1

1. **Arguments vides** : en sortie structurée, un objet sans propriétés ne peut valoir que `{}`. Les décisions et
   les skills passent désormais par `args_json` (chaîne JSON).
2. **Adaptateur Anthropic** : les modèles 5.5 refusent `temperature`, et Sonnet/Opus 5.5 refusent `tool_choice`
   forcé. La configuration par défaut (`claude-sonnet-5-5`) échouait donc à chaque décision. Ces contraintes sont
   maintenant apprises sur le 400.
3. **Coût invisible** : OpenRouter comptait 0 $ ; il renvoie maintenant sa facture. Plafond dur persistant
   `EMETH_MAX_USD`.
4. **`mine cobblestone`** renvoyait NOT_FOUND au milieu de la pierre. Le corps mine maintenant le bloc qui lâche
   l'objet demandé.
5. **Abri cru et non vérifié** : la mesure d'enceinte arrive dans l'observation, le contexte, le rapport de force et
   l'instinct.
6. **Synthèse de skills tronquée** : la consigne « think step by step » consommait les 4000 tokens en sortie
   structurée.
7. **Un argument facultatif à `null`** (`flee {fromId: null}`) était refusé.

## Prochaines cibles (M1 → M2)

- Nourriture : poursuivre un animal repéré loin (`explore` l'a trouvé à 91 m, aucune décision ne l'a suivi),
  `attack` sur les petites cibles mobiles.
- Trouver des animaux loin de la base (moutons, vaches) : `explore` voit loin mais ne poursuit pas.
- Le plugin compilé sans Gradle : Gradle 8.14 ne tourne pas sur Java 25 (passer au wrapper 9.x).
- Session longue (plusieurs heures) : dérive de la mémoire, coût réel avec le rêve.
