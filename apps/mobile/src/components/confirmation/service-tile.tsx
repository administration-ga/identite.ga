import React from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { Text } from '@/design/text';
import { useIdnTheme } from '@/design/theme';
import { clientInitial } from '@/lib/confirmation';

/**
 * Tuile du service partenaire : son icône s'il en publie une, sinon son initiale
 * sur fond vert. Le nom reste toujours lisible à côté dans les écrans.
 */
export function ServiceTile({ name, icon, size = 44 }: { name: string; icon?: string | null; size?: number }) {
  const t = useIdnTheme();
  const radius = Math.round(size * 0.27);
  if (icon) {
    return (
      <Image
        source={{ uri: icon }}
        accessibilityLabel={name}
        style={{ width: size, height: size, borderRadius: radius, backgroundColor: t.surface2 }}
        contentFit="cover"
      />
    );
  }
  return (
    <View
      accessible
      accessibilityLabel={name}
      style={{ width: size, height: size, borderRadius: radius, backgroundColor: t.green, alignItems: 'center', justifyContent: 'center' }}
    >
      <Text style={{ color: '#fff', fontSize: Math.round(size * 0.42), fontWeight: '600' }}>{clientInitial(name)}</Text>
    </View>
  );
}
