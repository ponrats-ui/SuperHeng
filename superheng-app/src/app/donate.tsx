import { Image, StyleSheet, View } from 'react-native';

import { Card, ModalScaffold } from '@/components/superheng';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useTranslation } from '@/lib/i18n';

/**
 * The bundled asset is 885x1200. Its display height is computed from that ratio
 * rather than set with `aspectRatio`, because react-native-web does not apply
 * `aspectRatio` to an `Image` — the code rendered at 220x1200 (stretched) on web
 * with only a width set.
 */
const QR_DISPLAY_WIDTH = 220;
const QR_DISPLAY_HEIGHT = Math.round((QR_DISPLAY_WIDTH * 1200) / 885);

/**
 * Voluntary tip screen.
 *
 * The QR image is rendered **only** here, never on the dashboard: the dashboard
 * shows a button that opens this modal, so a visitor is never shown payment
 * details unless they deliberately ask for them.
 */
export default function DonateScreen() {
  const { t } = useTranslation();

  return (
    <ModalScaffold eyebrow={t('donate.eyebrow')}>
      <View style={styles.titleBlock}>
        <ThemedText style={styles.titleEmoji}>☕</ThemedText>
        <View style={styles.titleText}>
          <ThemedText style={styles.title}>{t('donate.title')}</ThemedText>
        </View>
      </View>

      <Card>
        <ThemedText style={styles.thanks}>{t('donate.thanks')}</ThemedText>
      </Card>

      <Card>
        {/* White plate so the code stays scannable in dark mode. */}
        <View style={styles.qrPlate}>
          <Image
            source={require('@/assets/52677.jpg')}
            style={styles.qr}
            resizeMode="contain"
            accessibilityRole="image"
            accessibilityLabel={t('donate.qrA11y')}
          />
        </View>
        <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
          {t('donate.qrCaption')}
        </ThemedText>
      </Card>

      <ThemedText type="small" themeColor="textMuted" style={styles.note}>
        {t('donate.note')}
      </ThemedText>
    </ModalScaffold>
  );
}

const styles = StyleSheet.create({
  // Title -----------------------------------------------------------------
  titleBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  titleEmoji: {
    fontSize: 32,
    lineHeight: 40,
  },
  titleText: {
    flexShrink: 1,
    gap: 2,
  },
  title: {
    // Thai tone marks need a taller line box than Latin text at the same size;
    // the English copy inherits the extra height harmlessly.
    fontSize: 20,
    lineHeight: 34,
    fontWeight: '800',
  },

  thanks: {
    fontSize: 14,
    lineHeight: 26,
    textAlign: 'center',
  },

  // QR --------------------------------------------------------------------
  qrPlate: {
    alignItems: 'center',
    // Always white — a QR rendered on the dark card surface is hard to scan.
    backgroundColor: '#FFFFFF',
    borderRadius: Radius.lg,
    padding: Spacing.three,
  },
  qr: {
    width: QR_DISPLAY_WIDTH,
    height: QR_DISPLAY_HEIGHT,
    borderRadius: Radius.sm,
  },
  caption: {
    fontSize: 12,
    lineHeight: 22,
    textAlign: 'center',
    marginTop: Spacing.two,
  },

  note: {
    fontSize: 11,
    lineHeight: 22,
    textAlign: 'center',
    paddingHorizontal: Spacing.two,
  },
});
