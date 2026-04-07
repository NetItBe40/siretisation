-- ============================================================================
-- SIRETISATION - Script de création du schéma
-- Projet : Siretisation des fiches Google Business
-- Base    : netit972_france_business (MariaDB 10.11.15)
-- Date    : 2026-03-25
-- Auteur  : Net It Be
-- Version : 1.0
-- ============================================================================
-- Ce script crée :
--   1. Un index FULLTEXT sur sirene_etablissements.enseigne
--   2. La structure de brand_mapping
--   3. Les 6 tables srt_* (campagnes, demandes, tentatives, candidats,
--      validations, metriques)
--   4. La migration des données existantes de matching_results vers srt_demandes
-- ============================================================================

-- ============================================================================
-- ÉTAPE 1 : INDEX FULLTEXT SUR ENSEIGNE
-- ============================================================================
-- Permet le matching local SQL sur les noms d'enseignes (McDonald's, etc.)
-- Complète l'index FULLTEXT existant sur nom_complet

ALTER TABLE sirene_etablissements
  ADD FULLTEXT INDEX idx_sirene_enseigne_ft (enseigne);


-- ============================================================================
-- ÉTAPE 2 : STRUCTURE DE BRAND_MAPPING
-- ============================================================================
-- Table de correspondance enseigne connue → SIREN maison-mère
-- Alimentée au fil des validations pour accélérer les matchings futurs

DROP TABLE IF EXISTS brand_mapping;
CREATE TABLE brand_mapping (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  enseigne      VARCHAR(255)    NOT NULL COMMENT 'Nom d enseigne normalise (MAJUSCULES, sans accents)',
  enseigne_brut VARCHAR(255)    DEFAULT NULL COMMENT 'Nom d enseigne tel que trouve dans Google Business',
  siren         VARCHAR(9)      NOT NULL COMMENT 'SIREN de la maison-mere ou du franchiseur',
  siret         VARCHAR(14)     DEFAULT NULL COMMENT 'SIRET type (siege ou etablissement representatif)',
  denomination  VARCHAR(255)    DEFAULT NULL COMMENT 'Denomination sociale officielle',
  naf           VARCHAR(6)      DEFAULT NULL COMMENT 'Code NAF principal de l enseigne',
  type_enseigne ENUM('franchise','succursale','independant','autre') DEFAULT 'autre'
                                COMMENT 'Type de reseau',
  nb_matchings  INT UNSIGNED    DEFAULT 0 COMMENT 'Nombre de fiches GB matchees via cette enseigne',
  actif         TINYINT(1)      DEFAULT 1 COMMENT '1=actif, 0=desactive',
  cree_le       TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
  modifie_le    TIMESTAMP       DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  cree_par      VARCHAR(100)    DEFAULT NULL COMMENT 'Utilisateur ou processus ayant cree l entree',

  PRIMARY KEY (id),
  UNIQUE KEY uk_brand_enseigne (enseigne),
  KEY idx_brand_siren (siren),
  FULLTEXT KEY idx_brand_enseigne_ft (enseigne, enseigne_brut)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Dictionnaire d enseignes connues pour matching accelere';


-- ============================================================================
-- ÉTAPE 3 : TABLE srt_campagnes
-- ============================================================================
-- Pilotage des traitements par lots
-- Chaque lancement de siretisation = une campagne

CREATE TABLE IF NOT EXISTS srt_campagnes (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  nom                 VARCHAR(255)    NOT NULL COMMENT 'Nom descriptif de la campagne',
  source_schema       VARCHAR(100)    DEFAULT 'netit972_france_business',
  source_table        VARCHAR(100)    DEFAULT 'google_business_v2',
  filtres_appliques   JSON            DEFAULT NULL COMMENT 'Filtres : departement, categorie, date, etc.',
  parametres_matching JSON            DEFAULT NULL COMMENT 'Seuils et ponderations utilises',

  -- Compteurs (mis a jour en temps reel pendant le traitement)
  nb_fiches_total     INT UNSIGNED    DEFAULT 0,
  nb_matchees         INT UNSIGNED    DEFAULT 0 COMMENT 'Score >= seuil_haut',
  nb_incertaines      INT UNSIGNED    DEFAULT 0 COMMENT 'Score entre seuil_bas et seuil_haut',
  nb_echouees         INT UNSIGNED    DEFAULT 0 COMMENT 'Score < seuil_bas ou pas de resultat',
  nb_en_cours         INT UNSIGNED    DEFAULT 0,

  -- Seuils de decision
  seuil_haut          INT UNSIGNED    DEFAULT 80 COMMENT 'Score >= seuil_haut = matchee automatiquement',
  seuil_bas           INT UNSIGNED    DEFAULT 50 COMMENT 'Score < seuil_bas = echouee',

  -- Statut et dates
  statut              ENUM('en_attente','en_cours','terminee','annulee','erreur')
                                      DEFAULT 'en_attente',
  date_creation       TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
  date_debut          TIMESTAMP       NULL DEFAULT NULL,
  date_fin            TIMESTAMP       NULL DEFAULT NULL,
  lance_par           VARCHAR(100)    DEFAULT NULL COMMENT 'Utilisateur ou systeme',
  notes               TEXT            DEFAULT NULL COMMENT 'Notes libres sur la campagne',

  PRIMARY KEY (id),
  KEY idx_camp_statut (statut),
  KEY idx_camp_date (date_creation)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Campagnes de siretisation - pilotage des traitements par lots';


-- ============================================================================
-- ÉTAPE 4 : TABLE srt_demandes
-- ============================================================================
-- Table centrale : une ligne par fiche Google Business a siretiser
-- Lien entre la fiche source et le resultat final

CREATE TABLE IF NOT EXISTS srt_demandes (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campagne_id           BIGINT UNSIGNED DEFAULT NULL COMMENT 'FK vers srt_campagnes (NULL = migration)',
  gb_id                 BIGINT UNSIGNED NOT NULL COMMENT 'FK vers google_business_v2.id',

  -- Donnees source (copie denormalisee pour performance)
  source_nom            TEXT            DEFAULT NULL COMMENT 'nom_gb original',
  source_nom_nettoye    VARCHAR(255)    DEFAULT NULL COMMENT 'nom_gb normalise (MAJ, sans accents, sans forme jur.)',
  source_forme_juridique VARCHAR(20)    DEFAULT NULL COMMENT 'Forme juridique extraite du nom (SAS, SARL...)',
  source_adresse        TEXT            DEFAULT NULL COMMENT 'adresse_gb original',
  source_code_postal    VARCHAR(5)      DEFAULT NULL,
  source_ville          VARCHAR(255)    DEFAULT NULL,
  source_departement    VARCHAR(3)      DEFAULT NULL,
  source_telephone      VARCHAR(20)     DEFAULT NULL,
  source_categorie      TEXT            DEFAULT NULL COMMENT 'categorie_gb original',
  source_latitude       DECIMAL(10,6)   DEFAULT NULL,
  source_longitude      DECIMAL(10,6)   DEFAULT NULL,

  -- Resultat final
  siren_attribue        VARCHAR(9)      DEFAULT NULL COMMENT 'SIREN final retenu',
  siret_attribue        VARCHAR(14)     DEFAULT NULL COMMENT 'SIRET final retenu',
  denomination_matchee  VARCHAR(255)    DEFAULT NULL COMMENT 'Denomination officielle du match',
  score_final           INT UNSIGNED    DEFAULT NULL COMMENT 'Score de confiance (0-100)',
  methode_finale        VARCHAR(50)     DEFAULT NULL COMMENT 'Passe ayant produit le resultat',
  detail_score_final    JSON            DEFAULT NULL COMMENT 'Decomposition du score par critere',

  -- Statut
  statut                ENUM('en_attente','en_cours','matchee','incertaine','echouee',
                              'validee_manuellement','corrigee','rejetee')
                                        DEFAULT 'en_attente',
  nb_tentatives         INT UNSIGNED    DEFAULT 0,

  -- Dates
  date_creation         TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
  date_derniere_tentative TIMESTAMP     NULL DEFAULT NULL,
  date_validation       TIMESTAMP       NULL DEFAULT NULL,
  validee_par           VARCHAR(100)    DEFAULT NULL COMMENT 'NULL = automatique',

  PRIMARY KEY (id),
  UNIQUE KEY uk_dem_campagne_gb (campagne_id, gb_id),
  KEY idx_dem_gb (gb_id),
  KEY idx_dem_statut (statut),
  KEY idx_dem_score (score_final),
  KEY idx_dem_siren (siren_attribue),
  KEY idx_dem_siret (siret_attribue),
  KEY idx_dem_dept (source_departement),
  KEY idx_dem_cp (source_code_postal),
  KEY idx_dem_campagne (campagne_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Demandes de siretisation - une ligne par fiche Google Business';


-- ============================================================================
-- ÉTAPE 5 : TABLE srt_tentatives
-- ============================================================================
-- Chaque appel API ou requete SQL effectue pour rapprocher une fiche
-- Une demande peut avoir N tentatives (une par passe, voire plus)

CREATE TABLE IF NOT EXISTS srt_tentatives (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  demande_id          BIGINT UNSIGNED NOT NULL COMMENT 'FK vers srt_demandes',
  passe               TINYINT UNSIGNED NOT NULL COMMENT '0=local SQL, 1=suggestions, 2=recherche, 3=texte libre, 4=GPS',
  type_source         ENUM('local_sql','api_suggestions','api_recherche','api_recherche_texte','api_entreprise','gps','brand_mapping','manuel')
                                      NOT NULL COMMENT 'Source utilisee',

  -- Parametres de la requete
  endpoint_appele     VARCHAR(255)    DEFAULT NULL COMMENT 'URL ou requete SQL utilisee',
  parametres_envoyes  JSON            DEFAULT NULL COMMENT 'Parametres de la requete',

  -- Resultats
  nb_resultats        INT UNSIGNED    DEFAULT 0 COMMENT 'Nombre de candidats retournes',
  siren_candidat      VARCHAR(9)      DEFAULT NULL COMMENT 'SIREN du meilleur candidat',
  siret_candidat      VARCHAR(14)     DEFAULT NULL COMMENT 'SIRET du meilleur candidat',
  denomination_candidat VARCHAR(255)  DEFAULT NULL,
  score_calcule       INT UNSIGNED    DEFAULT NULL COMMENT 'Score de confiance du meilleur candidat',
  detail_score        JSON            DEFAULT NULL COMMENT 'Decomposition du score',
  retenu              TINYINT(1)      DEFAULT 0 COMMENT '1 = cette tentative est le resultat final',

  -- Performance et diagnostic
  temps_reponse_ms    INT UNSIGNED    DEFAULT NULL COMMENT 'Temps de reponse en ms',
  code_http           SMALLINT        DEFAULT NULL COMMENT 'Code HTTP (NULL si local SQL)',
  erreur              TEXT            DEFAULT NULL COMMENT 'Message d erreur si echec',
  date_execution      TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_tent_demande (demande_id),
  KEY idx_tent_passe (passe),
  KEY idx_tent_retenu (retenu),
  KEY idx_tent_siren (siren_candidat)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Tentatives de rapprochement - historique de chaque appel API/SQL';


-- ============================================================================
-- ÉTAPE 6 : TABLE srt_candidats
-- ============================================================================
-- Quand une tentative retourne plusieurs resultats plausibles
-- Permet l arbitrage humain dans les cas incertains

CREATE TABLE IF NOT EXISTS srt_candidats (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tentative_id        BIGINT UNSIGNED NOT NULL COMMENT 'FK vers srt_tentatives',
  rang                TINYINT UNSIGNED NOT NULL COMMENT 'Position dans les resultats (1=meilleur)',

  -- Donnees du candidat
  siren               VARCHAR(9)      NOT NULL,
  siret               VARCHAR(14)     DEFAULT NULL,
  denomination        VARCHAR(255)    DEFAULT NULL COMMENT 'Denomination officielle',
  enseigne            VARCHAR(255)    DEFAULT NULL COMMENT 'Enseigne commerciale',
  adresse             TEXT            DEFAULT NULL,
  code_postal         VARCHAR(5)      DEFAULT NULL,
  commune             VARCHAR(255)    DEFAULT NULL,
  activite_principale VARCHAR(6)      DEFAULT NULL COMMENT 'Code NAF',
  etat_administratif  CHAR(1)         DEFAULT NULL COMMENT 'A=actif, C=cessee',
  latitude            DECIMAL(10,6)   DEFAULT NULL,
  longitude           DECIMAL(10,6)   DEFAULT NULL,

  -- Scoring
  score               INT UNSIGNED    NOT NULL DEFAULT 0,
  detail_score        JSON            DEFAULT NULL COMMENT 'Points par critere',
  distance_gps_m      INT UNSIGNED    DEFAULT NULL COMMENT 'Distance en metres vs fiche Google',
  similarite_nom      DECIMAL(5,2)    DEFAULT NULL COMMENT 'Score de similarite textuelle (0-100)',

  PRIMARY KEY (id),
  KEY idx_cand_tentative (tentative_id),
  KEY idx_cand_siren (siren),
  KEY idx_cand_score (score)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Candidats de rapprochement - resultats multiples par tentative';


-- ============================================================================
-- ÉTAPE 7 : TABLE srt_validations
-- ============================================================================
-- Trace chaque intervention humaine (confirmer, corriger, rejeter)
-- Chaque correction = signal d entrainement pour l optimisation

CREATE TABLE IF NOT EXISTS srt_validations (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  demande_id          BIGINT UNSIGNED NOT NULL COMMENT 'FK vers srt_demandes',
  action_type         ENUM('confirmer','corriger','rejeter') NOT NULL,

  -- Avant / Apres
  siren_avant         VARCHAR(9)      DEFAULT NULL COMMENT 'SIREN avant intervention',
  siren_apres         VARCHAR(9)      DEFAULT NULL COMMENT 'SIREN apres intervention',
  siret_avant         VARCHAR(14)     DEFAULT NULL,
  siret_apres         VARCHAR(14)     DEFAULT NULL,
  score_avant         INT UNSIGNED    DEFAULT NULL,

  -- Contexte
  motif               TEXT            DEFAULT NULL COMMENT 'Raison de la correction/rejet',
  valideur            VARCHAR(100)    NOT NULL COMMENT 'Identifiant de la personne',
  date_validation     TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_val_demande (demande_id),
  KEY idx_val_action (action_type),
  KEY idx_val_valideur (valideur),
  KEY idx_val_date (date_validation)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Validations manuelles - corrections humaines pour optimisation';


-- ============================================================================
-- ÉTAPE 8 : TABLE srt_metriques
-- ============================================================================
-- Agregations calculees periodiquement pour piloter l amelioration continue

CREATE TABLE IF NOT EXISTS srt_metriques (
  id                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campagne_id               BIGINT UNSIGNED DEFAULT NULL COMMENT 'FK vers srt_campagnes (NULL=global)',
  date_calcul               TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,

  -- Taux globaux
  taux_matching_global      DECIMAL(5,2)    DEFAULT NULL COMMENT 'Pourcentage matchees (score >= seuil_haut)',
  taux_incertain            DECIMAL(5,2)    DEFAULT NULL,
  taux_echec                DECIMAL(5,2)    DEFAULT NULL,

  -- Scores
  score_moyen               DECIMAL(5,1)    DEFAULT NULL,
  score_median              DECIMAL(5,1)    DEFAULT NULL,
  taux_precision_estimee    DECIMAL(5,2)    DEFAULT NULL COMMENT 'Basee sur validations manuelles',

  -- Decomposition
  taux_par_passe            JSON            DEFAULT NULL COMMENT '{"passe_0": 55, "passe_1": 20, ...}',
  taux_par_departement      JSON            DEFAULT NULL,
  taux_par_categorie        JSON            DEFAULT NULL,
  temps_moyen_par_fiche_ms  INT UNSIGNED    DEFAULT NULL,

  -- Signaux d optimisation
  nb_corrections_humaines   INT UNSIGNED    DEFAULT 0,
  principales_causes_echec  JSON            DEFAULT NULL,
  suggestions_optimisation  JSON            DEFAULT NULL COMMENT 'Suggestions auto-generees',

  PRIMARY KEY (id),
  KEY idx_met_campagne (campagne_id),
  KEY idx_met_date (date_calcul)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Metriques d optimisation - tableau de bord siretisation';


-- ============================================================================
-- ÉTAPE 9 : MIGRATION DES DONNÉES EXISTANTES
-- ============================================================================
-- Creer une campagne "Migration initiale" pour les 78 062 resultats existants

-- 9.1 : Campagne de migration
INSERT INTO srt_campagnes (nom, source_schema, source_table, statut, date_debut, date_fin, lance_par, notes)
VALUES (
  'Migration initiale - matching_results existants',
  'netit972_france_business',
  'google_business_v2',
  'terminee',
  '2026-03-11 06:58:00',
  '2026-03-25 06:43:00',
  'migration_auto',
  'Migration automatique des 78062 resultats de matching_results vers le nouveau schema srt_*. Scores et methodes conserves tels quels.'
);

-- 9.2 : Migration des demandes
-- On copie les donnees de matching_results + google_business_v2 vers srt_demandes
INSERT INTO srt_demandes (
  campagne_id,
  gb_id,
  source_nom,
  source_adresse,
  source_code_postal,
  source_ville,
  source_departement,
  source_telephone,
  source_categorie,
  source_latitude,
  source_longitude,
  siren_attribue,
  siret_attribue,
  score_final,
  methode_finale,
  statut,
  nb_tentatives,
  date_creation,
  date_derniere_tentative
)
SELECT
  (SELECT MAX(id) FROM srt_campagnes) as campagne_id,
  mr.gb_id,
  gb.nom_gb,
  gb.adresse_gb,
  gb.code_postal,
  gb.ville,
  gb.departement,
  gb.telephone,
  gb.categorie_gb,
  gb.latitude,
  gb.longitude,
  mr.siren,
  mr.siret,
  mr.score_match,
  mr.methode,
  CASE
    WHEN mr.confiance = 'haute' THEN 'matchee'
    WHEN mr.confiance = 'moyenne' AND mr.score_match >= 50 THEN 'incertaine'
    ELSE 'echouee'
  END as statut,
  1 as nb_tentatives,
  mr.matched_at,
  mr.matched_at
FROM matching_results mr
INNER JOIN google_business_v2 gb ON gb.id = mr.gb_id;

-- 9.3 : Mise a jour des compteurs de la campagne de migration
UPDATE srt_campagnes c
SET
  nb_fiches_total = (SELECT COUNT(*) FROM srt_demandes WHERE campagne_id = c.id),
  nb_matchees = (SELECT COUNT(*) FROM srt_demandes WHERE campagne_id = c.id AND statut = 'matchee'),
  nb_incertaines = (SELECT COUNT(*) FROM srt_demandes WHERE campagne_id = c.id AND statut = 'incertaine'),
  nb_echouees = (SELECT COUNT(*) FROM srt_demandes WHERE campagne_id = c.id AND statut = 'echouee')
WHERE c.id = (SELECT MAX(id) FROM (SELECT MAX(id) as id FROM srt_campagnes) tmp);


-- ============================================================================
-- ÉTAPE 10 : VUES UTILITAIRES
-- ============================================================================

-- Vue : fiches Google Business non encore traitees (pour prochaine campagne)
CREATE OR REPLACE VIEW v_fiches_a_traiter AS
SELECT gb.*
FROM google_business_v2 gb
LEFT JOIN srt_demandes sd ON sd.gb_id = gb.id
WHERE sd.id IS NULL;

-- Vue : tableau de bord rapide
CREATE OR REPLACE VIEW v_dashboard_siretisation AS
SELECT
  (SELECT COUNT(*) FROM google_business_v2) as total_fiches_gb,
  (SELECT COUNT(*) FROM srt_demandes) as total_traitees,
  (SELECT COUNT(*) FROM srt_demandes WHERE statut = 'matchee') as nb_matchees,
  (SELECT COUNT(*) FROM srt_demandes WHERE statut = 'incertaine') as nb_incertaines,
  (SELECT COUNT(*) FROM srt_demandes WHERE statut = 'echouee') as nb_echouees,
  (SELECT COUNT(*) FROM srt_demandes WHERE statut IN ('validee_manuellement','corrigee')) as nb_validees_manuellement,
  (SELECT COUNT(*) FROM v_fiches_a_traiter) as nb_restantes,
  ROUND((SELECT COUNT(*) FROM srt_demandes) * 100.0 / (SELECT COUNT(*) FROM google_business_v2), 1) as taux_couverture_pct,
  ROUND((SELECT COUNT(*) FROM srt_demandes WHERE statut = 'matchee') * 100.0 / NULLIF((SELECT COUNT(*) FROM srt_demandes), 0), 1) as taux_matching_pct;

-- Vue : demandes en attente de validation humaine
CREATE OR REPLACE VIEW v_a_valider AS
SELECT
  sd.id as demande_id,
  sd.gb_id,
  sd.source_nom,
  sd.source_code_postal,
  sd.source_ville,
  sd.siren_attribue,
  sd.siret_attribue,
  sd.denomination_matchee,
  sd.score_final,
  sd.methode_finale,
  sd.statut
FROM srt_demandes sd
WHERE sd.statut = 'incertaine'
ORDER BY sd.score_final DESC;


-- ============================================================================
-- FIN DU SCRIPT
-- ============================================================================
-- Résumé des objets créés :
--   - 1 index FULLTEXT sur sirene_etablissements.enseigne
--   - 7 tables : brand_mapping, srt_campagnes, srt_demandes, srt_tentatives,
--                srt_candidats, srt_validations, srt_metriques
--   - 3 vues : v_fiches_a_traiter, v_dashboard_siretisation, v_a_valider
--   - 1 campagne de migration avec ~78 062 demandes migrees
-- ============================================================================
