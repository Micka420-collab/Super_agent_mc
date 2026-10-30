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

## Défauts trouvés en vrai et corrigés pendant la session

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
- `goto` qui expire près du but : reprendre au plus proche atteint plutôt que d'abandonner.
- Session avec un joueur : dialogue, conseils, plugin compagnon en jeu.
- Session longue (plusieurs heures) : dérive de la mémoire, coût réel avec le rêve.
