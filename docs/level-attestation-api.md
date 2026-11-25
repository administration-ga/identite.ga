# Attestation de niveau — API pour partenaires (`IDN-ATTESTATION-NIVEAU-V1`)

Permet à une application partenaire habilitée (consulat.ga aujourd'hui) d'**attester un fait**
sur une personne qui a un compte identite.ga : « ce sujet IDN est un ressortissant gabonais dont
l'inscription consulaire est déposée ». identite.ga **décide seul** de l'effet sur le niveau du
compte et l'écrit lui-même. Décision : `docs/adr/0003-niveau-2-atteste-par-un-partenaire.md`.

Règle du propriétaire (25/11/2026) : tout ressortissant gabonais qui a ouvert son inscription
consulaire dans consulat.ga est par défaut au **Niveau 2** sur son compte IDN associé.

Serveur à serveur. Pas de CORS.

## Authentification

```
Authorization: Basic base64(client_id:client_secret)
```

C'est le secret OAuth que le partenaire détient déjà pour la connexion par IDN : aucun nouveau
secret, aucune variable d'environnement. Le client doit :

1. exister dans `oauthApplication`, être actif et confidentiel (pas `public`) ;
2. présenter le bon secret ;
3. détenir une **capacité active** pour le type de fait (table `partnerLevelGrant`).

La capacité est **fermée par défaut**. Un secret faux donne `401` même pour un client sans
capacité : un appelant anonyme n'apprend pas quels clients sont habilités.

### Ouvrir ou fermer la capacité (geste d'opérateur)

Par la CLI Convex (fonctions internes, jamais exposées), sur le déploiement visé. En
production, nommer explicitement le déploiement `flexible-panda-248` et ne jamais utiliser
`--prod` (cf. `packages/backend/convex/AGENTS.md`) :

```sh
npx convex run --deployment flexible-panda-248 partnerLevel/attestations:grantCapability \
  '{"clientId":"<client_id>","kind":"consular_registration","grantedBy":"<nom de l opérateur>"}'

npx convex run --deployment flexible-panda-248 partnerLevel/attestations:revokeCapability \
  '{"clientId":"<client_id>","kind":"consular_registration","revokedBy":"<nom de l opérateur>"}'
```

- `grantCapability` refuse un client absent, public ou désactivé, et rend le nom du client pour
  vérification. Il est idempotent et rouvre une capacité fermée.
- Les deux gestes sont tracés au journal d'audit (`admin_action`, métadonnée `kind` :
  `partner_level_capability_granted` ou `partner_level_capability_revoked`).
- Fermer la capacité ne retire pas les attestations déjà enregistrées. Le client ne peut plus ni
  attester ni retirer. Revue : `partnerLevel/attestations:listAttested`
  (`{"paginationOpts":{"numItems":50,"cursor":null}}`, une page par appel).

## Base

`https://site.identite.ga` (même hôte que l'API de confirmation de connexion).
Préfixe des routes : `/partner-level/v1`.

## Routes

| Appel | Corps | Réponse `200` |
|---|---|---|
| `POST /partner-level/v1/attestations` | `{ sub, kind, dryRun? }` | `{ outcome, loa, acr, attestedAt, dryRun }` |
| `POST /partner-level/v1/attestations/withdraw` | `{ sub, kind, dryRun? }` | `{ outcome, loa, acr, dryRun }` |

- `sub` : identifiant OIDC de la personne (le `sub` du jeton d'identité), 128 caractères au plus.
- `kind` : `consular_registration`, seule valeur admise aujourd'hui.
- `dryRun` : booléen facultatif, `false` par défaut. Voir plus bas.
- Corps strict : tout autre champ est refusé (`400`).
- `loa` : niveau du compte après l'appel (1, 2 ou 3) ; `acr` : `eidas1`, `eidas2` ou `eidas3`.
- `attestedAt` : horodatage en millisecondes de l'attestation active.
- Aucun identifiant interne, aucune donnée d'état civil dans les réponses.

### Résultat d'une attestation

| `outcome` | Signification |
|---|---|
| `applied` | Le compte était au Niveau 1 : il passe au Niveau 2. La personne est prévenue. |
| `already_attested` | Une attestation active existe déjà pour ce client, ce sujet et ce type : rien n'est refait. |
| `recorded` | Le compte était déjà au Niveau 2 ou 3 par une autre voie : simple trace, le niveau ne bouge pas. Une attestation ne fait **jamais** baisser un niveau. |

### Résultat d'un retrait

| `outcome` | Signification |
|---|---|
| `withdrawn` | Attestation close et niveau ramené à celui d'avant l'attestation. Seulement si l'attestation avait elle-même monté le compte, si aucune demande KYC n'a été approuvée depuis, si le compte n'est pas au Niveau 3 et si aucune autre attestation active ne soutient le niveau. La personne est prévenue. |
| `kept` | Attestation close, niveau inchangé : elle n'avait rien monté, ou des pièces ont été approuvées, ou le compte est au Niveau 3, ou une autre attestation active soutient le niveau. |
| `not_attested` | Aucune attestation active pour ce client, ce sujet et ce type. |

Le retrait n'exige pas de consentement en cours : un partenaire doit pouvoir lever son
attestation même si la personne lui a retiré son consentement entre-temps.

### Idempotence

Clé : (client, sujet, type de fait). Rejouer une attestation répond `already_attested`.
Attester de nouveau après un retrait **réactive la même ligne**.

### `dryRun`

Avec `"dryRun": true`, identite.ga évalue tout et **n'écrit rien** : aucune ligne
d'attestation, aucun changement de niveau, aucune entrée au journal, aucune notification. La
réponse montre l'effet qu'aurait l'appel (`outcome`, `loa` projeté). Un `dryRun` **consomme le
plafond** du client, comme un appel réel : sans cela l'API deviendrait un oracle illimité sur les
comptes.

### Erreurs

Corps `{ error, message, reason? }`.

| Statut | `error` | Cas |
|---|---|---|
| 400 | `invalid_request` | Corps JSON invalide, champ inconnu, `sub` absent, `kind` inconnu, `dryRun` non booléen |
| 401 | `invalid_client` | Authentification absente ou incorrecte, y compris pour un client sans capacité |
| 403 | `attestation_not_enabled` | Client authentifié sans capacité active |
| 404 | `unknown_subject` | Sujet inconnu, compte sans profil, ou compte anonymisé |
| 409 | `not_linked` | Attestation : aucun consentement enregistré de cette personne pour ce client |
| 409 | `review_required` | `reason` : `kyc_rejected` (la dernière demande de vérification a été refusée), `duplicate_flag_open` (un signalement de doublon est ouvert sur le compte) |
| 422 | `not_eligible` | `reason` : `profile_incomplete` (nom, prénom, date de naissance ou nationalité manquant), `profile_type` (compte autre que citoyen), `account_closing` (suppression du compte demandée) |
| 429 | `rate_limited` | Plus de 120 appels par minute pour ce client (attestations et retraits confondus). En-tête `Retry-After` en secondes. |

Ordre des contrôles : authentification, capacité, plafond, sujet, consentement (attestation
seulement), attestation déjà active, éligibilité, revue humaine, niveau.

## Ce que l'attestation change pour la personne

- **Notification** (catégorie vérification) : « Votre identité passe au Niveau 2 », ou au
  retrait « Votre identité revient au Niveau 1 ». Le texte nomme le partenaire.
- **État civil verrouillé** tant qu'une attestation est active : nom, prénoms, date de naissance,
  nationalité et NIP ne se modifient plus depuis l'espace de la personne (code
  `IDENTITY_LOCKED`). Une correction passe par le consulat ou le support. Le genre et le lieu de
  naissance restent modifiables.
- **Niveau 3** : un Niveau 2 obtenu par la seule attestation n'est pas une preuve documentaire.
  Pour viser le Niveau 3, la personne fournit ses pièces comme depuis le Niveau 1.
- **Doublons** : un homonyme qui s'inscrit face à un compte attesté seulement est signalé à un
  administrateur, pas refusé.

## Côté application relying party

Le jeton d'identité porte `acr: eidas2` que le Niveau 2 vienne de pièces examinées ou d'une
attestation : les deux origines se distinguent en base, pas dans les jetons. Une application qui
exige des pièces examinées par IDN garde son propre contrôle. Voir `docs/verification-api.md`.

## Exemple

```sh
curl -sS https://site.identite.ga/partner-level/v1/attestations \
  -u "$IDN_CLIENT_ID:$IDN_CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"sub":"<sub OIDC>","kind":"consular_registration","dryRun":true}'
# → {"outcome":"applied","loa":2,"acr":"eidas2","attestedAt":1764072000000,"dryRun":true}
```
