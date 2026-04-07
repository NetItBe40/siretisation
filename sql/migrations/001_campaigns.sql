-- Migration 001: Datactive Campagne - Sprint 1
-- Tables pour le module de campagnes multicanal

CREATE TABLE IF NOT EXISTS campaigns (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  nom VARCHAR(255) NOT NULL,
  description TEXT,
  type_canal ENUM('email', 'sms', 'courrier', 'multicanal') DEFAULT 'email',
  statut ENUM('brouillon', 'prete', 'en_cours', 'terminee', 'annulee') DEFAULT 'brouillon',
  ciblage_selection_id INT DEFAULT NULL,
  total_destinataires INT DEFAULT 0,
  total_emails_valides INT DEFAULT 0,
  date_envoi_prevue DATETIME DEFAULT NULL,
  date_envoi_effective DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  INDEX idx_statut (statut),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT NOT NULL,
  client_record_id INT DEFAULT NULL,
  nom VARCHAR(255) DEFAULT NULL,
  email VARCHAR(255) DEFAULT NULL,
  telephone VARCHAR(50) DEFAULT NULL,
  siren VARCHAR(20) DEFAULT NULL,
  siret VARCHAR(20) DEFAULT NULL,
  ville VARCHAR(255) DEFAULT NULL,
  departement VARCHAR(10) DEFAULT NULL,
  secteur VARCHAR(255) DEFAULT NULL,
  email_valide TINYINT(1) DEFAULT NULL,
  email_source ENUM('fichier_client', 'enrichissement', 'manuel', 'base_externe') DEFAULT 'fichier_client',
  statut_envoi ENUM('en_attente', 'envoye', 'delivre', 'ouvert', 'clique', 'erreur', 'desabonne') DEFAULT 'en_attente',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_campaign (campaign_id),
  INDEX idx_client (client_record_id),
  INDEX idx_email (email),
  INDEX idx_statut_envoi (statut_envoi),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS campaign_messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT NOT NULL,
  canal ENUM('email', 'sms', 'courrier') DEFAULT 'email',
  sujet VARCHAR(500) DEFAULT NULL,
  contenu_html LONGTEXT DEFAULT NULL,
  contenu_texte TEXT DEFAULT NULL,
  variables_utilisees JSON DEFAULT NULL,
  version INT DEFAULT 1,
  actif TINYINT(1) DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_campaign (campaign_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS campaign_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT NOT NULL,
  recipient_id INT DEFAULT NULL,
  type_event ENUM('cree', 'lance', 'envoye', 'delivre', 'ouvert', 'clique', 'erreur', 'desabonne', 'annule') NOT NULL,
  detail TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_campaign (campaign_id),
  INDEX idx_recipient (recipient_id),
  INDEX idx_type (type_event),
  INDEX idx_created (created_at),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
