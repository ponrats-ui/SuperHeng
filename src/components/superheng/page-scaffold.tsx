import { ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';

export type PageScaffoldProps = {
  children: React.ReactNode;
  /** Widest content column; centers on tablets. */
  maxWidth?: number;
  contentStyle?: ViewStyle;
  /** Set false for screens that manage their own scrolling. */
  scroll?: boolean;
};

/**
 * Shared screen chrome: themed background, safe-area padding, and a centered
 * content column that stays readable on tablets.
 *
 * The scroll container itself stays a vertical column — a horizontal row is
 * added inside it — otherwise the content width is unconstrained and flex
 * children can push past the viewport on web.
 */
export function PageScaffold({
  children,
  maxWidth = MaxContentWidth,
  contentStyle,
  scroll = true,
}: PageScaffoldProps) {
  const { colors } = useAppTheme();

  const inner = (
    <View style={styles.centerRow}>
      <View style={[styles.column, { maxWidth }, contentStyle]}>{children}</View>
    </View>
  );

  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: colors.background }]}
      edges={['top', 'left', 'right']}>
      {scroll ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled">
          {inner}
        </ScrollView>
      ) : (
        <View style={[styles.content, styles.fill]}>{inner}</View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  fill: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.five,
  },
  centerRow: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
  },
  column: {
    // `flex: 1` (not `flexGrow: 1`) so the column shrinks to the viewport
    // instead of sizing to its max-content width on narrow screens.
    flex: 1,
    minWidth: 0,
    gap: Spacing.three,
    paddingTop: Spacing.two,
  },
});
