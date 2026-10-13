import { router } from 'expo-router';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { HeaderIconButton } from '@/components/superheng/header-icon-button';
import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';

/**
 * Closes the current modal.
 *
 * `router.back()` restores the previous screen. On the web build a modal route
 * can also be opened cold (deep link or refresh) where there is no history to
 * pop, so fall back to the dashboard rather than stranding the user.
 */
export function closeModal() {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace('/');
}

export type ModalScaffoldProps = {
  /** Small uppercase label in the modal's fixed header. */
  eyebrow: string;
  children: React.ReactNode;
  /**
   * Optional ref to the scrolling body.
   *
   * The panel is height-capped, so content that appears *after* a tap (a
   * confirmation, an error) can land below the fold with no scroll gesture in
   * sight. Callers that reveal content on interaction use this to scroll it into
   * view instead of silently rendering it off-screen.
   */
  scrollRef?: React.Ref<ScrollView>;
};

/**
 * Shared chrome for full-screen modal routes.
 *
 * Native platforms get a real modal presentation (swipe down to dismiss); web
 * renders the route as a `transparentModal`, so this draws the dimmed backdrop
 * and a centred, height-capped panel itself. The header row stays put while the
 * body scrolls, so the close button is always reachable.
 */
export function ModalScaffold({ eyebrow, children, scrollRef }: ModalScaffoldProps) {
  const { colors } = useAppTheme();

  const closeButton = (
    <HeaderIconButton ios="xmark" android="close" label="ปิด" onPress={closeModal} />
  );

  if (Platform.OS === 'web') {
    return (
      <View style={styles.webRoot} pointerEvents="box-none">
        {/* Tapping outside the panel dismisses the overlay. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="ปิด"
          onPress={closeModal}
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }]}
        />
        <View
          style={[styles.webPanel, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
          <View style={styles.header}>
            <ThemedText type="smallBold" themeColor="textMuted" style={styles.eyebrow}>
              {eyebrow}
            </ThemedText>
            {closeButton}
          </View>
          <ScrollView
            ref={scrollRef}
            style={styles.webPanelScroll}
            contentContainerStyle={styles.webPanelBody}
            showsVerticalScrollIndicator={false}>
            {children}
          </ScrollView>
        </View>
      </View>
    );
  }

  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: colors.background }]}
      edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.header}>
        <ThemedText type="smallBold" themeColor="textMuted" style={styles.eyebrow}>
          {eyebrow}
        </ThemedText>
        {closeButton}
      </View>
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.nativeContent}
        showsVerticalScrollIndicator={false}>
        <View style={styles.centerRow}>
          <View style={[styles.column, { maxWidth: MaxContentWidth }]}>{children}</View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  eyebrow: {
    fontSize: 10,
    letterSpacing: 1.2,
    fontWeight: '700',
  },

  // Native modal chrome ---------------------------------------------------
  safe: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
  },
  scroll: {
    flex: 1,
  },
  nativeContent: {
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

  // Web overlay -----------------------------------------------------------
  webRoot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
  },
  webPanel: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '88%',
    borderRadius: Radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  webPanelScroll: {
    // Lets the scroll area shrink inside the height-capped panel.
    flexShrink: 1,
    minHeight: 0,
  },
  webPanelBody: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.four,
    gap: Spacing.three,
  },
});
