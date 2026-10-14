/**
 * English strings — the **source of truth for the key set**.
 *
 * Every user-facing string lives here, in a flat `area.thing` namespace, so:
 *
 * * `TranslationKey` is the union of these keys, which means `t('...')` is
 *   typo-checked at compile time rather than failing silently at runtime;
 * * `th.ts` is typed as `Record<TranslationKey, string>`, so a key added here but
 *   forgotten in Thai is a **build error**, not an English leak into the Thai UI.
 *
 * Placeholders are `{name}` and are filled by `t(key, { name })`. A key ending in
 * `_one` is used when `params.count === 1` and the suffix exists, which is how the
 * one/other distinction is expressed without a plural-rule library — Thai has no
 * plural forms and simply omits the `_one` variants.
 *
 * `TH` in a comment marks a string whose Thai wording is a terminology decision
 * worth keeping deliberate; see the header of `th.ts` for the fixed vocabulary.
 */
export const en = {
  // ---------------------------------------------------------------------------
  // Shared
  // ---------------------------------------------------------------------------
  'common.retry': 'Retry',
  'common.loading': 'Loading…',
  'common.close': 'Close',
  'common.dismiss': 'Dismiss',
  'common.draws': '{count} draws',
  'common.draws_one': '{count} draw',
  'common.draw': 'draw',
  'common.today': 'Today',
  'common.daysAgo_one': '1 day ago',
  'common.daysAgo': '{count} days ago',
  'common.of': '{part} of {whole}',
  'common.uniform': 'uniform',
  'common.weight': '{percent}% weight',
  'common.language': 'Language',
  'common.switchToEnglish': 'Switch to English',
  'common.switchToThai': 'Switch to Thai',

  // ---------------------------------------------------------------------------
  // Navigation + headers
  // ---------------------------------------------------------------------------
  'nav.dashboard': 'Dashboard',
  'nav.myNumber': 'My Number',
  'nav.insights': 'Insights',
  'nav.performance': 'Performance',

  'header.dashboardSubtitle': 'Probability intelligence',
  'header.insightsSubtitle': 'Deep insights',
  'header.myNumberSubtitle': 'Analyse any number',
  'header.performanceSubtitle': 'Performance & transparency',
  'header.gridBadge': '00–99 GRID',

  // ---------------------------------------------------------------------------
  // Dashboard — hero + tiles
  // ---------------------------------------------------------------------------
  'dashboard.tagline': 'Decision support for every draw',
  'dashboard.drawDateLabel': 'Draw date: {date}',
  'dashboard.resetNotice':
    'The system resets and recomputes every statistic automatically after each draw, ready for the next one.',
  'dashboard.dataThrough': 'Data through {date} · {count} draws',
  'dashboard.nextDraw': 'NEXT DRAW',
  'dashboard.governmentLottery': 'Government Lottery Draw',
  'dashboard.days': 'DAYS',
  'dashboard.hrs': 'HRS',
  'dashboard.min': 'MIN',
  'dashboard.sec': 'SEC',
  'dashboard.jackpot': 'JACKPOT',
  'dashboard.drawsAnalysed': 'DRAWS ANALYSED',
  'dashboard.latestDraw': 'LATEST DRAW',
  'dashboard.aiTopPick': 'AI TOP PICK',
  'dashboard.highConfidence': 'High confidence',
  'dashboard.coldConfidence': 'No confidence',
  'dashboard.positionModelFallback': '2-digit position model',
  'dashboard.lowConfidence': 'LOW CONFIDENCE',
  'dashboard.mediumConfidence': 'MEDIUM CONFIDENCE',
  'dashboard.topPosition2Digit': '2-DIGIT · TOP POSITION',
  'dashboard.bottomPosition2Digit': '2-DIGIT · BOTTOM POSITION',
  'dashboard.hengScore': 'HENG SCORE',
  'dashboard.sampleSize': 'SAMPLE SIZE',
  'dashboard.boardState': 'BOARD STATE',
  'dashboard.markovSupport': 'MARKOV SUPPORT',
  'dashboard.frequencyLift': 'FREQUENCY LIFT',
  'dashboard.topPosition': 'Top Position',
  'dashboard.bottomPosition': 'Bottom Position',
  'dashboard.modelEnsembleTitle': 'Model ensemble',
  'dashboard.signalsFeeding': 'Signals currently feeding the prediction',
  'dashboard.dataConditions': 'Data conditions',
  'dashboard.modelStatus': 'Model status: {status}',
  'dashboard.unknownError': 'Something went wrong while loading predictions.',
  'dashboard.rankings': 'RANKINGS',
  'dashboard.rankingsSubtitle': '2-digit Top (the last 2 digits of the 1st prize) · {count} draws',
  'dashboard.rankingsSubtitleBottom': '2-digit Bottom (the last-2-digits prize) · {count} draws',
  'dashboard.transitions_one': '{count} transition',
  'dashboard.transitions': '{count} transitions',
  'dashboard.vsUniform': '{lift}× uniform',
  'dashboard.analysedState': '{label} · {count} draws analysed · state {state}',
  'dashboard.modelEnsemble': 'All four models · what feeds the {market}-position blend',
  'dashboard.marketTop': 'top',
  'dashboard.marketBottom': 'bottom',
  'dashboard.behindTheMath': 'Behind the math',
  'dashboard.barIsScore':
    "Bar length is the Heng score (0–100). The pill is the model's literal per-draw " +
    'probability, where 1.0% is the uniform baseline across 100 codes. All four model ' +
    'badges are shown on every pick — a greyed badge is a model that contributed no ' +
    'measured evidence there; tap it for the reason.',
  'dashboard.donateCta': '💸 Won something? Buy the team a coffee',
  'dashboard.donateSub': 'Support the developer',
  'dashboard.disclaimer':
    'Predictions are statistical estimates from historical draw data. No model can ' +
    'guarantee an outcome — play responsibly.',
  'dashboard.confidence': 'Confidence {percent}',

  // ---------------------------------------------------------------------------
  // Dashboard — states (loading / waking / error / empty)
  // ---------------------------------------------------------------------------
  'dashboard.waking':
    'Waking the server… (it sleeps on a free instance and can take up to a minute)',
  'dashboard.loadingPredictions': 'Loading the analysis from the server…',
  'dashboard.connectFailed': 'Could not load the data',
  'dashboard.connectFailedBody':
    'The prediction service did not answer. If you are running this locally, start the ' +
    'backend at {url} first — uvicorn main:app --reload',
  'dashboard.emptyTitle': 'Not enough data yet',
  'dashboard.emptyBody':
    'The database holds {count} draws, so the system has not produced a ranking. A ' +
    'ranking built on this little data would be a random guess, and the app does not ' +
    'show numbers it cannot stand behind.',
  'dashboard.live': 'LIVE',
  'dashboard.offline': 'OFFLINE',
  'dashboard.connecting': 'CONNECTING',
  'dashboard.wakingLabel': 'WAKING',
  // The endpoint's `status` values, as words. Shared by every screen that shows a
  // status, so the raw enum never reaches the UI (it used to print "limited" verbatim).
  'status.ok': 'OK',
  'status.limited': 'LIMITED',
  'status.insufficientData': 'NO DATA',

  // ---------------------------------------------------------------------------
  // Premium
  // ---------------------------------------------------------------------------
  'premium.title': 'Premium insights',
  // The three ledgers the panel can analyse. Country names, not codes: "TH/LA/VN"
  // would be a second abbreviation system next to the header's TH/EN language
  // switch, and the two mean completely different things.
  'premium.lotteryThai': 'Thai',
  'premium.lotteryLaos': 'Laos',
  'premium.lotteryVietnam': 'Vietnam',
  'premium.lotteryFilter': 'Choose which lottery to analyse',
  'premium.lotteryMismatch':
    'The service answered with a different lottery than the one selected — the ' +
    'ledger filter is not active on the server, so these numbers are not the ones ' +
    'you asked for.',
  'premium.subtitle': 'Bayesian positional model · 1st prize',
  'premium.modePill': '✨ PREMIUM MODE',
  'premium.loginPill': '🔒 PREMIUM LOGIN',
  'premium.unlockHint': 'Open the Premium sign-in form (password required)',
  'premium.analysisLoading': 'Loading the per-position analysis…',
  'premium.analysisWaking':
    'Waking the server… (it sleeps on a free instance and can take up to a minute)',
  'premium.loadFailed': 'Could not load the Premium insights',
  'premium.unknownError': 'Unknown error.',
  'premium.emptyState':
    'There is not enough data for a per-position analysis yet — at least 5 past draws are needed.',
  'premium.downloading': 'Downloading…',
  'premium.railTitle': 'Premium',
  'premium.railSubtitle': 'Sign in to open the positional model',
  'premium.username': 'Username',
  'premium.password': 'Password',
  'premium.signIn': 'Sign in',
  'premium.signOut': '🔒 Lock Premium mode',
  'premium.accessTitle': 'Premium Access',
  'premium.accessSubtitle':
    'Beta test of Premium mode — sign in to see the per-position analysis',
  'premium.lockedPill': '🔒 PREMIUM',
  'premium.wrongCredentials': 'That username or password is not right.',
  'premium.gateNote':
    'The beta door for the Premium panel — not account security. The numbers are served ' +
    'by a public endpoint, so treat them as public.',
  'premium.lockedTitle': 'Locked',
  'premium.lockedCta': 'Unlock to see the analysis',
  'premium.unlockWithPremium': '{title} — unlock with Premium',
  'premium.openSignInForm': 'Open the Premium sign-in form',
  'premium.basisConditional': 'CONDITIONAL',
  'premium.basisMarginal': 'MARGINAL',
  'premium.basisThinRow': 'THIN ROW',
  'premium.leadingDigit': 'leading digit · marginal only',
  'premium.marginalOnly': 'marginal only',
  'premium.givenState': 'given {position} = {digit}',
  // Pure English: the Thai place names (หลักแสน …) are one toggle away in `th.ts`, and
  // repeating them here is exactly the mixed-language string this system removes.
  'premium.positionHundredThousands': 'Hundred-thousands',
  'premium.positionTenThousands': 'Ten-thousands',
  'premium.positionThousands': 'Thousands',
  'premium.positionHundreds': 'Hundreds',
  'premium.positionTens': 'Tens',
  'premium.positionUnits': 'Units',
  'premium.vsMarginal': 'x{lift} vs marginal · {count}/{support}',
  'premium.metaRow': '{count} draws · latest {prize} ({date})',
  'premium.thinRowPillHint':
    'The conditioning state for this position has too few past draws, so it fell back ' +
    'to the marginal distribution.',

  // ---------------------------------------------------------------------------
  // Paywall (/premium)
  // ---------------------------------------------------------------------------
  // The upgrade page used to render the Thai headline and price with an English
  // parenthetical underneath, which no toggle could resolve into one language. Each
  // string is now a single key that both languages fill.
  'paywall.eyebrow': 'Premium membership',
  'paywall.title': 'Unlock premium insights',
  'paywall.features':
    'Deep analysis of the 3-digit sets and of all six digits of the 1st prize, from ' +
    'the high-tier AI models.',
  'paywall.comingSoonPill': '🔒 COMING SOON',
  'paywall.comingSoon': 'This tier is opening soon.',
  'paywall.benefitsTitle': 'WHAT YOU GET',
  'paywall.benefit1': '3-digit sets — rankings and Heng score for every position',
  'paywall.benefit2': '6-digit 1st prize — opens when the high-tier models are ready',
  'paywall.benefit3': 'The full historical analysis, unlimited viewing',
  'paywall.price': '฿99/month',
  'paywall.priceSub': 'Cancel anytime · pay by credit card',
  'paywall.subscribe': 'Subscribe now',
  'paywall.subscribeHint': 'Subscribe now (the tier is not open yet)',
  'paywall.noCharge':
    'Nothing is charged at the moment — tapping subscribe will not bill you.',
  'paywall.dismiss': 'Not now — back to the dashboard',
  'paywall.dismissHint': 'Back',
  'paywall.disclaimer':
    'Every analysis is a statistical estimate from historical draw data. No model can ' +
    'guarantee a prize.',

  // ---------------------------------------------------------------------------
  // Models (client-side names and reason labels)
  // ---------------------------------------------------------------------------
  'models.frequency': 'Frequency',
  'models.markov': 'Markov',
  'models.timeseries': 'ARIMA',
  'models.montecarlo': 'Monte Carlo',
  'models.frequencyShort': 'Freq',
  'models.markovShort': 'Markov',
  'models.timeseriesShort': 'ARIMA',
  'models.montecarloShort': 'MC',
  'models.lstm': 'LSTM',
  'models.detailTimeseries': 'Time-series drift',
  'models.detailMontecarlo': '10k simulations',
  'models.detailLstm': 'Sequence net',
  'models.planned': '{detail} · planned',
  'models.applied': 'Applied',
  'models.weightedZero': 'Zero weight',
  'models.insufficientSupport': 'Insufficient data',
  'models.notInBlend': 'Not in blend',
  'models.noObservedTransition': 'No pattern',
  'models.noArimaFit': 'No pattern',
  'models.notReported': 'Not reported',
  'models.neutral': 'Neutral',
  'models.skipped': 'skipped',
  'models.stateActive': 'active',
  'models.stateNeutral': 'neutral',
  'models.neutralReason': 'neutral, {reason}',
  'models.activeTag': '{label} · {percent}% weight',
  'models.neutralTag': '{label} · {reason}',
  'models.chipA11y': '{label}: {state}. {detail}',
  'models.collapsedHint': 'Tap a model badge to see why it was used or skipped',

  // ---------------------------------------------------------------------------
  // Signal tones
  // ---------------------------------------------------------------------------
  'tone.high': 'Strong signal',
  'tone.medium': 'Positive signal',
  'tone.low': 'Weak signal',
  'tone.cold': 'No meaningful signal',

  // ---------------------------------------------------------------------------
  // Ranking rows
  // ---------------------------------------------------------------------------
  'rank.meta': 'Heng {score} · {seen}',
  'rank.uniformLift': '{lift}× uniform rate',

  // ---------------------------------------------------------------------------
  // Other screens
  // ---------------------------------------------------------------------------
  'insights.trendTitle': 'Trend',
  'insights.trendSubtitle': 'Share of even digits and high digits over time',
  'insights.parity': 'Even / Odd',
  'insights.range': 'High / Low',
  'insights.heatmapTitle': 'Frequency heatmap',
  'insights.heatmapSubtitle': 'Every 2-digit code · darker is drawn more often',
  'insights.aiLogTitle': 'AI log',
  'insights.logGenerated': 'Log generated {date} · updates each draw cycle',
  'insights.odd': 'Odd %',
  'insights.high': 'High (5–9) %',

  'myNumber.title': 'Check a number',
  'myNumber.subtitle': 'Type any 2-digit code to see what the models say about it',
  'myNumber.inputLabel': '2-digit code',
  'myNumber.inputHint': 'Enter a number between 00 and 99',
  'myNumber.invalid': 'That is not a 2-digit code.',
  'myNumber.notFound': 'No recent draw contains that number.',
  'myNumber.lastWon': 'Last seen {date}',
  'myNumber.noRecent': 'No recent hit',

  'performance.hitRate': 'Hit rate',
  'performance.top5Rate': 'Top-5 rate',
  'performance.prizeChecker': 'Prize checker',
  'performance.latestResult': 'Latest result · {date}',
  'performance.historyTitle': 'Recent draws',
  'performance.disclaimer':
    'Past performance does not predict future draws. Every draw is independent.',

  // ---------------------------------------------------------------------------
  // About (/about) — the "how it works" explainer
  // ---------------------------------------------------------------------------
  // Model names are translated rather than left in English: the Thai copy is aimed
  // at readers who do not read English jargon, and `th.ts` already fixes the Thai
  // names for Markov chain (ลูกโซ่มาร์คอฟ), Monte Carlo (มอนติคาร์โล) and the rest.
  'about.eyebrow': 'How it works',
  'about.title': 'Behind the probability model',
  'about.intro':
    'We take the historical draw statistics of the Government Lottery Office (GLO) ' +
    'and process them through advanced mathematical and AI models:',
  'about.modelTimeseriesName': 'Time series (ARIMA & Prophet)',
  'about.modelTimeseriesBody':
    'Reads how each digit relates to time and picks up seasonal patterns — digits that ' +
    'keep appearing in this month or around this holiday.',
  'about.modelMarkovName': 'Markov chains',
  'about.modelMarkovBody':
    'Builds a probability table: given the digits in the last draw, which state the next ' +
    'draw is most likely to move to.',
  'about.modelMontecarloName': 'Monte Carlo simulation',
  'about.modelMontecarloBody':
    'Runs hundreds of thousands of simulated draws weighted by 20 years of results; the ' +
    'numbers that win most often score highest.',
  'about.modelLstmName': 'Deep learning (LSTM)',
  'about.modelLstmBody':
    'A neural network that learns patterns too complex to see by eye, such as links ' +
    'between the 1st prize and the last two digits over time.',
  'about.disclaimer':
    'Warning: the data and scores in this app are a statistical analysis of past draws. ' +
    'They are not a guarantee of any result.',
  'about.copyright':
    '© 2026 SuperHeng. All rights reserved. Copying, adapting or reproducing the ' +
    'algorithm and the data is strictly prohibited.',

  // ---------------------------------------------------------------------------
  // Donate (/donate)
  // ---------------------------------------------------------------------------
  'donate.eyebrow': 'Support the developers',
  'donate.title': 'Support the developer',
  'donate.subtitle': 'Thank you for your support',
  'donate.thanks':
    'Every contribution helps the team improve the analytics and the models. Thank you ' +
    'sincerely. 🙏',
  'donate.qrCaption': 'Scan the QR code to buy the team a coffee',
  'donate.qrA11y': 'QR code for supporting the developers',
  'donate.note':
    'Support is voluntary and has no effect on the draw or on the Heng score.',
} as const;

/** Every valid translation key. Keys are derived from `en`, never listed by hand. */
export type TranslationKey = keyof typeof en;
