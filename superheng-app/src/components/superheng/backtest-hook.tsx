import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { Card } from '@/components/superheng/card';
import { SectionHeader } from '@/components/superheng/section-header';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';
import {
  LOTTERY_TYPES,
  getBacktest,
  type Backtest,
  type BacktestChannel,
  type BacktestChannelReport,
  type LotteryType,
} from '@/lib/api';
import { formatP, percent } from '@/lib/backtest-format';
import { useTranslation, type TranslationKey } from '@/lib/i18n';

/** The window the hook replays — the same `draws=30` the full tab opens on. */
const HOOK_DRAWS = 30;

/** Channel preference: the first one this ledger can actually publish. */
const CHANNEL_ORDER: readonly BacktestChannel[] = ['top', 'bottom'];

const LEDGER_LABEL_KEYS: Record<LotteryType, TranslationKey> = {
  thai: 'premium.lotteryThai',
  laos: 'premium.lotteryLaos',
  vietnam: 'premium.lotteryVietnam',
};

type LedgerState =
  | { status: 'loading' }
  | { status: 'ready'; report: Backtest }
  | { status: 'failed' };

function headlineChannel(report: Backtest): BacktestChannelReport | undefined {
  return CHANNEL_ORDER.map((key) => report.channels[key]).find((row) => row?.available);
}

/**
 * The paywall hook: the backtest reduced to its three honest numbers, sitting
 * directly above the upgrade card.
 *
 * **What it is for, and what it deliberately is not.** The Founder wants this to
 * drive upgrades; the measured reality is that it cannot do that by claiming an
 * edge. On the live ledger the 2-digit model scores 0% on both Thai and Hanoi —
 * below the seeded random player — with a negative ROI and p = 1.0, and only Laos
 * clears significance (17.4% against 4.35%, p = 0.026) on 23 of 30 draws with a
 * payout assumption this project cannot verify. A card that led with "AI win rate"
 * would therefore be either cherry-picking the one flattering window or advertising
 * a 0.0%. So the pitch here is the *transparency* instead: every ledger, the random
 * player's rate on the same rows, and the p-value, published even where it does not
 * flatter the models — which is the one claim this data can actually support.
 *
 * Every rate comes from `/api/backtest`, so it is the same walk-forward replay the
 * dedicated tab shows; nothing is computed twice or summarised differently.
 *
 * **Loading is progressive on purpose.** Each ledger is its own request and fills in
 * as it answers. On live data Laos and Hanoi land in under 2.5 s while Thai takes
 * ~13 s, so awaiting all three would leave the card blank for the slowest one. The
 * card is also self-contained and non-blocking: the dashboard's own content is
 * never waiting on it.
 */
export function BacktestHook() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [reloadKey, setReloadKey] = useState(0);
  const [ledgers, setLedgers] = useState<Record<LotteryType, LedgerState>>({
    thai: { status: 'loading' },
    laos: { status: 'loading' },
    vietnam: { status: 'loading' },
  });

  useEffect(() => {
    let cancelled = false;

    // Fired together rather than in sequence: the three answer at very different
    // speeds, and a sequential loop would make the card as slow as the sum of them.
    LOTTERY_TYPES.forEach((kind) => {
      void getBacktest(kind, HOOK_DRAWS).then(
        (report) => {
          if (cancelled) return;
          setLedgers((previous) => ({ ...previous, [kind]: { status: 'ready', report } }));
        },
        () => {
          if (cancelled) return;
          setLedgers((previous) => ({ ...previous, [kind]: { status: 'failed' } }));
        }
      );
    });

    return () => {
      cancelled = true;
    };
    // No `t` here on purpose: this effect never translates anything, so depending on
    // the translator would re-fire three multi-second replays on a language toggle.
    // The messages that *are* language-dependent are translated at render time.
  }, [reloadKey]);

  function retry() {
    setLedgers({
      thai: { status: 'loading' },
      laos: { status: 'loading' },
      vietnam: { status: 'loading' },
    });
    setReloadKey((key) => key + 1);
  }

  const states = LOTTERY_TYPES.map((kind) => ledgers[kind]);
  const allFailed = states.every((state) => state.status === 'failed');

  // Taken from the payload rather than hard-coded, so a change to the server's
  // Top-K is described here without a second edit.
  const topK =
    states.find(
      (state): state is Extract<LedgerState, { status: 'ready' }> => state.status === 'ready'
    )?.report.top_k ?? 5;

  return (
    <Card>
      <SectionHeader title={t('backtest.hookTitle')} subtitle={t('backtest.hookSubtitle')} />

      {/*
        The promise, stated before the numbers. This is the position the card is
        taking, so it leads rather than being buried in a footnote under a figure
        the reader has already read as a claim.
      */}
      <ThemedText type="small" themeColor="textSecondary" style={styles.promise}>
        {t('backtest.hookPromise')}
      </ThemedText>

      {allFailed ? (
        <View style={styles.failed}>
          <ThemedText type="small" themeColor="textMuted" style={styles.failedText}>
            {t('backtest.hookFailed')}
          </ThemedText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.retry')}
            onPress={retry}
            style={({ pressed }) => [styles.retry, pressed && styles.pressed]}>
            <ThemedText type="small" style={[styles.retryText, { color: colors.accent }]}>
              {t('common.retry')}
            </ThemedText>
          </Pressable>
        </View>
      ) : (
        <>
          <ThemedText type="small" themeColor="textMuted" style={styles.caption}>
            {t('backtest.hookCaption', { count: topK })}
          </ThemedText>

          <View style={styles.rows}>
            {LOTTERY_TYPES.map((kind) => (
              <LedgerRow key={kind} kind={kind} state={ledgers[kind]} />
            ))}
          </View>
        </>
      )}

      <ThemedText type="small" themeColor="textMuted" style={styles.method}>
        {t('backtest.hookMethod')}
      </ThemedText>

      {/*
        The upgrade path this card exists to open. It points at the replay itself
        rather than at the paywall: the argument for paying is the evidence, and the
        paywall is one card further down the same screen.
      */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('backtest.hookCta')}
        onPress={() => router.push('/backtest')}
        style={({ pressed }) => [
          styles.cta,
          { borderColor: colors.gold, backgroundColor: colors.backgroundElement },
          pressed && styles.pressed,
        ]}>
        <ThemedText type="smallBold" style={[styles.ctaText, { color: colors.accent }]}>
          {t('backtest.hookCta')}
        </ThemedText>
        <ThemedText type="small" themeColor="textMuted" style={styles.ctaSub}>
          {t('backtest.hookCtaSub')}
        </ThemedText>
      </Pressable>
    </Card>
  );
}

/**
 * One ledger's summary line.
 *
 * Keeps the AI rate, the random player's rate and the p-value on the same row,
 * which is the whole reason the card works: any one of the three alone is either a
 * brag or a mystery, and the reader is entitled to see them together.
 */
function LedgerRow({ kind, state }: { kind: LotteryType; state: LedgerState }) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();

  const channel = state.status === 'ready' ? headlineChannel(state.report) : undefined;
  const significant = Boolean(channel?.skill?.top_5_significant);

  return (
    <View
      style={[
        styles.row,
        { borderColor: colors.cardBorder, backgroundColor: colors.backgroundElement },
      ]}>
      <View style={styles.rowHead}>
        <ThemedText type="smallBold" style={styles.rowName}>
          {t(LEDGER_LABEL_KEYS[kind])}
        </ThemedText>

        {state.status === 'ready' ? (
          <ThemedText type="small" themeColor="textMuted" style={styles.rowMeta}>
            {t('backtest.hookDraws', {
              done: state.report.draws_evaluated,
              requested: state.report.draws_requested,
            })}
          </ThemedText>
        ) : null}

        {/*
          The badge is the significance verdict, not a marketing label. On live data
          two of the three rows read "not significant", and that is the point — a card
          that showed only green here would be selling a different dataset.
        */}
        {channel ? (
          <View
            style={[
              styles.badge,
              {
                borderColor: significant ? `${colors.success}66` : `${colors.neutral}66`,
                backgroundColor: significant ? `${colors.success}1A` : `${colors.neutral}14`,
              },
            ]}>
            <ThemedText
              type="small"
              style={[
                styles.badgeText,
                { color: significant ? colors.success : colors.textMuted },
              ]}>
              {t(significant ? 'backtest.significant' : 'backtest.notSignificant')}
            </ThemedText>
          </View>
        ) : null}
      </View>

      {state.status === 'loading' ? (
        <View style={styles.rowState}>
          <ActivityIndicator size="small" color={colors.primary} />
          <ThemedText type="small" themeColor="textMuted" style={styles.rowStateText}>
            {t('backtest.hookLoading')}
          </ThemedText>
        </View>
      ) : null}

      {state.status === 'failed' ? (
        <ThemedText type="small" themeColor="textMuted" style={styles.rowStateText}>
          {t('backtest.hookFailed')}
        </ThemedText>
      ) : null}

      {state.status === 'ready' && !channel ? (
        <ThemedText type="small" themeColor="textMuted" style={styles.rowStateText}>
          {t('backtest.hookNoChannel')}
        </ThemedText>
      ) : null}

      {channel ? (
        <View style={styles.metrics}>
          <Metric
            label={t('backtest.aiLabel')}
            value={percent(channel.ai?.top_5_hit_rate_percent)}
            color={
              (channel.ai?.top_5_hit_rate_percent ?? 0) > 0 ? colors.accent : colors.text
            }
          />
          <Metric
            label={t('backtest.randomLabel')}
            value={percent(channel.random?.top_5_hit_rate_percent)}
          />
          <Metric
            label={t('backtest.hookP')}
            value={channel.skill ? formatP(channel.skill.top_5_p_value) : '—'}
          />
        </View>
      ) : null}
    </View>
  );
}

/** One labelled figure inside a ledger row. */
function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.metric}>
      <ThemedText type="small" themeColor="textMuted" style={styles.metricLabel}>
        {label}
      </ThemedText>
      <ThemedText style={[styles.metricValue, color ? { color } : undefined]}>
        {value}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  promise: {
    marginTop: Spacing.two,
    lineHeight: 19,
  },
  caption: {
    marginTop: Spacing.three,
    lineHeight: 17,
  },
  rows: {
    marginTop: Spacing.two,
    gap: Spacing.two,
  },
  row: {
    gap: Spacing.one,
    padding: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rowHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    flexWrap: 'wrap',
  },
  rowName: {
    flexShrink: 1,
  },
  rowMeta: {
    flex: 1,
    fontSize: 10,
    fontVariant: ['tabular-nums'],
  },
  badge: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 1,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  badgeText: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  rowState: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.half,
  },
  rowStateText: {
    fontSize: 10,
    lineHeight: 15,
  },
  metrics: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  metric: {
    flex: 1,
    gap: 1,
  },
  metricLabel: {
    fontSize: 9,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    fontWeight: '700',
  },
  metricValue: {
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  method: {
    marginTop: Spacing.three,
    fontSize: 10,
    lineHeight: 16,
  },
  cta: {
    marginTop: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  ctaText: {
    fontSize: 13,
  },
  ctaSub: {
    fontSize: 10,
    lineHeight: 15,
  },
  failed: {
    marginTop: Spacing.three,
  },
  failedText: {
    fontSize: 11,
    lineHeight: 17,
  },
  retry: {
    alignSelf: 'flex-start',
    marginTop: Spacing.one,
    paddingVertical: Spacing.one,
  },
  retryText: {
    fontSize: 11,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.7,
  },
});
