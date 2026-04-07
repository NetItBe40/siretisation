# Cahier des charges v3 — Audit de la structure réelle et adaptation du modèle

**Projet :** Siretisation des fiches Google Business → Service API SIRENE
**Base de données :** MariaDB 10.11.15 — srv1.net-it-be.com:3306
**Schéma inspecté :** `netit972_france_business`
**Date d'audit :** 25 mars 2026
**Auteur :** Net It Be

---

## 1. Inventaire complet du schéma `netit972_france_business`

L'inspection de phpMyAdmin révèle **10 tables** dans le schéma. Voici l'inventaire complet avec volumétrie :

| Table | Lignes | Taille | Rôle identifié |
|---|---|---|---|
| `google_business_v2` | **894 771** | 646 Mo | **Table source principale** — Fiches Google Business collectées |
| `google_business` | 283 888 | 102 Mo | Ancienne version des fiches (v1) |
| `sirene_etablissements` | **3 083 790** | 1,4 Go | **Cache local SIRENE** — Établissements pré-chargés depuis l'API |
| `matching_results` | **78 062** | 23,5 Mo | **Résultats de siretisation** — Travail déjà commencé |
| `search_log_v2` | 84 731 | 11 Mo | Journal des recherches effectuées |
| `brand_mapping` | 0 | 48 Ko | Table de correspondance enseignes (vide) |
| `collection_jobs` | 0 | 48 Ko | Jobs de collecte (vide) |
| `linkedin_apollo_link` | 0 | 48 Ko | Liaison LinkedIn/Apollo (vide) |
| `linkedin_check_log` | 0 | 48 Ko | Log vérification LinkedIn (vide) |
| `linkedin_companies` | ~63 144 | 28 Mo | Entreprises LinkedIn |

**Constats clés :**
- Un processus de siretisation a déjà été lancé : 78 062 fiches sur 894 771 ont un résultat dans `matching_results` (soit **8,7% de couverture**).
- Un cache local de 3M d'établissements SIRENE existe déjà dans `sirene_etablissements`.
- Les tables `brand_mapping` et `collection_jobs` existent mais sont vides — elles étaient prévues mais jamais alimentées.
- Toutes les tables ont été créées ou modifiées entre le 11 et le 25 mars 2026 (projet en cours).

---

## 2. Structure détaillée des tables clés

### 2.1 Table `google_business_v2` — 894 771 lignes

| # | Colonne | Type | Nullable | Défaut | Rôle pour la siretisation |
|---|---|---|---|---|---|
| 1 | `id` | bigint(20) | Non | AUTO_INCREMENT | **Clé primaire** — identifiant unique de la fiche |
| 2 | `nom_gb` | text | Oui | NULL | **Nom commercial** — donnée principale pour le matching |
| 3 | `adresse_gb` | text | Oui | NULL | **Adresse complète** — rapprochement géographique |
| 4 | `ville` | varchar(255) | Oui | NULL | **Ville** — filtrage géographique |
| 5 | `code_postal` | varchar(5) | Oui | NULL | **Code postal** — critère de filtrage clé |
| 6 | `departement` | varchar(3) | Oui | NULL | **Département** — filtrage large |
| 7 | `telephone` | varchar(20) | Oui | NULL | **Téléphone** — rapprochement secondaire |
| 8 | `note` | decimal(2,1) | Oui | NULL | Note Google (1.0 à 5.0) — non utilisé pour le matching |
| 9 | `avis` | int(11) | Oui | NULL | Nombre d'avis — non utilisé pour le matching |
| 10 | `categorie_gb` | text | Oui | NULL | **Catégorie Google** — correspondance NAF |
| 11 | `lien_gmaps` | text | Oui | NULL | Lien Google Maps — extraction possible du place_id |
| 12 | `site_web` | text | Oui | NULL | **Site web** — peut contenir le SIRET ou des indices |
| 13 | `latitude` | decimal(10,6) | Oui | NULL | **Latitude GPS** — rapprochement géographique passe 4 |
| 14 | `longitude` | decimal(10,6) | Oui | NULL | **Longitude GPS** — rapprochement géographique passe 4 |
| 15 | `recherche` | text | Oui | NULL | Termes de recherche utilisés lors de la collecte |
| 16 | `scraped_at` | timestamp | Oui | current_timestamp() | Date de collecte |
| 17 | `facebook` | text | Oui | NULL | Lien Facebook |
| 18 | `instagram` | text | Oui | NULL | Lien Instagram |
| 19 | `twitter` | text | Oui | NULL | Lien Twitter/X |
| 20 | `linkedin` | text | Oui | NULL | Lien LinkedIn |
| 21 | `youtube` | text | Oui | NULL | Lien YouTube |
| 22 | `tiktok` | text | Oui | NULL | Lien TikTok |
| 23 | `scraped_by` | varchar(100) | Oui | NULL | Identifiant du collecteur |

**Index existants :**

| Index | Type | Colonne | Cardinalité |
|---|---|---|---|
| PRIMARY | BTREE | `id` | 894 773 |
| lien_gmaps | HASH (Unique) | `lien_gmaps` | — |
| idx_dept | BTREE | `departement` | 82 |
| idx_cp | BTREE | `code_postal` | 3 195 |
| idx_nom | BTREE | `nom_gb` (100 chars) | 894 773 |
| idx_tel | BTREE | `telephone` | 894 773 |

**Analyse :**
- La table est déjà bien indexée (département, code postal, nom, téléphone).
- Le champ `lien_gmaps` a un index HASH unique → c'est le dédoublonnage naturel des fiches.
- Les 6 colonnes de réseaux sociaux (Facebook à TikTok) sont un bonus pour du rapprochement indirect (scraper le SIRET sur la page Facebook d'une entreprise, par exemple).
- Le champ `recherche` donne un contexte sur le type de business recherché.

### 2.2 Table `matching_results` — 78 062 lignes

| # | Colonne | Type | Nullable | Défaut | Rôle |
|---|---|---|---|---|---|
| 1 | `id` | bigint(20) UNSIGNED | Non | AUTO_INCREMENT | Clé primaire |
| 2 | `gb_id` | bigint(20) UNSIGNED | Non | — | **FK vers google_business_v2.id** |
| 3 | `siret` | varchar(14) | Non | — | SIRET attribué |
| 4 | `siren` | varchar(9) | Oui | NULL | SIREN déduit |
| 5 | `score_match` | int(11) | Non | — | Score de confiance (0-100) |
| 6 | `confiance` | varchar(10) | Oui | NULL | Niveau de confiance textuel |
| 7 | `methode` | text | Oui | NULL | Méthode de matching utilisée |
| 8 | `matched_at` | timestamp | Oui | current_timestamp() | Date du rapprochement |
| 9 | `details` | longtext | Oui | NULL | Détails JSON (binaire) |

**Index existants :**

| Index | Type | Colonnes | Note |
|---|---|---|---|
| PRIMARY | BTREE | `id` | |
| uk_match_gb_siret | BTREE (Unique) | `gb_id` + `siret` | Empêche les doublons fiche/SIRET |
| idx_match_gb | BTREE | `gb_id` | |
| idx_match_siret | BTREE | `siret` | |
| idx_match_siren | BTREE | `siren` | |
| idx_match_score | BTREE | `score_match` | |

**Analyse :**
- La contrainte unique `(gb_id, siret)` est correcte : une fiche peut avoir plusieurs candidats SIRET mais pas de doublon.
- Le champ `methode` contient des valeurs comme `nom_100`, `nom_100+cp`, `nom_70+cp`, `nom_100+cp+naf+addr_100`, `nom_52+cp+naf`, etc. — ce sont des descriptions textuelles des critères qui ont matché.
- Le champ `confiance` utilise les niveaux `haute`, `moyenne` (vu dans les données).
- Le score va de 40 à 85 dans les données observées.
- **78 062 lignes sur 894 771 fiches = 8,7% de couverture.** Il reste 91,3% à traiter.

### 2.3 Table `sirene_etablissements` — 3 083 790 lignes

| # | Colonne | Type | Nullable | Défaut | Rôle |
|---|---|---|---|---|---|
| 1 | `siret` | varchar(14) | Non | — | **Clé primaire** |
| 2 | `siren` | varchar(9) | Non | — | SIREN parent |
| 3 | `departement` | varchar(3) | Non | — | Département |
| 4 | `nom_complet` | text | Oui | NULL | Dénomination sociale |
| 5 | `adresse` | text | Oui | NULL | Adresse complète |
| 6 | `code_postal` | varchar(5) | Oui | NULL | Code postal |
| 7 | `commune` | varchar(255) | Oui | NULL | Commune |
| 8 | `naf` | varchar(6) | Oui | NULL | Code NAF (activité) |
| 9 | `enseigne` | text | Oui | NULL | **Enseigne commerciale** — crucial pour le matching |
| 10 | `latitude` | decimal(10,6) | Oui | NULL | Latitude GPS |
| 11 | `longitude` | decimal(10,6) | Oui | NULL | Longitude GPS |
| 12 | `categorie` | varchar(50) | Oui | NULL | Catégorie attribuée |
| 13 | `fetched_at` | timestamp | Oui | current_timestamp() | Date de chargement |

**Index existants :**

| Index | Type | Colonne | Cardinalité |
|---|---|---|---|
| PRIMARY | BTREE (Unique) | `siret` | 3 083 790 |
| idx_sirene_dept | BTREE | `departement` | 12 093 |
| idx_sirene_siren | BTREE | `siren` | 3 083 790 |
| idx_sirene_naf | BTREE | `naf` | 34 264 |
| idx_sirene_cp | BTREE | `code_postal` | 17 929 |
| idx_sirene_cat | BTREE | `categorie` | 10 744 |
| idx_sirene_nom_ft | **FULLTEXT** | `nom_complet` | — |

**Analyse :**
- Un index FULLTEXT existe déjà sur `nom_complet` → la recherche textuelle est possible directement en SQL, sans passer par l'API.
- Le champ `enseigne` est présent — c'est un atout majeur car beaucoup de fiches Google utilisent l'enseigne plutôt que la raison sociale.
- 3M d'établissements avec coordonnées GPS → le matching géographique peut se faire en local aussi.
- **Cette table permet un rapprochement hybride : local (SQL direct) + API pour les cas non résolus.**

### 2.4 Table `search_log_v2` — 84 731 lignes

| # | Colonne | Type | Rôle |
|---|---|---|---|
| 1 | `id` | bigint(20) | Clé primaire |
| 2 | `departement` | varchar(3) | Département recherché |
| 3 | `code_postal` | varchar(5) | Code postal recherché |
| 4 | `categorie` | varchar(100) | Catégorie recherchée |
| 5 | `results_count` | int(11) | Nombre de résultats trouvés |
| 6 | `searched_at` | timestamp | Date de la recherche |

Ce log trace les recherches de collecte Google Business (pas les recherches de siretisation).

---

## 3. Écarts entre le modèle prévu (v2) et la réalité

### 3.1 Ce qui existe déjà

| Élément prévu dans le CDC v2 | Équivalent existant | État |
|---|---|---|
| Table `demandes` | `matching_results` | **Existe** mais structure simplifiée (pas de notion de campagne, pas de statut détaillé) |
| Table `tentatives` | Partiellement dans `matching_results.details` | **Partiel** — un seul résultat par ligne, pas d'historique des essais |
| Table `candidats` | Non existante | **Manquant** |
| Table `campagnes` | Non existante | **Manquant** |
| Table `validations_manuelles` | Non existante | **Manquant** |
| Table `metriques_optimisation` | Non existante | **Manquant** |
| Cache local SIRENE | `sirene_etablissements` | **Existe** — 3M d'établissements avec FULLTEXT |
| Table de correspondance enseignes | `brand_mapping` | **Existe mais vide** |
| Log de recherche | `search_log_v2` | **Existe** — pour la collecte, pas pour le matching |

### 3.2 Ce qu'il faut adapter dans le modèle v2

**Adaptation 1 : Double stratégie de matching (local + API)**

Le cache `sirene_etablissements` de 3M de lignes avec un index FULLTEXT permet un rapprochement en SQL pur, beaucoup plus rapide que les appels API. La stratégie de matching doit être revue :

- **Passe 0 (NOUVELLE)** — Matching local SQL : requête FULLTEXT sur `sirene_etablissements.nom_complet` + filtre `code_postal` + filtre `departement`. Également comparer avec `sirene_etablissements.enseigne`.
- **Passes 1 à 4** — Via l'API SIRENE, uniquement pour les fiches non résolues en passe 0.

Ce changement réduit considérablement le nombre d'appels API et accélère le traitement global.

**Adaptation 2 : Intégration de `matching_results` existante**

Il ne faut pas repartir de zéro. Les 78 062 résultats existants doivent être :
1. Migrés dans la nouvelle structure (table `demandes`).
2. Leurs scores recalculés avec le nouveau barème pour homogénéité.
3. Marqués avec la méthode d'origine (`methode` existante → champ `methode_finale`).

**Adaptation 3 : Alimentation de `brand_mapping`**

La table `brand_mapping` est prête mais vide. Le processus de siretisation doit l'alimenter au fil de l'eau : chaque fois qu'une enseigne connue (McDonald's, Carrefour, Pharmacie Lafayette, etc.) est matchée avec succès, on l'ajoute au dictionnaire pour accélérer les matchings futurs.

**Adaptation 4 : Noms de colonnes réels dans la table `demandes`**

Le CDC v2 utilisait des noms hypothétiques. Voici la correspondance exacte :

| Colonne prévue (CDC v2) | Colonne réelle (google_business_v2) |
|---|---|
| `source_nom` | `nom_gb` |
| `source_adresse` | `adresse_gb` |
| `source_code_postal` | `code_postal` |
| `source_commune` | `ville` |
| `source_departement` | `departement` |
| `source_telephone` | `telephone` |
| `source_categorie` | `categorie_gb` |
| `source_latitude` | `latitude` |
| `source_longitude` | `longitude` |

---

## 4. Architecture révisée — Plan de création des tables

### 4.1 Tables à créer (schéma `siretisation` ou dans `netit972_france_business`)

Étant donné que le travail est déjà commencé dans `netit972_france_business`, deux options se présentent :

**Option A — Nouveau schéma `siretisation`** (recommandation CDC v2)
- Séparation propre, mais nécessite des requêtes cross-schema.
- Plus d'effort de migration.

**Option B — Rester dans `netit972_france_business`** avec un préfixe `srt_`
- Toutes les tables au même endroit, jointures simples.
- Préfixe `srt_` pour identifier les tables de siretisation.
- Plus pragmatique vu l'état actuel.

**Recommandation : Option B** — rester dans le même schéma avec préfixe. Voici les tables à créer :

| Table à créer | Rôle | Remplace ou complète |
|---|---|---|
| `srt_campagnes` | Pilotage des lots | Nouveau |
| `srt_demandes` | Une ligne par fiche à siretiser | Évolue `matching_results` |
| `srt_tentatives` | Chaque essai de rapprochement | Nouveau (était dans `details` JSON) |
| `srt_candidats` | Résultats multiples par tentative | Nouveau |
| `srt_validations` | Corrections humaines | Nouveau |
| `srt_metriques` | Tableau de bord | Nouveau |

La table `matching_results` existante est **conservée en lecture seule** comme archive. Les 78 062 résultats sont migrés vers `srt_demandes` lors de l'initialisation.

### 4.2 Tables existantes à enrichir

| Table | Modification |
|---|---|
| `brand_mapping` | Définir sa structure (actuellement vide) pour stocker les correspondances enseigne → SIREN |
| `sirene_etablissements` | Ajouter un index FULLTEXT sur `enseigne` (actuellement seul `nom_complet` a un FULLTEXT) |

### 4.3 Nouveaux endpoints API à ajouter à l'API SIRENE

En tenant compte de la double stratégie (local + API) :

| Endpoint | Méthode | Nouveauté par rapport au CDC v2 |
|---|---|---|
| `POST /api/siretisation/fiche` | POST | Siretisation unitaire — essaie d'abord le matching local SQL, puis API si échec |
| `POST /api/siretisation/campagne` | POST | Crée une campagne — spécifie la source (table), les filtres, les paramètres de scoring |
| `GET /api/siretisation/campagne/:id` | GET | Suivi d'avancement avec compteurs temps réel |
| `GET /api/siretisation/stats` | GET | Métriques globales incluant taux de matching local vs API |
| `POST /api/siretisation/demande/:id/valider` | POST | Validation humaine |
| `POST /api/siretisation/demande/:id/corriger` | POST | Correction avec alimentation automatique de `brand_mapping` |

---

## 5. Stratégie de matching révisée (5 passes)

Compte tenu du cache local `sirene_etablissements`, la stratégie passe de 4 à 5 passes :

```
┌─────────────────────────────────────────────────────────┐
│  PASSE 0 — Matching local SQL (sirene_etablissements)   │
│  FULLTEXT sur nom_complet + enseigne                    │
│  Filtre code_postal + departement                       │
│  ➜ Résolution estimée : 50-60% des fiches               │
│  ➜ Temps : quelques minutes pour 900K fiches             │
└──────────────────────────┬──────────────────────────────┘
                           │ fiches non résolues
                           ▼
┌─────────────────────────────────────────────────────────┐
│  PASSE 1 — API /api/suggestions (nom exact + CP)        │
│  ➜ Résolution estimée : 15-20% des fiches restantes     │
│  ➜ Temps : ~100ms par appel                              │
└──────────────────────────┬──────────────────────────────┘
                           │ fiches non résolues
                           ▼
┌─────────────────────────────────────────────────────────┐
│  PASSE 2 — API /api/recherche (multicritère élargi)     │
│  ➜ Résolution estimée : 10-15% des fiches restantes     │
│  ➜ Temps : ~500ms par appel                              │
└──────────────────────────┬──────────────────────────────┘
                           │ fiches non résolues
                           ▼
┌─────────────────────────────────────────────────────────┐
│  PASSE 3 — API /api/recherche-texte (texte libre)       │
│  ➜ Résolution estimée : 5-10% des fiches restantes      │
│  ➜ Temps : ~500ms par appel                              │
└──────────────────────────┬──────────────────────────────┘
                           │ fiches non résolues
                           ▼
┌─────────────────────────────────────────────────────────┐
│  PASSE 4 — Rapprochement GPS (distance haversine)       │
│  Coordonnées google_business_v2 vs sirene_etablissements│
│  ➜ Résolution estimée : 3-5% des fiches restantes       │
│  ➜ Peut se faire en local SQL (les deux tables ont GPS) │
└──────────────────────────┬──────────────────────────────┘
                           │ fiches non résolues (~10-15%)
                           ▼
               ┌───────────────────────┐
               │  REVUE MANUELLE       │
               │  + brand_mapping      │
               │  + réseaux sociaux    │
               └───────────────────────┘
```

**Estimation de taux de siretisation final : 85-90%** des fiches actives.

Les 10-15% restants correspondent typiquement à : auto-entrepreneurs sans enseigne référencée, associations, professions libérales non inscrites au RCS, fiches Google obsolètes ou fantômes.

---

## 6. Exploitation des données existantes

### 6.1 Analyse des 78 062 résultats existants

Avant de lancer la nouvelle campagne, il faut analyser ce qui a déjà été fait :

| Requête à exécuter | Information obtenue |
|---|---|
| `SELECT confiance, COUNT(*) FROM matching_results GROUP BY confiance` | Répartition par niveau de confiance |
| `SELECT AVG(score_match), MIN(score_match), MAX(score_match) FROM matching_results` | Distribution des scores |
| `SELECT methode, COUNT(*) FROM matching_results GROUP BY methode ORDER BY COUNT(*) DESC` | Méthodes les plus efficaces |
| `SELECT departement, COUNT(*) FROM google_business_v2 gb LEFT JOIN matching_results mr ON gb.id = mr.gb_id WHERE mr.id IS NULL GROUP BY departement` | Départements non traités |

### 6.2 Fiches restantes à traiter

```sql
-- Nombre de fiches sans matching
SELECT COUNT(*)
FROM google_business_v2 gb
LEFT JOIN matching_results mr ON gb.id = mr.gb_id
WHERE mr.id IS NULL;
-- Résultat attendu : ~816 709 fiches
```

### 6.3 Qualité du cache `sirene_etablissements`

| Vérification | Requête |
|---|---|
| Couverture géographique | `SELECT departement, COUNT(*) FROM sirene_etablissements GROUP BY departement` |
| Présence des enseignes | `SELECT COUNT(*) FROM sirene_etablissements WHERE enseigne IS NOT NULL AND enseigne != ''` |
| Présence du GPS | `SELECT COUNT(*) FROM sirene_etablissements WHERE latitude IS NOT NULL` |
| Fraîcheur des données | `SELECT MIN(fetched_at), MAX(fetched_at) FROM sirene_etablissements` |

---

## 7. Résumé des actions immédiates

| Priorité | Action | Prérequis |
|---|---|---|
| **1** | Exécuter les requêtes d'analyse (section 6) pour connaître l'état exact | Accès SQL |
| **2** | Ajouter un index FULLTEXT sur `sirene_etablissements.enseigne` | ALTER TABLE |
| **3** | Créer les 6 tables `srt_*` dans `netit972_france_business` | Scripts DDL |
| **4** | Migrer les 78 062 résultats de `matching_results` vers `srt_demandes` | Script INSERT...SELECT |
| **5** | Implémenter la Passe 0 (matching local SQL) comme module API | Développement Node.js |
| **6** | Tester la Passe 0 sur un département pilote | Campagne test |
| **7** | Implémenter les Passes 1-4 (via API SIRENE) | Développement Node.js |
| **8** | Créer les endpoints `/api/siretisation/*` | Développement API |
| **9** | Lancer la campagne complète France entière | Infrastructure prête |
| **10** | Alimenter `brand_mapping` à partir des résultats validés | Post-campagne |
