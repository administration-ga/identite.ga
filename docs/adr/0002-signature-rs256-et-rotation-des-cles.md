# ADR 0002 — Signature RS256 conservée, rotation des clés, niveau à l'émission

**Statut** : Accepté — décision de l'architecte du 24/11/2026, prise par délégation du propriétaire, chantier CH-820
**Date** : 2026-11-24

## Contexte

Le ministère des Affaires étrangères (`ae.ministere.ga`) aura sa propre session, adossée à
identite.ga (lot L2b). Avant d'émettre son client OIDC de production, IDN devait être durci.
L'ADR-0164 de la plateforme, accepté avec une réserve, demandait à CH-820 de retirer RS256 ou
de le justifier. La passerelle n'admet RS256 que par exception, fermée par défaut.

Constats sur la version en production (`ntsagui/idn-gabon` `6fd98ac`, backend `flexible-panda-248`) :

- IDN signe ses ID tokens et ses JWT Convex avec une seule clé RSA 2048, jamais renouvelée.
- `@convex-dev/better-auth` 0.12.2 impose RS256 au fournisseur `customJwt` du plan de données
  Convex (`getAuthConfigProvider`, `getJwksAlg`).
- Les deux instances du plugin `jwt` partagent la table `jwks` et signent avec la clé la plus
  récente. Cette table n'a pas de colonne d'algorithme.
- Le plugin `jwt` explicite trie les clés avec `createdAt.getTime()`, alors que l'adaptateur Convex
  rend des nombres : dès deux clés, `/oauth2/token` répondait 500.
- La rotation intégrée du plugin convex supprime toutes les clés avant d'en créer une.
- Le niveau n'était contrôlé que par l'écran de consentement. Better Auth émet le code sans écran
  pour un client déjà consenti, et l'échange partenaire n'a pas d'écran.
- `acr` valait `urn:mace:incommon:iap:silver` sans le scope `profile`.
- `/oauth2/register` acceptait toute session, et le demandeur choisissait lui-même `metadata`.

## Décision

1. **RS256 est conservé.** Les clés créées par rotation sont en RSA 3072. Chaque clé publiée
   porte un `kid` et `alg: "RS256"`. Aucun vérificateur ne retombe sur une autre clé : le SDK
   exige `alg`, un module d'au moins 2048 bits et un `kid` connu.
2. **Rotation tous les 90 jours**, par les actions internes de `convex/jwksRotation.ts`
   (`list`, `rotate`, `prune`, `revoke`, `tick`) et par la règle pure de
   `lib/jwksRotationPolicy.ts`.
   - La nouvelle clé signe dès sa création.
   - L'ancienne reste publiée 7 jours après la création de sa remplaçante.
   - La clé active n'est jamais purgée, et le JWKS n'est jamais vide.
   - Deux rotations automatiques sont toujours espacées d'au moins 7 jours.
   - Un geste forcé reste possible : rotation immédiate, ou révocation (compromission, retour
     arrière ; la clé active demande `confirmLatest`).
3. **La rotation automatique ne s'arme qu'avec `IDN_JWKS_AUTO_ROTATION=enabled`.** Cette
   variable est posée par le propriétaire après une première rotation manuelle en production.
   La tâche quotidienne purge toujours. Elle journalise l'âge de la clé active.
4. **Interdits** : la rotation intégrée du plugin convex, `jwksRotateOnTokenGenerationError`,
   et tout changement de `keyPairConfig.alg` hors migration. Un test vérifie qu'aucune source ne
   cite les deux premiers.
5. **Niveau d'assurance.**
   - `acr` (`eidas1`…`eidas3`, ou `"0"` pour un compte sans profil) et `loa` partent toujours
     dans l'ID token et dans userinfo.
   - Un client **strict** (`metadata.loaEnforcement: "strict"`) n'obtient ni jeton ni claim
     sous son minimum `metadata.loa`. Le refus est un 403 `access_denied`
     `unmet_authentication_requirements: eidasN requis`, sur `/oauth2/token`,
     `/oauth2/userinfo` et l'échange partenaire.
   - Si `loa` est illisible sur un client strict, le plancher est 3.
   - Les autres clients gardent le contrat publié : jeton au niveau réel, revue manuelle suivie
     par l'application.
   - `acr_values` reste une demande, que l'application vérifie elle-même (option `minLevel` du
     SDK).
6. **`/oauth2/register` est fermé à tous** (403 `client_registration_closed`) et n'est plus
   annoncé par la découverte. Un client se crée par trois voies :
   - le portail développeur ;
   - l'approbation d'un administrateur ;
   - `bootstrapTrustedClient` pour les applications de l'État. `env` y est obligatoire, et le
     plancher strict toujours posé.
7. **Passerelle de la plateforme.** Elle reste fermée par défaut. RS256 n'est admis que pour le
   seul émetteur IDN (`https://site.identite.ga`), comme seul algorithme de cet émetteur, avec
   `alg` exigé et un module d'au moins 2048 bits. Si la plateforme passe par un échange de jeton,
   l'exception peut être retirée chez elle. Note de passation remise à la session plateforme.

## Conséquences

- Pendant 7 jours après chaque rotation, deux clés sont publiées.
- Le SDK `@idn-ga/core` ≥ 0.3.0 relit le JWKS sur `kid` inconnu, au plus une fois toutes les
  30 s. Les versions 0.2.0 et antérieures échouent jusqu'à une heure après une rotation : publier
  0.3.0 avant la première rotation de production.
- Selon le code ouvert de Convex et l'essai du 24/11, le plan de données relit le JWKS d'un
  `customJwt` à chaque validation. À surveiller lors de la première rotation de production. Le
  retour arrière se fait en révoquant la nouvelle clé.
- Changer `BETTER_AUTH_SECRET` rend illisibles toutes les clés privées.
- Les clients existants ne passent pas en strict d'office : ce serait fermer la porte à des
  usagers en revue manuelle. La décision revient au propriétaire, client par client.

## Preuves (24/11/2026)

- **Tests** : `convex/oidcHardening.test.ts` joue les vraies routes Better Auth ; à côté,
  `lib/jwksRotationPolicy.test.ts`, `developer/trustedClient.test.ts`,
  `oauthAuthorize.test.ts`, `scripts/visibility.test.ts` et `packages/sdk/core/src/jwks.test.ts`.
- **Essai sur un backend Convex local de développement** :
  - inscription refusée à une session ordinaire (403) ;
  - jeton refusé sous le niveau du client strict `ae.ministere.ga (développement)` (403) ;
  - après rotation, l'ancien ID token reste accepté par le SDK, cache chaud, et l'ancien JWT
    Convex par le plan de données ;
  - les nouveaux jetons portent le nouveau `kid` : le SDK relit le JWKS une seule fois, et le
    plan de données les accepte aussitôt ;
  - la purge immédiate n'a rien retiré ; après révocation, l'ancien `kid` est refusé.

## Sortie vers ES256

Pas de migration partielle. ES256 deviendra possible quand trois conditions seront réunies :

- le composant l'accepte pour `customJwt`, ou IDN migre vers `@better-auth/oauth-provider`
  (`oidc-provider` est déprécié) ;
- les lignes `jwks` portent leur algorithme ;
- les applications acceptent les deux algorithmes pendant le recouvrement.

À revoir à chaque montée de version, au plus tard fin 2028.

## Alternatives écartées

- **Retirer RS256** : impossible sans patcher le composant.
- **ES256 pour les seuls ID tokens** : le plugin convex signerait avec la clé la plus récente,
  sans filtre d'algorithme.
- **`rotationInterval` de better-auth** : sans effet sur l'instance interne du plugin convex.
- **Publier une clé avant de l'activer** : le composant signe toujours avec la plus récente.
- **Plancher de niveau pour tous les clients** : romprait le contrat publié de la revue manuelle.
- **Niveau demandé par `acr_values`, attaché au code** : le hook d'`oidcProvider` crée aussi des
  codes hors de ce chemin, et l'usager peut retirer le paramètre.
