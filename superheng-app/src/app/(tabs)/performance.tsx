import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { AppHeader, Card, PageScaffold, SectionHeader, StatTile } from '@/components/superheng';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { LATEST_RESULT, PERFORMANCE_SUMMARY, PRIZE_TIERS, SCORECARD } from '@/data/mock';
import { useAppTheme } from '@/hooks/use-app-theme';
import { formatDate, formatPercent } from '@/lib/format';

type CheckResult = { label: string; amount: string; note: string } | null;

/** Mock prize lookup against the latest published result. */
function checkTicket(input: string): CheckResult {
  const digits = input.replace(/\D/g, '');
  if (!digits) return null;

  if (digits === LATEST_RESULT.first) {
    return { ...PRIZE_TIERS[0], note: 'Exact 1st prize match' };
  }
  if (digits === LATEST_RESULT.second) {
    return { ...PRIZE_TIERS[1], note: 'Exact 2nd prize match' };
  }
  if (digits === LATEST_RESULT.third) {
    return { ...PRIZE_TIERS[2], note: 'Exact 3rd prize match' };
  }
  if (digits.length >= 2 && digits.endsWith(LATEST_RESULT.third)) {
    return { ...PRIZE_TIERS[2], note: 'Trailing pair matches 3rd prize' };
  }
  return null;
}

export default function PerformanceScreen() {
  const { colors } = useAppTheme();
  const [ticket, setTicket] = useState('');
  const [result, setResult] = useState<CheckResult>(null);
  const [checked, setChecked] = useState(false);

  const onCheck = () => {
    setResult(checkTicket(ticket));
    setChecked(true);
  };

  return (
    <PageScaffold>
      <AppHeader subtitle="Performance & transparency" />

      {/* Accuracy summary */}
      <Card>
        <SectionHeader title="AI scorecard" subtitle={`Across ${PERFORMANCE_SUMMARY.totalPredictions} published predictions`} />
        <View style={styles.tiles}>
          <StatTile
            label="Hit rate"
            value={formatPercent(PERFORMANCE_SUMMARY.hitRate)}
            hint="Exact number hit"
            color={colors.success}
          />
          <StatTile
            label="Top-5 rate"
            value={formatPercent(PERFORMANCE_SUMMARY.top5Rate)}
            hint="Hit inside top 5"
            color={colors.gold}
          />
          <StatTile label="Predictions" value={`${PERFORMANCE_SUMMARY.totalPredictions}`} hint="Published" />
          <StatTile label="Best streak" value={`${PERFORMANCE_SUMMARY.longestStreak}`} hint="Consecutive hits" />
        </View>
      </Card>

      {/* Prize checker */}
      <Card>
        <SectionHeader title="Prize checker" subtitle={`Latest result · ${formatDate(LATEST_RESULT.date)}`} />
        <View style={styles.inputRow}>
          <TextInput
            value={ticket}
            onChangeText={(text) => setTicket(text.replace(/\D/g, '').slice(0, 6))}
            onSubmitEditing={onCheck}
            placeholder="Enter ticket number"
            placeholderTextColor={colors.textMuted}
            keyboardType="number-pad"
            maxLength={6}
            returnKeyType="search"
            accessibilityLabel="Ticket number"
            style={[
              styles.input,
              { color: colors.text, backgroundColor: colors.backgroundElement, borderColor: colors.cardBorder },
            ]}
          />
          <Pressable
            onPress={onCheck}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
            ]}>
            <ThemedText style={[styles.buttonText, { color: colors.onPrimary }]}>Check</ThemedText>
          </Pressable>
        </View>

        {checked ? (
          <View
            style={[
              styles.result,
              {
                backgroundColor: result ? `${colors.success}1A` : colors.backgroundElement,
                borderColor: result ? `${colors.success}66` : colors.cardBorder,
              },
            ]}>
            <ThemedText type="smallBold" style={result ? { color: colors.success } : undefined}>
              {result ? `Winner — ${result.label}` : 'No prize for this draw'}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.resultNote}>
              {result ? `${result.amount} · ${result.note}` : 'The number did not match any prize tier.'}
            </ThemedText>
          </View>
        ) : null}

        <View style={styles.tiers}>
          {PRIZE_TIERS.map((tier) => (
            <View key={tier.label} style={[styles.tierRow, { borderTopColor: colors.cardBorder }]}>
              <ThemedText type="small" themeColor="textSecondary" style={styles.tierMatch}>
                {tier.match}
              </ThemedText>
              <ThemedText type="smallBold">{tier.label}</ThemedText>
              <ThemedText type="smallBold" style={[styles.tierAmount, { color: colors.gold }]}>
                {tier.amount}
              </ThemedText>
            </View>
          ))}
        </View>
      </Card>

      {/* Prediction history */}
      <Card>
        <SectionHeader title="Prediction history" subtitle="Published picks vs. actual results" />
        <View style={styles.history}>
          {SCORECARD.map((entry) => {
            const hit = entry.hits > 0;
            return (
              <View key={entry.id} style={[styles.historyRow, { borderTopColor: colors.cardBorder }]}>
                <View style={styles.historyLeft}>
                  <ThemedText type="small" themeColor="textMuted" style={styles.historyDate}>
                    {formatDate(entry.date)}
                  </ThemedText>
                  <View style={styles.picks}>
                    {entry.predicted.map((pick) => (
                      <View
                        key={pick}
                        style={[
                          styles.pick,
                          {
                            backgroundColor:
                              pick === entry.actual ? `${colors.success}22` : colors.backgroundElement,
                          },
                        ]}>
                        <ThemedText type="small" style={styles.pickText}>
                          {pick}
                        </ThemedText>
                      </View>
                    ))}
                  </View>
                </View>

                <View style={styles.historyRight}>
                  <ThemedText type="small" themeColor="textMuted" style={styles.actualLabel}>
                    ACTUAL
                  </ThemedText>
                  <ThemedText type="smallBold" style={styles.actualValue}>
                    {entry.actual}
                  </ThemedText>
                  <View
                    style={[
                      styles.hitBadge,
                      { backgroundColor: hit ? `${colors.success}22` : `${colors.danger}22` },
                    ]}>
                    <ThemedText
                      type="small"
                      style={[styles.hitText, { color: hit ? colors.success : colors.danger }]}>
                      {hit ? 'HIT' : 'MISS'}
                    </ThemedText>
                  </View>
                </View>
              </View>
            );
          })}
        </View>
        <ThemedText type="small" themeColor="textMuted" style={styles.scorecardNote}>
          Scorecard is append-only: every prediction is published before the draw and never edited
          afterwards.
        </ThemedText>
      </Card>
    </PageScaffold>
  );
}

const styles = StyleSheet.create({
  tiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  inputRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  input: {
    flex: 1,
    // See my-number: keeps the field from overflowing its row on web.
    minWidth: 0,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 3,
    fontVariant: ['tabular-nums'],
  },
  button: {
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
    borderRadius: Radius.md,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '800',
  },
  result: {
    marginTop: Spacing.three,
    padding: Spacing.three,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  resultNote: {
    lineHeight: 18,
  },
  tiers: {
    marginTop: Spacing.three,
  },
  tierRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tierMatch: {
    flex: 1,
  },
  tierAmount: {
    fontVariant: ['tabular-nums'],
  },
  history: {
    marginTop: Spacing.two,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
    paddingVertical: Spacing.three,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  historyLeft: {
    flex: 1,
    gap: Spacing.one,
  },
  historyDate: {
    fontSize: 11,
  },
  picks: {
    flexDirection: 'row',
    gap: Spacing.one,
  },
  pick: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 2,
    borderRadius: Radius.sm,
  },
  pickText: {
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  historyRight: {
    alignItems: 'flex-end',
    gap: 2,
  },
  actualLabel: {
    fontSize: 9,
    letterSpacing: 0.8,
  },
  actualValue: {
    fontSize: 16,
    fontVariant: ['tabular-nums'],
  },
  hitBadge: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 1,
    borderRadius: Radius.pill,
  },
  hitText: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  scorecardNote: {
    fontSize: 10,
    lineHeight: 15,
    marginTop: Spacing.three,
  },
});
