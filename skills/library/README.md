# Bibliothèque de skills

Un skill est un fichier JavaScript `async function main(api, args)` avec un en-tête `/** @skill nom ... */`
(description, tags, version). `api` expose chaque primitive du corps (voir `cd body && npm run manifest`) plus
`api.log`, `api.sleep`, `api.observe`, `api.Vec3`, `api.distance`, `api.aborted`.

- Les skills **seed** (`gather_logs`, `bootstrap_tools`, `emergency_shelter`) sont écrits à la main et testés
  statiquement par `body/test/seed-skills.test.ts`.
- Les skills **appris** sont ajoutés par l'esprit après vérification (`tags: auto, verified`) ; les versions précédentes
  sont gardées en `nom.vN.js`, les skills retirés en `nom.retired.js`.
- `index.json` est régénéré par l'esprit (`SkillLibrary.write_index`). L'esprit indexe tout fichier `.js` présent au
  démarrage : un skill écrit par un humain ou par Codex devient disponible au prochain lancement.

Règles : pas de `require/import/process/eval`, boucles bornées, vérifier l'état avant/après, erreurs explicites avec
`code` (`MISSING_ITEM`, `NOT_FOUND`…), paramètres via `args` pour rester réutilisable.
