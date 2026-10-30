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
