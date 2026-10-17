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
  // Request failures
  // ---------------------------------------------------------------------------
  // `ApiError.message` is an English sentence written for whoever is debugging the
  // client. These are what the reader sees instead: one key per kind/status, with the
  // HTTP status passed through because it is the detail an operator needs and the one
  // detail no translation can change. `lib/api-error.ts` does the mapping.
  'apiError.network': 'Could not reach the server. Check your connection and try again.',
  'apiError.timeout': 'The server did not answer in time. Try again in a moment.',
  'apiError.unauthorized': 'That session is no longer valid ({status}). Sign in again.',
  'apiError.forbidden': 'This account is not allowed to read this ({status}).',
  'apiError.server': 'The server reported an error ({status}). Try again shortly.',
  'apiError.unexpected': 'The request failed ({status}). Try again shortly.',
  'apiError.malformed': 'The server sent a response this app could not read.',

  // ---------------------------------------------------------------------------
  // Navigation + headers
  // ---------------------------------------------------------------------------
  'nav.dashboard': 'Dashboard',
  'nav.myNumber': 'My Number',
  'nav.insights': 'Insights',
  'nav.performance': 'Performance',
  'nav.backtest': 'Backtest',

  'header.dashboardSubtitle': 'Probability intelligence',
  'header.insightsSubtitle': 'Deep insights',
  'header.myNumberSubtitle': 'Analyse any number',
  'header.performanceSubtitle': 'Performance & transparency',
  'header.backtestSubtitle': 'Proven, not promised',
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
  // Presence — the live active-user count
  // ---------------------------------------------------------------------------
  // `_one` is the singular; the i18n layer picks it automatically only when `count`
  // is the number 1, and the badge formats thousands, so it asks for the key itself.
  'presence.active': '{count} Active Users',
  'presence.active_one': '1 Active User',

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
  'premium.unlockHint': 'Open the Premium sign-in form',
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
  'premium.signOut': 'Sign out',
  'premium.accessTitle': 'Premium Access',
  'premium.accessSubtitle':
    'Sign in to subscribe, or to open the analysis you already pay for.',

  // --- Accounts (replaces the client-side password gate) -------------------
  'premium.modeSignIn': 'Sign in',
  'premium.modeRegister': 'Sign up',
  'premium.email': 'Email',
  'premium.newPassword': 'Password',
  // Stated up front rather than shown as a validation failure after submitting:
  // this is Supabase's default minimum and the only rule the user has to satisfy.
  'premium.passwordHint': 'At least 6 characters.',
  'premium.checkEmail':
    'Account created. Check your inbox to confirm the address, then sign in.',
  'premium.signedInAs': 'Signed in as {email}',
  'premium.activeUntil': 'active until {date}',

  // --- Subscription state -------------------------------------------------
  // "Expired" and "never subscribed" are different asks — renew versus subscribe —
  // so they get different words rather than one vague "not available".
  'premium.noSubscriptionTitle': 'No active subscription',
  'premium.noSubscriptionBody':
    'This account is signed in but has no active Premium subscription. The positional ' +
    'analysis stays locked until it does.',
  'premium.lapsedTitle': 'Subscription expired',
  'premium.lapsedBody':
    'This account\u2019s Premium subscription has ended. Renew it to reopen the ' +
    'positional analysis.',
  'premium.planTitle': 'Choose a plan',
  'premium.perMonth': 'month',
  'premium.perYear': 'year',
  'premium.checkout': 'Upgrade',
  'premium.checkoutFor': '{plan} — {price}',
  'premium.checkoutMethods': 'Card or PromptPay',
  // The Premium card's single upgrade button. It opens the paywall at `/premium`,
  // which holds the plan, the payment methods and Stripe's return URL — so the label
  // names what can actually be paid with, and the shorter fallback applies when no
  // gateway is connected and there is nothing to name.
  'premium.upgradeCta': 'Upgrade to Premium (Card / PromptPay)',
  'premium.upgradeCtaComingSoon': 'Upgrade to Premium',
  'premium.checkoutUnavailable':
    'Payments are not open yet. Nothing was charged and no subscription was started — ' +
    'the button is wired to the real endpoint and will work as soon as a payment ' +
    'provider is connected.',
  'premium.checkoutCharged':
    'The payment provider accepted this checkout. Your subscription will appear here ' +
    'as soon as the confirmation reaches the server.',
  'premium.checkoutOpening': 'Opening Stripe\u2019s secure payment page\u2026',
  'premium.checkoutCreated':
    'Opening Stripe\u2019s secure payment page. Nothing has been charged yet \u2014 your ' +
    'subscription starts when Stripe confirms the payment, not when you come back here.',
  'premium.checkoutRedirectFailed':
    'Stripe created a payment page but this device would not open it. Nothing was ' +
    'charged \u2014 if a popup blocker is on, allow this site and try again.',
  'premium.alreadyPremium': 'This account already has an active Premium subscription.',
  'premium.accountUnreadable':
    'Signed in, but the subscription could not be checked just now. This is a service ' +
    'problem, not a verdict about your account.',
  'premium.profileMissing':
    'No profile row exists for this account yet, so no subscription can be attached to ' +
    'it. An administrator needs to apply backend/schema_profiles.sql.',
  'premium.refusedHint':
    'The server refused this request. Sign in below, or subscribe if you have not — '
    + 'asking again will not change the answer.',
  'premium.notConfiguredTitle': 'Accounts are not set up on this build',
  'premium.notConfiguredBody':
    'This build has no Supabase configuration, so signing in is not possible here. The ' +
    'free dashboard, the ledger and the backtest are unaffected.',

  // --- Sign-in failures ---------------------------------------------------
  // Supabase reports these as English sentences meant for developers; they are
  // mapped to codes in lib/auth.tsx and translated here so a Thai UI stays Thai.
  'premium.authError.unconfigured': 'This build has no account configuration.',
  'premium.authError.invalidCredentials': 'That email or password is not right.',
  'premium.authError.emailNotConfirmed':
    'That address has not been confirmed yet. Check your inbox for the confirmation ' +
    'link.',
  'premium.authError.alreadyRegistered':
    'There is already an account for that address. Sign in instead.',
  'premium.authError.weakPassword':
    'That password is too short — use at least 6 characters.',
  'premium.authError.rateLimited':
    'Too many attempts just now. Wait a moment and try again.',
  'premium.authError.invalidEmail': 'Enter a valid email address and a password.',
  'premium.authError.network':
    'Could not reach the account service. Check your connection and try again.',
  'premium.authError.unknown': 'Sign-in failed.',
  // The value proposition on **every** locked card, above the sign-in form and above
  // the upgrade button. Four checkmarked lines rather than a paragraph: this is the
  // only place the reader decides whether the door is worth opening, and a bulleted
  // list is scannable where prose is not.
  'premium.benefitsTitle': 'Premium Benefits',
  'premium.valueMarkets': 'Unlock all 3 markets (Thai, Lao, Hanoi)',
  'premium.valueModels': 'Deep analysis with all 4 AI models (ARIMA, Markov, Bayesian, Frequency)',
  'premium.valuePositions': 'Exact positional probability, leading digit to units',
  'premium.valueRealtime': 'Real-time results and trend updates',
  'premium.lockedPill': '🔒 PREMIUM',
  'premium.gateNote':
    'Your account is used only to check the subscription. The dashboard, the ledger and ' +
    'the backtest stay free and need no account at all.',
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

  // --- Latest-draw accuracy (ตรวจการบ้าน AI) ---------------------------------
  // The two faces of the premium panel's view switcher. Short, because they sit in a
  // pill beside a country switcher that uses the same control.
  'premium.viewAnalysis': 'Analysis',
  'premium.viewAccuracy': 'Latest accuracy',
  // The switcher's own label, for screen readers. The visible faces are the two
  // above; a pill row with no label is a tablist nobody can name.
  'premium.viewFilter': 'Analysis or latest-draw accuracy',
  'premium.accuracy.title': 'Latest draw accuracy',
  'premium.accuracy.subtitle':
    'The model\u2019s picks for each completed draw, beside the numbers that were ' +
    'actually drawn.',
  // Stated before the numbers, not after them. The service stores no prediction, so
  // everything below is a reconstruction — the one thing this card must not imply is
  // that it is a forecast that was made at the time.
  'premium.accuracy.replayTitle': 'Replayed, not recorded',
  'premium.accuracy.replayBody':
    'No prediction is stored when one is made, so the model was re-run for each draw ' +
    'using only the draws before it. That reproduces what it would have said — it is ' +
    'not proof that it was run at the time.',
  'premium.accuracy.loading': 'Loading the accuracy report…',
  'premium.accuracy.loadFailed': 'Could not load the accuracy report',
  'premium.accuracy.empty':
    'No draw has enough history behind it to rebuild a prediction yet.',
  'premium.accuracy.latestDraw': 'Latest draw',
  'premium.accuracy.aiPredicted': 'AI predicted',
  'premium.accuracy.actualResult': 'Actual result',
  'premium.accuracy.hit': 'HIT',
  'premium.accuracy.miss': 'MISS',
  'premium.accuracy.nearMiss': 'IN TOP 3',
  'premium.accuracy.rankOf': 'ranked #{rank}',
  'premium.accuracy.positionsHit': '{hits}/{total} positions',
  'premium.accuracy.trainedOn': 'trained on {count} draws',
  'premium.accuracy.overWindow': 'Over the last {draws} draws',
  'premium.accuracy.hitRate': '{rate} hit rate vs {baseline} baseline',
  'premium.accuracy.pValue': 'p = {p}',
  'premium.accuracy.significant': 'Better than chance in this sample',
  'premium.accuracy.notSignificant':
    'Not distinguishable from chance at this sample size',
  'premium.accuracy.channels': '2-digit prizes',
  'premium.accuracy.channelTop': 'Top · last 2 of the 1st prize',
  'premium.accuracy.channelBottom': 'Bottom · the 2-digit prize',
  'premium.accuracy.exact': 'Exact',
  'premium.accuracy.inTop5': 'In top 5',
  'premium.accuracy.recentDraws': 'Draws compared',
  'premium.accuracy.limitsTitle': 'What this cannot show',
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
  // Shown instead of "coming soon" once a gateway is connected, so the pill states
  // what can actually be used rather than what is missing.
  'paywall.livePill': 'CARD · PROMPTPAY',
  // The way in, on this screen. The paywall carries the same form as the Premium
  // card, so a customer Stripe sends back here can sign in without leaving it —
  // which is what the old "sign in on the dashboard first" wording could not do.
  'paywall.authTitle': 'Sign in or create an account',
  'paywall.authBody':
    'Subscriptions are tied to an account. Sign in, or create one — the price and the '
    + 'payment methods are the same either way.',
  // The paywall's upgrade button calls the real checkout endpoint. These are the
  // states that replace "coming soon" when it cannot complete.
  'paywall.signInRequired':
    'Sign in or create an account above first — then this button opens a checkout.',
  'paywall.checkoutUnavailable':
    'Payments are not open yet, so nothing was charged and no subscription started. '
    + 'The dashboard\u2019s Premium card shows the full status.',
  'paywall.checkoutFailed':
    'The checkout could not be started. Nothing was charged — try again in a moment.',
  'paywall.checkoutRedirectFailed':
    'Stripe created a payment page but this device would not open it. Nothing was '
    + 'charged — if a popup blocker is on, allow this site and try again.',
  // Shown after Stripe sends the customer back. The redirect proves nothing: the
  // entitlement is written by the webhook, which can land a moment later, so the
  // wording is "confirming" rather than "confirmed".
  'paywall.paymentReturning':
    'Stripe is confirming your payment. This page updates on its own — it usually '
    + 'takes a few seconds.',
  'paywall.paymentCancelled': 'Payment cancelled. Nothing was charged.',
  'paywall.methodsTitle': 'PAY WITH',
  'paywall.methodsCard': 'Credit or debit card — Visa, Mastercard, JCB, Amex',
  'paywall.methodsPromptPay': 'PromptPay QR — scan with any Thai banking app',
  'paywall.benefitsTitle': 'WHAT YOU GET',
  'paywall.benefit1': '3-digit sets — rankings and Heng score for every position',
  'paywall.benefit2': '6-digit 1st prize — opens when the high-tier models are ready',
  'paywall.benefit3': 'The full historical analysis, unlimited viewing',
  'paywall.price': '฿99/month',
  // "Cancel anytime" was wrong: this is a one-time payment for a 30-day pass, not a
  // recurring subscription, so there is nothing to cancel. Copy has to match what
  // the gateway will actually do (Stripe is called with mode=payment).
  'paywall.priceSub': 'One-time payment · 30 days of access',
  'paywall.subscribe': 'Upgrade with card or PromptPay',
  'paywall.subscribeHint': 'Upgrade with a credit card or PromptPay',
  // Used while no gateway is connected, so the button does not name payment
  // methods this build has nothing to offer them with. The methods block below is
  // hidden in the same state, for the same reason.
  'paywall.subscribeComingSoon': 'Subscribe',
  'paywall.subscribeComingSoonHint': 'Subscribe (the tier is not open yet)',
  'paywall.noCharge':
    'Nothing is charged until you complete the payment on Stripe\u2019s secure page.',
  'paywall.noChargeComingSoon':
    'Nothing is charged at the moment \u2014 tapping subscribe will not bill you.',
  'paywall.dismiss': 'Not now — back to the dashboard',
  'paywall.dismissHint': 'Back',
  'paywall.disclaimer':
    'Every analysis is a statistical estimate from historical draw data. No model can ' +
    'guarantee a prize.',

  // ---------------------------------------------------------------------------
  // Backtest
  // ---------------------------------------------------------------------------
  // This panel exists to be *believed*, so the wording never rounds an
  // inconclusive result up to a win: `backtest.noEdge` says the edge is unproven
  // rather than absent, and the two verdict bodies state the limit of what a
  // finite sample can show. A baseline is named beside every rate for the same
  // reason — a hit rate on its own is the claim this screen refuses to make.
  'backtest.title': 'Backtest',
  'backtest.subtitle': 'Every model replayed on draws it had never seen',
  'backtest.windowDraws': 'Last {count}',
  'backtest.loading': 'Replaying the last {count} draws — each one against its own past…',
  'backtest.waking':
    'Waking the server… (it sleeps on a free instance and can take up to a minute)',
  'backtest.loadFailed': 'Could not load the backtest',
  'backtest.ledgerMismatch':
    'The service answered with a different lottery than the one selected, so these ' +
    'numbers are not the ones you asked for.',
  'backtest.sampleLine': '{done} of {requested} draws replayed · {from}–{to}',
  'backtest.channelUnavailable':
    'The 2-digit game cannot be replayed for this ledger: its first prize is five ' +
    'digits, so the last-two-digits channel is not defined for it. The positional ' +
    'model below is unaffected.',

  // Verdict
  'backtest.significant': 'ABOVE CHANCE',
  'backtest.noEdge': 'NOT PROVEN',
  'backtest.notSignificant': 'Not significant',
  'backtest.pValue': 'p = {p} · n = {count}',
  'backtest.pShort': 'p {p}',
  'backtest.testPositional': 'positional digit accuracy',
  'backtest.testTop5': 'top-{count} hit rate',
  'backtest.verdictSource': 'From {test} · {count} significance test(s) run',
  'backtest.verdictSignificantTitle': 'The models beat chance on this window',
  'backtest.verdictChanceTitle': 'Not distinguishable from chance',
  'backtest.verdictSignificantBody':
    'The result clears the 0.05 threshold on this window, which is evidence the ' +
    'models are picking up something real — not proof they will keep doing it, and ' +
    'not a guarantee of any prize.',
  'backtest.verdictChanceBody':
    'A result this close to the baseline happens by luck often enough that this ' +
    'window cannot claim an edge, and the app does not claim one. More draws would ' +
    'be needed before saying otherwise.',
  'backtest.verdictEmptyTitle': 'Not enough history to judge',
  'backtest.verdictEmptyBody':
    'This ledger is too short to replay, so no accuracy claim is made. The counts ' +
    'and the reason are in the notes below.',

  // Metrics
  'backtest.metricWinRate': 'Win rate',
  'backtest.metricTop5': 'Top-5 rate',
  'backtest.metricRoi': 'ROI',
  'backtest.metricBreakEven': 'Break-even',
  'backtest.breakEvenHint': 'Hit rate needed to profit',
  'backtest.metricDigitAccuracy': 'Digit accuracy',
  'backtest.metricPredictions': 'Predictions',
  'backtest.metricPValue': 'p-value',
  'backtest.metricHitsNeeded': 'Hits needed',
  'backtest.metricHitsNeededHint': 'For significance',
  'backtest.vsUniformHint': 'uniform {uniform} · random {random}',
  'backtest.vsUniformSimple': 'uniform {uniform}',
  'backtest.roiHint': '{payout}× payout · random {random}',
  'backtest.drawsHint': '{count} draws',
  'backtest.channelLine': '{channel} channel · {draws} draws',
  'backtest.hitsNeededLine': '{count} hits would be significant',
  'backtest.positionCount': '{hits}/{total}',

  // Charts
  'backtest.aiLabel': 'AI',
  'backtest.randomLabel': 'Random',
  'backtest.uniformLabel': 'Uniform',
  'backtest.zeroLine': 'Break-even',
  'backtest.rateChartTitle': 'Cumulative top-{count} hit rate',
  'backtest.rateChartSubtitle': 'Cumulative, so one lucky draw cannot spike it',
  'backtest.bankrollTitle': 'Bankroll, bet for bet',
  'backtest.bankrollSubtitle':
    'One unit on the top pick every draw — the gap between the lines is the edge',
  'backtest.bankrollAxis': 'After {date}: AI {last} units, random {random}',
  'backtest.roiTitle': 'Return on investment at {payout}×',
  'backtest.roiSubtitle': 'Break-even is the centre line · {breakEven}% hit rate needed',
  'backtest.roiAxis': '−{lose}% loss ← 0 → +{win}% profit',
  'backtest.roiExactAi': 'AI · top pick only',
  'backtest.roiExactRandom': 'Random · top pick only',
  'backtest.roiCoverAi': 'AI · all 5 picks',
  'backtest.roiCoverRandom': 'Random · all 5 picks',

  // Positional
  'backtest.positionalTitle': 'Premium positional model',
  'backtest.positionalSubtitle': 'One digit per position, per draw · {count} predictions',
  'backtest.positionChartTitle': 'Cumulative digit accuracy',
  'backtest.positionChartSubtitle': 'Against the 10% uniform baseline',
  'backtest.positionNote':
    'The marker on each bar is that position’s 10% baseline — what a blind guess ' +
    'would score. Green means this position’s own result cleared the 0.05 ' +
    'threshold on this window.',

  // Method notes
  'backtest.notesTitle': 'How this was measured',
  'backtest.notesSubtitle': 'The method, the assumption, and what was left out',
  'backtest.leakageTitle': 'No leakage',
  'backtest.payoutTitle': 'Payout assumption',
  'backtest.methodTitle': 'Method',
  'backtest.excludedTitle': 'Not backtested here',
  'backtest.disclaimer':
    'A backtest measures the past, not the future. Beating the baseline on these ' +
    'draws says nothing about the next one — a fair draw is independent of every ' +
    'draw before it.',

  // Paywall hook — the same replay, reduced to one honest line per ledger
  'backtest.hookTitle': 'Proof, with the baseline beside it',
  'backtest.hookSubtitle': 'All three ledgers, replayed on draws the models had never seen',
  'backtest.hookPromise':
    'Everything is published here, including the ledgers that do not flatter the ' +
    'models. A hit rate without its baseline is marketing, so the seeded random ' +
    'player sits on every row.',
  'backtest.hookCaption':
    'Each row: the top-{count} hit rate, the same seeded random player, and p ' +
    'against chance.',
  'backtest.hookP': 'p',
  'backtest.hookDraws': '{done} of {requested} draws',
  'backtest.hookMethod':
    'No leakage: each draw is predicted from the draws strictly before it. Over a ' +
    'window this short a p above 0.05 means the model cannot be told apart from ' +
    'chance, and this card says so rather than implying otherwise.',
  'backtest.hookCta': 'See the full replay',
  'backtest.hookCtaSub': 'Every draw, every baseline, every p-value',
  'backtest.hookLoading': 'Replaying every ledger…',
  'backtest.hookFailed': 'Could not load the replay',
  'backtest.hookNoChannel': 'This ledger does not publish this channel',

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
  'insights.subtitle': 'Deep insights',
  'insights.gridBadge': '00–99 GRID',
  'insights.trendTitle': 'Trend',
  'insights.trendSubtitle': 'Share of even digits and high digits over time',
  'insights.parity': 'Even / Odd',
  'insights.range': 'High / Low',
  'insights.heatmapTitle': 'Four-model heatmap',
  'insights.heatmapSubtitle': 'Bottom two digits · next draw · weighted ensemble score',
  'insights.heatmapHint':
    'Tap a cell to analyse that number · green is reserved for the board’s strict top band',
  'insights.heatmapLoading': 'Computing from the published draws…',
  'insights.heatmapThin': 'At least {draws} draws are needed to build the heatmap.',
  'insights.heatmapBlend': 'Ensemble score = weighted sum of four models',
  // The weights are refit per board from each model's own walk-forward log score, so the
  // sentence quotes whatever the board in `lib/heatmap.ts` actually used this draw.
  'insights.heatmapAdaptive':
    'Adaptive AI weighting — refit from each model’s last {draws} walk-forward results. ' +
    'This draw: {detail}.',
  'insights.heatmapForm':
    'Recent form: average percentile {rank}/100 across the last {draws} boards it produced',
  'insights.heatmapMarkovName': 'Markov chain · draw-to-draw transitions',
  'insights.heatmapMarkovBody':
    'How likely the latest code is to be followed by each other code, shrunk toward ' +
    'the long-run frequency while the observed transitions are still few.',
  'insights.heatmapFrequencyName': 'Historical frequency · long-run baseline',
  'insights.heatmapFrequencyBody':
    'How often each code appeared across the whole window, smoothed so a code that ' +
    'never appeared is rare rather than impossible.',
  'insights.heatmapMomentumName': 'Recency / momentum · hot and cold',
  'insights.heatmapMomentumBody':
    'The last ten draws weighted by age (three-draw half-life), so numbers trending ' +
    'right now count for more.',
  'insights.heatmapMontecarloName': 'Monte Carlo · {paths} simulated paths',
  'insights.heatmapMontecarloBody':
    'Simulates the next draw {paths} times from the measured mean, standard deviation ' +
    'and mean reversion of the real ledger.',
  'insights.heatmapScale':
    'Colour is a fixed quota, not a score cut-off: green is the {high} highest-ranked ' +
    'codes, gold the next {medium}, red the next {low} and grey the rest. The 0–100 score ' +
    'is each code’s percentile on this board, not a probability · the strongest code’s ' +
    'chance is {probability}% per draw (uniform baseline 1.00%).',
  'insights.heatmapSample': 'Computed from {draws} draws · {from} → {to}',
  // The four quota bands, sizes printed from `HEATMAP_BAND_COUNTS` (out of 100 codes).
  'insights.legendStrong': 'Strong · top {share}',
  'insights.legendMedium': 'Medium · next {share}',
  'insights.legendLow': 'Low · next {share}',
  'insights.legendIgnore': 'Ignore · bottom {share}',
  'insights.parityNote':
    'Share of odd digits per draw. Spikes above 50% suggest a parity tilt.',
  'insights.rangeNote':
    'Share of high digits (5–9) per draw. Useful for band selection.',
  'insights.aiLogTitle': 'AI reasoning log',
  'insights.aiLogSubtitle': 'Why the model predicts what it predicts',
  // Stated, not hidden. These four entries are hand-written illustrations: no model
  // emits a reasoning log yet, and the backend's own numbers contradict some of the
  // claims below (the Markov transition, for one). Shipping them as if they were
  // produced by the last run would be a fabricated explanation of a real prediction,
  // so the panel says what it is until it is wired to `/api/predict/basic`'s evidence.
  'insights.aiLogSample':
    'Illustrative example — this panel is not generated from a live model run yet.',
  'insights.logGenerated': 'Log generated {date} · updates each draw cycle',
  'insights.odd': 'Odd %',
  'insights.high': 'High (5–9) %',
  'confidence.high': 'High',
  'confidence.medium': 'Medium',
  'confidence.low': 'Low',
  // The log's four entries. The `tag` stays a model name in both languages (see the
  // vocabulary note at the top of `th.ts`); everything else is the dictionary's job.
  'insights.log.log1.headline': 'Q4 drift detected on the "4x" band',
  'insights.log.log1.detail':
    'Numbers ending in 4 outperform their 12-draw baseline by 24% in the final ' +
    'quarter. The effect is strongest in the Top position and has held for three ' +
    'consecutive cycles.',
  'insights.log.log2.headline': 'Transition 93 → 48 has elevated weight',
  'insights.log.log2.detail':
    'The transition matrix gives 48 a 0.31 conditional probability after 93 is ' +
    'drawn, roughly 1.9x its unconditional rate.',
  'insights.log.log3.headline': '10,000 simulations cluster on low-mid pairs',
  'insights.log.log3.detail':
    'Across 10k simulated draws the low-mid band (10-59) appeared in 58% of ' +
    'Top-position outcomes, versus 50% expected uniformly.',
  'insights.log.log4.headline': 'Volatility compression before the draw',
  'insights.log.log4.detail':
    '(1,1,1) residuals show narrowing variance in the last 5 draws, historically a ' +
    'precursor to a higher-conviction prediction.',

  // My Number (/my-number). The generated sentences — verdict, advice — are ids in
  // `data/mock.ts` resolved through the maps at the top of the screen, so nothing the
  // analyst sees is assembled in the data layer.
  // The grid's own band names, used in cell accessibility labels. Deliberately short:
  // a screen reader reads one of these for every cell it lands on.
  'heatmap.bandHigh': 'HIGH',
  'heatmap.bandMedium': 'MEDIUM',
  'heatmap.bandLow': 'LOW',
  'heatmap.bandIgnore': 'IGNORE',
  'heatmap.cellA11y': 'Number {code}, rank {rank} of 100, {band} band',

  'myNumber.title': 'Your number',
  'myNumber.subtitle': '2 or 3 digits — e.g. a licence plate',
  'myNumber.inputLabel': 'Number to analyse',
  'myNumber.analyse': 'Analyse',
  'myNumber.try': 'Try',
  'myNumber.verdictFavourable': 'Favourable statistical position',
  'myNumber.verdictMild': 'Mild positive signal',
  'myNumber.verdictNeutral': 'Neutral — no strong edge',
  'myNumber.confidenceLine': '{level} confidence',
  'myNumber.hengScore': 'Heng score',
  'myNumber.appearances': 'Appearances',
  'myNumber.lastWon': 'Last won',
  'myNumber.noRecentHit': 'No recent hit',
  'myNumber.parity': 'Parity',
  'myNumber.parityAllEven': 'All even',
  'myNumber.parityAllOdd': 'All odd',
  'myNumber.parityMixed': 'Mixed parity',
  'myNumber.digitSum': 'Digit sum',
  'myNumber.prizeBottomTwo': 'Last two',
  'myNumber.prizeFirstPrize': 'First prize',
  'myNumber.signalProfile': 'Signal profile',
  'myNumber.axisFrequency': 'Frequency',
  'myNumber.axisRecency': 'Recency',
  'myNumber.axisSeasonality': 'Seasonality',
  'myNumber.axisBalance': 'Balance',
  'myNumber.axisMomentum': 'Momentum',
  'myNumber.aiAdvice': 'AI advice',
  'myNumber.aiAdviceSubtitle': 'Model-derived recommendations',
  'myNumber.adviceConsensus': 'Model consensus',
  'myNumber.adviceConsensusBody':
    'Probability of {probability}% for the trailing pair "{code}", ranked against ' +
    'the current 00-99 grid.',
  'myNumber.advicePositioning': 'Positioning',
  'myNumber.advicePositioningConcentrated':
    'Signals are concentrated in the Top position. Focus exposure there rather than ' +
    'splitting evenly.',
  'myNumber.advicePositioningSpread':
    'Signals are spread across positions. Treat this as a diversification candidate, ' +
    'not a core pick.',
  'myNumber.adviceRisk': 'Risk note',
  // The `_one` variants are picked by the `count` parameter, which is the odd-digit
  // count: English inflects, Thai does not (see `common.draws_one` for the pattern).
  'myNumber.adviceRiskBody_one':
    'Digit sum {sum} with a single odd digit. This configuration appeared in ' +
    '{appearances} of the last {draws} draws.',
  'myNumber.adviceRiskBody':
    'Digit sum {sum} with {odd} odd digits. This configuration appeared in ' +
    '{appearances} of the last {draws} draws.',
  'myNumber.emptyTitle': 'No analysis yet',
  'myNumber.emptyBody':
    'Enter a 2 or 3-digit number to see its Heng score, history and model advice.',

  // ---------------------------------------------------------------------------
  // Performance (/performance) — scorecard, prize checker, prediction history
  // ---------------------------------------------------------------------------
  // This screen used to render hardcoded English beside hardcoded numbers. Both are
  // gone: every string is a key here, and every figure comes from `/api/backtest` or
  // `/api/predict/basic`, so a new draw appears without an edit.
  'performance.title': 'Performance & transparency',
  'performance.scorecardTitle': 'AI scorecard',
  'performance.scorecardSubtitle': 'Thai ledger · {draws} draw(s) replayed',
  'performance.scorecardSubtitleFallback': 'Thai ledger · walk-forward replay',
  'performance.hitRate': 'Hit rate',
  'performance.top5Rate': 'Top-5 rate',
  'performance.uniformBaseline': 'uniform {rate}',
  'performance.drawsScored': 'Draws scored',
  'performance.drawsRequested': 'of {requested} requested',
  'performance.pValue': 'p-value',
  'performance.significant': 'significant',
  'performance.notSignificant': 'not significant',
  'performance.replaying': 'Replaying the recent draws…',
  'performance.scoring': 'Scoring the recent draws…',
  'performance.replayFailed': 'The replay request failed.',
  'performance.requestFailed': 'The request failed ({status}).',
  'performance.channelUnavailable':
    'This ledger published no 2-digit channel for the window.',
  'performance.notEnoughHistory': 'There is not enough history to score yet.',
  'performance.retry': 'Retry',

  // Prize checker — against the draw that was actually published.
  'performance.prizeChecker': 'Prize checker',
  'performance.latestResult': 'Latest result · {date}',
  'performance.latestResultWithPrize': 'Latest result · {date} · {prize}',
  'performance.latestResultLoading': 'Loading the latest result…',
  'performance.latestResultUnavailable': 'Latest result unavailable',
  'performance.ticketLabel': 'Ticket number',
  'performance.ticketPlaceholder': 'Enter ticket number',
  'performance.check': 'Check',
  'performance.winner': 'Winner — {label}',
  'performance.noPrize': 'No prize for this draw',
  'performance.tierAllSix': 'All 6 digits',
  'performance.tierFirstPrize': 'First prize (รางวัลที่ 1)',
  'performance.tierLastTwoDigits': 'Last 2 digits',
  'performance.tierLastTwo': 'Last two (เลขท้าย 2 ตัว)',
  'performance.amountFirstPrize': '฿ 6,000,000',
  'performance.amountLastTwo': '฿ 2,000',
  'performance.matchFirstPrize': 'Exact First prize match · {prize}',
  'performance.matchLastTwo': 'Last two digits match · {digits}',
  'performance.noPrizeDetail':
    'Against {date}: first prize {first}, last two {bottom}.',
  'performance.noPrizePending': 'The latest published result has not loaded yet.',
  'performance.prizeScope':
    'Only the two prizes this ledger publishes are checked: the exact six-digit ' +
    'first prize (รางวัลที่ 1) and the separately drawn last two (เลขท้าย 2 ตัว).',

  // Prediction history — the replay, newest draw first.
  'performance.historyTitle': 'Prediction history',
  'performance.historySubtitle': 'Walk-forward replay · {from} → {to}',
  'performance.historySubtitleFallback': 'Model pick vs. actual result',
  'performance.latestDraw': 'Latest draw',
  // Where the *next* draw's top pick came from, using the evidence the model actually
  // emitted. It is deliberately attached to the upcoming draw and never to a past one:
  // the service keeps no evidence for a replay, so a badge on a historical pick would
  // be invented provenance.
  'performance.evidenceTitle': 'Next draw · where the picks come from',
  'performance.evidenceSubtitle':
    "The strongest signal behind each channel's top pick, from the same payload as " +
    'the prediction.',
  'performance.evidenceFrequency':
    'Frequency {lift}× baseline · seen {count} of {expected} expected',
  'performance.evidenceMarkov': 'Markov {lift}× baseline',
  'performance.evidenceUniform': 'No edge over the uniform rate',
  // The verified highlight above the list. It is filled from the replay, never written
  // by hand, and it names the weakest claim it can make (top five) as exactly that.
  'performance.highlightsTitle': '🔥 Latest AI highlights',
  'performance.highlightsExactBody':
    'The draw came out {number} — the exact code the model ranked first.',
  'performance.highlightsTop5Body':
    'The draw came out {number}, and it was one of the five codes the model shortlisted.',
  // Only used when the drawn code was in the board's green band before the draw
  // (score >= 75, the same HIGH definition as the heatmap colours).
  'performance.highlightsHeatmapBody':
    'Bullseye — {number} was in the Heatmap’s green band (its strict top {share} of ' +
    'codes) before the draw.',
  'performance.highlightsMarkovBody':
    'The draw came out {number} — the #1 code from the Markov model’s board.',
  'performance.highlightsFrequencyBody':
    'The draw came out {number} — the #1 code by long-run frequency on that board.',
  'performance.highlightsMomentumBody':
    'The draw came out {number} — the hottest code on that board’s momentum ranking.',
  'performance.highlightsScore': 'Signal score {score}/100 on the pre-draw board',
  'performance.highlightsChannel': 'Channel: {channel}',
  'performance.highlightsReplay':
    'Walk-forward replay of the same ledger as the list below, not a stored forecast. ' +
    'Past results do not predict the next draw.',
  'performance.highlightsEmpty':
    'No tracked signal caught a draw in the last {draws} draws of the Thai ledger.',
  'performance.highlightsEmptyBody':
    'This card fills in only when a published result matches a signal we can replay — ' +
    'the #1 pick, the top five, the heatmap’s green band, or one model’s single pick. ' +
    'Nothing in it is written by hand.',
  'performance.highlightsFailed':
    'Highlights are unavailable right now: the replay ledgers did not answer.',
  'performance.sourceTop5': 'from Top 5',
  'performance.sourceTop1': 'from AI #1',
  'performance.sourceHeatmap': 'from Heatmap',
  'performance.sourceMarkov': 'from Markov',
  'performance.sourceFrequency': 'from Frequency',
  'performance.sourceMomentum': 'from Momentum',
  'performance.signalHit': 'HIT',
  'performance.aiPredicted': 'AI predicted',
  'performance.actualResult': 'Actual result',
  'performance.hit': 'HIT',
  'performance.miss': 'MISS',
  'performance.inTop5': 'IN TOP 5',
  'performance.actual': 'ACTUAL',
  'performance.channelBottom': 'bottom two (เลขท้าย 2 ตัว)',
  'performance.channelTop': 'top two (first prize tail)',
  'performance.historyRowNote':
    "Each row is the model's {channel} pick beside the number that was drawn, " +
    'newest first.',
  'performance.historyReplayNote':
    'This is a replay, not a record: the service stores no prediction when it makes ' +
    'one, so every pick here was computed from the draws before it and then marked ' +
    'against the published result — the same walk-forward rule the Backtest tab ' +
    'measures.',
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

  // ---------------------------------------------------------------------------
  // Developer credit
  // ---------------------------------------------------------------------------
  // The footer on every main screen. The founder's name is translated on purpose:
  // Thai readers get the Thai spelling, English readers the Latin one, exactly as the
  // credit was written in each language. It is a dictionary entry like any other, so
  // the name and the sentence around it can never fall out of step.
  //
  // The link URLs deliberately do **not** live here — a profile URL is not copy, and
  // duplicating it per language would let the two builds point at different profiles.
  // They are constants in `components/superheng/credits-footer.tsx`.
  'credits.developedBy': 'Developed with ❤️ by {name} (Founder)',
  'credits.name': 'Ponrat Saripan',
  'credits.githubA11y': 'Open the developer’s GitHub profile',
  'credits.facebookA11y': 'Open the developer’s Facebook page',

  // ---------------------------------------------------------------------------
  // Legal notice
  // ---------------------------------------------------------------------------
  // Compliance wording, quoted verbatim from the legal brief. It is deliberately
  // NOT edited for tone or tightened for length: this is the sentence the Founder
  // needs a reviewer to read, and rewriting it would change what was reviewed.
  //
  // It lives here rather than inline at either call site because two surfaces render
  // it — the page footer and the premium paywall — and one of them eventually drifts
  // from the other when a shared legal string is duplicated. `t('legal.disclaimer')`
  // also puts it in front of the TH/EN toggle for free, which is the point: a
  // disclaimer only the English build shows is not a disclaimer.
  'legal.disclaimer':
    'This application is intended for statistical analysis and entertainment purposes ' +
    'only. We do not encourage illegal gambling and do not guarantee the accuracy of ' +
    'any calculated results.',
} as const;

/** Every valid translation key. Keys are derived from `en`, never listed by hand. */
export type TranslationKey = keyof typeof en;
