# Audit des données - 25 mars 2026

## 1. Table `google_business_v2` — 894 771 fiches

### Structure (23 colonnes)

| # | Colonne | Type | Rôle matching |
|---|---|---|---|
| 1 | `id` | bigint(20) AUTO_INCREMENT | Clé primaire |
| 2 | `nom_gb` | text | Nom commercial — donnée principale |
| 3 | `adresse_gb` | text | Adresse complète |
| 4 | `ville` | varchar(255) | Ville |
| 5 | `code_postal` | varchar(5) | Code postal — critère clé |
| 6 | `departement` | varchar(3) | Département |
| 7 | `telephone` | varchar(20) | Téléphone |
| 8 | `note` | decimal(2,1) | Note Google (non utilisé) |
| 9 | `avis` | int(11) | Nombre d'avis (non utilisé) |
| 10 | `categorie_gb` | text | Catégorie Google → NAF |
| 11 | `lien_gmaps` | text | Lien Google Maps (UNIQUE HASH) |
| 12 | `site_web` | text | Site web |
| 13 | `latitude` | decimal(10,6) | GPS |
| 14 | `longitude` | decimal(10,6) | GPS |
| 15 | `recherche` | text | Termes de collecte |
| 16 | `scraped_at` | timestamp | Date collecte |
| 17-22 | `facebook`..`tiktok` | text | Réseaux sociaux (6 colonnes) |
| 23 | `scraped_by` | varchar(100) | Identifiant collecteur |

### Index existants
- PRIMARY (id), HASH UNIQUE (lien_gmaps), BTREE (departement, code_postal, nom_gb(100), telephone)

## 2. Table `matching_results` — 78 062 lignes (créée 11/03/2026)

### Structure (9 colonnes)
| Colonne | Type | Rôle |
|---|---|---|
| `id` | bigint(20) UNSIGNED AI | Clé primaire |
| `gb_id` | bigint(20) UNSIGNED | FK vers google_business_v2.id |
| `siret` | varchar(14) | SIRET attribué |
| `siren` | varchar(9) | SIREN déduit |
| `score_match` | int(11) | Score 0-100 |
| `confiance` | varchar(10) | "haute" ou "moyenne" |
| `methode` | text | Description textuelle |
| `matched_at` | timestamp | Date matching |
| `details` | longtext | JSON binaire |

### Résultats d'analyse

**Répartition par confiance :**
| confiance | nb | score_moyen | score_min | score_max |
|---|---|---|---|---|
| moyenne | 71 714 | 51.4 | 35 | 75 |
| haute | 12 616 | 85.0 | 85 | 85 |

**Top 10 méthodes :**
| methode | nb | score_moyen |
|---|---|---|
| nom_100 | 28 318 | 40.0 |
| nom_100+cp+naf+addr_100 | 7 492 | 85.0 |
| nom_100+cp+naf | 7 144 | 75.0 |
| nom_100+cp | 5 918 | 60.0 |
| nom_100+naf | 4 302 | 55.0 |
| nom_100+cp+addr_100 | 4 121 | 70.0 |
| nom_85 | 813 | 40.0 |
| nom_86 | 781 | 40.0 |
| nom_100+cp+naf+addr_80 | 715 | 85.0 |
| nom_84+partial_88 | 641 | 40.0 |

**Constat clé :** 36% des matchings (28 318) reposent uniquement sur le nom (`nom_100`, score 40). Ces résultats sont peu fiables et devront être réévalués.

## 3. Table `sirene_etablissements` — 3 083 790 lignes

### Structure (13 colonnes)
| Colonne | Type | Rôle |
|---|---|---|
| `siret` | varchar(14) | PK |
| `siren` | varchar(9) | SIREN parent |
| `departement` | varchar(3) | Département |
| `nom_complet` | text | Dénomination sociale |
| `adresse` | text | Adresse |
| `code_postal` | varchar(5) | Code postal |
| `commune` | varchar(255) | Commune |
| `naf` | varchar(6) | Code NAF |
| `enseigne` | text | Enseigne commerciale |
| `latitude` | decimal(10,6) | GPS |
| `longitude` | decimal(10,6) | GPS |
| `categorie` | varchar(50) | Catégorie |
| `fetched_at` | timestamp | Date chargement |

### Index existants
- PK (siret), BTREE (departement, siren, naf, code_postal, categorie), **FULLTEXT (nom_complet)**
- FULLTEXT sur `enseigne` ajouté par le script 01

## 4. Table `search_log_v2` — 84 731 lignes
Log des recherches de collecte Google Business (département, code postal, catégorie, résultats).

## 5. Synthèse

| Métrique | Valeur |
|---|---|
| Total fiches GB | 894 771 |
| Déjà matchées | 78 062 dans matching_results (8,7%) |
| Migrées vers srt_demandes | 81 227 (9,1%) — inclut doublons gb_id avec SIRET différents |
| Répartition après migration | 12 138 matchées / 30 654 incertaines / 38 435 échouées |
| Fiches restantes à traiter | 895 925 (via v_fiches_a_traiter) |
| Cache SIRENE local | 3 083 790 établissements |
| Couverture : taux matching global | 9,1% |
| Taux matching "fiable" (matchée) | 1,4% |
