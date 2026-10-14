import { StyleSheet, View } from 'react-native';

import { Card, ModalScaffold } from '@/components/superheng';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useTranslation, type TranslationKey } from '@/lib/i18n';

/**
 * The four models the ensemble actually runs.
 *
 * Names deliberately match the engine labels on the dashboard's model panel so
 * the explainer and the product tell the same story. Both the name and the
 * description are translation keys, so switching language re-renders the list in
 * place — the copy itself used to be a Thai paragraph with English model names
 * inside it.
 */
const MODELS: readonly {
  key: string;
  emoji: string;
  nameKey: TranslationKey;
  bodyKey: TranslationKey;
}[] = [
  {
    key: 'time-series',
    emoji: '📈',
    nameKey: 'about.modelTimeseriesName',
    bodyKey: 'about.modelTimeseriesBody',
  },
  {
    key: 'markov-chains',
    emoji: '🔗',
    nameKey: 'about.modelMarkovName',
    bodyKey: 'about.modelMarkovBody',
  },
  {
    key: 'monte-carlo',
    emoji: '🎲',
    nameKey: 'about.modelMontecarloName',
    bodyKey: 'about.modelMontecarloBody',
  },
  {
    key: 'deep-learning',
    emoji: '🧠',
    nameKey: 'about.modelLstmName',
    bodyKey: 'about.modelLstmBody',
  },
];

/**
 * "How SuperHeng works" explainer.
 *
 * Presented as a modal from the dashboard header. Native platforms get a real
 * modal (swipe down to dismiss); web renders it as a `transparentModal` overlay
 * with a tappable backdrop, because Expo Router renders `modal` as a plain
 * stack route on web.
 */
export default function AboutScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();

  const content = (
    <>
      <View style={styles.titleBlock}>
        <ThemedText style={styles.titleEmoji}>💡</ThemedText>
        <View style={styles.titleText}>
          <ThemedText style={styles.title}>{t('about.title')}</ThemedText>
        </View>
      </View>

      <Card>
        <ThemedText style={styles.intro}>{t('about.intro')}</ThemedText>

        <View style={styles.list}>
          {MODELS.map((model) => (
            <View key={model.key} style={styles.listItem}>
              <View style={[styles.divider, { backgroundColor: colors.cardBorder }]} />
              <View style={styles.modelHead}>
                <ThemedText style={styles.modelEmoji}>{model.emoji}</ThemedText>
                <ThemedText style={styles.modelName}>{t(model.nameKey)}</ThemedText>
              </View>
              <ThemedText style={styles.modelBody}>{t(model.bodyKey)}</ThemedText>
            </View>
          ))}
        </View>
      </Card>

      <View
        style={[
          styles.note,
          { backgroundColor: colors.backgroundElement, borderColor: colors.warning },
        ]}>
        <ThemedText style={styles.noteEmoji}>⚠️</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.noteText}>
          {t('about.disclaimer')}
        </ThemedText>
      </View>

      <ThemedText type="small" themeColor="textMuted" style={styles.copyright}>
        {t('about.copyright')}
      </ThemedText>
    </>
  );

  return <ModalScaffold eyebrow={t('about.eyebrow')}>{content}</ModalScaffold>;
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
    // Thai stacks tone marks above and vowel marks below the baseline, so the
    // default line box clips them; this needs a taller line height than Latin.
    // English copy inherits the extra height harmlessly.
    fontSize: 20,
    lineHeight: 34,
    fontWeight: '800',
  },

  // Model list ------------------------------------------------------------
  intro: {
    fontSize: 14,
    lineHeight: 26,
  },
  list: {
    marginTop: Spacing.three,
    gap: Spacing.three,
  },
  listItem: {
    gap: Spacing.two,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  modelHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two + 2,
  },
  modelEmoji: {
    fontSize: 18,
    lineHeight: 28,
  },
  modelName: {
    // Bold label for each algorithm; `flex: 1` keeps long names wrapping
    // inside the row instead of pushing past the card edge.
    flex: 1,
    fontSize: 15,
    lineHeight: 28,
    fontWeight: '700',
  },
  modelBody: {
    fontSize: 14,
    lineHeight: 26,
  },

  // Disclaimer ------------------------------------------------------------
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  noteEmoji: {
    fontSize: 14,
    lineHeight: 22,
  },
  noteText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 22,
  },
  copyright: {
    // Muted legal footer. Line height stays tall enough that Thai tone marks
    // are not clipped at this small size.
    fontSize: 11,
    lineHeight: 22,
    textAlign: 'center',
    paddingHorizontal: Spacing.two,
  },
});
