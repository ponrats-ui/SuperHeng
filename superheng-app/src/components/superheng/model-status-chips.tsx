import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { MODEL_SHORT_LABELS, type ModelStatus } from '@/data/mock';
import { useAppTheme } from '@/hooks/use-app-theme';

/**
 * Friendly wording for the backend's machine-readable `reason` codes.
 *
 * Kept short because it sits on the chip face; the full measured sentence is
 * always available one tap away.
 */
export const MODEL_REASON_TAGS: Record<string, string> = {
  applied: 'Applied',
  weighted_zero: 'Zero weight',
  insufficient_support: 'Insufficient data',
  not_in_blend: 'Not in blend',
  no_observed_transition: 'No pattern',
  no_arima_fit: 'No pattern',
  not_reported: 'Not reported',
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
  const [openKey, setOpenKey] = useState<string | null>(null);

  if (!statuses || statuses.length === 0) return null;

  const open = statuses.find((status) => status.key === openKey) ?? null;

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
              accessibilityLabel={`${status.label}: ${
                active ? 'active' : `neutral, ${MODEL_REASON_TAGS[status.reason] ?? 'skipped'}`
              }. ${status.detail}`}
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
                {MODEL_SHORT_LABELS[status.key] ?? status.label}
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
              ? `${open.label} · ${Math.round(open.weight * 100)}% weight`
              : `${open.label} · ${MODEL_REASON_TAGS[open.reason] ?? 'Neutral'}`}
          </ThemedText>
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
