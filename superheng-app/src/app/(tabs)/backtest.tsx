import { AppHeader, BacktestDashboard, PageScaffold } from '@/components/superheng';
import { useTranslation } from '@/lib/i18n';

/**
 * The backtest tab.
 *
 * Public on purpose: the replay is the argument for the paid tier, so it has to be
 * readable *before* paying. The panel is self-contained — it owns the ledger and
 * window switchers, the request and every state — so this screen is chrome only.
 */
export default function BacktestScreen() {
  const { t } = useTranslation();

  return (
    <PageScaffold>
      <AppHeader subtitle={t('header.backtestSubtitle')} />
      <BacktestDashboard />
    </PageScaffold>
  );
}
