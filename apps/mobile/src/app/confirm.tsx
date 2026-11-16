import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { ConvexError } from 'convex/values';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { Text } from '@/design/text';
import { useIdnTheme } from '@/design/theme';
import { IdnMark } from '@/design/mark';
import { Icon, type IconName } from '@/design/icons';
import { AppBar } from '@/design/components/app-bar';
import { IdnButton } from '@/design/components/idn-button';
import { Screen } from '@/design/components/screen';
import { Card, ErrorNote, useToneColors, type RowTone } from '@/design/components/list';
import { ServiceTile } from '@/components/confirmation/service-tile';
import { api } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { biometricAvailable, confirmWithBiometrics } from '@/lib/face-unlock';
import { readAuthenticatorState } from '@/lib/authenticator/device';
import { secureAuthenticatorStorage } from '@/lib/authenticator/secure-storage';
import {
  formatClock,
  formatWhen,
  kindLabel,
  maskAccount,
  outcomeView,
  type ConfirmationStatus,
  type OutcomeView,
} from '@/lib/confirmation';

/** Session telle que lue par le client Better Auth (typé `any` dans auth-client). */
type SessionSnapshot = { data?: { user?: { id?: string; email?: string } } | null };

/** Message lisible d'une erreur Convex métier, sinon un repli générique. */
function errorMessage(caught: unknown): string {
  if (caught instanceof ConvexError && typeof caught.data === 'object' && caught.data !== null) {
    const message = (caught.data as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'Réponse impossible pour le moment. Réessaie.';
}

/**
 * « Est-ce bien toi ? » : un service demande une confirmation, l'utilisateur
 * touche le nombre affiché sur l'écran du service. Le choix seul n'envoie rien
 * tant que la biométrie (si disponible) n'a pas réussi.
 */
export default function ConfirmScreen() {
  const t = useIdnTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const requestId = typeof params.id === 'string' && params.id.length > 0 ? params.id : null;
  const { isAuthenticated, isLoading } = useConvexAuth();
  const request = useQuery(
    api.partnerMfa.requests.get,
    isAuthenticated && requestId ? { id: requestId } : 'skip',
  );
  const respond = useMutation(api.partnerMfa.requests.respond);
  const deny = useMutation(api.partnerMfa.requests.deny);

  const [account, setAccount] = useState<{ email: string | null; userId: string | null }>({ email: null, userId: null });
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Résultat de la réponse envoyée depuis cet écran (la requête se mettra à jour aussi).
  const [settled, setSettled] = useState<ConfirmationStatus | null>(null);

  React.useEffect(() => {
    void authClient.getSession().then((session: SessionSnapshot | null) => {
      setAccount({
        email: (session?.data?.user?.email as string | undefined) ?? null,
        userId: (session?.data?.user?.id as string | undefined) ?? null,
      });
    });
  }, []);

  // Horloge pour l'échéance affichée et le passage à « expirée ».
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  function close() {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/home');
  }

  async function answer(choice: string) {
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Biométrie après le choix ; l'annulation n'envoie rien.
      if (await biometricAvailable()) {
        const verified = await confirmWithBiometrics(`Confirmer : ${kindLabel(request.kind, request.actionLabel)}`);
        if (!verified) return;
      }
      const local = account.userId
        ? await readAuthenticatorState(secureAuthenticatorStorage, account.userId)
        : { installationId: null, secret: null };
      const result = await respond({
        id: request.id,
        choice,
        installationId: local.installationId ?? undefined,
      });
      setSettled(result.status);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function refuse() {
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await deny({ id: request.id });
      setSettled(result.status);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const header = <AppBar title="Confirmation" onBack={close} backIcon="close" />;

  if (!requestId) {
    return <Notice header={header} title="Demande introuvable" text="Cette notification ne désigne aucune demande." onClose={close} />;
  }
  if (!isAuthenticated && !isLoading) {
    return <Notice header={header} title="Connexion requise" text="Connecte-toi à identite.ga pour répondre à cette demande." onClose={close} />;
  }
  if (request === undefined) {
    return (
      <Screen header={header}>
        <Text style={{ marginTop: 24, fontSize: 14, color: t.muted, textAlign: 'center' }}>Chargement…</Text>
      </Screen>
    );
  }
  if (request === null) {
    return <Notice header={header} title="Demande introuvable" text="Elle n’existe plus, ou elle ne te concerne pas." onClose={close} />;
  }

  // Résultat : la réponse vient d'être envoyée, ou la demande n'est plus ouverte.
  const finalStatus: ConfirmationStatus | null =
    settled ??
    (request.status !== 'pending' ? request.status : request.expiresAt <= now ? 'expired' : null);
  if (finalStatus && finalStatus !== 'pending') {
    return (
      <Outcome
        header={header}
        view={outcomeView(finalStatus, { clientName: request.clientName, kind: request.kind })}
        status={finalStatus}
        onClose={close}
        onSecure={() => router.replace('/settings/security')}
      />
    );
  }

  const what = kindLabel(request.kind, request.actionLabel);
  return (
    <Screen header={header} footer={
      <IdnButton
        t={t}
        variant="danger"
        full
        disabled={busy}
        leadIcon={<Icon name="shieldAlert" size={18} color="#fff" />}
        onPress={() => void refuse()}
      >
        Non, ce n’était pas moi
      </IdnButton>
    }>
      <View style={{ gap: 14, paddingTop: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <ServiceTile name={request.clientName} icon={request.clientIcon} />
          <View style={{ width: 28, height: 2, borderRadius: 1, backgroundColor: t.border }} />
          <IdnMark size={44} />
        </View>

        <View style={{ alignItems: 'center', gap: 6 }}>
          <Text accessibilityRole="header" style={{ fontSize: 22, fontWeight: '600', color: t.ink, textAlign: 'center' }}>
            Est-ce bien toi ?
          </Text>
          <Text style={{ fontSize: 14, lineHeight: 20, color: t.muted, textAlign: 'center' }}>
            {request.clientName} demande ta confirmation pour{' '}
            <Text style={{ fontWeight: '600', color: t.ink }}>{what}</Text>.
          </Text>
        </View>

        <Card padded>
          <Detail icon="user" label="Compte" value={maskAccount(account.email)} />
          <Detail icon="pinLoc" label="Lieu" value={request.context.location ?? 'Lieu inconnu'} />
          <Detail icon="smartphone" label="Appareil" value={request.context.device ?? 'Appareil inconnu'} />
          <Detail icon="clock" label="Heure" value={formatWhen(request.createdAt, now)} />
        </Card>

        <View style={{ gap: 10 }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: t.ink, textAlign: 'center' }}>
            Touche le nombre affiché sur ton écran
          </Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {request.choices.map((choice) => (
              <Pressable
                key={choice}
                onPress={() => void answer(choice)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={`Nombre ${choice}`}
                style={({ pressed }) => ({
                  flex: 1,
                  minHeight: 64,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: t.border,
                  backgroundColor: pressed ? t.surface2 : t.surface,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: busy ? 0.6 : 1,
                })}
              >
                <Text style={{ fontSize: 24, fontWeight: '600', color: t.ink, fontFamily: t.mono }}>{choice}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <ErrorNote>{error}</ErrorNote>
        <Text style={{ fontSize: 12, color: t.muted, textAlign: 'center' }}>
          Demande valable jusqu’à {formatClock(request.expiresAt)}
        </Text>
      </View>
    </Screen>
  );
}

function Detail({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  const t = useIdnTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44, paddingVertical: 10 }}>
      <Icon name={icon} size={17} color={t.muted} />
      <Text style={{ fontSize: 14, color: t.muted }}>{label}</Text>
      <Text style={{ flex: 1, textAlign: 'right', fontSize: 14, fontWeight: '500', color: t.ink }}>{value}</Text>
    </View>
  );
}

function Notice({
  header,
  title,
  text,
  onClose,
}: {
  header: React.ReactNode;
  title: string;
  text: string;
  onClose: () => void;
}) {
  const t = useIdnTheme();
  return (
    <Screen
      header={header}
      footer={<IdnButton t={t} full onPress={onClose}>Fermer</IdnButton>}
    >
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingTop: 40 }}>
        <Text accessibilityRole="header" style={{ fontSize: 20, fontWeight: '600', color: t.ink, textAlign: 'center' }}>{title}</Text>
        <Text style={{ fontSize: 14, lineHeight: 20, color: t.muted, textAlign: 'center' }}>{text}</Text>
      </View>
    </Screen>
  );
}

const OUTCOME_TONE: Record<OutcomeView['tone'], { tone: RowTone; icon: IconName }> = {
  ok: { tone: 'green', icon: 'check' },
  wrong: { tone: 'red', icon: 'close' },
  denied: { tone: 'red', icon: 'ban' },
  expired: { tone: 'neutral', icon: 'clock' },
  cancelled: { tone: 'neutral', icon: 'circleX' },
};

function Outcome({
  header,
  view,
  status,
  onClose,
  onSecure,
}: {
  header: React.ReactNode;
  view: OutcomeView;
  status: ConfirmationStatus;
  onClose: () => void;
  onSecure: () => void;
}) {
  const t = useIdnTheme();
  const { tone, icon } = OUTCOME_TONE[view.tone];
  const colors = useToneColors(tone);
  return (
    <Screen
      header={header}
      footer={
        <>
          {status === 'denied' ? (
            <IdnButton t={t} variant="ghost" full onPress={onSecure} leadIcon={<Icon name="shield" size={18} color={t.ink} />}>
              Sécuriser mon compte
            </IdnButton>
          ) : null}
          <IdnButton t={t} full onPress={onClose}>Terminé</IdnButton>
        </>
      }
    >
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingTop: 40 }}>
        <View style={{ width: 84, height: 84, borderRadius: 42, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={icon} size={40} color={colors.fg} />
        </View>
        <Text accessibilityRole="header" style={{ fontSize: 22, fontWeight: '600', color: t.ink, textAlign: 'center' }}>{view.title}</Text>
        <Text style={{ fontSize: 14, lineHeight: 20, color: t.muted, textAlign: 'center', maxWidth: 320 }}>{view.text}</Text>
      </View>
    </Screen>
  );
}
