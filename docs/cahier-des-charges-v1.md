# Cahier des charges — Siretisation des fiches Google Business

**Projet :** Enrichissement SIREN/SIRET des fiches Google Business
**Source de données :** `srv1` — schéma `netit972_france_business`, table `google_business_v2`
**API de référence :** SIRENE v5.4 — `http://srv1.net-it-be.com:3005`
**Date :** 25 mars 2026
**Auteur :** Net It Be

---

## 1. Contexte et objectif

Les fiches Google Business collectées dans la table `google_business_v2` contiennent des informations commerciales (nom, adresse, téléphone, catégorie, coordonnées GPS) mais ne possèdent pas de numéro SIREN/SIRET officiel. L'objectif de ce projet est de **rapprocher chaque fiche Google Business avec l'entreprise correspondante dans le registre SIRENE** afin d'attribuer un identifiant légal (SIREN et/ou SIRET) à chaque fiche.

Ce rapprochement — appelé "siretisation" — permet de relier les données commerciales Google aux données légales, financières et administratives du registre officiel, ouvrant la voie à des analyses croisées (chiffre d'affaires, dirigeants, état administratif, etc.).

---

## 2. Périmètre

Le traitement concerne **l'intégralité** des fiches présentes dans `google_business_v2`. Chaque fiche doit passer par le processus de rapprochement, quel que soit son secteur d'activité ou sa localisation en France.

---

## 3. Données disponibles

### 3.1 Données source — Table `google_business_v2`

Champs exploitables pour le rapprochement (liste supposée, à confirmer par inspection de la table) :

| Champ probable | Utilité pour le matching |
|---|---|
| `name` / `business_name` | Dénomination à comparer avec la base SIRENE |
| `address` / `full_address` | Adresse postale pour filtrage géographique |
| `city` / `commune` | Commune pour affiner la recherche |
| `postal_code` / `zip` | Code postal — critère de filtrage clé |
| `phone` | Téléphone (rapprochement secondaire) |
| `category` / `type` | Catégorie Google → correspondance approximative code NAF |
| `latitude` / `longitude` | Coordonnées GPS pour rapprochement géographique |
| `website` | URL — peut contenir le SIRET ou des indices |

### 3.2 Données cibles — API SIRENE v5.4

Endpoints principaux utilisés pour le rapprochement :

| Endpoint | Usage dans le processus |
|---|---|
| `GET /api/suggestions?q=XXX` | Recherche rapide par dénomination (autocomplétion) |
| `GET /api/recherche` | Recherche multicritère (dénomination + code postal + activité) |
| `GET /api/entreprise/:siren` | Récupération de la fiche complète après identification |
| `GET /api/batch` | Vérification en lot (jusqu'à 100 SIREN par requête) |
| `GET /api/recherche-texte?q=XXX` | Recherche texte libre en dernier recours |

---

## 4. Stratégie de rapprochement

Le rapprochement repose sur une approche **multi-passes**, de la plus précise à la plus tolérante, avec un score de confiance attribué à chaque résultat.

### 4.1 Passe 1 — Recherche exacte par dénomination + code postal

**Méthode :** Appel à `/api/suggestions?q={business_name}` puis vérification du code postal parmi les établissements retournés.

**Critères de validation :**
- La dénomination retournée correspond à au moins 85% (similarité textuelle) au nom Google Business.
- Le code postal du siège ou d'un établissement correspond exactement.

**Score de confiance :** 90–100

### 4.2 Passe 2 — Recherche multicritère élargie

**Méthode :** Appel à `/api/recherche` avec combinaison de critères :
- `denomination` = nom Google Business (nettoyé)
- `code_postal` = code postal de la fiche
- `commune` = ville de la fiche

**Critères de validation :**
- Correspondance partielle sur la dénomination (> 70% de similarité).
- Correspondance géographique (même commune ou commune limitrophe).

**Score de confiance :** 70–89

### 4.3 Passe 3 — Recherche texte libre

**Méthode :** Appel à `/api/recherche-texte?q={nom_nettoyé}&type=entreprise` pour une recherche plus floue.

**Critères de validation :**
- Au moins un mot significatif du nom correspond.
- Le code postal ou le département correspond.
- Vérification croisée de l'activité (catégorie Google vs code NAF).

**Score de confiance :** 50–69

### 4.4 Passe 4 — Rapprochement géographique (coordonnées GPS)

**Méthode :** Pour les fiches non résolues, comparer les coordonnées GPS de la fiche Google avec les coordonnées latitude/longitude des établissements retournés par l'API. Rechercher les entreprises dans un rayon restreint ayant une activité compatible.

**Score de confiance :** 40–60

### 4.5 Passe 5 — Revue manuelle

Les fiches restantes (score < 50 ou pas de résultat) sont marquées pour **vérification humaine**.

---

## 5. Étapes de travail détaillées

### Étape 1 — Audit et préparation des données source

**Actions :**
1. Inspecter la structure complète de la table `google_business_v2` (colonnes, types, volumétrie).
2. Identifier les champs exploitables pour le matching.
3. Mesurer la qualité des données : taux de remplissage de chaque champ, doublons, valeurs aberrantes.
4. Vérifier si certaines fiches possèdent déjà un SIREN/SIRET.

**Livrable :** Rapport d'audit des données source.

### Étape 2 — Normalisation et nettoyage des données

**Actions :**
1. Normaliser les dénominations : passage en majuscules, suppression des caractères spéciaux, des abréviations courantes (SARL, SAS, EURL → à conserver séparément).
2. Normaliser les adresses : extraction propre du code postal, de la commune, du numéro et de la voie.
3. Extraire la forme juridique quand elle est incluse dans le nom Google Business.
4. Créer une colonne `nom_nettoyé` (dénomination sans forme juridique ni ponctuation).
5. Dédoublonner les fiches Google Business si nécessaire.

**Livrable :** Données source nettoyées, prêtes pour le rapprochement.

### Étape 3 — Préparation de l'infrastructure de traitement

**Actions :**
1. Ajouter les colonnes de résultat dans la table (ou créer une table de liaison) :
   - `siren` (CHAR 9)
   - `siret` (CHAR 14)
   - `match_score` (INTEGER 0–100)
   - `match_method` (VARCHAR — passe utilisée)
   - `match_denomination` (VARCHAR — dénomination retournée par l'API)
   - `match_status` (ENUM : `matched`, `uncertain`, `unmatched`, `manual_review`)
   - `match_date` (TIMESTAMP)
2. Créer une table de log pour tracer chaque appel API et son résultat.
3. Configurer la clé API et tester la connectivité avec `GET /api/health`.
4. Estimer le volume d'appels API nécessaire et vérifier le rate limiting.

**Livrable :** Schéma de base de données enrichi, script de migration.

### Étape 4 — Développement du moteur de rapprochement

**Actions :**
1. Développer le script de rapprochement (Python ou Node.js recommandé) implémentant les passes 1 à 4 décrites en section 4.
2. Implémenter un algorithme de similarité textuelle (Levenshtein, Jaro-Winkler ou trigram) pour comparer les dénominations.
3. Gérer le rate limiting avec un mécanisme de retry exponentiel.
4. Implémenter la pagination pour les réponses volumineuses.
5. Prévoir un mode "dry run" (simulation sans écriture en base).

**Livrable :** Script de rapprochement fonctionnel et testé.

### Étape 5 — Exécution par lots (batch processing)

**Actions :**
1. Découper le jeu de données en lots (par département ou par tranche d'ID).
2. Exécuter la Passe 1 sur l'ensemble des fiches.
3. Exécuter la Passe 2 sur les fiches non résolues.
4. Exécuter la Passe 3 sur les fiches restantes.
5. Exécuter la Passe 4 (GPS) sur les fiches encore non résolues.
6. Suivre l'avancement en temps réel (progression, taux de matching par passe).

**Livrable :** Table enrichie avec SIREN/SIRET et scores de confiance.

### Étape 6 — Contrôle qualité

**Actions :**
1. Calculer les statistiques globales :
   - Taux de matching par passe
   - Distribution des scores de confiance
   - Taux de fiches non résolues
2. Échantillonnage aléatoire et vérification manuelle sur 200 à 500 fiches (stratifié par score de confiance).
3. Vérifier la cohérence : une fiche Google Business = un seul SIRET (pas de doublons inversés).
4. Identifier les faux positifs (mauvais rapprochement) et ajuster les seuils si nécessaire.
5. Vérifier que les entreprises matchées sont en état administratif "A" (actif) quand la fiche Google est active.

**Livrable :** Rapport qualité avec taux de précision et rappel estimés.

### Étape 7 — Traitement des cas non résolus

**Actions :**
1. Exporter les fiches `unmatched` et `manual_review` dans un fichier dédié.
2. Analyser les causes d'échec : nom trop différent, entreprise non immatriculée (auto-entrepreneurs, associations), adresse hors France, fiche fantôme.
3. Tenter un rapprochement manuel assisté pour les fiches à fort enjeu.
4. Catégoriser les fiches non résolues (hors périmètre, données insuffisantes, entreprise inexistante).

**Livrable :** Classification des fiches non résolues avec motifs.

### Étape 8 — Enrichissement complémentaire

**Actions :**
1. Pour toutes les fiches matchées (score ≥ 70), appeler `GET /api/entreprise/{siren}` pour récupérer :
   - État administratif
   - Forme juridique
   - Code NAF et libellé
   - Effectif
   - Date de création
   - Données du dernier bilan (CA, résultat)
   - SIRET de l'établissement correspondant (si le SIREN a plusieurs établissements, sélectionner celui dont l'adresse correspond le mieux)
2. Stocker ces données enrichies dans des colonnes dédiées ou une table liée.
3. Utiliser `GET /api/batch` pour traiter les enrichissements par lots de 100 SIREN.

**Livrable :** Base complète enrichie avec données légales et financières.

### Étape 9 — Validation finale et documentation

**Actions :**
1. Produire un rapport final de siretisation :
   - Volume total de fiches traitées
   - Taux de siretisation (global et par département/catégorie)
   - Distribution des scores de confiance
   - Nombre de fiches en revue manuelle
2. Documenter le processus pour permettre sa reproductibilité (réexécution sur de nouvelles fiches).
3. Mettre en place un mécanisme de siretisation incrémentale pour les nouvelles fiches ajoutées.

**Livrable :** Rapport final, documentation technique, procédure de maintenance.

---

## 6. Règles de matching et scoring

### 6.1 Nettoyage de la dénomination

Avant toute comparaison, le nom Google Business subit les transformations suivantes :

1. Conversion en majuscules.
2. Suppression des accents (normalisation Unicode NFD).
3. Extraction et mise à part de la forme juridique (SAS, SARL, EURL, SA, SCI, SASU, etc.).
4. Suppression de la ponctuation et des caractères spéciaux.
5. Suppression des mots vides courants (LE, LA, LES, DE, DU, DES, ET).
6. Remplacement des abréviations connues (ST → SAINT, CIE → COMPAGNIE, ETS → ETABLISSEMENTS).

### 6.2 Calcul du score de confiance

| Critère | Points |
|---|---|
| Dénomination identique (après nettoyage) | +40 |
| Dénomination similaire > 85% (Jaro-Winkler) | +30 |
| Dénomination similaire > 70% | +20 |
| Code postal identique | +20 |
| Même département (2 premiers chiffres) | +10 |
| Commune identique (après normalisation) | +15 |
| Forme juridique identique | +5 |
| Catégorie Google compatible avec code NAF | +10 |
| Proximité GPS < 100m | +15 |
| Proximité GPS < 500m | +10 |
| Entreprise en état actif | +5 |
| Un seul résultat trouvé (pas d'ambiguïté) | +10 |

**Seuils de décision :**
- Score ≥ 80 : `matched` — rapprochement validé automatiquement.
- Score 50–79 : `uncertain` — probable mais à confirmer.
- Score < 50 : `unmatched` — rapprochement rejeté, passage à la passe suivante ou revue manuelle.

---

## 7. Gestion des cas particuliers

| Cas | Traitement |
|---|---|
| **Enseignes / noms commerciaux** | Le nom Google peut être une enseigne différente de la dénomination sociale. Vérifier le champ `enseigne_1` des établissements retournés par l'API. |
| **Franchises** | Plusieurs fiches Google pour le même SIREN mais des SIRET différents (établissements). Matcher au niveau SIRET en utilisant l'adresse. |
| **Auto-entrepreneurs** | Peuvent ne pas apparaître dans SIRENE sous leur nom commercial. Tenter la recherche par nom/prénom du dirigeant via `/api/recherche-dirigeants`. |
| **Associations (loi 1901)** | Présentes dans SIRENE mais pas toujours avec le même nom que sur Google. Identifier via la forme juridique (92xx). |
| **Entreprises cessées** | Fiche Google encore active mais entreprise radiée. Signaler l'incohérence (`etat_administratif = C`). |
| **Multi-établissements** | Un SIREN avec plusieurs établissements. Utiliser l'adresse et les coordonnées GPS pour identifier le bon SIRET. |
| **Noms en langue étrangère** | Certaines fiches Google utilisent un nom traduit. Prévoir une recherche élargie. |

---

## 8. Contraintes techniques

### 8.1 Performance et rate limiting

- L'API intègre un rate limiting côté serveur. Prévoir un délai entre les appels (100–200 ms minimum).
- Utiliser l'endpoint `/api/batch` (100 SIREN par requête) dès que possible pour réduire le nombre d'appels.
- Paralléliser les appels avec un pool de workers contrôlé (5 à 10 requêtes concurrentes maximum).

### 8.2 Volumétrie estimée

| Métrique | Estimation |
|---|---|
| Nombre de fiches Google Business | À mesurer (`SELECT COUNT(*) FROM google_business_v2`) |
| Appels API Passe 1 (suggestions) | 1 appel par fiche |
| Appels API Passe 2 (recherche) | ~30% des fiches (non résolues en passe 1) |
| Appels API enrichissement | 1 appel par fiche matchée (ou batch /100) |
| Temps estimé total | Dépend du volume — prévoir plusieurs heures pour > 100 000 fiches |

### 8.3 Authentification

Toutes les requêtes (sauf `/api/health`) nécessitent le header `x-api-key`. La clé doit être stockée de manière sécurisée (variable d'environnement, pas en dur dans le code).

---

## 9. Livrables attendus

1. **Script de siretisation** — Code source documenté (Python ou Node.js) implémentant les 4 passes de rapprochement.
2. **Table enrichie** — `google_business_v2` (ou table de liaison) complétée avec SIREN, SIRET, score de confiance et statut de matching.
3. **Rapport de siretisation** — Statistiques détaillées sur les taux de matching, la qualité des résultats et les cas non résolus.
4. **Procédure de maintenance** — Documentation pour réexécuter le processus sur de nouvelles fiches (siretisation incrémentale).

---

## 10. Planning prévisionnel

| Étape | Durée estimée |
|---|---|
| 1. Audit des données source | 0,5 jour |
| 2. Nettoyage et normalisation | 1 jour |
| 3. Infrastructure et schéma | 0,5 jour |
| 4. Développement du moteur | 2–3 jours |
| 5. Exécution par lots | 1–2 jours (selon volume) |
| 6. Contrôle qualité | 1 jour |
| 7. Traitement cas non résolus | 1–2 jours |
| 8. Enrichissement complémentaire | 0,5–1 jour |
| 9. Documentation et rapport | 0,5 jour |
| **Total estimé** | **7–11 jours ouvrés** |
