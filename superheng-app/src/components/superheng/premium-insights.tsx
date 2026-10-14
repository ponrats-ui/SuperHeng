import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { ProbabilityBar } from '@/components/superheng/probability-bar';
import { SegmentedControl } from '@/components/superheng/segmented-control';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';
import {
  LOTTERY_TYPES,
  POSITION_KEYS,
  getPremiumInsights,
  isApiError,
  type LotteryType,
  type PositionalDigit,
  type PositionalEstimate,
  type PositionKey,
  type PremiumInsights,
  type PredictionStatus,
} from '@/lib/api';
import { formatCount, formatLocalizedDate, formatPercent } from '@/lib/format';
import { useTranslation, type TranslationKey } from '@/lib/i18n';

/**
 * Localised name for each modelled position.
 *
 * The panel deliberately **ignores** the API's own `label` field, which is a
 * bilingual concatenation like "Thousands (หลักพัน)" — the exact mixed-language
 * string this rewrite exists to remove.
 */
const POSITION_LABEL_KEYS: Record<PositionKey, TranslationKey> = {
  hundred_thousands: 'premium.positionHundredThousands',
  ten_thousands: 'premium.positionTenThousands',
  thousands: 'premium.positionThousands',
  hundreds: 'premium.positionHundreds',
  tens: 'premium.positionTens',
  units: 'premium.positionUnits',
};

/**
 * The endpoint's `status` values as dictionary keys.
 *
 * Mapped rather than interpolated so the raw enum never reaches the screen: the
 * Thai UI used to print `Model status: limited` in English.
 */
const STATUS_KEYS: Record<string, TranslationKey> = {
  ok: 'status.ok',
  limited: 'status.limited',
  insufficient_data: 'status.insufficientData',
};

/**
 * Tab label per ledger.
 *
 * Country names rather than the ISO-ish codes the API uses, and translated: a
 * reader in Thai mode should not have to read "Laos" in Latin script to find the
 * Lao lottery. The header's TH/EN switch is a *language* control, so the tab row
 * deliberately does not reuse its two-letter faces — the same "TH" meaning two
 * different things eight pixels apart is a usability trap.
 */
const LOTTERY_LABEL_KEYS: Record<LotteryType, TranslationKey> = {
  thai: 'premium.lotteryThai',
  laos: 'premium.lotteryLaos',
  vietnam: 'premium.lotteryVietnam',
};

/**
 * Premium positional insights — every digit of the selected lottery's first prize.
 *
 * Self-contained: it owns its request, loading, error and empty states, so the
 * dashboard only has to drop it into a card. There **is** a door in front of it —
 * `PremiumGate`, while the beta runs — but it is presentation, not entitlement:
 * this component still calls `/api/predict/premium` directly and that endpoint is
 * unauthenticated, so treat the panel as public until the API enforces access.
 *
 * Three states are rendered for the three outcomes the endpoint can produce:
 * a genuine failure (`ApiError`), an empty/thin ledger (`insufficient_data` /
 * `limited`), and a populated ranking. An empty ledger is a success, so it gets
 * an empty state rather than the error card.
 *
 * The country tabs at the top swap the *data source*, not the layout: every state
 * below them is the same markup for Thai, Lao and Vietnamese history, because the
 * marginal-vs-conditional maths does not depend on which lottery the draws came
 * from. A country with no ingested history therefore shows the ordinary empty
 * state rather than a special case.
 *
 * One thing does differ, and it is honest rather than cosmetic: Vietnam's special
 * prize is five digits, so its response carries five positions and the panel draws
 * five. `positions` is keyed by name and parsed as a partial record, so an absent
 * position is a row that is not rendered — never a zero padded in to make the
 * country look like Thailand.
 */
export function PremiumInsightsPanel() {
  const { colors } = useAppTheme();
  const { t, language } = useTranslation();
  const [insights, setInsights] = useState<PremiumInsights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** The selected ledger. Thai is the default because it is the seeded one. */
  const [lotteryType, setLotteryType] = useState<LotteryType>('thai');
  /**
   * True once the transport has started retrying, i.e. the first attempt did not
   * answer and the instance is probably booting. See the dashboard's LoadingCard
   * for the same distinction.
   */
  const [waking, setWaking] = useState(false);
  /** Bumped by Retry; the fetch effect keys off it. */
  const [reloadKey, setReloadKey] = useState(0);

  /**
   * The mount fetch, and every later retry — the same shape the dashboard uses
   * for `/api/predict/basic`: state is never written synchronously in the effect
   * body, and a `cancelled` flag stops a superseded response from overwriting a
   * newer one.
   */
  useEffect(() => {
    let cancelled = false;

    void getPremiumInsights(
      undefined,
      {
        onRetry: () => {
          if (cancelled) return;
          setWaking(true);
        },
      },
      lotteryType
    ).then(
      (result) => {
        if (cancelled) return;
        // Guard the tab against a server that answered with the wrong ledger. The
        // endpoint echoes the type it analysed, so a response belonging to another
        // country is refused rather than rendered: showing Thai numbers under the
        // Laos tab is precisely the failure the tabs exist to prevent. This cannot
        // normally fire — the effect refetches on every change — which is why it is
        // worth keeping as a check instead of a comment.
        if (result.lottery_type !== lotteryType) {
          setInsights(null);
          setError(t('premium.lotteryMismatch'));
          setLoading(false);
          return;
        }
        setInsights(result);
        setError(null);
        setLoading(false);
      },
      (caught: unknown) => {
        if (cancelled) return;
        setInsights(null);
        setError(
          isApiError(caught)
            ? caught.message
            : 'Something went wrong while loading premium insights.'
        );
        setLoading(false);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [reloadKey, lotteryType, t]);

  function retry() {
    setLoading(true);
    setWaking(false);
    setReloadKey((key) => key + 1);
  }

  /**
   * Switches country: clears the previous ledger's numbers and fetches the new one.
   *
   * Clearing is the point. The request takes as long as a cold server takes, and
   * leaving the old positions on screen under the new tab would attribute one
   * country's posterior to another. Nothing is cached between tabs because a
   * country's analysis is cheap to recompute and a stale one is worse than a
   * spinner.
   */
  function selectType(next: LotteryType) {
    if (next === lotteryType) return;
    setInsights(null);
    setError(null);
    setWaking(false);
    setLoading(true);
    setLotteryType(next);
  }

  /**
   * The country switcher, rendered above every state.
   *
   * Above *every* state, including the error one: a fetch failure must not strand
   * the reader on the tab that failed, or a country whose ledger is empty would be
   * a one-way door.
   */
  const tabs = (
    <View accessibilityRole="tablist" accessibilityLabel={t('premium.lotteryFilter')}>
      <SegmentedControl
        options={LOTTERY_TYPES.map((kind) => ({
          key: kind,
          label: t(LOTTERY_LABEL_KEYS[kind]),
        }))}
        value={lotteryType}
        onChange={selectType}
      />
    </View>
  );

  if (loading) {
    return (
      <View style={styles.container}>
        {tabs}
        <View style={styles.stateBody}>
          <ActivityIndicator color={colors.primary} />
          <ThemedText type="small" themeColor="textSecondary" style={styles.stateText}>
            {waking ? t('premium.analysisWaking') : t('premium.analysisLoading')}
          </ThemedText>
        </View>
      </View>
    );
  }

  if (error || !insights) {
    return (
      <View style={styles.container}>
        {tabs}
        <View style={styles.errorWrap}>
          <View style={styles.errHeader}>
            <View style={[styles.errRule, { backgroundColor: colors.danger }]} />
            <ThemedText type="smallBold" style={[styles.errTitle, { color: colors.danger }]}>
              {t('premium.loadFailed')}
            </ThemedText>
          </View>
          <ThemedText type="small" themeColor="textSecondary" style={styles.errBody}>
            {error ?? t('premium.unknownError')}
          </ThemedText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.retry')}
            onPress={retry}
            style={({ pressed }) => [
              styles.retry,
              { backgroundColor: colors.primary },
              pressed && styles.pressed,
            ]}>
            <ThemedText
              type="smallBold"
              style={[styles.retryText, { color: colors.onPrimary }]}>
              {t('common.retry')}
            </ThemedText>
          </Pressable>
        </View>
      </View>
    );
  }

  const positions = POSITION_KEYS.map((key) => insights.positions[key]).filter(
    (estimate): estimate is PositionalEstimate => estimate !== undefined
  );

  return (
    <View style={styles.container}>
      {tabs}

      <View style={styles.metaRow}>
        <StatusPill status={insights.status} />
        <ThemedText type="small" themeColor="textMuted" style={styles.metaText}>
          {insights.latest_draw
            ? t('premium.metaRow', {
                count: formatCount(insights.draws_analyzed),
                prize: insights.latest_draw.first_prize,
                date: formatLocalizedDate(insights.latest_draw.draw_date, language),
              })
            : t('common.draws', { count: insights.draws_analyzed })}
        </ThemedText>
      </View>

      {insights.warnings.length > 0 ? (
        <View
          style={[
            styles.warnBox,
            { borderColor: `${colors.warning}55`, backgroundColor: `${colors.warning}14` },
          ]}>
          {insights.warnings.map((warning) => (
            <ThemedText
              key={warning}
              type="small"
              themeColor="textSecondary"
              style={styles.warnItem}>
              • {warning}
            </ThemedText>
          ))}
        </View>
      ) : null}

      {positions.length === 0 ? (
        <View style={styles.emptyBox}>
          <ThemedText type="small" themeColor="textSecondary" style={styles.emptyText}>
            {t('premium.emptyState')}
          </ThemedText>
        </View>
      ) : (
        positions.map((estimate, index) => (
          <PositionBlock key={estimate.name} estimate={estimate} first={index === 0} />
        ))
      )}

      {insights.methodology ? (
        <ThemedText type="small" themeColor="textMuted" style={styles.methodology}>
          {insights.methodology}
        </ThemedText>
      ) : null}
    </View>
  );
}

/** Small status pill mirroring the endpoint's `status` field. */
function StatusPill({ status }: { status: PredictionStatus }) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const tone =
    status === 'ok' ? colors.success : status === 'limited' ? colors.warning : colors.neutral;
  const label = t(STATUS_KEYS[status] ?? 'status.insufficientData');

  return (
    <View style={[styles.statusPill, { borderColor: tone }]}>
      <ThemedText type="small" style={[styles.statusText, { color: tone }]}>
        {label}
      </ThemedText>
    </View>
  );
}

/**
 * One position: its name, the conditioning context, and the top-3 digits.
 *
 * The two probabilities on each row are deliberately different quantities and
 * both are shown — `formatPercent(probability)` is the posterior this pick ranked
 * on, and the `x… vs marginal` line is the lift over the digit's overall rate, so
 * a genuinely elevated digit is distinguishable from one that is merely common.
 *
 * The leading digit has no conditioning context at all, so its bridge says so
 * rather than printing a state it never had.
 */
function PositionBlock({ estimate, first }: { estimate: PositionalEstimate; first: boolean }) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const label = t(POSITION_LABEL_KEYS[estimate.name]);
  const bridge =
    estimate.conditioned_on === null
      ? t('premium.leadingDigit')
      : estimate.conditioned_digit
        ? t('premium.givenState', {
            // The position it conditions on is named in the reader's language, not
            // in the backend's snake_case key.
            position: t(POSITION_LABEL_KEYS[estimate.conditioned_on]),
            digit: estimate.conditioned_digit,
          })
        : t('premium.marginalOnly');

  /**
   * The pill reports the basis the *ranking* used, which is not the same question
   * as `usable`. The leading digit is usable but ranks on its marginal, so reading
   * that as "CONDITIONAL" would overstate it; a conditioned position that fell back
   * to the marginal is labelled separately from one that never had a choice.
   */
  const basisLabel =
    estimate.basis === 'conditional'
      ? t('premium.basisConditional')
      : estimate.usable
        ? t('premium.basisMarginal')
        : t('premium.basisThinRow');
  const basisTone =
    estimate.basis === 'conditional'
      ? colors.success
      : estimate.usable
        ? colors.textMuted
        : colors.warning;
  const basisBackground =
    estimate.basis === 'conditional'
      ? `${colors.success}22`
      : estimate.usable
        ? colors.backgroundElement
        : `${colors.warning}1A`;

  return (
    <View
      style={[
        styles.block,
        !first && {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.cardBorder,
        },
      ]}>
      <View style={styles.blockHead}>
        <View
          style={[
            styles.posPill,
            { borderColor: `${colors.gold}80`, backgroundColor: `${colors.gold}14` },
          ]}>
          <ThemedText type="small" style={[styles.posPillText, { color: colors.accent }]}>
            {label}
          </ThemedText>
        </View>
        <View style={[styles.basisPill, { backgroundColor: basisBackground }]}>
          <ThemedText type="small" style={[styles.basisText, { color: basisTone }]}>
            {basisLabel}
          </ThemedText>
        </View>
      </View>

      <ThemedText type="small" themeColor="textMuted" style={styles.bridge}>
        {bridge} · {t('common.draws', { count: estimate.support })}
      </ThemedText>

      <View style={styles.picks}>
        {estimate.top.map((entry, index) => (
          <PickRow key={entry.digit} entry={entry} rank={index} />
        ))}
      </View>
    </View>
  );
}

/** One recommended digit, with its probability meter and the model's reason. */
function PickRow({ entry, rank }: { entry: PositionalDigit; rank: number }) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const percent = entry.probability * 100;
  const highlight = rank === 0;

  return (
    <View style={styles.pick}>
      <View
        style={[
          styles.digitBox,
          {
            borderColor: highlight ? `${colors.gold}99` : colors.cardBorder,
            backgroundColor: highlight ? `${colors.gold}1A` : colors.backgroundElement,
          },
        ]}>
        <ThemedText style={[styles.digit, { color: highlight ? colors.accent : colors.text }]}>
          {entry.digit}
        </ThemedText>
      </View>

      <View style={styles.pickBody}>
        <View style={styles.pickHead}>
          <ThemedText style={styles.percent}>{formatPercent(entry.probability)}</ThemedText>
          <ThemedText type="small" themeColor="textMuted" style={styles.lift}>
            {t('premium.vsMarginal', {
              lift: entry.lift.toFixed(2),
              count: formatCount(entry.count),
              support: formatCount(entry.support),
            })}
          </ThemedText>
        </View>

        <ProbabilityBar
          value={percent}
          height={6}
          color={highlight ? colors.accent : colors.primary}
        />

        <ThemedText type="small" themeColor="textMuted" style={styles.reason}>
          {entry.reason}
        </ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    flexWrap: 'wrap',
  },
  metaText: {
    fontSize: 11,
    flexShrink: 1,
  },
  statusPill: {
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
  },

  // Warnings + empty state ------------------------------------------------
  warnBox: {
    padding: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.one,
  },
  warnItem: {
    fontSize: 11,
    lineHeight: 16,
  },
  emptyBox: {
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 12,
    lineHeight: 20,
    textAlign: 'center',
  },
  methodology: {
    fontSize: 10,
    lineHeight: 16,
    marginTop: Spacing.one,
  },

  // Position block --------------------------------------------------------
  block: {
    gap: Spacing.two,
    paddingTop: Spacing.three,
  },
  blockHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  posPill: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  posPillText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  basisPill: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: Radius.pill,
  },
  basisText: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  bridge: {
    fontSize: 11,
  },
  picks: {
    gap: Spacing.three,
  },

  // One pick --------------------------------------------------------------
  pick: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  digitBox: {
    width: 44,
    height: 48,
    borderRadius: Radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  digit: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  pickBody: {
    flex: 1,
    gap: Spacing.one,
  },
  pickHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  percent: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  lift: {
    fontSize: 10,
    flexShrink: 1,
    textAlign: 'right',
  },
  reason: {
    fontSize: 11,
    lineHeight: 16,
  },

  // Load / error ----------------------------------------------------------
  stateBody: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.four,
  },
  stateText: {
    fontSize: 13,
    lineHeight: 22,
  },
  errorWrap: {
    paddingTop: Spacing.two,
  },
  errHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  errRule: {
    width: 3,
    height: 14,
    borderRadius: 2,
  },
  errTitle: {
    letterSpacing: 0.4,
  },
  errBody: {
    fontSize: 12,
    lineHeight: 20,
    marginTop: Spacing.two,
  },
  retry: {
    alignSelf: 'flex-start',
    marginTop: Spacing.three,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    borderRadius: Radius.pill,
  },
  retryText: {
    fontSize: 13,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.7,
  },
});
