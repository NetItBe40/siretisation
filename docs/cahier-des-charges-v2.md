# Cahier des charges v2 — Architecture de la siretisation comme service API

**Projet :** Intégration de la siretisation dans l'API SIRENE v5.4
**Complément au :** Cahier des charges v1 (processus de rapprochement)
**Date :** 25 mars 2026
**Auteur :** Net It Be

---

## 1. Vision d'ensemble

La siretisation ne doit pas rester un traitement ponctuel exécuté manuellement. Elle doit devenir un **service permanent** de l'API SIRENE, capable de recevoir des fiches Google Business (ou toute fiche commerciale), de les traiter automatiquement, de stocker l'historique des traitements et de s'améliorer au fil du temps grâce aux retours et aux statistiques accumulées.

Cela implique trois briques fondamentales :

- **Un schéma dédié** dans la base de données pour isoler toute la mécanique de siretisation.
- **De nouveaux endpoints API** pour soumettre, suivre et piloter les demandes.
- **Un moteur d'apprentissage** qui exploite l'historique pour optimiser les règles de matching.

---

## 2. Architecture de la base de données

### 2.1 Pourquoi un schéma dédié ?

Créer un schéma séparé (par exemple `siretisation`) plutôt que d'ajouter des colonnes dans `google_business_v2` apporte plusieurs avantages :

- **Séparation des responsabilités** — Les données Google Business restent intactes dans leur schéma d'origine. La siretisation ne pollue pas les données source.
- **Historique complet** — Chaque tentative de rapprochement est conservée, même si elle échoue ou est remplacée par une meilleure plus tard.
- **Multi-source** — Le jour où vous voudrez siretiser autre chose que Google Business (Pages Jaunes, annuaires sectoriels, fichiers clients), le schéma est déjà prêt.
- **Auditabilité** — On sait exactement quand, comment et pourquoi chaque SIREN a été attribué.

### 2.2 Schéma proposé : `siretisation`

Le schéma comporte **6 tables** organisées autour de trois fonctions : le pilotage des campagnes, le suivi unitaire de chaque fiche, et l'optimisation continue.

---

#### Table 1 : `campagnes`

Cette table pilote les traitements par lots. Chaque fois qu'on lance une siretisation (sur l'ensemble des fiches, un département, un type d'activité), on crée une campagne.

| Colonne | Rôle |
|---|---|
| `id` | Identifiant unique de la campagne |
| `nom` | Nom descriptif (ex : "Siretisation initiale France entière", "Re-matching Martinique 2026-04") |
| `source` | Origine des données : `google_business_v2`, `pages_jaunes`, etc. |
| `schema_source` | Schéma d'origine (ex : `netit972_france_business`) |
| `table_source` | Table d'origine (ex : `google_business_v2`) |
| `filtres_appliques` | JSON décrivant les filtres éventuels (département, catégorie, date...) |
| `nb_fiches_total` | Nombre de fiches à traiter dans cette campagne |
| `nb_matchees` | Compteur de fiches matchées (mis à jour au fil du traitement) |
| `nb_incertaines` | Compteur de fiches au statut "incertain" |
| `nb_echouees` | Compteur de fiches non résolues |
| `nb_en_cours` | Compteur de fiches en cours de traitement |
| `statut` | `en_attente`, `en_cours`, `terminee`, `annulee` |
| `parametres_matching` | JSON contenant les seuils et pondérations utilisés pour cette campagne |
| `date_creation` | Horodatage de création |
| `date_debut` | Horodatage du lancement effectif |
| `date_fin` | Horodatage de fin |
| `lance_par` | Identifiant de l'utilisateur ou du système ayant lancé la campagne |

**Intérêt :** permet de comparer les performances entre campagnes, de relancer un sous-ensemble de fiches, et de tracer qui a déclenché quoi.

---

#### Table 2 : `demandes`

C'est la table centrale. Chaque ligne représente **une fiche à siretiser** (une fiche Google Business = une demande).

| Colonne | Rôle |
|---|---|
| `id` | Identifiant unique de la demande |
| `campagne_id` | Rattachement à la campagne (FK vers `campagnes`) |
| `source_id` | Identifiant de la fiche dans la table source (clé primaire de `google_business_v2`) |
| `source_nom` | Nom commercial tel que reçu |
| `source_nom_nettoyé` | Nom après normalisation |
| `source_adresse` | Adresse complète d'origine |
| `source_code_postal` | Code postal extrait |
| `source_commune` | Commune extraite |
| `source_departement` | Département déduit |
| `source_telephone` | Téléphone d'origine |
| `source_categorie` | Catégorie Google Business |
| `source_latitude` | Latitude GPS |
| `source_longitude` | Longitude GPS |
| `siren_attribue` | SIREN final retenu (NULL si non résolu) |
| `siret_attribue` | SIRET final retenu |
| `score_final` | Score de confiance du meilleur rapprochement |
| `methode_finale` | Passe ayant produit le résultat retenu (`passe_1`, `passe_2`, ..., `manuel`) |
| `statut` | `en_attente`, `en_cours`, `matchee`, `incertaine`, `echouee`, `validee_manuellement`, `rejetee` |
| `nb_tentatives` | Nombre total de tentatives de rapprochement |
| `date_creation` | Horodatage de création |
| `date_derniere_tentative` | Horodatage du dernier traitement |
| `date_validation` | Horodatage de la validation (manuelle ou automatique) |
| `validee_par` | Identifiant du validateur (NULL si automatique) |

**Intérêt :** c'est le point de liaison entre la fiche source et le résultat. On ne touche jamais à la table source, on lit ici.

---

#### Table 3 : `tentatives`

Chaque appel API effectué pour rapprocher une fiche est enregistré ici. Une demande peut avoir 1 à N tentatives (une par passe, voire plusieurs par passe si retry).

| Colonne | Rôle |
|---|---|
| `id` | Identifiant unique |
| `demande_id` | FK vers `demandes` |
| `passe` | Numéro de passe (`1`, `2`, `3`, `4`) |
| `endpoint_appele` | Endpoint API utilisé (`/api/suggestions`, `/api/recherche`, etc.) |
| `parametres_envoyes` | JSON des paramètres envoyés à l'API |
| `nb_resultats` | Nombre de résultats retournés par l'API |
| `siren_candidat` | SIREN du meilleur candidat identifié |
| `siret_candidat` | SIRET du meilleur candidat |
| `denomination_candidat` | Dénomination retournée par l'API |
| `score_calcule` | Score de confiance calculé pour ce candidat |
| `detail_score` | JSON décomposant le score (points par critère) |
| `retenu` | Booléen — cette tentative est-elle celle retenue comme résultat final ? |
| `temps_reponse_ms` | Temps de réponse de l'API en millisecondes |
| `code_http` | Code de retour HTTP |
| `erreur` | Message d'erreur si échec |
| `date_execution` | Horodatage |

**Intérêt :** c'est la boîte noire. On sait exactement ce qui a été essayé, ce que l'API a retourné, et pourquoi le score est tel qu'il est. Indispensable pour l'optimisation.

---

#### Table 4 : `candidats`

Quand une tentative retourne plusieurs résultats plausibles, chacun est stocké ici. Cela permet l'arbitrage humain dans les cas incertains.

| Colonne | Rôle |
|---|---|
| `id` | Identifiant unique |
| `tentative_id` | FK vers `tentatives` |
| `rang` | Position dans les résultats (1 = meilleur score) |
| `siren` | SIREN du candidat |
| `siret` | SIRET du candidat |
| `denomination` | Dénomination officielle |
| `adresse` | Adresse de l'établissement |
| `code_postal` | Code postal |
| `commune` | Commune |
| `activite_principale` | Code NAF |
| `etat_administratif` | `A` (actif), `C` (cessée) |
| `score` | Score de confiance |
| `detail_score` | JSON décomposant le score |
| `distance_gps_m` | Distance en mètres entre la fiche Google et l'établissement |

**Intérêt :** quand le score est entre 50 et 79, un humain peut venir consulter les 2 ou 3 candidats et choisir le bon. On conserve aussi les "perdants" pour améliorer l'algorithme.

---

#### Table 5 : `validations_manuelles`

Trace chaque intervention humaine sur un rapprochement.

| Colonne | Rôle |
|---|---|
| `id` | Identifiant unique |
| `demande_id` | FK vers `demandes` |
| `action` | `confirmer`, `corriger`, `rejeter` |
| `siren_avant` | SIREN qui était attribué avant intervention |
| `siren_apres` | SIREN attribué après intervention |
| `motif` | Texte libre expliquant la décision |
| `valideur` | Identifiant de la personne |
| `date_validation` | Horodatage |

**Intérêt :** chaque correction humaine est un signal d'entraînement. Si un humain corrige systématiquement un certain type de matching, c'est que l'algorithme a un biais qu'on peut corriger.

---

#### Table 6 : `metriques_optimisation`

Agrégations calculées régulièrement pour piloter l'amélioration continue.

| Colonne | Rôle |
|---|---|
| `id` | Identifiant unique |
| `campagne_id` | FK vers `campagnes` (NULL si métrique globale) |
| `date_calcul` | Horodatage |
| `taux_matching_global` | Pourcentage de fiches matchées (score ≥ 80) |
| `taux_incertain` | Pourcentage de fiches entre 50 et 79 |
| `taux_echec` | Pourcentage de fiches non résolues |
| `score_moyen` | Score moyen des fiches matchées |
| `score_median` | Score médian |
| `taux_precision_estimee` | Précision estimée (basée sur les validations manuelles) |
| `taux_par_passe` | JSON : `{"passe_1": 65, "passe_2": 18, "passe_3": 10, "passe_4": 4}` |
| `taux_par_departement` | JSON : taux de matching par département |
| `taux_par_categorie` | JSON : taux de matching par catégorie Google |
| `nb_corrections_humaines` | Nombre de validations manuelles depuis le dernier calcul |
| `principales_causes_echec` | JSON catégorisant les raisons d'échec |

**Intérêt :** c'est le tableau de bord. On y voit d'un coup d'œil si la dernière campagne a mieux fonctionné que la précédente, quels départements posent problème, et quelles catégories d'entreprises échappent au matching.

---

## 3. Nouveaux endpoints API proposés

La siretisation devient une fonctionnalité de l'API SIRENE v5.4. Voici les endpoints à créer :

### 3.1 Soumission et pilotage

| Endpoint | Méthode | Rôle |
|---|---|---|
| `/api/siretisation/campagne` | POST | Créer une nouvelle campagne (déclenche le traitement asynchrone) |
| `/api/siretisation/campagne/:id` | GET | Consulter l'état d'avancement d'une campagne |
| `/api/siretisation/campagnes` | GET | Lister toutes les campagnes avec filtres et pagination |
| `/api/siretisation/campagne/:id/relancer` | POST | Relancer le traitement sur les fiches échouées ou incertaines |
| `/api/siretisation/campagne/:id/annuler` | POST | Annuler une campagne en cours |

### 3.2 Consultation unitaire

| Endpoint | Méthode | Rôle |
|---|---|---|
| `/api/siretisation/demande/:id` | GET | Détail complet d'une demande (tentatives, candidats, score) |
| `/api/siretisation/demandes` | GET | Lister les demandes avec filtres (statut, campagne, score, département) |
| `/api/siretisation/fiche` | POST | Soumettre **une seule fiche** à siretiser en temps réel (réponse synchrone) |

### 3.3 Validation manuelle

| Endpoint | Méthode | Rôle |
|---|---|---|
| `/api/siretisation/demande/:id/valider` | POST | Confirmer le SIREN proposé |
| `/api/siretisation/demande/:id/corriger` | POST | Attribuer un SIREN différent avec motif |
| `/api/siretisation/demande/:id/rejeter` | POST | Marquer comme "non siretisable" avec motif |
| `/api/siretisation/a-valider` | GET | Liste des demandes en attente de validation humaine, triées par priorité |

### 3.4 Statistiques et optimisation

| Endpoint | Méthode | Rôle |
|---|---|---|
| `/api/siretisation/stats` | GET | Métriques globales (taux de matching, score moyen, etc.) |
| `/api/siretisation/stats/campagne/:id` | GET | Métriques pour une campagne spécifique |
| `/api/siretisation/stats/evolution` | GET | Évolution des métriques dans le temps (pour graphiques) |
| `/api/siretisation/optimisation/rapport` | GET | Rapport d'optimisation : causes d'échec, suggestions d'amélioration |

---

## 4. Cycle de vie d'une demande

Chaque fiche suit un parcours précis à travers les statuts :

```
                    ┌─────────────┐
                    │  en_attente  │  (fiche soumise, pas encore traitée)
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │   en_cours   │  (traitement actif, passes en cours)
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
       ┌──────────┐ ┌────────────┐ ┌──────────┐
       │ matchee  │ │ incertaine │ │ echouee  │
       │ (≥ 80)   │ │  (50-79)   │ │  (< 50)  │
       └────┬─────┘ └─────┬──────┘ └────┬─────┘
            │             │              │
            │             ▼              │
            │   ┌──────────────────┐     │
            │   │ Revue humaine    │     │
            │   └───┬────┬────┬───┘     │
            │       │    │    │         │
            ▼       ▼    │    ▼         ▼
    ┌───────────────┐    │  ┌──────────────┐
    │    validee    │    │  │   rejetee     │
    │ (SIREN final) │    │  │ (non siretis.)│
    └───────────────┘    │  └──────────────┘
                         ▼
                ┌────────────────┐
                │    corrigee     │
                │ (SIREN modifié) │
                └────────────────┘
```

Les fiches "matchées" avec un score ≥ 80 passent automatiquement en "validée" sauf si la campagne est configurée pour exiger une validation humaine systématique.

---

## 5. Boucle d'optimisation continue

### 5.1 Le principe

Chaque correction humaine est un signal. Si un humain change le SIREN proposé, c'est que l'algorithme s'est trompé. En analysant ces corrections, on peut ajuster les pondérations du scoring.

### 5.2 Les données qui alimentent l'optimisation

- **Corrections humaines** (table `validations_manuelles`) — Quand un humain corrige un résultat, on compare le score détaillé du mauvais candidat avec celui du bon. On en déduit quels critères ont sur-pondéré ou sous-pondéré.
- **Taux de réussite par passe** — Si la passe 3 (texte libre) produit beaucoup de faux positifs, on peut resserrer ses seuils.
- **Taux par catégorie/département** — Certaines catégories Google se mappent mal aux codes NAF. On peut créer une table de correspondance catégorie→NAF affinée au fil du temps.
- **Patterns d'échec** — Les fiches échouées révèlent des patterns : noms commerciaux très différents de la raison sociale, enseignes de franchises, auto-entrepreneurs utilisant un nom fantaisiste, etc.

### 5.3 Les leviers d'ajustement

| Levier | Ce qu'on modifie | Comment on décide |
|---|---|---|
| **Pondérations du scoring** | Points attribués à chaque critère (nom, CP, commune, GPS...) | Analyse des corrections humaines : si les corrections portent souvent sur des fiches où le nom matchait bien mais l'adresse était fausse, on augmente le poids de l'adresse. |
| **Seuils de confiance** | Seuil "matchée" (80) et "incertaine" (50) | Si trop de faux positifs au-dessus de 80, on monte le seuil. Si trop de validations manuelles triviales entre 50 et 80, on baisse le seuil haut. |
| **Table de correspondance catégories** | Mapping catégorie Google → codes NAF probables | On enrichit au fur et à mesure avec les résultats validés. |
| **Dictionnaire d'enseignes** | Liste enseigne → SIREN maison-mère | Pour les franchises (McDo, Carrefour, pharmacies...), un dictionnaire permet un matching direct sans passer par les passes. |
| **Règles de nettoyage** | Expressions régulières de normalisation des noms | Les corrections révèlent des patterns de nommage non gérés. |

### 5.4 Quand optimiser ?

L'optimisation n'est pas permanente. Elle se fait par cycles :

1. **Après chaque campagne** — On calcule les métriques et on compare avec la campagne précédente.
2. **Après 100 validations manuelles** — Seuil suffisant pour détecter des tendances statistiquement significatives.
3. **Sur demande** — L'endpoint `/api/siretisation/optimisation/rapport` génère un rapport avec des suggestions concrètes.

---

## 6. Mise en place — Ordre des travaux

### Phase 1 : Fondations (schéma et tables)

Créer le schéma `siretisation` et les 6 tables décrites en section 2. C'est la première étape car tout le reste en dépend. Prévoir les index sur les colonnes de recherche fréquente : `demande.statut`, `demande.campagne_id`, `demande.score_final`, `tentative.demande_id`.

### Phase 2 : Moteur de rapprochement (logique métier)

Coder le moteur qui implémente les 4 passes du cahier des charges v1. Ce moteur doit être un module interne de l'API, pas un script séparé. Il lit les demandes en statut `en_attente`, les traite, et écrit les résultats dans `tentatives` et `candidats`.

### Phase 3 : Endpoints de soumission et suivi

Ajouter les routes `/api/siretisation/*` à l'API existante. Commencer par les endpoints essentiels : créer une campagne, consulter son avancement, consulter une demande. Le traitement en lot doit être asynchrone — l'endpoint de création de campagne retourne immédiatement un ID, le traitement se fait en arrière-plan.

### Phase 4 : Interface de validation manuelle

Exposer les endpoints de validation (`/valider`, `/corriger`, `/rejeter`, `/a-valider`). Ces endpoints alimentent la table `validations_manuelles`. À terme, une interface web dédiée permettra aux opérateurs de traiter les cas incertains visuellement.

### Phase 5 : Siretisation en temps réel

L'endpoint `/api/siretisation/fiche` (POST) permet de soumettre une seule fiche et d'obtenir le résultat immédiatement. Utile pour les intégrations en temps réel (nouvelle fiche Google Business détectée → siretisation instantanée).

### Phase 6 : Métriques et optimisation

Implémenter le calcul des métriques (table `metriques_optimisation`) et les endpoints de statistiques. Mettre en place la boucle d'optimisation décrite en section 5.

### Phase 7 : Siretisation incrémentale

Ajouter un mécanisme qui détecte les nouvelles fiches dans `google_business_v2` (via un trigger, un cron, ou un webhook) et les soumet automatiquement à la siretisation. Les fiches déjà traitées ne sont pas re-traitées sauf demande explicite.

---

## 7. Relations entre les tables (modèle de données)

```
  ┌──────────────┐
  │  campagnes   │
  │              │
  │  id ─────────┼──────┐
  │  nom         │      │
  │  statut      │      │
  │  parametres  │      │
  └──────────────┘      │
                        │ 1:N
                        ▼
                 ┌──────────────┐        ┌─────────────────────┐
                 │   demandes   │        │ validations_manuelles│
                 │              │ 1:N    │                     │
                 │  id ─────────┼───────►│  demande_id         │
                 │  campagne_id │        │  action              │
                 │  source_id   │        │  siren_avant/apres   │
                 │  siren_attrib│        └─────────────────────┘
                 │  statut      │
                 │  score_final │
                 └──────┬───────┘
                        │ 1:N
                        ▼
                 ┌──────────────┐
                 │  tentatives  │
                 │              │
                 │  demande_id  │
                 │  passe       │
                 │  endpoint    │
                 │  score       │
                 │  id ─────────┼──────┐
                 └──────────────┘      │ 1:N
                                       ▼
                                ┌──────────────┐
                                │  candidats   │
                                │              │
                                │ tentative_id │
                                │ siren        │
                                │ score        │
                                │ rang         │
                                └──────────────┘

  ┌─────────────────────────┐
  │ metriques_optimisation  │
  │                         │
  │  campagne_id (nullable) │
  │  taux_matching          │
  │  taux_par_passe (JSON)  │
  └─────────────────────────┘
```

---

## 8. Synthèse des décisions architecturales

| Question | Décision | Justification |
|---|---|---|
| Schéma dédié ou colonnes dans la table source ? | **Schéma dédié `siretisation`** | Séparation des responsabilités, multi-source, historique complet |
| Script séparé ou module API ? | **Module intégré à l'API** | Cohérence technique, réutilisation de la couche d'accès SIRENE, endpoints unifiés |
| Traitement synchrone ou asynchrone ? | **Asynchrone pour les lots, synchrone pour les fiches unitaires** | Les campagnes peuvent durer des heures ; les fiches unitaires doivent répondre en < 2 secondes |
| Validation automatique ou systématiquement humaine ? | **Automatique au-dessus du seuil, humaine en dessous** | Compromis entre volume et qualité ; seuil ajustable par campagne |
| Stockage des candidats non retenus ? | **Oui, dans la table `candidats`** | Indispensable pour la revue manuelle et l'optimisation de l'algorithme |
| Optimisation manuelle ou automatique ? | **Semi-automatique** | L'API calcule les métriques et suggère des ajustements ; un humain valide avant application |
