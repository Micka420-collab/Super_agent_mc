# Serveur de test

`docker compose up -d` lance un Paper 1.21.11 en mode hors-ligne (le bot se connecte avec `MC_AUTH=offline`).
Le monde est persistant dans `server/data/` (ignoré par git). Seed fixe `emeth-2026` pour des bancs reproductibles.

Compte joueur humain : connectez-vous avec un client 1.21.11 sur `localhost:25565` (ou via ViaProxy depuis 26.x).

Commandes utiles (RCON, mot de passe `emeth-rcon`) :
```
docker exec -i emeth-mc rcon-cli time set day
docker exec -i emeth-mc rcon-cli give Micka writable_book 1      # pour que l'agent reçoive un journal
docker exec -i emeth-mc rcon-cli tp Emeth Micka                   # exceptionnel : ramener le bot (ça triche)
```

## Versions : 1.21.11, 26.1, et au-delà via ViaProxy

Mineflayer (le corps) parle les protocoles jusqu'à **26.1**. Un serveur Paper 1.21.11 ou 26.1 fonctionne directement
(`MC_VERSION` auto-détecté). Pour rejoindre un serveur **26.2 / 26.3** sans attendre Mineflayer :

1. Télécharger [ViaProxy](https://github.com/ViaVersion/ViaProxy/releases) (jar, Java 17+).
2. Le lancer en mode CLI à côté du corps :
   ```bash
   java -jar ViaProxy.jar cli --bind-address 127.0.0.1:25566 --target-address mon-serveur:25565 \
        --target-version 26.3 --auth-method NONE
   ```
   (`--auth-method ACCOUNT` + `ViaProxy.jar` en mode GUI une première fois pour un compte Microsoft).
3. Pointer le corps sur le proxy avec la version qu'il connaît : `MC_HOST=127.0.0.1 MC_PORT=25566 MC_VERSION=26.1`.

ViaProxy traduit les paquets dans les deux sens ; les nouveaux blocs/entités de 26.2+ apparaissent au corps sous leurs
équivalents 26.1 (ils restent visibles et solides, mais leur nom peut être approximatif). Les tests e2e tournent sur
flying-squid (1.21.1, JS, sans Java) : il ne gère ni les recettes serveur, ni les portes/torches — ces primitives sont à
valider sur Paper.

## Plugin compagnon
Construisez le plugin puis déposez-le dans le dossier `plugins/` du serveur avant `docker compose up` :
```bash
cd ../plugin && ./gradlew build && mkdir -p ../server/data/plugins && cp build/libs/emeth-companion-*.jar ../server/data/plugins/
```
Dans ce conteneur, le jeton de l'esprit n'est pas au chemin par défaut : passez `EMETH_CONTROL_TOKEN` au service `mc`
(ou renseignez `mind.token` dans `data/plugins/EmethCompanion/config.yml`) et, comme l'esprit tourne hors du conteneur,
réglez `mind.url` sur l'hôte (`ws://host.docker.internal:8766` avec `mind.allow-remote: true`, ou lancez l'esprit avec
`--network host`). Voir [`plugin/README.md`](../plugin/README.md).
