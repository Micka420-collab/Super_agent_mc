# ADR-0004 — Mémoire : markdown = vérité, SQLite = index, consolidation au sommeil

**Statut** : accepté

## Contexte
ai-memory (13,7k ★) a prouvé la robustesse du couple « wiki markdown + index SQLite reconstructible » et d'une formule de
rétention explicite ; VoxelMind a montré la valeur de blocs de mémoire réécrits avec attribution des sources ; MC-EvoBench
montre que l'expérience des agents actuels ne se transfère pas.

## Décision
Cinq couches (épisodique, sémantique, spatiale, procédurale, sociale) sur un `MemoryStore` SQLite WAL (FTS5 + vecteurs
float32), pages markdown avec frontmatter comme source de vérité, retrieval par fusion RRF, rétention
`salience·e^(−λt) + σ·log(1+accès)·e^(−μ·jours)`, réécriture roulante toutes les 24 lignes, **rêve** à l'endormissement,
**âme** exportable. Embeddings : fournisseur si disponible, sinon hachage n-gram local déterministe.

## Conséquences
- Aucune dépendance à un vector store externe ; tout tient dans `data/`.
- Les humains peuvent lire et corriger la mémoire (fichiers .md).
- Les embeddings locaux sont grossiers : bons pour la dédup et la récupération approximative, pas pour la nuance ; un
  fournisseur d'embeddings améliore la mémoire sans changer le code.
