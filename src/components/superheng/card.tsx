import { StyleSheet, View, type ViewProps } from 'react-native';

import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';

export type CardProps = ViewProps & {
  /** Adds the default inner padding. Set false for full-bleed content. */
  padded?: boolean;
};

/** Elevated surface used for every panel in SuperHeng. */
export function Card({ style, padded = true, children, ...rest }: CardProps) {
  const { colors } = useAppTheme();

  return (
    <View
      {...rest}
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.cardBorder },
        padded && styles.padded,
        style,
      ]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
  padded: {
    padding: Spacing.three,
  },
});
