# Serveur mail idn.ga

Le service de messagerie temporaire est hébergé par Stalwart dans la VM
`homelab` de la Freebox :

- IP publique : `82.66.163.161` ;
- IP privée de la VM : `192.168.1.39` ;
- nom public : `mail.idn.ga` ;
- image Stalwart : série stable `v0.16` ;
- répertoire de service : `/home/berny/services/mail` ;
- données : `/home/berny/services/mail/data`.

Le fichier `compose.freebox.yaml` expose directement SMTP, SMTPS et IMAPS.
Le conteneur Caddy existant du homelab termine HTTPS et transmet les requêtes
à Stalwart sur le réseau Docker `homelab_default`. Le bloc Caddy à conserver
dans la configuration du homelab se trouve dans `Caddyfile.freebox`.

Le conteneur `idn-mail-bridge` relie Stalwart à l'application :

- `POST /bridge/provision` crée idempotemment une vraie boîte Stalwart ;
- `POST /bridge/send` soumet un message authentifié à Stalwart ;
- le MTA Hook Stalwart appelle directement `/inbound` sur le réseau Docker ;
- le bridge transmet ensuite le message MIME normalisé à l'action HTTP Convex
  `/mail/inbound` ;
- les appels sont protégés par deux jetons distincts et les mots de passe des
  boîtes sont dérivés par HMAC, sans être stockés dans Convex.

Les secrets du bridge sont dans `/home/berny/services/mail/bridge.env` avec le
mode `0600`. Leurs copies d'exploitation sont dans le Trousseau macOS sous les
services `idn-ga-mail-bridge-token`, `idn-ga-mail-hook-token`,
`idn-ga-mail-inbound-token` et `idn-ga-mailbox-password-key` (compte
`idn-mail`).

L'administration est disponible sur `https://mail.idn.ga/admin`. Le mot de
passe du compte `admin@idn.ga` est conservé dans le Trousseau macOS, sous le
service `idn-ga-stalwart-admin` et le compte `admin@idn.ga`.

## Ports publics

La Freebox redirige les ports TCP suivants vers `192.168.1.39` :

- `25` : réception SMTP entre serveurs ;
- `80` et `443` : certificats ACME, administration, JMAP et autodécouverte ;
- `465` : soumission SMTP avec TLS implicite ;
- `993` : IMAP avec TLS implicite.

Les règles sont limitées à ces ports ; la DMZ Freebox n'est pas activée.

## DNS et délivrabilité

La zone NETIM contient un MX unique vers `mail.idn.ga`, dont l'enregistrement
A pointe vers `82.66.163.161`. Elle contient aussi SPF, deux signatures DKIM
(RSA et Ed25519), DMARC `reject`, MTA-STS, TLS-RPT et les alias de découverte
automatique.

Le trafic SMTP sortant direct sur TCP/25 est autorisé par l'accès Free et a été
testé vers plusieurs MX externes. Le reverse DNS Free est configuré sur
`mail.idn.ga`. Après un changement d'adresse, vérifier impérativement :

```sh
dig +short mail.idn.ga A
dig +short -x 82.66.163.161
```

Le compte `admin@idn.ga` reçoit également l'alias `postmaster@idn.ga`.

Le 8 août 2026, un test de production vers Mail Tester a obtenu `10/10` : SPF,
DKIM RSA, DKIM Ed25519, DMARC et reverse DNS valides.

## Exploitation

Depuis le réseau local :

```sh
ssh berny@192.168.1.39
cd /home/berny/services/mail
sudo docker compose -f compose.freebox.yaml ps
sudo docker logs --tail 100 stalwart
sudo docker logs --tail 100 idn-mail-bridge
```

Pour relancer le service :

```sh
sudo docker compose -f compose.freebox.yaml up -d
sudo docker exec caddy caddy reload \
  --config /etc/caddy/Caddyfile --adapter caddyfile
```

Après une évolution du bridge, reconstruire uniquement ce service :

```sh
sudo docker compose -f compose.freebox.yaml up -d --build bridge
```

Le hook MTA est un objet de configuration Stalwart nommé par son identifiant
JMAP. Il est exécuté au stage `data`, utilise une authentification Bearer et
conserve `tempFailOnError=true` : si Convex est indisponible, l'expéditeur
reçoit une erreur SMTP temporaire au lieu d'une fausse acceptation.

Le relais doit utiliser l'adresse canonique du backend auto-hébergé :

```dotenv
CONVEX_INBOUND_URL=https://site.identite.ga/mail/inbound
```

Après toute migration du backend, vérifier cette variable dans le conteneur
effectivement démarré, puis vérifier le transfert entrant. Le contrôle
`/bridge/health` teste uniquement l'accès à Stalwart : un résultat positif ne
garantit pas que Convex reçoit les messages.

### Incident du 20 octobre 2026

Le relais conservait l'adresse `flexible-panda-248.convex.site` après la
migration du backend du 10 octobre. Les journaux conservés montrent des erreurs
HTTP 500 depuis le 10 octobre, suivies d'erreurs du hook MTA de Stalwart. Le DNS,
le port SMTP public et la reconnaissance de la boîte examinée fonctionnaient.

Le 20 octobre, l'accès SSH a été rétabli en ajoutant la clé publique actuelle du
Mac pour `berny`, en conservant l'ancienne clé. La configuration cloud-init
Freebox conserve les deux clés, un ajout idempotent dans `authorized_keys` au
démarrage et `ssh_deletekeys: false` pour préserver les clés d'hôte.
La configuration précédente est sauvegardée sur le Mac dans
`~/.config/identite-ga/freebox-ssh-recovery-2026-10-20.json`, en mode `0600`.

`CONVEX_INBOUND_URL` a été corrigée dans `bridge.env`, puis seul le service
`bridge` a été recréé. La sauvegarde privée sur la VM est
`/home/berny/services/mail/bridge.env.before-backend-fix-2026-10-20`.
Un appel authentifié au hook, avec un destinataire de diagnostic inexistant,
a traversé le relais et obtenu `200 {"action":"accept"}` sans livrer de mail.
Des délais de connexion intermittents vers ST Digital subsistent : deux des
trois contrôles ultérieurs depuis de nouveaux processus Node ont dépassé le
délai de connexion de 10 secondes ; le troisième a atteint le backend et
obtenu la réponse attendue à un corps volontairement incomplet. Une capture
limitée aux métadonnées TCP montre des retransmissions, alors que le ping
mesuré est stable à environ 131 ms. La cause de ces délais réseau n'est pas
encore déterminée. Le test positif du hook ne suffit donc pas à garantir la
fiabilité de la réception, et aucune nouvelle livraison réelle de bout en bout
n'a été validée pendant ce diagnostic.

L'administration et la page MTA-STS, initialement en erreur 502, ont retrouvé
un statut HTTP 200 après le redémarrage de la VM, sans modification de Caddy.
Aucun renvoi de message en échec ni aucune bascule DNS n'a été effectué.
Les messages définitivement rejetés nécessitent un nouvel envoi autorisé.

## Sauvegardes

Une sauvegarde de migration est conservée dans
`/home/berny/services/mail/backup`. Les données persistantes à sauvegarder sont
`data/stalwart`, `data/etc` et `bridge-data`. Cette installation temporaire ne
dispose pas encore d'une sauvegarde automatique hors site : il faut en ajouter
une avant d'en faire l'hébergement définitif.

## Ancienne infrastructure Google Cloud

L'ancienne infrastructure `mail-prod` a été supprimée le 8 août 2026 :
instance, disque, adresse IP statique, instantané, politique de sauvegarde,
règle pare-feu et secret Google Secret Manager. Il n'existe plus de repli
Google Cloud pour ce service.

## Vérifications après changement

Contrôler le DNS direct et inverse, le certificat TLS, les ports publics, les
enregistrements SPF/DKIM/DMARC, puis effectuer un test réel d'envoi et de
réception avec une adresse externe connue.
