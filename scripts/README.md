# Siretisation API - Module de rapprochement SIREN/SIRET

Module d'enrichissement des fiches Google Business avec les identifiants SIREN/SIRET du registre officiel SIRENE.
Intégré à l'API SIRENE v5.4 (`http://srv1.net-it-be.com:3005`).

## Contexte

La base `netit972_france_business` contient **894 771 fiches Google Business** (`google_business_v2`) sans identifiant légal.
Ce module permet de rapprocher chaque fiche avec l'entreprise correspondante dans le registre SIRENE, en attribuant un SIREN et un SIRET à chaque fiche.

## Architecture

### Tables créées (préfixe `srt_`)

| Table | Rôle |
|---|---|
| `srt_campagnes` | Pilotage des traitements par lots |
| `srt_demandes` | Table centrale : une ligne par fiche à siretiser |
| `srt_tentatives` | Historique de chaque appel API/SQL |
| `srt_candidats` | Résultats multiples pour arbitrage |
| `srt_validations` | Corrections humaines (signal d'optimisation) |
| `srt_metriques` | Tableau de bord et suivi performance |
| `brand_mapping` | Dictionnaire d'enseignes connues |

### Vues

| Vue | Rôle |
|---|---|
| `v_fiches_a_traiter` | Fiches non encore traitées |
| `v_dashboard_siretisation` | Tableau de bord synthétique |
| `v_a_valider` | File d'attente de validation humaine |

### Stratégie de matching (5 passes)

1. **Passe 0** — SQL local via `sirene_etablissements` (FULLTEXT nom + enseigne + code postal)
2. **Passe 1** — API `/api/suggestions` (nom exact + code postal)
3. **Passe 2** — API `/api/recherche` (multicritère élargi)
4. **Passe 3** — API `/api/recherche-texte` (texte libre)
5. **Passe 4** — Rapprochement GPS (distance haversine)

## Installation

### Prérequis

- MariaDB 10.11+ sur srv1
- Accès à la base `netit972_france_business`
- API SIRENE v5.4 opérationnelle

### Exécution

```bash
# 1. Analyser l'état actuel (optionnel, lecture seule)
mysql -u USER -p netit972_france_business < sql/00_analyse_etat_actuel.sql

# 2. Créer le schéma et migrer les données
mysql -u USER -p netit972_france_business < sql/01_siretisation_schema.sql

# 3. Vérifier l'installation
mysql -u USER -p netit972_france_business < sql/02_verification_post_install.sql
```

Ou via phpMyAdmin : onglet **Importer** > sélectionner `01_siretisation_schema.sql` > Importer.

## Structure du projet

```
siretisation-api/
  README.md                          # Ce fichier
  CHANGELOG.md                       # Journal des modifications
  sql/
    00_analyse_etat_actuel.sql       # Requêtes d'audit (lecture seule)
    01_siretisation_schema.sql       # Script principal (DDL + migration)
    02_verification_post_install.sql # Tests post-installation
  docs/
    cahier-des-charges-v1.md         # CDC v1 : processus de rapprochement
    cahier-des-charges-v2.md         # CDC v2 : architecture service API
    cahier-des-charges-v3.md         # CDC v3 : audit structure et adaptation
    audit-donnees.md                 # Résultats de l'audit des données
```

## État actuel (25 mars 2026)

| Métrique | Valeur |
|---|---|
| Fiches Google Business | 894 771 |
| Déjà matchées (legacy) | 81 227 (9,1%) — dont 12 138 matchées, 30 654 incertaines, 38 435 échouées |
| Cache SIRENE local | 3 083 790 établissements |
| Fiches restantes à traiter | 895 925 |
| Tables `srt_*` | 7 créées + 3 vues |
| Migration legacy | Effectuée (81 227 lignes) |
| Installation vérifiée | Oui (25 mars 2026) |

## Prochaines étapes

1. Implémenter la Passe 0 (matching local SQL) comme endpoint API
2. Tester sur un département pilote
3. Implémenter les Passes 1-4 (via API SIRENE)
4. Créer les endpoints `/api/siretisation/*`
5. Lancer la campagne France entière
6. Alimenter `brand_mapping` à partir des résultats validés

## Auteur

Net It Be — mars 2026
