# ADR 0003 — Niveau 2 attesté par un partenaire

**Statut** : Accepté — règle du propriétaire du 25/11/2026, décision de l'architecte du même jour
**Date** : 2026-11-25
**Contrat** : `IDN-ATTESTATION-NIVEAU-V1` (`docs/level-attestation-api.md`)

## Contexte

- Jusqu'ici, le Niveau 2 d'un compte IDN venait de deux voies seulement : une demande KYC
  approuvée (pièce, selfie, analyse automatique ou contrôleur), ou la délégation au guichet
  (`delegate/`), où un opérateur crée l'identité pour la personne.
- Règle du propriétaire, 25/11/2026 : « tout gabonais qui a ouvert son compte d'inscription
  consulaire dans consulat.ga est par défaut de niveau 2 sur son compte associé IDN ».
- Le Niveau 2 ouvre les clients à plancher strict (`loaEnforcement: "strict"`, ADR 0002) : les
  applications de l'État n'émettent aucun jeton en dessous.
- Plusieurs règles d'IDN lisaient `loa >= 2` comme « pièces déjà examinées » : le raccourci vers
  le Niveau 3 (pas de nouvelle piste documentaire), la décision de Niveau 3 (rien à constater) et
  le contrôle anti-doublon (une identité vérifiée ferme la porte à un homonyme).

## Décision

1. **Le partenaire atteste, IDN écrit.** consulat.ga atteste un fait (« ce sujet IDN est un
   ressortissant gabonais dont l'inscription consulaire est déposée »). IDN seul décide et écrit
   `userProfile.loa`, par les mutations à déclencheurs de `convex/functions.ts` (l'agrégat
   `usersByLoa` suit).
2. **Deux routes, une capacité fermée par défaut.** `POST /partner-level/v1/attestations` et
   `POST /partner-level/v1/attestations/withdraw`, authentifiées par le secret OAuth que le
   partenaire détient déjà (`Authorization: Basic`). La capacité vit en base (table
   `partnerLevelGrant`), s'ouvre et se ferme par un geste d'opérateur tracé
   (`partnerLevel/attestations:grantCapability`, `revokeCapability`, audit `admin_action`). 401
   avant 403 ; plafond de 120 appels par minute et par client. L'opérateur peut lever les
   attestations actives d'un client, capacité ouverte ou fermée (`operatorWithdraw`, une page par
   appel, même règle et mêmes écritures que le retrait du partenaire, opérateur inscrit au
   journal).
3. **Une table de trace, jamais de baisse à l'attestation, un retrait borné.** Table
   `levelAttestation` (une ligne par client, sujet et type de fait ; clé d'idempotence ; une
   nouvelle attestation après un retrait réactive la même ligne). Elle garde le niveau constaté
   avant l'attestation (`previousLoa`) et si l'attestation l'a monté (`raised`). Une attestation
   ne fait jamais baisser un niveau. Le retrait ne redescend qu'au niveau d'avant, et seulement si
   l'attestation l'avait monté, si aucune demande KYC n'a été approuvée, si le compte n'est pas au
   Niveau 3 et si aucune autre attestation active ne soutient le niveau (qui hérite alors de la
   charge de l'avoir monté). Journal : `level_attested`, `level_attestation_withdrawn`,
   `level_attestation_refused` (avec le motif, sans donnée civile). La personne est prévenue
   quand son niveau monte ou redescend.
4. **Refus.** Consentement de la personne pour ce client exigé à l'attestation (`not_linked`), et
   au retrait quand aucune attestation n'a jamais été enregistrée pour ce sujet (la route ne
   renseigne pas sur le niveau d'un compte inconnu du partenaire). Revue humaine si la dernière
   **décision** KYC est un refus — une demande refusée plus récente que la dernière approuvée ;
   une demande rouverte ensuite ne l'efface pas — ou si un doublon est ouvert
   (`review_required`). Non éligible : profil incomplet, compte autre que citoyen, nationalité
   enregistrée autre que gabonaise pour une inscription consulaire, suppression demandée
   (`not_eligible`). Sujet inconnu ou anonymisé : `unknown_subject`.

   **Identité lue par le partenaire.** Le partenaire compare son dossier à une copie de l'état
   civil IDN. L'attestation porte `identityReadAt` (moment de cette lecture, 0 si inconnu) ; IDN
   date chaque changement réel du nom, des prénoms, de la date de naissance ou de la nationalité
   (`userProfile.pivotUpdatedAt`, écrit par `onboarding.completeSignup`,
   `onboarding.setIdentityPivot`, `profile.updatePivot`, `delegate/mutations.createDelegatedProfile`)
   et refuse une identité modifiée après la lecture (`409 identity_stale`). Sans reprise de
   l'existant : un champ absent vaut « inchangé depuis la mise en service ».
5. **Un Niveau 2 attesté seulement n'est pas une preuve documentaire.** « Attesté seulement » :
   attestation active qui a monté le compte, et aucune demande KYC approuvée
   (`verification/documentProof.ts`, `documentaryLoa`). Pour ces comptes, et pour eux seuls : le
   Niveau 3 passe par la piste documentaire comme depuis le Niveau 1 (`verification/requestFlow.ts`,
   `verification.getMine`, `level3/scheduling.ts`), la décision de Niveau 3 exige des pièces
   constatées (`level3/decision.ts`), le contrôleur ne peut pas planifier l'entretien avant les
   pièces (`controller/agenda.ts`), `level3Verification.entryLoa` enregistre ce niveau de preuve
   (la file partenaire et l'agenda n'escamotent donc pas l'étape des pièces ; le niveau détenu
   reste au journal, `heldLoa`), et un homonyme qui s'inscrit est signalé, pas refusé
   (`lib/duplicateGuard.ts`) — sinon une attestation suffirait à verrouiller un nom contre son
   vrai porteur. Un compte dont les pièces ont été approuvées ferme toujours la porte.
6. **État civil verrouillé pendant une attestation active.** Nom, prénoms, date de naissance,
   nationalité et NIP ne se modifient plus depuis l'espace de la personne (`profile.updatePivot`,
   `profile.updateNip`, `onboarding.setIdentityPivot` ; code `IDENTITY_LOCKED`), et le compte ne
   quitte pas le type « citoyen » (`onboarding.selectProfile`). Une saisie identique passe ; genre
   et lieu de naissance restent modifiables ; ajouter un premier NIP reste permis. Le verrou ne
   s'applique pas aux comptes vérifiés par KYC sans attestation.

## Conséquences

- `eidas2` couvre désormais deux origines, distinguables en base (`levelAttestation`,
  `kycRequest` approuvé) mais pas dans les jetons. Une application relying party qui exige des
  pièces examinées par IDN garde son propre contrôle (`docs/verification-api.md`, section 5).
- Aucune empreinte faciale pour un compte attesté : la galerie de déduplication ne se remplit
  qu'à l'approbation d'un KYC. Un compte attesté seulement n'y fait donc pas obstacle.
- Les écrans du Niveau 3 (citoyen et contrôleur) affichent encore le niveau détenu : ils
  devront dire qu'un compte attesté doit fournir ses pièces. Hors de ce changement.
- La purge RGPD (`privacy/deletion.ts`) efface les attestations du compte ; le journal reste.
- Fermer la capacité d'un client ne retire pas ses attestations : l'opérateur les revoit avec
  `listAttested` et les lève avec `operatorWithdraw`.

## Limites connues

Acceptées ou reportées après la revue de sécurité du 25/11/2026 :

- **Un refus KYC postérieur à l'attestation ne la retire pas.** Le refus est vérifié au moment
  d'attester ; ensuite, seul le partenaire (`withdraw`) ou l'opérateur (`operatorWithdraw`) lève
  l'attestation.
- **`grantCapability` ne refuse pas une application en bac à sable.** C'est un geste explicite
  d'opérateur ; une application en bac à sable n'atteint de toute façon que ses propres
  personnes d'essai, par leur consentement.
- **Retirer son consentement ne lève pas le verrou d'état civil.** Le verrou suit l'attestation,
  pas le consentement ; le partenaire ou l'opérateur la retire.
- **La date de naissance n'est pas comparée par le partenaire aujourd'hui** : consulat.ga ne
  demande pas le scope `idn:civil_status`, qui porte `birthdate`. Sa comparaison porte sur les
  noms et prénoms ; IDN verrouille et date néanmoins la date de naissance.
- **`identityReadAt` est déclaratif** : IDN croit le partenaire sur l'heure de sa lecture. La
  règle protège un partenaire de bonne foi contre une copie périmée, pas contre un partenaire
  qui mentirait.

## Alternatives écartées

- **Clé d'API avec un nouveau scope** : un nouveau secret à émettre, transmettre et faire tourner,
  alors que le partenaire détient déjà un secret OAuth.
- **Liste blanche en variable d'environnement** (comme `IDN_MFA_CLIENT_IDS`) : un geste
  d'environnement, non tracé au journal, hors de portée de l'opérateur ordinaire.
- **Drapeau dans les `metadata` de l'application** : le portail développeur réécrit `metadata`
  en entier à chaque modification ; le drapeau disparaîtrait sans bruit.
- **Fausse demande KYC approuvée** : mentirait sur l'examen des pièces, ouvrirait le raccourci
  vers le Niveau 3 et fermerait la porte aux homonymes sans preuve.
- **« Niveau effectif » calculé à l'émission des jetons** : toucherait chaque lecture du niveau
  (jetons, userinfo, vérification, tableau de bord, agrégats) au lieu d'une seule écriture.
- **Jeton de la personne présenté par le partenaire** : expire en une heure et ne permet pas de
  reprendre l'existant (inscriptions consulaires déjà déposées).

## Preuves (25/11/2026)

- Tests : `convex/partnerLevel/rules.test.ts`, `partnerLevel.test.ts`, `api.test.ts`,
  `protections.test.ts` (suite du backend complète au vert, voir le compte rendu de la PR).
