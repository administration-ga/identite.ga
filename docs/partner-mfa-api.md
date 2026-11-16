# Confirmation de connexion — API pour partenaires

Permet à une application partenaire (Diplomate.ga aujourd'hui) de faire confirmer
par un citoyen, depuis l'app identite.ga, qu'une connexion ou une action sensible
est bien la sienne. Décision : ADR-0007 §6 (`docs/adr/0007-double-authentification-agents.md`
dans le dépôt gabon-diplomatie).

Serveur à serveur. Pas de CORS.

## Authentification

```
Authorization: Basic base64(client_id:client_secret)
```

Le client doit :

1. exister dans `oauthApplication`, être actif et confidentiel (pas `public`) ;
2. présenter le bon secret ;
3. figurer dans la variable `IDN_MFA_CLIENT_IDS` (liste séparée par des virgules).

Un secret faux donne `401` même pour un client hors liste, pour ne pas révéler la liste.

## Base

`https://site.identite.ga` par défaut, surchargeable par `IDN_MFA_BASE_URL` côté partenaire.
Préfixe des routes : `/partner-mfa/v1`.

## Routes

| Appel | Corps / paramètres | Réponse |
|---|---|---|
| `POST /partner-mfa/v1/requests` | `{ sub, kind, actionLabel?, context? }` | `201 { requestId, number, expiresAt }` |
| `GET /partner-mfa/v1/requests/status?id=` | — | `{ status, decidedAt? }` |
| `POST /partner-mfa/v1/requests/cancel` | `{ id }` | `{ ok: true }` |
| `POST /partner-mfa/v1/totp/verify` | `{ sub, code }` | `{ valid: boolean }` |
| `GET /partner-mfa/v1/links/status?sub=` | — | `{ linked, devices }` |
| `POST /partner-mfa/v1/links/revoke` | `{ sub }` | `{ ok: true }` |

- `sub` : identifiant OIDC du citoyen (id Better Auth).
- `kind` : `enroll` (première liaison), `login` (connexion), `sensitive` (action sensible).
- `actionLabel` : 100 caractères au plus. Affiché à l'app pour `sensitive`.
- `context` : `device` (80), `location` (80), `ip` (45). Champs inconnus refusés.
- `code` : exactement 6 chiffres.

### Statuts

`pending`, `approved`, `denied`, `wrong_number`, `cancelled`, `expired`.

- Une demande vit **2 minutes**. Le statut `expired` est calculé à la lecture.
- Le nombre (2 chiffres) est renvoyé **uniquement** à la création. L'app reçoit trois
  choix sans savoir lequel est bon : c'est le serveur qui compare.
- Un mauvais choix clôt la demande en `wrong_number`.

### Erreurs

Corps `{ error, message }`.

| Statut | `error` | Cas |
|---|---|---|
| 400 | `invalid_request` | Corps ou paramètres invalides |
| 401 | `invalid_client` | Authentification absente ou incorrecte |
| 403 | `client_not_allowed` | Client authentifié, absent de `IDN_MFA_CLIENT_IDS` |
| 404 | `unknown_subject` | Aucun compte pour ce `sub` |
| 404 | `not_found` | Demande inconnue, ou appartenant à un autre partenaire |
| 409 | `not_linked` | `login` / `sensitive` sans lien actif |
| 409 | `no_device` | Aucun appareil de confiance enregistré dans l'app |
| 409 | `request_closed` | Annulation d'une demande déjà tranchée (contient `status`) |
| 429 | `rate_limited` | Création : 6 par minute et par partenaire et citoyen. Vérification de code : 10 par 10 minutes |

### Liaison

L'approbation d'une demande `enroll` crée le **lien** (citoyen, partenaire). Le lien
autorise ensuite les demandes `login` / `sensitive` et la vérification de codes.
Le citoyen voit et retire ses liens dans l'app (Sécurité › Services liés) ; le
partenaire peut aussi retirer le sien (`links/revoke`). Une révocation annule les
demandes encore en attente pour ce couple.

### Codes de connexion (TOTP)

Chaque appareil de l'app a son propre secret TOTP (RFC 6238, SHA-1, 6 chiffres, pas de 30 s).
`totp/verify` accepte le pas courant et les pas précédent / suivant (±1). Un pas déjà
accepté ne repasse plus (anti-rejeu, par appareil). Sans lien actif, la route répond
`409 not_linked`, même si le code est juste.

## Notification

Titre « Confirmation demandée », corps « <nom du client> te demande de confirmer que
c’est bien toi. », lien `/confirm?id=<requestId>`. Aucune donnée sensible dans le texte.

## Variables d'environnement (backend Convex)

| Variable | Obligatoire | Rôle |
|---|---|---|
| `IDN_MFA_CLIENT_IDS` | oui | Liste blanche des `client_id` autorisés à appeler l'API (virgules). Absente : tous les appels reçoivent `403`. |
| `IDN_AUTHENTICATOR_KEY` | oui en production | Clé AES-256 (32 octets, hex 64 caractères ou base64url) qui chiffre les secrets TOTP des appareils. |
| `WEBHOOK_SECRETS_KEY` | repli | Utilisée à la place de `IDN_AUTHENTICATOR_KEY` si celle-ci est absente. Même format. L'AAD est distinct (`idn:device-totp:v1`), donc un chiffré ne se rejoue pas dans l'autre contexte. Repli déconseillé : une clé dédiée sépare les usages. |
| `IDN_MFA_BASE_URL` | non | Côté partenaire uniquement. Base de l'API si différente du discovery. |

Générer une clé dédiée :

```sh
openssl rand -hex 32
```

Changer la clé rend illisibles les secrets déjà chiffrés : la vérification de code
échoue pour les appareils concernés. Il faut alors que chaque appareil régénère son
secret (`devices.rotateDevice`, bouton « Réenregistrer » de l'app) ou le retirer.
