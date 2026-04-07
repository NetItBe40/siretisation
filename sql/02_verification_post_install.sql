-- ============================================================================
-- SIRETISATION - Vérification post-installation
-- À exécuter APRÈS le script 01_siretisation_schema.sql
-- Date    : 2026-03-25
-- ============================================================================

-- 1. Vérifier que toutes les tables existent
SELECT TABLE_NAME, TABLE_ROWS, TABLE_COMMENT
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'netit972_france_business'
  AND TABLE_NAME IN ('brand_mapping', 'srt_campagnes', 'srt_demandes',
                     'srt_tentatives', 'srt_candidats', 'srt_validations',
                     'srt_metriques')
ORDER BY TABLE_NAME;
-- ATTENDU : 7 tables

-- 2. Vérifier l'index FULLTEXT sur enseigne
SHOW INDEX FROM sirene_etablissements WHERE Key_name = 'idx_sirene_enseigne_ft';
-- ATTENDU : 1 index FULLTEXT sur colonne enseigne

-- 3. Vérifier la campagne de migration
SELECT * FROM srt_campagnes;
-- ATTENDU : 1 campagne "Migration initiale" avec statut "terminee"

-- 4. Vérifier le nombre de demandes migrées
SELECT statut, COUNT(*) as nb
FROM srt_demandes
GROUP BY statut;
-- ATTENDU : ~78 062 demandes réparties entre matchee, incertaine, echouee

-- 5. Vérifier la cohérence migration vs source
SELECT
  (SELECT COUNT(*) FROM matching_results) as total_source,
  (SELECT COUNT(*) FROM srt_demandes) as total_migre,
  (SELECT COUNT(*) FROM matching_results) - (SELECT COUNT(*) FROM srt_demandes) as ecart;
-- ATTENDU : ecart = 0

-- 6. Tester les vues
SELECT * FROM v_dashboard_siretisation;
-- ATTENDU : tableau de bord avec taux_couverture ~8.7%

SELECT COUNT(*) as fiches_restantes FROM v_fiches_a_traiter;
-- ATTENDU : ~816 709

SELECT COUNT(*) as a_valider FROM v_a_valider;
-- ATTENDU : nombre de fiches en statut 'incertaine'

-- 7. Test FULLTEXT enseigne (exemple)
SELECT siret, siren, nom_complet, enseigne, code_postal
FROM sirene_etablissements
WHERE MATCH(enseigne) AGAINST('CARREFOUR' IN BOOLEAN MODE)
LIMIT 5;
-- ATTENDU : établissements Carrefour avec enseigne matchée
