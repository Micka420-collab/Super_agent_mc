# ADR-0002 — Contrôle à deux vitesses : réflexes au tick, esprit événementiel

**Statut** : accepté

## Contexte
Un LLM répond en 1–5 s. Un creeper explose en 1,5 s. Les agents « LLM seul » meurent pendant qu'ils réfléchissent ;
AltoClef/ChatClef et mc_aiplayer survivent grâce à des chaînes de priorité au tick.

## Décision
- Dans le corps : `ReflexSystem` évalué toutes les 2 ticks, candidats à priorité (lave 90, noyade 85, fuite 80, creeper
  75, défense 60), un seul réflexe actif, préemption de l'action en cours si sa priorité est inférieure, rapport à l'esprit.
- Dans l'esprit : boucle purement événementielle (réveils debouncés) + minuteur « moment calme », **une décision en vol**,
  corps agissant en tâche de fond, `keep` pour laisser finir.

## Conséquences
- L'esprit ne micro-gère pas la survie ; il reçoit « mon corps a fui » et décide la suite.
- Les réflexes ne frappent jamais un joueur : la violence envers les humains est une décision de l'esprit, jamais un réflexe.
- Un `stop` explicite a toujours la priorité maximale.
