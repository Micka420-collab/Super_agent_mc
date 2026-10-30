# ADR-0005 — Vocabulaire validé d'abord, code généré en sandbox à trois couches ensuite

**Statut** : accepté

## Contexte
Voyager/Mindcraft exécutent le code du LLM par `eval` dans le processus du bot (accès total, pas de timeout dur).
mc_aiplayer et cairn montrent qu'un vocabulaire d'outils validés + exécuteurs déterministes est plus fiable qu'un LLM
qui écrit tout.

## Décision
1. 45 primitives à schéma zod ; manifeste et doc d'API générés depuis la même source ; le LLM choisit une primitive quand
   une étape suffit.
2. Code généré seulement pour les tâches multi-étapes : analyse statique acorn (liste noire d'identifiants et de
   propriétés, `main` obligatoire, `api.x` connus) → worker thread (le bot n'est jamais exposé ; appels proxifiés ;
   `resourceLimits` ; budget temps dur avec `terminate()`) → `vm` sans génération de code.
3. Résultat structuré avec trace des appels pour le feedback et l'apprentissage ; 4 tentatives max ; skills validés
   stockés avec description et taux de succès ; retraite automatique sous 25 %.

## Conséquences
- Un skill en boucle infinie ne bloque pas le corps.
- Les skills sont des fichiers JS lisibles, versionnés dans le dépôt (`skills/library`).
- Le worker ajoute ~20 ms par appel de primitive : négligeable face aux actions du jeu.
