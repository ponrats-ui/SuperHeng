import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { ProbabilityBar } from '@/components/superheng/probability-bar';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';
import {
  POSITION_KEYS,
  getPremiumInsights,
  isApiError,
  type PositionalDigit,
  type PositionalEstimate,
  type PremiumInsights,
  type PredictionStatus,
} from '@/lib/api';
import { formatCount, formatDate, formatPercent } from '@/lib/format';

/** Turns the backend's snake_case position key into something readable. */
function prettyPosition(name: string): string {
  return name.replace(/_/g, '-');
}

/**
 * Premium positional insights — all six digits of รางวัลที่ 1.
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
 */
export function PremiumInsightsPanel() {
  const { colors } = useAppTheme();
  const [insights, setInsights] = useState<PremiumInsights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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

    void getPremiumInsights(undefined, {
      onRetry: () => {
        if (cancelled) return;
        setWaking(true);
      },
    }).then(
      (result) => {
        if (cancelled) return;
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
  }, [reloadKey]);

  function retry() {
    setLoading(true);
    setWaking(false);
    setReloadKey((key) => key + 1);
  }

  if (loading) {
    return (
      <View style={styles.stateBody}>
        <ActivityIndicator color={colors.primary} />
        <ThemedText type="small" themeColor="textSecondary" style={styles.stateText}>
          {waking
            ? 'กำลังปลุกเซิร์ฟเวอร์… (เซิร์ฟเวอร์สลีปอยู่ อาจใช้เวลาถึง 1 นาที)'
            : 'กำลังโหลดการวิเคราะห์รายตำแหน่ง…'}
        </ThemedText>
      </View>
    );
  }

  if (error || !insights) {
    return (
      <View style={styles.errorWrap}>
        <View style={styles.errHeader}>
          <View style={[styles.errRule, { backgroundColor: colors.danger }]} />
          <ThemedText type="smallBold" style={[styles.errTitle, { color: colors.danger }]}>
            โหลด Premium insights ไม่สำเร็จ
          </ThemedText>
        </View>
        <ThemedText type="small" themeColor="textSecondary" style={styles.errBody}>
          {error ?? 'Unknown error.'}
        </ThemedText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="ลองอีกครั้ง"
          onPress={retry}
          style={({ pressed }) => [
            styles.retry,
            { backgroundColor: colors.primary },
            pressed && styles.pressed,
          ]}>
          <ThemedText type="smallBold" style={[styles.retryText, { color: colors.onPrimary }]}>
            ลองอีกครั้ง (Retry)
          </ThemedText>
        </Pressable>
      </View>
    );
  }

  const positions = POSITION_KEYS.map((key) => insights.positions[key]).filter(
    (estimate): estimate is PositionalEstimate => estimate !== undefined
  );

  return (
    <View style={styles.container}>
      <View style={styles.metaRow}>
        <StatusPill status={insights.status} />
        <ThemedText type="small" themeColor="textMuted" style={styles.metaText}>
          {formatCount(insights.draws_analyzed)} draws
          {insights.latest_draw
            ? ` · latest ${insights.latest_draw.first_prize} (${formatDate(insights.latest_draw.draw_date)})`
            : ''}
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
            ยังมีข้อมูลไม่พอสำหรับการวิเคราะห์รายตำแหน่ง — ต้องมีประวัติการออกรางวัลอย่างน้อย 5 งวด
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
  const tone =
    status === 'ok' ? colors.success : status === 'limited' ? colors.warning : colors.neutral;
  const label = status === 'ok' ? 'OK' : status === 'limited' ? 'LIMITED' : 'NO DATA';

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
  const bridge =
    estimate.conditioned_on === null
      ? 'leading digit · marginal only'
      : estimate.conditioned_digit
        ? `given ${prettyPosition(estimate.conditioned_on)} = ${estimate.conditioned_digit}`
        : 'marginal only';

  /**
   * The pill reports the basis the *ranking* used, which is not the same question
   * as `usable`. The leading digit is usable but ranks on its marginal, so reading
   * that as "CONDITIONAL" would overstate it; a conditioned position that fell back
   * to the marginal is labelled separately from one that never had a choice.
   */
  const basisLabel =
    estimate.basis === 'conditional'
      ? 'CONDITIONAL'
      : estimate.usable
        ? 'MARGINAL'
        : 'THIN ROW';
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
            {estimate.label}
          </ThemedText>
        </View>
        <View style={[styles.basisPill, { backgroundColor: basisBackground }]}>
          <ThemedText type="small" style={[styles.basisText, { color: basisTone }]}>
            {basisLabel}
          </ThemedText>
        </View>
      </View>

      <ThemedText type="small" themeColor="textMuted" style={styles.bridge}>
        {bridge} · {formatCount(estimate.support)} draws
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
            x{entry.lift.toFixed(2)} vs marginal · {formatCount(entry.count)}/
            {formatCount(entry.support)}
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
