# Architecture et Developpements - Siretisation

> Version : 1.0 - 07/04/2026

## Vue d'ensemble

Le projet Siretisation associe automatiquement un SIREN/SIRET a des fiches entreprises.
Trois couches : scripts de traitement, API REST, interface admin.

## Stack technique
- Runtime : Node.js / Express.js / express-session
- BDD : MySQL (pool netit972_siretisation)
- PM2 (processus siretisation-api, id 19, port 3001)
- Serveur : srv1.net-it-be.com

## Structure du projet

```
siretisation-project/
  api/
    server.js, ecosystem.config.js, package.json
    config/database.js
    middleware/auth.js
    routes/admin.js, siretisation.js, taches.js
    controllers/siretisationController.js, tachesController.js
    services/sireneLocale.js, firecrawl.js, orchestrateur.js, spooler.js, worker.js, logger.js
    scripts/manage-api-keys.js
  admin/
    taches.html, qualite.html, api-keys.html, documentation.html
  scripts/
    passe_I_firecrawl.js (v1-v10), retry_v9-v11.js, enrich.js, export_json.js
  sql/
    00_analyse_etat_actuel.sql, 01_siretisation_schema.sql, 02_verification_post_install.sql
  docs/
    cahier-des-charges-v1/v2/v3.md, audit-donnees.md
```

## Flux de donnees

Fichier CSV -> POST /taches -> Orchestrateur -> Workers (SIRENE locale + Firecrawl)
-> Table resultats (MATCHEE/INCERTAINE/ECHOUEE) -> Interface admin (controle qualite)

---

## Corrections apportees (07/04/2026)

### 1. Restauration authentification (taches.html)
Fonction doLogin() reinseree (POST /api/v1/admin/login, credentials: include).

### 2. URLs API corrigees (qualite.html)

| Appel | Avant (incorrect) | Apres (correct) |
|-------|-------------------|-----------------|
| Taches | /api/v1/admin/qualite/taches | /api/v1/admin/taches |
| Stats | /api/v1/admin/qualite/stats | /api/v1/admin/stats |
| Resultats | /api/v1/admin/qualite/resultats?tache_id=X | /api/v1/admin/taches/X/resultats |
| Login | /api/v1/admin/qualite/login | /api/v1/admin/login |

### 3. Credentials manquants (qualite.html)
Ajout credentials:'include' sur tous les fetch + overlay de login.

### 4. Noms de champs corriges

| Frontend attendait | API retourne | Contexte |
|-------------------|-------------|----------|
| data.resultats | data.rows | Resultats |
| data.total | data.nb_resultats | Stats |
| data.uncertain | data.incertaines | Stats |
| data.failed | data.erreurs | Stats |
| search (param) | q (param) | Recherche |

### 5. Panneau de detail
Route /taches/:id/resultats/:resultId inexistante.
Solution : cache local (resultsCache) des resultats affiches.

### 6. Pagination
data.nb_resultats (stats) vs data.total (resultats) - corrige.

---

## Limitations connues

1. Filtres methode/score non supportes par l'API /taches/:id/resultats
2. Stats globales (/stats) non filtrees par tache_id
3. Score moyen et duree moyenne non calcules par /stats
4. Pas de route GET pour un seul resultat (contourne par cache local)

---

## Git

- Depot local : /home/netit972/siretisation-project/
- Remote : https://github.com/NetItBe40/siretisation.git
- Commit initial : 5978d85 (07/04/2026)

### Workflow apres modification

```bash
cd /home/netit972/siretisation-project
# Copier les fichiers modifies
cp /home/netit972/sirene-etl/admin/qualite.html admin/
cp /home/netit972/sirene-etl/api/routes/admin.js api/routes/
# Commiter
git add -A && git commit -m "Description"
git push
```

Note : les fichiers de production restent dans /home/netit972/sirene-etl/.
Le repo siretisation-project est une copie de reference a synchroniser manuellement.
