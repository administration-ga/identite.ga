import React, { useState } from 'react';
import { Alert, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useConvexAuth, useMutation } from 'convex/react';
import { Text } from '@/design/text';
import { useIdnTheme } from '@/design/theme';
import { Icon } from '@/design/icons';
import { AppBar } from '@/design/components/app-bar';
import { IdnButton } from '@/design/components/idn-button';
import { Screen } from '@/design/components/screen';
import { Card, ErrorNote, Note, useToneColors } from '@/design/components/list';
import { api } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { readAuthenticatorState } from '@/lib/authenticator/device';
import { secureAuthenticatorStorage } from '@/lib/authenticator/secure-storage';
import { provisionThisDevice } from '@/lib/authenticator/this-device';
import { formatTotpCode, secondsUntilNextCode, totpAt, TOTP_PERIOD_SECONDS } from '@/lib/authenticator/totp';

/**
 * « Codes de connexion » : le code TOTP de cet appareil, calculé sur le
 * téléphone. Il marche hors réseau ; le secret ne quitte jamais le SecureStore.
 */
export default function ConnectionCodes() {
  const t = useIdnTheme();
  const router = useRouter();
  const { isAuthenticated } = useConvexAuth();
  const register = useMutation(api.partnerMfa.devices.registerDevice);
  const rotate = useMutation(api.partnerMfa.devices.rotateDevice);

  const [userId, setUserId] = useState<string | null>(null);
  // undefined : lecture en cours ; null : aucun secret sur ce téléphone.
  const [secret, setSecret] = useState<string | null | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSecret = React.useCallback(async (id: string) => {
    const state = await readAuthenticatorState(secureAuthenticatorStorage, id);
    setSecret(state.secret);
  }, []);

  React.useEffect(() => {
    if (!isAuthenticated) return;
    void authClient.getSession().then(async (session: { data?: { user?: { id?: string } } | null } | null) => {
      const id = (session?.data?.user?.id as string | undefined) ?? null;
      setUserId(id);
      if (id) await loadSecret(id);
      else setSecret(null);
    });
  }, [isAuthenticated, loadSecret]);

  // Le code change toutes les 30 s : on rafraîchit chaque seconde (calcul local, sans réseau).
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const code = secret ? totpAt(secret, now) : null;
  const remaining = secondsUntilNextCode(now);

  async function copyCode() {
    if (!code) return;
    await Clipboard.setStringAsync(code);
    setCopied(true);
  }

  async function renew() {
    if (!userId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await provisionThisDevice({ userId, register, rotate, force: true });
      await loadSecret(userId);
      Alert.alert('Appareil réenregistré', 'Les nouveaux codes sont prêts.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Réenregistrement impossible.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen header={<AppBar title="Codes de connexion" onBack={() => router.back()} />}>
      <View style={{ gap: 14, paddingTop: 6 }}>
        <Card padded style={{ alignItems: 'center', gap: 10, paddingVertical: 18 }}>
          <Text style={{ fontFamily: t.mono, fontSize: 11, letterSpacing: 1.3, textTransform: 'uppercase', color: t.greenText }}>
            Code de confirmation
          </Text>
          {secret === undefined ? (
            <Text style={{ fontSize: 14, color: t.muted, paddingVertical: 12 }}>Chargement…</Text>
          ) : code ? (
            <>
              <Text
                accessibilityLabel={`Code ${code.split('').join(' ')}`}
                style={{ fontFamily: t.mono, fontSize: 36, fontWeight: '500', letterSpacing: 4, color: t.ink, paddingVertical: 4 }}
              >
                {formatTotpCode(code)}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Ring remaining={remaining} />
                <Text style={{ fontSize: 13, color: t.muted }}>Nouveau code dans {remaining} s</Text>
              </View>
            </>
          ) : (
            <Text style={{ fontSize: 14, lineHeight: 20, color: t.muted, textAlign: 'center' }}>
              Ce téléphone n’a pas de secret de connexion. Réenregistre-le pour afficher les codes.
            </Text>
          )}
        </Card>

        {code ? (
          <IdnButton t={t} variant="secondary" full onPress={() => void copyCode()} leadIcon={<Icon name="copy" size={18} color={t.ink} />}>
            {copied ? 'Code copié' : 'Copier le code'}
          </IdnButton>
        ) : null}

        {secret === null ? (
          <IdnButton t={t} full onPress={() => void renew()} loading={busy}>
            Réenregistrer cet appareil
          </IdnButton>
        ) : null}

        <ErrorNote>{error}</ErrorNote>

        <Note style={{ marginTop: 0 }}>
          Saisis ce code sur le service qui te le demande. Il fonctionne même sans réseau.
        </Note>

        <Warning />
      </View>
    </Screen>
  );
}

/** Anneau de compte à rebours : il se vide sur les 30 secondes du code. */
function Ring({ remaining }: { remaining: number }) {
  const t = useIdnTheme();
  const size = 26;
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const fraction = remaining / TOTP_PERIOD_SECONDS;
  return (
    <Svg width={size} height={size}>
      <Circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={t.surface2} strokeWidth={stroke} />
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={remaining <= 5 ? t.redText : t.green}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${c}`}
        strokeDashoffset={c * (1 - fraction)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </Svg>
  );
}

function Warning() {
  const colors = useToneColors('yellow');
  return (
    <View
      accessibilityRole="alert"
      style={{ flexDirection: 'row', gap: 10, padding: 12, borderRadius: 10, backgroundColor: colors.bg }}
    >
      <Icon name="alert" size={18} color={colors.fg} />
      <Text style={{ flex: 1, fontSize: 13, lineHeight: 19, color: colors.fg }}>
        Ne donne jamais ce code par téléphone ou par message : aucun agent ne te le demandera.
      </Text>
    </View>
  );
}
