-- ============================================================================
-- SIRETISATION - Requêtes d'analyse de l'état actuel
-- À exécuter AVANT le script 01_siretisation_schema.sql
-- Date    : 2026-03-25
-- ============================================================================

-- 1. Répartition des matching existants par niveau de confiance
SELECT confiance, COUNT(*) as nb,
       ROUND(AVG(score_match),1) as score_moyen,
       MIN(score_match) as score_min,
       MAX(score_match) as score_max
FROM matching_results
GROUP BY confiance
ORDER BY nb DESC;
-- RÉSULTAT ATTENDU (constaté le 25/03/2026) :
-- moyenne : 71 714 | score_moyen 51.4 | range 35-75
-- haute   : 12 616 | score_moyen 85.0 | range 85-85

-- 2. Méthodes de matching les plus utilisées
SELECT methode, COUNT(*) as nb,
       ROUND(AVG(score_match),1) as score_moyen
FROM matching_results
GROUP BY methode
ORDER BY nb DESC
LIMIT 20;
-- RÉSULTAT ATTENDU (top 5) :
-- nom_100                    : 28 318 (score 40)
-- nom_100+cp+naf+addr_100   :  7 492 (score 85)
-- nom_100+cp+naf             :  7 144 (score 75)
-- nom_100+cp                 :  5 918 (score 60)
-- nom_100+naf                :  4 302 (score 55)

-- 3. Volumétrie et qualité des données
SELECT
  (SELECT COUNT(*) FROM google_business_v2) as total_fiches_gb,
  (SELECT COUNT(DISTINCT gb_id) FROM matching_results) as fiches_matchees,
  (SELECT COUNT(*) FROM sirene_etablissements) as total_etab_sirene,
  (SELECT COUNT(*) FROM sirene_etablissements WHERE enseigne IS NOT NULL AND enseigne != '') as etab_avec_enseigne,
  (SELECT COUNT(*) FROM sirene_etablissements WHERE latitude IS NOT NULL) as etab_avec_gps,
  (SELECT COUNT(*) FROM google_business_v2 WHERE nom_gb IS NULL OR nom_gb = '') as fiches_sans_nom,
  (SELECT COUNT(*) FROM google_business_v2 WHERE code_postal IS NULL OR code_postal = '') as fiches_sans_cp;

-- 4. Répartition par département (top 10 non traités)
SELECT gb.departement, COUNT(*) as nb_non_traitees
FROM google_business_v2 gb
LEFT JOIN matching_results mr ON gb.id = mr.gb_id
WHERE mr.id IS NULL
GROUP BY gb.departement
ORDER BY nb_non_traitees DESC
LIMIT 10;

-- 5. Couverture du cache SIRENE par département
SELECT departement, COUNT(*) as nb_etablissements
FROM sirene_etablissements
GROUP BY departement
ORDER BY nb_etablissements DESC
LIMIT 10;
