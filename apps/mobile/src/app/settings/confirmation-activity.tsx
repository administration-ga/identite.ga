import React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useConvexAuth, useQuery } from 'convex/react';
import { Text } from '@/design/text';
import { useIdnTheme } from '@/design/theme';
import { AppBar } from '@/design/components/app-bar';
import { Screen } from '@/design/components/screen';
import { Card, Note, Row, type RowTone } from '@/design/components/list';
import { api } from '@/lib/api';
import { formatWhen, historyStatusLabel, type ConfirmationKind, type ConfirmationStatus } from '@/lib/confirmation';

const KIND_TITLE: Record<ConfirmationKind, string> = {
  enroll: 'Activation',
  login: 'Connexion',
  sensitive: 'Action sensible',
};

function visual(status: ConfirmationStatus): { icon: 'checkCir' | 'circleX' | 'ban' | 'clock'; tone: RowTone } {
  switch (status) {
    case 'approved':
      return { icon: 'checkCir', tone: 'green' };
    case 'wrong_number':
      return { icon: 'circleX', tone: 'red' };
    case 'denied':
      return { icon: 'ban', tone: 'red' };
    default:
      return { icon: 'clock', tone: 'neutral' };
  }
}

/** Les 30 dernières demandes tranchées : acceptées, refusées ou échues. */
export default function ConfirmationActivity() {
  const t = useIdnTheme();
  const router = useRouter();
  const { isAuthenticated } = useConvexAuth();
  const history = useQuery(api.partnerMfa.requests.myHistory, isAuthenticated ? {} : 'skip');
  const now = Date.now();

  return (
    <Screen header={<AppBar title="Activité de confirmation" onBack={() => router.back()} />}>
      {history === undefined ? (
        <Text style={{ marginTop: 24, fontSize: 14, color: t.muted, textAlign: 'center' }}>Chargement…</Text>
      ) : history.length === 0 ? (
        <Note>Aucune demande de confirmation pour l’instant. Elles apparaîtront ici une fois traitées.</Note>
      ) : (
        <View style={{ gap: 12, paddingTop: 6 }}>
          <Card>
            {history.map((entry) => {
              const { icon, tone } = visual(entry.status);
              return (
                <Row
                  key={entry.id}
                  icon={icon}
                  tone={tone}
                  title={`${entry.clientName} · ${KIND_TITLE[entry.kind]}`}
                  sub={`${historyStatusLabel(entry.status)} · ${formatWhen(entry.decidedAt ?? entry.createdAt, now)}`}
                />
              );
            })}
          </Card>
          <Note style={{ marginTop: 4 }}>
            Une demande refusée ou non reconnue peut signaler que quelqu’un tente de se connecter à ta place.
          </Note>
        </View>
      )}
    </Screen>
  );
}
