# ADR-0001 — Le corps est un client Mineflayer, pas un mod serveur

**Statut** : accepté (30/10/2026)

## Contexte
Trois façons d'incarner un agent : (a) client protocolaire (Mineflayer, azalea) ; (b) faux `ServerPlayer` dans un mod
serveur Fabric/Paper (VoxelMind, mc_aiplayer) ; (c) vrai client headless (ChatClef/Baritone, HeadlessMC).

## Décision
(a) Mineflayer en TypeScript, derrière une interface fine (`ActionRunner` + manifeste de primitives) pour pouvoir
brancher plus tard azalea (Rust, swarms, 26.2) ou un corps serveur Fabric.

## Raisons
- Fonctionne sur n'importe quel serveur sans installer quoi que ce soit : l'agent est un **joueur** du point de vue du serveur.
- L'API Mineflayer est massivement présente dans les corpus d'entraînement : le code de skill généré par les LLM marche
  (DeepMind, Voyager, Mindcraft l'utilisent tous).
- Écosystème : pathfinder, collectblock, auto-eat, armor-manager, tool, viewer, physics-util.
- Coût : un processus Node léger par agent, pas un client Java avec GPU.

## Conséquences
- Plafond de version : 26.1 aujourd'hui ; ViaProxy devant le serveur pour 26.2/26.3.
- Pas de pixels natifs → la rétine (raycast) et, en option, prismarine-viewer headless.
- Pas de physique serveur parfaite (lag de prédiction) ; acceptable pour un joueur.
