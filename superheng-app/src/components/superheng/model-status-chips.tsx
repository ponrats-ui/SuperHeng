import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import type { ModelStatus } from '@/data/mock';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useTranslation, type TranslationKey } from '@/lib/i18n';

/**
 * Translation **keys** for the backend's machine-readable `reason` codes.
 *
 * The backend sends codes (`insufficient_support`), never prose, so this map is a
 * lookup into the dictionary rather than a copy table — which is why adding a
 * language costs nothing here. Kept short because the wording sits on the chip
 * face; the full measured sentence is always available one tap away.
 */
export const MODEL_REASON_TAGS: Record<string, TranslationKey> = {
  applied: 'models.applied',
  weighted_zero: 'models.weightedZero',
  insufficient_support: 'models.insufficientSupport',
  not_in_blend: 'models.notInBlend',
  no_observed_transition: 'models.noObservedTransition',
  no_arima_fit: 'models.noArimaFit',
  not_reported: 'models.notReported',
};

/** The four model keys, mapped to their short chip labels. */
const MODEL_SHORT_KEYS: Record<string, TranslationKey> = {
  frequency: 'models.frequencyShort',
  markov: 'models.markovShort',
  timeseries: 'models.timeseriesShort',
  montecarlo: 'models.montecarloShort',
};

export type ModelStatusChipsProps = {
  /** All four models, active or neutral. Empty renders nothing at all. */
  statuses?: readonly ModelStatus[];
};

/**
 * Four compact model badges for one pick, so a skipped model is visible rather
 * than hidden.
 *
 * Two states, distinguished by **shape as well as colour** — a filled gold dot
 * for `active`, a hollow muted ring for `neutral` — because colour alone is not
 * a distinction every reader has (and a grey chip that is only grey says
 * nothing about *why*).
 *
 * Tapping a chip opens its measured explanation inline. That is the
 * cross-platform stand-in for a tooltip: hover does not exist on a phone, and
 * this way the reason is reachable, screen-reader labelled, and does not need a
 * popover.
 */
export function ModelStatusChips({ statuses }: ModelStatusChipsProps) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [openKey, setOpenKey] = useState<string | null>(null);

  if (!statuses || statuses.length === 0) return null;

  const open = statuses.find((status) => status.key === openKey) ?? null;

  /**
   * Short label for one chip: the localised model name, never the server's.
   *
   * `status.label` stays the fallback so a model the app does not know about yet
   * still shows *something* (the backend's own name) instead of a dictionary key.
   */
  const chipLabel = (key: string, fallback: string) => {
    const short = MODEL_SHORT_KEYS[key];
    return short ? t(short) : fallback;
  };

  /** The reason code as human wording, in the current language. */
  const reasonTag = (reason: string, fallbackKey: TranslationKey) =>
    t(MODEL_REASON_TAGS[reason] ?? fallbackKey);

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {statuses.map((status) => {
          const active = status.status === 'active';
          const expanded = status.key === openKey;

          return (
            <Pressable
              key={status.key}
              onPress={() => setOpenKey(expanded ? null : status.key)}
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              accessibilityLabel={t('models.chipA11y', {
                label: chipLabel(status.key, status.label),
                state: active
                  ? t('models.stateActive')
                  : t('models.neutralReason', {
                      reason: reasonTag(status.reason, 'models.skipped'),
                    }),
                detail: status.detail,
              })}
              style={[
                styles.chip,
                {
                  backgroundColor: active ? `${colors.gold}1F` : colors.backgroundElement,
                  borderColor: expanded
                    ? colors.primary
                    : active
                      ? `${colors.gold}66`
                      : colors.cardBorder,
                },
              ]}>
              <View
                style={[
                  styles.dot,
                  active
                    ? { backgroundColor: colors.gold }
                    : { borderWidth: 1, borderColor: colors.textMuted },
                ]}
              />
              <ThemedText
                type="small"
                style={[styles.chipText, { color: active ? colors.accent : colors.textMuted }]}>
                {chipLabel(status.key, status.label)}
              </ThemedText>
            </Pressable>
          );
        })}
      </View>

      {open ? (
        <ThemedText type="small" themeColor="textMuted" style={styles.detail}>
          <ThemedText
            type="small"
            style={[
              styles.detailTag,
              { color: open.status === 'active' ? colors.accent : colors.textSecondary },
            ]}>
            {open.status === 'active'
              ? t('models.activeTag', {
                  label: chipLabel(open.key, open.label),
                  percent: Math.round(open.weight * 100),
                })
              : t('models.neutralTag', {
                  label: chipLabel(open.key, open.label),
                  reason: reasonTag(open.reason, 'models.neutral'),
                })}
          </ThemedText>
          {/* Punctuation between the tag and the measured sentence, not language. */}
          {` — ${open.detail}`}
        </ThemedText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.one,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.one + 2,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingVertical: 1,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  chipText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  detail: {
    fontSize: 11,
    lineHeight: 16,
  },
  detailTag: {
    fontSize: 11,
    fontWeight: '700',
  },
});
