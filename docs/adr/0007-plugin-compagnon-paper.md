# ADR-0007 — Plugin compagnon Paper : une interface dans le jeu, pour les humains, qui ne touche jamais au corps

**Statut** : accepté (30 oct. 2026)

## Contexte
On regarde l'agent depuis l'extérieur du jeu (tableau de bord, façade MCP, ADR-0006). Mais les gens qui jouent *à côté*
d'EMETH n'ont que le chat. AgentCraft (blendi-remade/agentcraft) montre ce qu'apporte une vraie interface dans Minecraft :
on voit où en sont les agents d'un coup d'œil, ils viennent vous chercher quand une décision vous revient. AgentCraft est
un mod Fabric côté client, en solo, avec ses propres blocs, textures et écrans : chaque joueur doit installer le mod.

Pour EMETH, l'interface doit marcher sur un serveur multijoueur ordinaire, pour n'importe quel client vanilla, et ne
jamais devenir une triche (règle 1 : le corps ne triche pas).

## Décision
1. **Un plugin Paper** (`plugin/`, Java 21, `paper-api` 1.21.11, aucune autre dépendance) plutôt qu'un mod client :
   rien à installer côté joueur ; toute l'interface est faite d'éléments vanilla — entité `text_display`, barre de boss,
   barre d'action, tableau latéral, inventaire-menu, livres, cartes.
2. **Client du canal de contrôle de l'esprit, jamais du corps.** Le plugin lit `status`, `timeline`, `goals`, `render`
   et transmet des conseils par `tell` / `set_goal` (et `say` réservé aux administrateurs). L'agent pèse ces conseils à
   sa pensée suivante et peut les refuser (ADR-0006). Le plugin ne déplace pas le bot, ne lui donne rien, ne le soigne
   pas, ne change pas son mode de jeu.
3. **Perception honnête préservée.** L'hologramme au-dessus de l'agent est caché à l'agent lui-même
   (`Player#hideEntity`) : le serveur n'envoie jamais l'entité au client du bot, qui ne la perçoit donc pas.
   Le test de bout en bout le vérifie depuis les sens de l'agent.
4. **Sécurité du canal.** Le jeton est lu dans la config, `EMETH_CONTROL_TOKEN` ou `mind/data/control.token`, jamais
   journalisé (URL caviardée). Un hôte non local est refusé sauf `mind.allow-remote: true`, avec un avertissement si ce
   n'est pas du `wss://`. Permissions : `emeth.use` (voir, tout le monde), `emeth.mentor` (conseiller, ops),
   `emeth.monitor` (cartes), `emeth.admin` (`say`, `reload`). Les saisies sont nettoyées et bornées, et chaque mentor a
   un délai entre deux conseils : chaque conseil réveille une pensée, qui coûte des jetons.
5. **Robustesse.** Interrogation hors du thread serveur, une seule connexion WebSocket persistante (client JDK),
   délai par appel, reconnexion avec attente exponentielle, lecture tolérante du JSON. Le format de `status` est figé
   par `protocol/fixtures/control/*.json`, que génère l'esprit et que lisent les deux suites de tests.

## Conséquences
- N'importe quel joueur voit ce que l'agent fait, pense et craint sans quitter le jeu ; les mentors le conseillent depuis
  un menu ou le chat ; quand l'agent tourne en rond, les mentors reçoivent une ligne cliquable pour lui souffler une
  autre approche. C'est l'équivalent EMETH de l'agent d'AgentCraft qui vient vous poser une question.
- Les textures et écrans sur mesure d'AgentCraft demandent un mod client ou un pack de ressources serveur. C'est une
  étape possible, au-dessus de ce plugin et sans le remplacer.
- Le plugin dépend du canal de contrôle : la même machine que l'esprit par défaut. Un déploiement distant demande un
  proxy TLS.
- Test de bout en bout réel (`plugin/e2e/live_companion.py`) : Paper, plugin, corps, esprit et un second client qui
  joue l'humain. Il est plus lent que les autres suites (téléchargements au premier lancement) et tourne dans son propre
  job de CI.
