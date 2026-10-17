import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useActiveUsers } from '@/hooks/use-active-users';
import { useAppTheme } from '@/hooks/use-app-theme';
import { formatCount } from '@/lib/format';
import { useTranslation } from '@/lib/i18n';

/** One full "heartbeat": the halo expands and fades, then the next begins. */
const PULSE_MS = 1900;

/**
 * Live "N people are here" pill, for the header.
 *
 * Placement and restraint are deliberate. It sits under the wordmark rather than in
 * the header's right-hand cluster, which already holds the connection badge, the
 * info button and the language switch — a fourth item there wraps or squeezes on a
 * 390pt phone. Under the header it is the first thing read after the brand, which is
 * what social proof is for.
 *
 * Colours come from the theme rather than literal Tailwind values: `textSecondary`
 * is the slate-400 equivalent that already matches the rest of the UI, and the
 * dot uses `success` — the palette's emerald — so a future palette change does not
 * leave one component behind.
 *
 * It renders **nothing** until a real count exists (see `useActiveUsers`). A badge
 * that says "0 active users", or a spinner in its place, would be worse than the
 * absence: the point is to suggest a crowd, and neither does.
 */
export function ActiveUsersBadge() {
  const { count } = useActiveUsers();
  const { colors } = useAppTheme();
  const { t } = useTranslation();

  if (count === null) return null;

  // `formatCount` returns a string, so the dictionary's own `_one` plural rule (it
  // fires on a numeric `count === 1`) cannot see it. Singular is chosen here instead.
  const label = count === 1 ? t('presence.active_one') : t('presence.active', { count: formatCount(count) });

  return (
    <View
      accessible
      accessibilityLabel={label}
      style={[styles.badge, { backgroundColor: colors.backgroundElement }]}>
      <PulsingDot color={colors.success} />
      <ThemedText type="small" style={[styles.label, { color: colors.textSecondary }]}>
        {label}
      </ThemedText>
    </View>
  );
}

/**
 * A small dot with an expanding halo.
 *
 * Two layers, because a single animated dot cannot pulse *outward* without also
 * growing the layout: the static dot holds the position and the halo scales around
 * an absolute centre, so nothing reflows while it animates.
 *
 * Reduced motion is honoured — the dot stays solid and the halo is simply not drawn.
 * The animation is decoration; the number is the information.
 */
function PulsingDot({ color }: { color: string }) {
  const progress = useSharedValue(0);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (reducedMotion) {
      progress.value = 0;
      return;
    }

    progress.value = withRepeat(
      // Reset to 0 between beats. `withRepeat` of a lone `withTiming(1)` would
      // restart from 1 and visibly do nothing.
      withSequence(
        withTiming(1, { duration: PULSE_MS, easing: Easing.out(Easing.quad) }),
        withTiming(0, { duration: 0 })
      ),
      -1,
      false
    );

    return () => {
      cancelAnimation(progress);
    };
  }, [progress, reducedMotion]);

  const halo = useAnimatedStyle(() => ({
    opacity: 0.45 * (1 - progress.value),
    transform: [{ scale: 1 + progress.value * 1.8 }],
  }));

  return (
    <View
      style={styles.dotWrap}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      {reducedMotion ? null : (
        <Animated.View style={[styles.halo, { backgroundColor: color }, halo]} />
      )}
      <View style={[styles.dot, { backgroundColor: color }]} />
    </View>
  );
}

const DOT = 7;

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: Spacing.one + 2,
    paddingHorizontal: Spacing.two,
    paddingVertical: 3,
    borderRadius: Radius.pill,
  },
  label: {
    fontSize: 11,
    // Taller than the Latin default so Thai tone marks are not clipped.
    lineHeight: 17,
    fontWeight: '600',
    letterSpacing: 0.2,
    fontVariant: ['tabular-nums'],
  },
  dotWrap: {
    width: DOT,
    height: DOT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
  },
  halo: {
    position: 'absolute',
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
  },
});
