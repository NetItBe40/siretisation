# Changelog - Siretisation API

Toutes les modifications notables du projet sont documentées dans ce fichier.
Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).

## [0.1.0] - 2026-03-25

### Ajouté
- **Cahier des charges v1** : processus de rapprochement en 4 passes (suggestions, recherche, texte libre, GPS)
- **Cahier des charges v2** : architecture complète du service API avec 6 tables, endpoints REST, boucle d'optimisation
- **Cahier des charges v3** : audit de la structure réelle de `google_business_v2`, adaptation du modèle
  - Découverte du cache local `sirene_etablissements` (3M d'établissements avec FULLTEXT)
  - Découverte de `matching_results` existant (78 062 résultats, 8,7% de couverture)
  - Ajout de la Passe 0 (matching local SQL) dans la stratégie
- **Script SQL `01_siretisation_schema.sql`** :
  - Index FULLTEXT sur `sirene_etablissements.enseigne`
  - Structure de `brand_mapping` (dictionnaire d'enseignes)
  - 6 tables `srt_*` : campagnes, demandes, tentatives, candidats, validations, metriques
  - 3 vues utilitaires : `v_fiches_a_traiter`, `v_dashboard_siretisation`, `v_a_valider`
  - Migration des 81 227 résultats existants vers `srt_demandes`
    - 12 138 matchées (score ≥ 80), 30 654 incertaines (score 50-79), 38 435 échouées (score < 50)
- **Script SQL `00_analyse_etat_actuel.sql`** : requêtes d'audit avec résultats documentés
- **Script SQL `02_verification_post_install.sql`** : tests de vérification post-installation
- **Audit des données** :
  - Répartition confiance : 71 714 "moyenne" (score 35-75), 12 616 "haute" (score 85)
  - Top méthode : `nom_100` (28 318 résultats, score 40)
  - Méthode la plus fiable : `nom_100+cp+naf+addr_100` (7 492 résultats, score 85)

### Décisions architecturales
- Schéma dans `netit972_france_business` avec préfixe `srt_` (pas de schéma séparé)
- Double stratégie de matching : local SQL (Passe 0) + API SIRENE (Passes 1-4)
- Conservation de `matching_results` en archive, migration vers `srt_demandes`
- Table `brand_mapping` existante restructurée pour matching accéléré des enseignes

### Métriques de base constatées
- 894 771 fiches Google Business dans `google_business_v2`
- 81 227 résultats de matching migrés (9,1% de couverture)
- 3 083 790 établissements dans le cache SIRENE local
- 10 tables dans le schéma `netit972_france_business`
