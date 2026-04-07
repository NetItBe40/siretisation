# API Siretisation - Documentation Complete

> Version : 1.0 - 07/04/2026
> Serveur : srv1.net-it-be.com:3001
> Base de donnees : netit972_siretisation (MySQL)

## Architecture

Le serveur Express ecoute sur le port 3001 et expose deux routers :
- **pagesRouter** (`/admin/`) : pages HTML d'administration
- **apiRouter** (`/api/v1/admin/`) : API REST JSON

Process PM2 : siretisation-api (id 19)

---

## Authentification

### POST /api/v1/admin/login
Rate-limite : 5 tentatives / 15 min par IP.
Body : `{ "user": "...", "password": "..." }`
Reponse : `{ "success": true }` | Session cookie connect.sid (8h)
Tous les appels API doivent inclure `credentials: 'include'`.

### POST /api/v1/admin/logout
Deconnexion et destruction de la session.

---

## Statistiques globales

### GET /api/v1/admin/stats
Stats globales (toutes taches confondues).
Reponse : `{ nb_taches, en_cours, nb_resultats, matched, erreurs, incertaines }`

---

## Taches

### GET /api/v1/admin/taches
Liste toutes les taches (ORDER BY id DESC).
Reponse : Array `[{ id, type, statut, nb_total, nb_traite, fichier_source, date_creation }]`

### GET /api/v1/admin/taches/:id
Detail d'une tache + stats de resultats.
Reponse : `{ ...tache, total, matched, erreurs, incertaines, score_moyen }`

### GET /api/v1/admin/taches/:id/progression
Progression temps reel.
Reponse : `{ statut, nb_total, nb_traite, traite, matched, erreurs, incertaines }`

### GET /api/v1/admin/taches/:id/resultats
**Endpoint principal de la page qualite.**
Params : page(1), limit(50), q(recherche nom/siren), statut, sort(id), order(DESC)
Reponse : `{ rows: [...], total, page, pages }`
Note : params methode et score NON supportes cote serveur.

### POST /api/v1/admin/taches/:id/retraiter
Relance tous les ECHOUES. Reponse : `{ ok, message, count }`

### POST /api/v1/admin/taches
Cree une tache. Body : `{ type, fichier_source, parametres }`
Reponse : `{ ok, id }`

---

## Fiches (resultats individuels)

### GET /api/v1/admin/fiches
Recherche avancee tous resultats.
Params : page, limit, q, tache_id, statut, cp, has_siren, score_min, score_max, methode, date_from, date_to, sort, order

### GET /api/v1/admin/fiches/:id
Detail + logs. Reponse : `{ ...resultat, logs: [...] }`

### POST /api/v1/admin/fiches/:id/relancer
Relance un resultat. Body : `{ methode: "auto|sirene_locale|firecrawl", seuil_firecrawl: 80 }`
Reponse : `{ ok, resultat: { siren, siret, score, statut_siretisation, methode_utilisee, duree_ms }, etapes: [...] }`

---

## Exports

### GET /api/v1/admin/export/:tacheId
Export XLSX de tous les resultats d'une tache.

### GET /api/v1/admin/export-fiches
Export XLSX des fiches filtrees (limite 50 000).

---

## Cles API

- GET /api/v1/admin/api-keys : Liste
- POST /api/v1/admin/api-keys : Creation (body: nom, email, societe, rate_limit, permissions)
- PUT /api/v1/admin/api-keys/:id : Mise a jour
- DELETE /api/v1/admin/api-keys/:id : Suppression

---

## Pages HTML Admin

| Route | Fichier | Description |
|-------|---------|-------------|
| /admin/ | accueil.html | Accueil |
| /admin/taches | taches.html | Liste des taches + login |
| /admin/qualite | qualite.html | Controle qualite |
| /admin/documentation | documentation.html | Documentation |
| /admin/api-keys | api-keys.html | Gestion cles API |

---

## Base de donnees

### Tables
- **taches** : id, type, statut, nb_total, nb_traite, fichier_source, parametres, date_creation
- **resultats** : id, tache_id, ref_externe, nom, adresse, code_postal, ville, telephone, siret_fourni, statut_siretisation, score, methode_utilisee, siren, siret, sir_denomination, sir_adresse, sir_code_postal, sir_ville, sir_activite, sir_etat_administratif, duree_ms, date_traitement
- **logs** : id, resultat_id, date_log
- **api_keys** : id, cle_api, nom, email, societe, actif, rate_limit, permissions

### Statuts de siretisation
- MATCHEE : score >= 70
- INCERTAINE : score 50-69
- ECHOUEE : score < 50
- EN_ATTENTE : non traite
