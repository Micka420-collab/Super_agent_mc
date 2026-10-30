# ADR-0003 — Perception honnête et rétine par raycast

**Statut** : accepté

## Contexte
Les agents publics lisent les blocs dans un rayon (x-ray). Les piles pixel (VPT/STEVE-1/OpenHA) sont bloquées sur
MineRL 1.16.5. prismarine-viewer headless exige des dépendances natives fragiles.

## Décision
- Scan du champ de vision par une grille de rayons (`world.raycast`) : blocs visibles, horizon par secteur, description texte.
- Rétine : mêmes rayons → PNG (couleur = bloc, luminosité = profondeur, marqueurs d'entités projetés par le même modèle de
  caméra). Encodeur PNG maison (zlib), zéro dépendance native.
- Mode honnête optionnel qui filtre entités et blocs hors ligne de vue.
- prismarine-viewer reste une option (`VISION_MODE=viewer`) avec repli automatique sur la rétine.

## Conséquences
- Texte et image sont cohérents par construction.
- Coût CPU borné (≈ 600 rayons/s en compact) ; résolution ajustable à la demande.
- Les textures réelles ne sont pas rendues : la rétine est une carte sémantique, pas une capture d'écran.
