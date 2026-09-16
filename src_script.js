/* ============================================================
   GULLY LEDGER — local cricket scorecard
   Vanilla JS, single state object, persisted to Supabase (RLS-scoped per user).
   ============================================================ */

/* ---------- Supabase ---------- */
const SUPABASE_URL = 'https://pghqrenqfsqhhwtvffoz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_SHdZ1nvXIdW86HPAdvarXA_lS3jhwAD';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    flowType: 'pkce',          // robust redirect handling for magic-link / OAuth
    persistSession: true,      // keep the session across refreshes (localStorage)
    autoRefreshToken: true,    // silently refresh before the token expires
    detectSessionInUrl: true   // pick up ?code=... on redirect back from email/OAuth
  }
});

let state = null;        // the whole match
let history = [];        // undo stack (deep clones of state, pre-ball)
let currentUser = null;  // the signed-in Supabase user

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const clone = (o) => JSON.parse(JSON.stringify(o));

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

/* Screens other than the auth screen are "protected" — if for any reason we're
   not signed in (session lost, sign-out in another tab, expired refresh token),
   bounce back to screen-auth instead of leaving a scoring UI visible with no
   authenticated user behind it. */
const PUBLIC_SCREENS = new Set([
  'screen-role',
  'screen-auth',
  'screen-viewer-list',
  'screen-viewer-live',
  'screen-viewer-scorecard'
]);

/* Screens that get the extra "walking out to the middle" 3D tunnel push
   instead of the default depth-fade — the moments where you're stepping
   into a live scoreboard. */
const TUNNEL_SCREENS = new Set(['screen-scoring', 'screen-viewer-live']);

function showScreen(id) {
  if (!PUBLIC_SCREENS.has(id) && !currentUser) {
    id = 'screen-role';
  }
  document.querySelectorAll('.screen').forEach(s => hide(s));
  const el = $(id);
  el.classList.remove('screen-tunnel');
  if (TUNNEL_SCREENS.has(id)) {
    // force reflow so the animation class re-triggers every time
    void el.offsetWidth;
    el.classList.add('screen-tunnel');
  }
  show(el);
}

/* ============================================================
   THEME — floodlight day/night toggle, persisted across visits
   ============================================================ */
function initTheme() {
  const saved = localStorage.getItem('gully-theme');
  const theme = saved || 'light';
  applyTheme(theme);
  const btn = $('btnThemeToggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('gully-theme', next);
  });
}
function applyTheme(theme) {
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  const icon = $('ttIcon');
  if (icon) icon.textContent = theme === 'dark' ? '🌙' : '☀️';
}

/* ============================================================
   ENTRANCE CINEMATIC — ball-bounce + wordmark reveal, shown once
   per browser session on the Role Select screen. Always skippable.
   ============================================================ */
function playEntranceCinematic() {
  const overlay = $('entranceOverlay');
  const wordEl = $('entranceWord');
  if (!overlay || !wordEl) return;
  if (sessionStorage.getItem('gully-entrance-seen')) {
    overlay.classList.add('hidden');
    return;
  }
  const word = 'GULLY LEDGER';
  wordEl.innerHTML = word.split('').map((ch, i) => {
    const delay = (1.15 + i * 0.035).toFixed(2);
    const glyph = ch === ' ' ? '&nbsp;' : ch;
    return '<span style="animation-delay:' + delay + 's">' + glyph + '</span>';
  }).join('');

  const dismiss = (skipping) => {
    if (overlay.dataset.done) return;
    overlay.dataset.done = '1';
    sessionStorage.setItem('gully-entrance-seen', '1');
    if (skipping) overlay.classList.add('skip');
    setTimeout(() => overlay.classList.add('hidden'), skipping ? 400 : 50);
  };

  overlay.addEventListener('click', () => dismiss(true));
  setTimeout(() => dismiss(false), 3000);
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  show(t);
  clearTimeout(toast._h);
  toast._h = setTimeout(() => hide(t), 2200);
}

/* ---------- match persistence (Supabase, RLS-scoped to the signed-in user) ---------- */

/* Insert on first save, update on every save after that. Fire-and-forget —
   callers don't await this; scoring should never stall on network latency. */
function saveState() {
  if (state) persistMatch();
}

async function persistMatch() {
  if (!state) return false;
  const payload = {
    match_name: state.matchName || 'Local Match',
    state,
    is_complete: !!state.matchOver
  };
  if (state.dbId) {
    const { error } = await sb.from('matches').update(payload).eq('id', state.dbId);
    if (error) { console.error('save failed', error); toast('Could not save — check your connection.'); return false; }
  } else {
    const { data, error } = await sb.from('matches').insert(payload).select().single();
    if (error) { console.error('save failed', error); toast('Could not save — check your connection.'); return false; }
    state.dbId = data.id;
  }
  return true;
}

async function fetchMyMatches() {
  const { data, error } = await sb
    .from('matches')
    .select('id, match_name, is_complete, state, updated_at')
    .order('updated_at', { ascending: false })
    .limit(25);
  if (error) { console.error('fetch matches failed', error); return []; }
  return data;
}

/* ============================================================
   STATE FACTORY
   ============================================================ */
function newTeam(name) { return { name, players: [] }; }

function newMatch() {
  return {
    dbId: null,
    matchName: '', totalOvers: 10, maxOversPerBowler: 2,
    teamA: newTeam(''), teamB: newTeam(''),
    battingFirst: null,     // 'A' | 'B'
    innings: [],
    currentInningsIndex: -1,
    matchOver: false,
    resultText: ''
  };
}

function newInnings(battingKey, bowlingKey, totalOvers, target) {
  return {
    battingTeam: battingKey,
    bowlingTeam: bowlingKey,
    totalRuns: 0,
    wickets: 0,
    legalBalls: 0,
    target: target || null,
    freeHitNext: false,
    lastOverBowler: null,
    striker: null,
    nonStriker: null,
    bowler: null,
    currentOverEvents: [],      // display chips for the over in progress
    battingCard: {},            // name -> {runs, balls, fours, sixes, out, howOut}
    bowlingCard: {},            // name -> {legalBalls, runsConceded, wickets, dotBallsThisOver, maidens}
    fallOfWickets: [],
    dotBalls: 0,                 // real running count of legal deliveries with 0 runs added
    overHistory: [{ over: 0, runs: 0, wickets: 0 }]  // real cumulative score snapshot per completed over
  };
}

function ensureBattingCard(inn, name) {
  if (!inn.battingCard[name]) {
    inn.battingCard[name] = { runs: 0, balls: 0, fours: 0, sixes: 0, out: false, howOut: '' };
  }
  return inn.battingCard[name];
}
function ensureBowlingCard(inn, name) {
  if (!inn.bowlingCard[name]) {
    inn.bowlingCard[name] = { legalBalls: 0, runsConceded: 0, wickets: 0, oversStarted: 0 };
  }
  return inn.bowlingCard[name];
}

/* ============================================================
   AUTH — Email OTP only. Password, phone/SMS, and OAuth (GitHub) have all
   been removed. This is the single, real Supabase Auth login path:
   signInWithOtp({ email }) to send a one-time code, verifyOtp(... type:'email')
   to redeem it into a real session. No OTP is ever generated, stored, or
   checked client-side — Supabase issues, emails, and validates it.
   ============================================================ */
const OTP_RESEND_SECONDS = 30;
let resendCooldownTimer = null;
let otpSentToEmail = null; // the exact email the current code was sent to

function isValidEmail(email) {
  // Simple, deliberately permissive shape check — Supabase does the real validation.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function wireAuth() {
  $('btnSendOtp').addEventListener('click', () => sendEmailOtp(false));
  $('btnResendOtp').addEventListener('click', () => sendEmailOtp(true));

  $('btnVerifyOtp').addEventListener('click', async () => {
    const email = (otpSentToEmail || $('authEmail').value.trim());
    const token = $('authOtp').value.trim();

    if (!token) { $('authHint').textContent = 'Enter the 6-digit code from your email.'; return; }
    if (!/^\d{6}$/.test(token)) { $('authHint').textContent = 'The code should be exactly 6 digits.'; return; }

    $('authHint').textContent = 'Verifying…';
    $('btnVerifyOtp').disabled = true;

    const { data, error } = await sb.auth.verifyOtp({ email, token, type: 'email' });

    $('btnVerifyOtp').disabled = false;

    if (error) {
      // Supabase distinguishes these cases in error.message; surface them plainly
      // rather than a generic failure, without ever accepting the code ourselves.
      const msg = /expired/i.test(error.message) ? 'That code has expired — send a new one.'
                : /invalid|token/i.test(error.message) ? 'That code is incorrect. Check it and try again.'
                : error.message;
      $('authHint').textContent = msg;
      return;
    }

    if (data.session) {
      onSignedIn(data.session.user);
    } else {
      $('authHint').textContent = 'Verified, but no session came back — please try signing in again.';
    }
  });

  $('btnSignOut').addEventListener('click', async () => {
    await sb.auth.signOut();
  });
}

async function sendEmailOtp(isResend) {
  const email = $('authEmail').value.trim();
  if (!email) { $('authHint').textContent = 'Enter your email address.'; return; }
  if (!isValidEmail(email)) { $('authHint').textContent = 'That doesn\u2019t look like a valid email address.'; return; }

  const sendBtn = isResend ? $('btnResendOtp') : $('btnSendOtp');
  sendBtn.disabled = true;
  $('authHint').textContent = isResend ? 'Resending…' : 'Sending…';

  // shouldCreateUser: true means this single flow covers both sign-up and sign-in —
  // Supabase creates the account on first use, no separate "create account" step needed.
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });

  if (error) {
    sendBtn.disabled = false;
    const msg = /rate limit/i.test(error.message)
      ? 'Too many requests — please wait a bit before trying again.'
      : error.message;
    $('authHint').textContent = msg;
    return;
  }

  otpSentToEmail = email;
  $('authOtp').value = '';
  $('authHint').textContent = `Code sent to ${email} — check your inbox.`;
  show($('otpRow'));
  startResendCooldown();
}

function startResendCooldown() {
  clearInterval(resendCooldownTimer);
  let remaining = OTP_RESEND_SECONDS;
  const btn = $('btnResendOtp');
  btn.disabled = true;
  btn.textContent = `Resend OTP (${remaining}s)`;
  resendCooldownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(resendCooldownTimer);
      btn.disabled = false;
      btn.textContent = 'Resend OTP';
    } else {
      btn.textContent = `Resend OTP (${remaining}s)`;
    }
  }, 1000);
}

function resetAuthForm() {
  clearInterval(resendCooldownTimer);
  otpSentToEmail = null;
  $('authEmail').value = '';
  $('authOtp').value = '';
  $('authHint').textContent = '';
  $('btnSendOtp').disabled = false;
  $('btnVerifyOtp').disabled = false;
  $('btnResendOtp').disabled = true;
  $('btnResendOtp').textContent = 'Resend OTP';
  hide($('otpRow'));
}

function onSignedIn(user) {
  currentUser = user;
  $('accountIdentity').textContent = user.email || 'Signed in';
  show($('accountBar'));
  resetAuthForm();
  state = null; history = [];
  showScreen('screen-landing');
  refreshMyMatchesList();
}

function onSignedOut() {
  currentUser = null;
  state = null; history = [];
  hide($('accountBar'));
  hide($('scoreboard'));
  resetAuthForm();
  showScreen('screen-role');
}

/* ============================================================
   ROLE SELECTION — the new front door. Admin goes into the
   existing email-OTP flow untouched; Viewer never touches auth
   at all and only ever reads data (enforced server-side by the
   `anon` SELECT-only RLS policy on `matches`).
   ============================================================ */
function wireRoleScreen() {
  $('btnRoleAdmin').addEventListener('click', () => {
    hide($('scoreboard'));
    showScreen('screen-auth');
  });
  $('btnRoleViewer').addEventListener('click', () => {
    enterViewerMode();
  });
  $('btnAuthBack').addEventListener('click', () => {
    resetAuthForm();
    hide($('scoreboard'));
    showScreen('screen-role');
  });
}

/* ============================================================
   VIEWER MODE — no login, no writes. Reads matches via the
   public `anon` SELECT policy and, for a live match, subscribes
   to Supabase Realtime so the score updates instantly as the
   admin scores each ball, on any number of other devices.
   ============================================================ */
let viewerChannel = null;

function stopViewerChannel() {
  if (viewerChannel) {
    sb.removeChannel(viewerChannel);
    viewerChannel = null;
  }
}

function wireViewer() {
  $('btnViewerBack').addEventListener('click', () => {
    stopViewerChannel();
    hide($('scoreboard'));
    showScreen('screen-role');
  });
  $('btnViewerLiveBack').addEventListener('click', () => {
    stopViewerChannel();
    hide($('scoreboard'));
    showScreen('screen-viewer-list');
    refreshViewerLists();
  });
  $('btnViewerScorecardBack').addEventListener('click', () => {
    stopViewerChannel();
    showScreen('screen-viewer-list');
    refreshViewerLists();
  });
}

async function enterViewerMode() {
  hide($('scoreboard'));
  showScreen('screen-viewer-list');
  await refreshViewerLists();
}

async function fetchPublicMatches() {
  const { data, error } = await sb
    .from('matches')
    .select('id, match_name, is_complete, state, updated_at')
    .order('updated_at', { ascending: false })
    .limit(50);
  if (error) { console.error('viewer fetch failed', error); return []; }
  return data;
}

async function refreshViewerLists() {
  $('viewerLiveHint').textContent = 'Loading…';
  $('viewerCompletedHint').textContent = 'Loading…';
  const rows = await fetchPublicMatches();
  const live = rows.filter(r => !r.is_complete);
  const completed = rows.filter(r => r.is_complete);
  renderViewerList($('viewerLiveList'), live, true);
  renderViewerList($('viewerCompletedList'), completed, false);
  $('viewerLiveHint').textContent = live.length ? '' : 'No matches in progress right now.';
  $('viewerCompletedHint').textContent = completed.length ? '' : 'No completed matches yet.';
}

function renderViewerList(listEl, rows, isLive) {
  listEl.innerHTML = '';
  rows.forEach(row => {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'match-info';
    const nameEl = document.createElement('span');
    nameEl.className = 'match-name';
    nameEl.textContent = row.match_name;
    const metaEl = document.createElement('span');
    metaEl.className = 'match-meta';
    metaEl.textContent = isLive ? viewerScoreSnippet(row.state) : (row.state.resultText || 'Completed');
    info.appendChild(nameEl); info.appendChild(metaEl);

    const btn = document.createElement('button');
    btn.textContent = isLive ? 'Watch live' : 'View scorecard';
    btn.addEventListener('click', () => isLive ? openViewerLive(row) : openViewerScorecard(row));

    li.appendChild(info);
    li.appendChild(btn);
    listEl.appendChild(li);
  });
}

function viewerScoreSnippet(matchState) {
  const inn = matchState.innings && matchState.innings[matchState.currentInningsIndex];
  if (!inn) return 'Not yet underway';
  const team = matchState[teamKeyToObj(inn.battingTeam)];
  return `${team.name} ${inn.totalRuns}/${inn.wickets} (${formatOvers(inn.legalBalls)} ov)`;
}

function openViewerLive(row) {
  state = row.state;
  $('viewerLiveMatchName').textContent = row.match_name;
  $('viewerLiveStatus').textContent = '';
  renderViewerLiveOrBreak();

  stopViewerChannel();
  viewerChannel = sb
    .channel('viewer-match-' + row.id)
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'matches', filter: `id=eq.${row.id}`
    }, (payload) => {
      const prevState = state;
      state = payload.new.state;
      maybeCelebrateFromDiff(prevState, state);
      if (payload.new.is_complete) stopViewerChannel();
      renderViewerLiveOrBreak();
    })
    .subscribe();
}

/* Decides, from the real match state, whether to show the live ball-by-ball
   screen, the 1st-innings break scorecard+stats, or the final result. This is
   how a viewer automatically gets the innings scorecard and stats the moment
   the 1st innings ends — without needing to do anything. */
function renderViewerLiveOrBreak() {
  const inn = currentInnings();
  if (!inn) { showScreen('screen-viewer-live'); return; }

  if (state.matchOver) {
    let html = '';
    state.innings.forEach(i => {
      const team = state[teamKeyToObj(i.battingTeam)];
      html += buildScorecardHTML(i) + buildStatsSectionHTML(state, i, team.name);
    });
    hide($('scoreboard'));
    $('viewerScorecardHeadline').textContent = state.resultText || state.matchName;
    $('viewerScorecardBody').innerHTML = html;
    showScreen('screen-viewer-scorecard');
    return;
  }

  const firstInningsDone = state.innings.length === 1 && inningsLooksComplete(state, inn);
  if (firstInningsDone) {
    const team = state[teamKeyToObj(inn.battingTeam)];
    hide($('scoreboard'));
    $('viewerScorecardHeadline').textContent = team.name + ' set the target';
    $('viewerScorecardBody').innerHTML = buildScorecardHTML(inn)
      + buildStatsSectionHTML(state, inn, team.name)
      + '<p class="hint">Waiting for the 2nd innings to start…</p>';
    showScreen('screen-viewer-scorecard');
    return;
  }

  renderScoreboard();
  renderViewerLiveDetail();
  showScreen('screen-viewer-live');
}

function renderViewerLiveDetail() {
  const inn = currentInnings();
  if (!inn) return;
  const strikerCard = ensureBattingCard(inn, inn.striker);
  const nonStrikerCard = ensureBattingCard(inn, inn.nonStriker);
  const bowlCard = ensureBowlingCard(inn, inn.bowler);

  $('vwStriker').textContent = inn.striker || '—';
  $('vwStrikerStats').textContent = `${strikerCard.runs} (${strikerCard.balls})`;
  $('vwNonStriker').textContent = inn.nonStriker || '—';
  $('vwNonStrikerStats').textContent = `${nonStrikerCard.runs} (${nonStrikerCard.balls})`;
  $('vwBowler').textContent = inn.bowler || '—';
  $('vwBowlerStats').textContent = `${bowlCard.wickets}-${bowlCard.runsConceded}-${formatOvers(bowlCard.legalBalls)}`;

  const track = $('vwOverTrack');
  track.innerHTML = '';
  inn.currentOverEvents.forEach(ev => {
    const chip = document.createElement('span');
    chip.className = 'over-ball' + (ev.cls ? ' ' + ev.cls : '');
    chip.textContent = ev.label;
    track.appendChild(chip);
  });
}

function openViewerScorecard(row) {
  state = row.state;
  hide($('scoreboard'));
  $('viewerScorecardHeadline').textContent = state.resultText || state.matchName;
  let html = '';
  (state.innings || []).forEach(inn => {
    const team = state[teamKeyToObj(inn.battingTeam)];
    html += buildScorecardHTML(inn) + buildStatsSectionHTML(state, inn, team.name);
  });
  $('viewerScorecardBody').innerHTML = html;
  showScreen('screen-viewer-scorecard');
}

/* ============================================================
   BOOT
   ============================================================ */
window.addEventListener('DOMContentLoaded', () => {
  initTheme();
  playEntranceCinematic();
  wireRoleScreen();
  wireViewer();
  wireAuth();
  wireLandingAndSetup();
  wireToss();
  wireScoring();
  wireModals();
  wireBreakAndResult();

  sb.auth.onAuthStateChange((event, session) => {
    // TOKEN_REFRESHED / USER_UPDATED fire on a live, unchanged session — Supabase
    // does this automatically roughly every hour. Treating those as "sign in" was
    // a previous bug: it wiped an in-progress match and bounced the user back to
    // the landing screen mid-over. Only navigate on an actual sign-in or sign-out.
    if (event === 'SIGNED_OUT') { onSignedOut(); return; }
    if (!session || !session.user) { onSignedOut(); return; }
    if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') {
      onSignedIn(session.user);
    } else {
      // Keep identity fresh without disturbing whatever screen is currently open.
      currentUser = session.user;
      $('accountIdentity').textContent = session.user.email || 'Signed in';
    }
  });
});

/* ============================================================
   MY MATCHES (landing screen)
   ============================================================ */
async function refreshMyMatchesList() {
  $('myMatchesHint').textContent = 'Loading…';
  const rows = await fetchMyMatches();
  renderMyMatchesList(rows);
}

function renderMyMatchesList(rows) {
  const list = $('myMatchesList');
  list.innerHTML = '';
  if (!rows.length) {
    $('myMatchesHint').textContent = 'No matches yet — start one above.';
    return;
  }
  $('myMatchesHint').textContent = '';
  rows.forEach(row => {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'match-info';
    const nameEl = document.createElement('span');
    nameEl.className = 'match-name';
    nameEl.textContent = row.match_name;
    const metaEl = document.createElement('span');
    metaEl.className = 'match-meta';
    metaEl.textContent = row.is_complete ? (row.state.resultText || 'Completed') : 'In progress';
    info.appendChild(nameEl); info.appendChild(metaEl);

    const btn = document.createElement('button');
    btn.textContent = row.is_complete ? 'View' : 'Resume';
    btn.addEventListener('click', () => row.is_complete ? viewCompletedMatch(row) : resumeMatchRow(row));

    li.appendChild(info);
    li.appendChild(btn);
    list.appendChild(li);
  });
}

function resumeMatchRow(row) {
  state = row.state;
  history = [];
  renderScoreboard();
  if (state.currentInningsIndex === -1) {
    renderToss();
    showScreen('screen-toss');
  } else {
    renderScoringScreen();
    showScreen('screen-scoring');
  }
}

function viewCompletedMatch(row) {
  state = row.state;
  history = [];
  renderResultScreen();
  showScreen('screen-result');
}

/* ============================================================
   LANDING + SETUP
   ============================================================ */
function wireLandingAndSetup() {
  $('btnNewMatch').addEventListener('click', () => {
    state = newMatch();
    renderSetupPlayerLists();
    showScreen('screen-setup');
  });

  $('inTeamA').addEventListener('input', (e) => {
    $('labelTeamAPlayers').textContent = (e.target.value || 'Team A') + ' players';
  });
  $('inTeamB').addEventListener('input', (e) => {
    $('labelTeamBPlayers').textContent = (e.target.value || 'Team B') + ' players';
  });

  $('btnAddPlayerA').addEventListener('click', () => addPlayer('teamA', 'inPlayerA', 'listTeamA'));
  $('btnAddPlayerB').addEventListener('click', () => addPlayer('teamB', 'inPlayerB', 'listTeamB'));
  $('inPlayerA').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addPlayer('teamA', 'inPlayerA', 'listTeamA'); } });
  $('inPlayerB').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addPlayer('teamB', 'inPlayerB', 'listTeamB'); } });

  $('inOvers').addEventListener('input', () => {
    const overs = parseInt($('inOvers').value || '0', 10);
    if (overs > 0) $('inMaxOvers').value = Math.max(1, Math.ceil(overs / 5));
  });

  $('btnToToss').addEventListener('click', async () => {
    const name = $('inMatchName').value.trim() || 'Local Match';
    const teamAName = $('inTeamA').value.trim() || 'Team A';
    const teamBName = $('inTeamB').value.trim() || 'Team B';
    const overs = parseInt($('inOvers').value, 10) || 10;
    const maxOvers = parseInt($('inMaxOvers').value, 10) || Math.ceil(overs / 5);

    if (state.teamA.players.length < 2 || state.teamB.players.length < 2) {
      $('setupHint').textContent = 'Add at least 2 players per side to continue.';
      return;
    }
    $('setupHint').textContent = '';

    state.matchName = name;
    state.teamA.name = teamAName;
    state.teamB.name = teamBName;
    state.totalOvers = overs;
    state.maxOversPerBowler = maxOvers;

    $('btnToToss').disabled = true;
    const ok = await persistMatch();
    $('btnToToss').disabled = false;
    if (!ok) return;

    renderToss();
    showScreen('screen-toss');
  });
}

function addPlayer(teamKey, inputId, listId) {
  const input = $(inputId);
  const name = input.value.trim();
  if (!name) return;
  if (state[teamKey].players.includes(name)) { toast('Already added.'); return; }
  state[teamKey].players.push(name);
  input.value = '';
  renderSetupPlayerLists();
  input.focus();
}

function removePlayer(teamKey, name) {
  state[teamKey].players = state[teamKey].players.filter(p => p !== name);
  renderSetupPlayerLists();
}

function renderSetupPlayerLists() {
  ['A', 'B'].forEach(k => {
    const teamKey = 'team' + k;
    const list = $('listTeam' + k);
    list.innerHTML = '';
    state[teamKey].players.forEach(name => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(name)}</span>`;
      const btn = document.createElement('button');
      btn.textContent = '✕';
      btn.addEventListener('click', () => removePlayer(teamKey, name));
      li.appendChild(btn);
      list.appendChild(li);
    });
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ============================================================
   TOSS
   ============================================================ */
function wireToss() {
  $('btnBackSetup').addEventListener('click', () => showScreen('screen-setup'));
}

function renderToss() {
  $('tossLede').textContent = `${state.teamA.name} vs ${state.teamB.name} — ${state.totalOvers} overs a side. Who bats first?`;
  const wrap = $('tossChoice');
  wrap.innerHTML = '';
  [['A', state.teamA.name], ['B', state.teamB.name]].forEach(([key, name]) => {
    const btn = document.createElement('button');
    btn.className = 'toss-option';
    btn.innerHTML = `${escapeHtml(name)} bat first <small>${escapeHtml(name)} choose to open the batting</small>`;
    btn.addEventListener('click', () => startFirstInnings(key));
    wrap.appendChild(btn);
  });
}

function startFirstInnings(battingKey) {
  const bowlingKey = battingKey === 'A' ? 'B' : 'A';
  state.battingFirst = battingKey;
  const inn = newInnings(battingKey, bowlingKey, state.totalOvers, null);
  state.innings.push(inn);
  state.currentInningsIndex = 0;
  saveState();
  openOpenersModal('1st innings — set your openers');
}

/* ============================================================
   OPENERS MODAL (shared for both innings)
   ============================================================ */
function openOpenersModal(eyebrowText) {
  $('openersEyebrow').textContent = eyebrowText;
  const inn = currentInnings();
  const battingTeam = state[teamKeyToObj(inn.battingTeam)];
  const bowlingTeam = state[teamKeyToObj(inn.bowlingTeam)];

  fillSelect('selectStriker', battingTeam.players);
  fillSelect('selectNonStriker', battingTeam.players);
  fillSelect('selectOpeningBowler', bowlingTeam.players);
  // default non-striker to 2nd player
  if (battingTeam.players.length > 1) $('selectNonStriker').value = battingTeam.players[1];

  show($('modalOpeners'));
}

function teamKeyToObj(k) { return k === 'A' ? 'teamA' : 'teamB'; }

function fillSelect(id, options, excludeSet) {
  const sel = $(id);
  sel.innerHTML = '';
  options.forEach(o => {
    if (excludeSet && excludeSet.has(o)) return;
    const opt = document.createElement('option');
    opt.value = o; opt.textContent = o;
    sel.appendChild(opt);
  });
}

function wireModals() {
  $('btnConfirmOpeners').addEventListener('click', () => {
    const striker = $('selectStriker').value;
    const nonStriker = $('selectNonStriker').value;
    const bowler = $('selectOpeningBowler').value;
    if (!striker || !nonStriker || striker === nonStriker) { toast('Pick two different batters.'); return; }
    const inn = currentInnings();
    inn.striker = striker;
    inn.nonStriker = nonStriker;
    inn.bowler = bowler;
    inn.lastOverBowler = null;
    ensureBattingCard(inn, striker);
    ensureBattingCard(inn, nonStriker);
    ensureBowlingCard(inn, bowler);
    hide($('modalOpeners'));
    saveState();
    renderScoreboard();
    renderScoringScreen();
    showScreen('screen-scoring');
  });

  /* ---- new bowler modal ---- */
  $('btnConfirmBowler').addEventListener('click', () => {
    const inn = currentInnings();
    const bowler = $('selectBowler').value;
    inn.bowler = bowler;
    ensureBowlingCard(inn, bowler);
    hide($('modalBowler'));
    saveState();
    renderScoringScreen();
  });

  /* ---- wicket modal ---- */
  $('btnCancelWicket').addEventListener('click', () => hide($('modalWicket')));
  $('selectDismissal').addEventListener('change', updateWicketModalVisibility);
  $('btnConfirmWicket').addEventListener('click', confirmWicket);

  /* ---- bye/legbye run picker ---- */
  document.querySelectorAll('#modalByeRuns [data-byerun]').forEach(btn => {
    btn.addEventListener('click', () => {
      const runs = parseInt(btn.dataset.byerun, 10);
      hide($('modalByeRuns'));
      applyByeOrLegBye(modalByeRuns._type, runs);
    });
  });
  $('btnCancelBye').addEventListener('click', () => hide($('modalByeRuns')));
}

/* ============================================================
   SCORING SCREEN — wiring
   ============================================================ */
function wireScoring() {
  document.querySelectorAll('.btn-run[data-run]').forEach(btn => {
    btn.addEventListener('click', () => applyRuns(parseInt(btn.dataset.run, 10)));
  });
  $('btnWide').addEventListener('click', applyWide);
  $('btnNoBall').addEventListener('click', applyNoBall);
  $('btnBye').addEventListener('click', () => openByeModal('bye'));
  $('btnLegBye').addEventListener('click', () => openByeModal('legbye'));
  $('btnWicket').addEventListener('click', openWicketModal);
  $('btnUndo').addEventListener('click', undoLastBall);
}

function currentInnings() { return state.innings[state.currentInningsIndex]; }

function pushHistory() {
  history.push(clone(state));
  if (history.length > 150) history.shift();
}

function undoLastBall() {
  if (!history.length) { toast('Nothing to undo yet.'); return; }
  state = history.pop();
  saveState();
  renderScoreboard();
  renderScoringScreen();
  toast('Last ball undone.');
  const undoBtn = $('btnUndo');
  if (undoBtn) {
    undoBtn.classList.remove('rewind');
    void undoBtn.offsetWidth;
    undoBtn.classList.add('rewind');
  }
}

/* ---------- core ball application ---------- */
function applyRuns(runs) {
  pushHistory();
  const inn = currentInnings();
  const bat = ensureBattingCard(inn, inn.striker);
  const bowl = ensureBowlingCard(inn, inn.bowler);

  bat.runs += runs; bat.balls += 1;
  if (runs === 4) bat.fours += 1;
  if (runs === 6) bat.sixes += 1;

  bowl.legalBalls += 1; bowl.runsConceded += runs;

  inn.totalRuns += runs;
  inn.legalBalls += 1;
  if (runs === 0) inn.dotBalls += 1;

  pushOverChip(inn, runs === 4 ? '4' : runs === 6 ? '6' : String(runs), runs === 4 ? 'boundary4' : runs === 6 ? 'boundary6' : '');
  if (runs === 4) triggerCelebration('four');
  if (runs === 6) triggerCelebration('six');

  const wasFreeHit = inn.freeHitNext;
  inn.freeHitNext = false;

  if (runs % 2 === 1) swapStrike(inn);
  finishBallCommon(inn, wasFreeHit);
}

function applyWide() {
  pushHistory();
  const inn = currentInnings();
  const bowl = ensureBowlingCard(inn, inn.bowler);
  bowl.runsConceded += 1;
  inn.totalRuns += 1;
  pushOverChip(inn, 'Wd', 'extra');
  saveState();
  renderScoreboard();
  renderScoringScreen();
  checkInningsEnd();
}

function applyNoBall() {
  pushHistory();
  const inn = currentInnings();
  const bowl = ensureBowlingCard(inn, inn.bowler);
  bowl.runsConceded += 1;
  inn.totalRuns += 1;
  inn.freeHitNext = true;
  pushOverChip(inn, 'Nb', 'extra');
  saveState();
  renderScoreboard();
  renderScoringScreen();
  checkInningsEnd();
}

let modalByeRuns = { _type: 'bye' };
function openByeModal(type) {
  modalByeRuns._type = type;
  $('byeModalLabel').textContent = type === 'bye' ? 'Bye' : 'Leg Bye';
  show($('modalByeRuns'));
}
function applyByeOrLegBye(type, runs) {
  pushHistory();
  const inn = currentInnings();
  const bowl = ensureBowlingCard(inn, inn.bowler);
  bowl.legalBalls += 1; // counts as a legal delivery, but no runs against bowler
  inn.totalRuns += runs;
  inn.legalBalls += 1;
  pushOverChip(inn, (type === 'bye' ? 'B' : 'Lb') + runs, 'extra');
  const wasFreeHit = inn.freeHitNext;
  inn.freeHitNext = false;
  if (runs % 2 === 1) swapStrike(inn);
  finishBallCommon(inn, wasFreeHit);
}

function pushOverChip(inn, label, cls) {
  inn.currentOverEvents.push({ label, cls });
}

function swapStrike(inn) {
  const t = inn.striker; inn.striker = inn.nonStriker; inn.nonStriker = t;
}

/* called after any LEGAL ball (runs, bye, legbye, or a wicket ball) */
function finishBallCommon(inn, wasFreeHit) {
  saveState();
  renderScoreboard();

  if (checkInningsEnd()) return; // innings may have just ended

  if (inn.legalBalls % 6 === 0) {
    // over complete: record the real score at this point, swap ends, ask for next bowler
    inn.overHistory.push({ over: inn.legalBalls / 6, runs: inn.totalRuns, wickets: inn.wickets });
    swapStrike(inn);
    inn.currentOverEvents = [];
    inn.lastOverBowler = inn.bowler;
    openBowlerModal();
  } else {
    renderScoringScreen();
  }
}

function openBowlerModal() {
  const inn = currentInnings();
  const bowlingTeam = state[teamKeyToObj(inn.bowlingTeam)];
  fillSelect('selectBowler', bowlingTeam.players);
  // default-select someone who isn't the last bowler, if possible
  const opts = [...$('selectBowler').options];
  const notLast = opts.find(o => o.value !== inn.lastOverBowler);
  if (notLast) $('selectBowler').value = notLast.value;

  const maxLegal = state.maxOversPerBowler * 6;
  $('bowlerWarning').textContent = '';
  $('selectBowler').onchange = () => {
    const chosen = $('selectBowler').value;
    if (chosen === inn.lastOverBowler) {
      $('bowlerWarning').textContent = "Same bowler can't bowl consecutive overs — pick someone else.";
    } else {
      const card = inn.bowlingCard[chosen];
      const bowled = card ? card.legalBalls : 0;
      if (bowled >= maxLegal) {
        $('bowlerWarning').textContent = `Heads up — ${chosen} has already bowled the max ${state.maxOversPerBowler} overs.`;
      } else {
        $('bowlerWarning').textContent = '';
      }
    }
  };
  $('selectBowler').onchange();
  show($('modalBowler'));
}

/* ---------- wicket flow ---------- */
function openWicketModal() {
  const inn = currentInnings();
  fillSelect('selectOutBatter', [inn.striker, inn.nonStriker]);
  const dismissSel = $('selectDismissal');
  // Reset options each time (LBW intentionally excluded — local rules waive it)
  dismissSel.value = 'Bowled';
  updateWicketModalVisibility();

  const battingTeam = state[teamKeyToObj(inn.battingTeam)];
  const outAlready = new Set(Object.keys(inn.battingCard).filter(n => inn.battingCard[n].out));
  const onCrease = new Set([inn.striker, inn.nonStriker]);
  const available = battingTeam.players.filter(p => !outAlready.has(p) && !onCrease.has(p));
  fillSelect('selectNewBatter', available);

  if (inn.freeHitNext) {
    $('freeHitDismissHint').textContent = "It's a free hit — only a run out counts here.";
  } else {
    $('freeHitDismissHint').textContent = '';
  }

  show($('modalWicket'));
}

function updateWicketModalVisibility() {
  const type = $('selectDismissal').value;
  // new batter not needed if it's the last man... but we don't track that strictly; always show.
  show($('rowNewBatter'));
}

function confirmWicket() {
  const inn = currentInnings();
  if (inn.freeHitNext && $('selectDismissal').value !== 'Run Out') {
    toast("Free hit — only Run Out is a valid dismissal.");
    return;
  }
  pushHistory();

  const outBatter = $('selectOutBatter').value;
  const dismissal = $('selectDismissal').value;
  const newBatter = $('selectNewBatter').value;
  const bowlerName = inn.bowler;

  const bat = ensureBattingCard(inn, outBatter);
  bat.out = true;
  const bowlerCredited = ['Bowled', 'Caught', 'Stumped', 'Hit Wicket'].includes(dismissal);
  bat.howOut = bowlerCredited ? `${dismissal} b ${bowlerName}` : dismissal;

  const bowl = ensureBowlingCard(inn, bowlerName);
  bowl.legalBalls += 1;
  if (dismissal !== 'Run Out' && dismissal !== 'Retired') bowl.wickets += 1;
  bat.balls += 1;

  inn.wickets += 1;
  inn.legalBalls += 1;
  inn.dotBalls += 1;
  inn.fallOfWickets.push({ score: inn.totalRuns, wicket: inn.wickets, batter: outBatter, over: formatOvers(inn.legalBalls), ballsAtFall: inn.legalBalls });

  pushOverChip(inn, 'W', 'wicket');
  triggerCelebration('wicket');

  if (outBatter === inn.striker) inn.striker = newBatter || null;
  else inn.nonStriker = newBatter || null;
  if (newBatter) ensureBattingCard(inn, newBatter);

  const wasFreeHit = inn.freeHitNext;
  inn.freeHitNext = false;

  hide($('modalWicket'));
  finishBallCommon(inn, wasFreeHit);
}

/* ============================================================
   INNINGS / MATCH END DETECTION
   ============================================================ */
function checkInningsEnd() {
  const inn = currentInnings();
  const battingTeam = state[teamKeyToObj(inn.battingTeam)];
  const maxLegal = state.totalOvers * 6;
  const allOut = inn.wickets >= battingTeam.players.length - 1;
  const oversUp = inn.legalBalls >= maxLegal;
  const chased = inn.target !== null && inn.totalRuns >= inn.target;

  if (allOut || oversUp || chased) {
    inn.overHistory.push({ over: inn.legalBalls / 6, runs: inn.totalRuns, wickets: inn.wickets });
    if (state.currentInningsIndex === 0) {
      endFirstInnings();
    } else {
      endMatch();
    }
    return true;
  }
  return false;
}

function endFirstInnings() {
  saveState();
  renderBreakScreen();
  showScreen('screen-break');
}

function endMatch() {
  const inn2 = state.innings[1];
  const inn1 = state.innings[0];
  const team1 = state[teamKeyToObj(inn1.battingTeam)];
  const team2 = state[teamKeyToObj(inn2.battingTeam)];

  if (inn2.totalRuns >= inn2.target) {
    const wicketsInHand = 10 - inn2.wickets; // informational; real "in hand" = players.length-1-wickets
    const battersAvail = team2.players.length - 1;
    const inHand = battersAvail - inn2.wickets;
    state.resultText = `${team2.name} won by ${inHand} wicket${inHand === 1 ? '' : 's'}`;
  } else if (inn2.totalRuns === inn2.target - 1) {
    state.resultText = 'Match tied';
  } else {
    const margin = (inn2.target - 1) - inn2.totalRuns;
    state.resultText = `${team1.name} won by ${margin} run${margin === 1 ? '' : 's'}`;
  }
  state.matchOver = true;
  saveState();
  renderResultScreen();
  showScreen('screen-result');
}

/* ============================================================
   BREAK / START 2ND INNINGS
   ============================================================ */
function wireBreakAndResult() {
  $('btnStartSecondInnings').addEventListener('click', () => {
    const inn1 = state.innings[0];
    const target = inn1.totalRuns + 1;
    const bowlingKey = inn1.battingTeam; // team that bowled first now bats
    const battingKey = inn1.bowlingTeam;
    const inn2 = newInnings(battingKey, bowlingKey, state.totalOvers, target);
    state.innings.push(inn2);
    state.currentInningsIndex = 1;
    saveState();
    openOpenersModal('2nd innings — set your openers');
  });

  $('btnCopyCard').addEventListener('click', copyScorecardText);
  $('btnFreshMatch').addEventListener('click', () => {
    state = null; history = [];
    hide($('scoreboard'));
    showScreen('screen-landing');
    refreshMyMatchesList();
  });
}

/* ============================================================
   RENDERERS
   ============================================================ */
function formatOvers(legalBalls) {
  const overs = Math.floor(legalBalls / 6);
  const balls = legalBalls % 6;
  return `${overs}.${balls}`;
}

function renderScoreboard() {
  const inn = currentInnings();
  if (!inn) { hide($('scoreboard')); return; }
  show($('scoreboard'));

  $('sbMatchName').textContent = state.matchName;
  const battingTeamObj = state[teamKeyToObj(inn.battingTeam)];
  $('sbBattingTeam').textContent = battingTeamObj.name;

  setFlipGroup('flipRuns', String(inn.totalRuns));
  setFlipGroup('flipWkts', String(inn.wickets));

  $('sbOvers').textContent = formatOvers(inn.legalBalls) + ` / ${state.totalOvers}`;

  const oversFloat = inn.legalBalls / 6;
  const crr = oversFloat > 0 ? (inn.totalRuns / oversFloat).toFixed(2) : '0.00';
  $('sbCRR').textContent = `CRR ${crr}`;

  $('sbThisOver').textContent = inn.currentOverEvents.map(e => e.label).join(' ');

  if (inn.target) {
    const ballsLeft = state.totalOvers * 6 - inn.legalBalls;
    const runsNeeded = inn.target - inn.totalRuns;
    if (runsNeeded > 0 && ballsLeft > 0) {
      const rrr = (runsNeeded / (ballsLeft / 6)).toFixed(2);
      $('sbTarget').textContent = `Need ${runsNeeded} off ${ballsLeft} · RRR ${rrr}`;
    } else {
      $('sbTarget').textContent = `Target ${inn.target}`;
    }
  } else {
    $('sbTarget').textContent = '';
  }

  if (inn.freeHitNext) $('sbFreeHit').classList.add('show'); else $('sbFreeHit').classList.remove('show');
}

function setFlipGroup(id, valueStr) {
  const group = $(id);
  const digits = valueStr.split('');
  const existing = group.dataset.value || '';
  group.innerHTML = '';
  digits.forEach((d, i) => {
    const box = document.createElement('div');
    box.className = 'flip-digit';
    box.textContent = d;
    if (existing !== valueStr) box.classList.add('flip');
    group.appendChild(box);
  });
  group.dataset.value = valueStr;
}

function renderScoringScreen() {
  const inn = currentInnings();
  if (!inn) return;
  $('inningsLabel').textContent = (state.currentInningsIndex === 0 ? '1st' : '2nd') + ' innings';

  const strikerCard = ensureBattingCard(inn, inn.striker);
  const nonStrikerCard = ensureBattingCard(inn, inn.nonStriker);
  const bowlCard = ensureBowlingCard(inn, inn.bowler);

  $('nameStriker').textContent = inn.striker || '—';
  $('statsStriker').textContent = `${strikerCard.runs} (${strikerCard.balls})`;
  $('nameNonStriker').textContent = inn.nonStriker || '—';
  $('statsNonStriker').textContent = `${nonStrikerCard.runs} (${nonStrikerCard.balls})`;
  $('nameBowler').textContent = inn.bowler || '—';
  const overStr = formatOvers(bowlCard.legalBalls);
  $('statsBowler').textContent = `${bowlCard.wickets}-${bowlCard.runsConceded}-${overStr}`;

  const track = $('overTrack');
  track.innerHTML = '';
  inn.currentOverEvents.forEach(ev => {
    const chip = document.createElement('span');
    chip.className = 'over-ball' + (ev.cls ? ' ' + ev.cls : '');
    chip.textContent = ev.label;
    track.appendChild(chip);
  });
}

/* ---------- scorecard table builder (shared by break + result) ---------- */
function buildScorecardHTML(inn) {
  const battingTeam = state[teamKeyToObj(inn.battingTeam)];
  let html = `<h3 class="sc-team-title">${escapeHtml(battingTeam.name)}</h3>`;
  html += `<table class="sc-table"><thead><tr><th>Batter</th><th class="num">R</th><th class="num">B</th><th class="num">4s</th><th class="num">6s</th></tr></thead><tbody>`;
  battingTeam.players.forEach(name => {
    const c = inn.battingCard[name];
    if (!c) return; // didn't bat
    html += `<tr><td>${escapeHtml(name)}${c.out ? '' : ' *'}<br><small style="color:var(--ink-soft)">${c.out ? escapeHtml(c.howOut) : (name===inn.striker||name===inn.nonStriker? 'not out':'')}</small></td>`;
    html += `<td class="num">${c.runs}</td><td class="num">${c.balls}</td><td class="num">${c.fours}</td><td class="num">${c.sixes}</td></tr>`;
  });
  html += `</tbody></table>`;
  const extras = inn.totalRuns - Object.values(inn.battingCard).reduce((s, c) => s + c.runs, 0);
  html += `<p class="sc-total-line">${inn.totalRuns}/${inn.wickets} in ${formatOvers(inn.legalBalls)} overs</p>`;
  html += `<p class="sc-extras-line">Extras: ${extras}</p>`;

  const bowlingTeam = state[teamKeyToObj(inn.bowlingTeam)];
  html += `<table class="sc-table"><thead><tr><th>Bowler</th><th class="num">O</th><th class="num">R</th><th class="num">W</th><th class="num">Econ</th></tr></thead><tbody>`;
  bowlingTeam.players.forEach(name => {
    const c = inn.bowlingCard[name];
    if (!c) return;
    const overs = c.legalBalls / 6;
    const econ = overs > 0 ? (c.runsConceded / overs).toFixed(2) : '0.00';
    html += `<tr><td>${escapeHtml(name)}</td><td class="num">${formatOvers(c.legalBalls)}</td><td class="num">${c.runsConceded}</td><td class="num">${c.wickets}</td><td class="num">${econ}</td></tr>`;
  });
  html += `</tbody></table>`;
  return html;
}

/* ---------- post-innings stats (built entirely from real, already-tracked match data) ---------- */
function inningsLooksComplete(matchState, inn) {
  const battingTeam = matchState[teamKeyToObj(inn.battingTeam)];
  const maxLegal = matchState.totalOvers * 6;
  const allOut = inn.wickets >= battingTeam.players.length - 1;
  const oversUp = inn.legalBalls >= maxLegal;
  const chased = inn.target !== null && inn.totalRuns >= inn.target;
  return allOut || oversUp || chased;
}

function computeTopBatter(inn) {
  const entries = Object.entries(inn.battingCard);
  if (!entries.length) return null;
  entries.sort((a, b) => {
    if (b[1].runs !== a[1].runs) return b[1].runs - a[1].runs;
    return a[1].balls - b[1].balls;
  });
  const [name, c] = entries[0];
  const sr = c.balls > 0 ? ((c.runs / c.balls) * 100).toFixed(1) : '0.0';
  return { name, runs: c.runs, balls: c.balls, sr, fours: c.fours, sixes: c.sixes };
}

function computeBestBowler(inn) {
  const entries = Object.entries(inn.bowlingCard);
  if (!entries.length) return null;
  entries.sort((a, b) => {
    if (b[1].wickets !== a[1].wickets) return b[1].wickets - a[1].wickets;
    return a[1].runsConceded - b[1].runsConceded;
  });
  const [name, c] = entries[0];
  const overs = c.legalBalls / 6;
  const econ = overs > 0 ? (c.runsConceded / overs).toFixed(2) : '0.00';
  return { name, oversStr: formatOvers(c.legalBalls), runs: c.runsConceded, wickets: c.wickets, econ };
}

function computeInningsSummary(inn) {
  const oversFloat = inn.legalBalls / 6;
  const runRate = oversFloat > 0 ? (inn.totalRuns / oversFloat).toFixed(2) : '0.00';
  let fours = 0, sixes = 0;
  Object.values(inn.battingCard).forEach(c => { fours += c.fours; sixes += c.sixes; });
  const extras = inn.totalRuns - Object.values(inn.battingCard).reduce((s, c) => s + c.runs, 0);
  return {
    totalRuns: inn.totalRuns, wickets: inn.wickets, oversStr: formatOvers(inn.legalBalls),
    runRate, boundaries: fours + sixes, extras, dotBalls: inn.dotBalls || 0
  };
}

function niceCeil(n) {
  if (n <= 20) return Math.max(5, Math.ceil(n / 5) * 5);
  if (n <= 100) return Math.ceil(n / 10) * 10;
  if (n <= 300) return Math.ceil(n / 20) * 20;
  return Math.ceil(n / 50) * 50;
}

function xTickStep(maxOver) {
  if (maxOver <= 6) return 1;
  if (maxOver <= 12) return 2;
  if (maxOver <= 24) return 4;
  return 5;
}

function buildProgressionSVG(matchState, inn) {
  const history = inn.overHistory || [];
  if (history.length < 2) {
    return '<p class="hint">Ball-by-ball progression isn\u2019t available for this match.</p>';
  }
  const maxOver = matchState.totalOvers;
  const niceMaxRuns = niceCeil(Math.max.apply(null, history.map(p => p.runs).concat([1])));
  const w = 600, h = 190, padL = 40, padB = 26, padT = 14, padR = 16;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const xPos = (over) => padL + (Math.min(over, maxOver) / maxOver) * plotW;
  const yPos = (runs) => padT + plotH - (Math.min(runs, niceMaxRuns) / niceMaxRuns) * plotH;

  const pts = history.map(p => xPos(p.over).toFixed(1) + ',' + yPos(p.runs).toFixed(1)).join(' ');

  // soft emerald gradient fill under the progression line
  const fillPts = pts
    ? (padL.toFixed(1) + ',' + (padT + plotH).toFixed(1) + ' ' + pts + ' ' + (padL + plotW).toFixed(1) + ',' + (padT + plotH).toFixed(1))
    : '';
  const areaFill = fillPts
    ? '<polygon points="' + fillPts + '" fill="url(#gullyChartGrad)"/>'
    : '';
  const gradDef = '<defs><linearGradient id="gullyChartGrad" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0%" stop-color="var(--turf)" stop-opacity="0.35"/>'
    + '<stop offset="100%" stop-color="var(--turf)" stop-opacity="0"/>'
    + '</linearGradient></defs>';

  // real fall-of-wickets markers, placed using the actual ball count at dismissal
  // (not the "3.4" cricket-notation string, which is not a valid decimal fraction of an over)
  let wicketMarkers = '';
  (inn.fallOfWickets || []).forEach(fw => {
    const overNum = (typeof fw.ballsAtFall === 'number') ? fw.ballsAtFall / 6 : parseFloat(fw.over);
    const cx = xPos(overNum), cy = yPos(fw.score);
    wicketMarkers += '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="4.5" fill="var(--seam)" stroke="var(--ledger-white)" stroke-width="1.5"><title>' + escapeHtml(fw.batter) + ' — ' + fw.score + ' (' + fw.over + ' ov)</title></circle>';
  });

  // gold dots for boundaries (4s and 6s), spotted from run deltas between points
  let boundaryMarkers = '';
  let prevRuns = 0;
  history.forEach(p => {
    const deltaRuns = p.runs - prevRuns;
    if (deltaRuns === 4 || deltaRuns === 6) {
      const cx = xPos(p.over), cy = yPos(p.runs);
      boundaryMarkers += '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="3.2" fill="var(--tennis)" stroke="var(--surface)" stroke-width="1"/>';
    }
    prevRuns = p.runs;
  });

  // x-axis tick numbers (overs)
  const xStep = xTickStep(maxOver);
  let xTicks = [];
  for (let t = 0; t <= maxOver; t += xStep) xTicks.push(t);
  if (xTicks[xTicks.length - 1] !== maxOver) xTicks.push(maxOver);
  let xLabels = '';
  xTicks.forEach(t => {
    const tx = xPos(t);
    xLabels += '<line x1="' + tx.toFixed(1) + '" y1="' + padT + '" x2="' + tx.toFixed(1) + '" y2="' + (padT + plotH) + '" stroke="var(--line)" stroke-width="0.5" stroke-dasharray="2,3"/>';
    xLabels += '<text x="' + tx.toFixed(1) + '" y="' + (padT + plotH + 15) + '" font-size="9" fill="var(--ink-soft)" text-anchor="middle" font-family="var(--mono)">' + t + '</text>';
  });

  // y-axis tick numbers (runs) — 0, half, max
  const yTicks = [0, Math.round(niceMaxRuns / 2), niceMaxRuns];
  let yLabels = '';
  yTicks.forEach(v => {
    const ty = yPos(v);
    yLabels += '<line x1="' + padL + '" y1="' + ty.toFixed(1) + '" x2="' + (padL + plotW) + '" y2="' + ty.toFixed(1) + '" stroke="var(--line)" stroke-width="0.5" stroke-dasharray="2,3"/>';
    yLabels += '<text x="' + (padL - 6) + '" y="' + (ty + 3).toFixed(1) + '" font-size="9" fill="var(--ink-soft)" text-anchor="end" font-family="var(--mono)">' + v + '</text>';
  });

  return '<svg viewBox="0 0 ' + w + ' ' + h + '" class="progression-chart" preserveAspectRatio="xMidYMid meet">'
    + gradDef
    + yLabels + xLabels
    + '<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (padT + plotH) + '" stroke="var(--line)" stroke-width="1"/>'
    + '<line x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (padL + plotW) + '" y2="' + (padT + plotH) + '" stroke="var(--line)" stroke-width="1"/>'
    + areaFill
    + '<polyline points="' + pts + '" fill="none" stroke="var(--turf)" stroke-width="2.5"/>'
    + wicketMarkers
    + boundaryMarkers
    + '</svg>';
}

function buildStatsSectionHTML(matchState, inn, teamLabel) {
  const top = computeTopBatter(inn);
  const bowl = computeBestBowler(inn);
  const sum = computeInningsSummary(inn);
  const chart = buildProgressionSVG(matchState, inn);

  let html = '<div class="stats-block">';
  html += '<h4 class="stats-heading">' + escapeHtml(teamLabel) + ' — Innings Stats</h4>';

  html += '<div class="stats-cards">';
  if (top) {
    html += '<div class="stat-card"><p class="stat-card-label">Top Batting Performer</p>'
      + '<p class="stat-card-name">' + escapeHtml(top.name) + '</p>'
      + '<p class="stat-card-figure">' + top.runs + ' (' + top.balls + ') · SR ' + top.sr + '</p>'
      + '<p class="stat-card-sub">' + top.fours + 'x4 · ' + top.sixes + 'x6</p></div>';
  }
  if (bowl) {
    html += '<div class="stat-card"><p class="stat-card-label">Best Bowling Figure</p>'
      + '<p class="stat-card-name">' + escapeHtml(bowl.name) + '</p>'
      + '<p class="stat-card-figure">' + bowl.wickets + '/' + bowl.runs + ' (' + bowl.oversStr + ' ov)</p>'
      + '<p class="stat-card-sub">Econ ' + bowl.econ + '</p></div>';
  }
  html += '</div>';

  html += '<div class="stats-grid">'
    + '<div><span>' + sum.totalRuns + '/' + sum.wickets + '</span><small>Score</small></div>'
    + '<div><span>' + sum.oversStr + '</span><small>Overs</small></div>'
    + '<div><span>' + sum.runRate + '</span><small>Run Rate</small></div>'
    + '<div><span>' + sum.boundaries + '</span><small>Boundaries</small></div>'
    + '<div><span>' + sum.extras + '</span><small>Extras</small></div>'
    + '<div><span>' + sum.dotBalls + '</span><small>Dot Balls</small></div>'
    + '</div>';

  html += chart;
  html += '</div>';
  return html;
}

/* ============================================================
   CELEBRATIONS — short, non-blocking overlay animations for 4s, 6s,
   and wickets. Pure CSS keyframes driven by randomized inline custom
   properties; auto-dismisses so it never delays the next ball.
   ============================================================ */
function triggerCelebration(type) {
  const overlay = $('celebrateOverlay');
  if (!overlay) return;
  overlay.innerHTML = buildCelebrationMarkup(type);
  overlay.className = 'celebrate-overlay show ' + type;
  clearTimeout(triggerCelebration._t);
  const duration = type === 'wicket' ? 1400 : (type === 'six' ? 1700 : 1200);
  triggerCelebration._t = setTimeout(() => {
    overlay.className = 'celebrate-overlay hidden';
    overlay.innerHTML = '';
  }, duration);
}

function buildCelebrationMarkup(type) {
  if (type === 'wicket') {
    const b1x = (Math.random() * 50 - 90).toFixed(0);
    const b1r = (Math.random() * 140 - 70).toFixed(0);
    const b2x = (Math.random() * 50 + 40).toFixed(0);
    const b2r = (Math.random() * 140 - 70).toFixed(0);
    return '<div class="screen-flash wicket-flash"></div>'
      + '<div class="wicket-scene">'
      + '<div class="stumps-scene">'
      + '<div class="cricket-ball"></div>'
      + '<div class="stump s1"></div><div class="stump s2"></div><div class="stump s3"></div>'
      + '<div class="bail b1" style="--bx:' + b1x + 'px; --br:' + b1r + 'deg;"></div>'
      + '<div class="bail b2" style="--bx:' + b2x + 'px; --br:' + b2r + 'deg;"></div>'
      + '</div>'
      + '<div class="celebrate-banner">OUT!</div>'
      + '</div>';
  }

  const isSix = type === 'six';
  const count = isSix ? 60 : 32;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const turf = isDark ? '#2ECC8F' : '#0B4D3A';
  const gold = isDark ? '#F0C24B' : '#D4A537';
  const colorsFour = [turf, gold, '#FBF6EA', '#1A6B4F'];
  const colorsSix = [gold, '#F4D98A', turf, '#FBF6EA', '#8C1F28'];
  const palette = isSix ? colorsSix : colorsFour;

  let confetti = '';
  for (let i = 0; i < count; i++) {
    const x = (Math.random() * 140 - 70).toFixed(0);
    const dur = (0.9 + Math.random() * 0.8).toFixed(2);
    const delay = (Math.random() * 0.25).toFixed(2);
    const rot = (Math.random() * 360).toFixed(0);
    const c = palette[i % palette.length];
    confetti += '<span class="confetti-piece" style="--x:' + x + '; --dur:' + dur + 's; --delay:' + delay + 's; --rot:' + rot + 'deg; --c:' + c + ';"></span>';
  }

  let sparks = '';
  if (isSix) {
    const sparkCount = 26;
    for (let i = 0; i < sparkCount; i++) {
      const angle = (Math.PI * 2 * i) / sparkCount;
      const dist = 90 + Math.random() * 70;
      const tx = (Math.cos(angle) * dist).toFixed(0);
      const ty = (Math.sin(angle) * dist).toFixed(0);
      const dur = (0.6 + Math.random() * 0.45).toFixed(2);
      const c = palette[i % palette.length];
      sparks += '<span class="spark-piece" style="--tx:' + tx + 'px; --ty:' + ty + 'px; --dur:' + dur + 's; --c:' + c + ';"></span>';
    }
  }

  return '<div class="screen-flash"></div>'
    + confetti + sparks
    + '<div class="celebrate-banner">' + (isSix ? 'SIX!' : 'FOUR!') + '</div>';
}

/* From a viewer's realtime diff (no access to the actual button click),
   detect a just-scored boundary or wicket by comparing the current
   over's event chips before and after an update, and celebrate it too. */
function maybeCelebrateFromDiff(prevState, newState) {
  try {
    if (!prevState || !newState) return;
    const idx = newState.currentInningsIndex;
    if (idx == null || idx < 0 || idx !== prevState.currentInningsIndex) return;
    const prevInn = prevState.innings[idx];
    const newInn = newState.innings[idx];
    if (!prevInn || !newInn) return;
    if (newInn.currentOverEvents.length > prevInn.currentOverEvents.length) {
      const last = newInn.currentOverEvents[newInn.currentOverEvents.length - 1];
      if (last.cls === 'boundary4') triggerCelebration('four');
      else if (last.cls === 'boundary6') triggerCelebration('six');
      else if (last.cls === 'wicket') triggerCelebration('wicket');
    }
  } catch (e) { /* never let a celebration glitch interrupt live viewing */ }
}

function renderBreakScreen() {
  const inn = state.innings[0];
  const battingTeam = state[teamKeyToObj(inn.battingTeam)];
  const bowlingTeam = state[teamKeyToObj(inn.bowlingTeam)];
  $('breakHeadline').textContent = `${battingTeam.name} set ${inn.totalRuns + 1} to win`;
  $('breakSummary').textContent = `${battingTeam.name} scored ${inn.totalRuns}/${inn.wickets} in ${formatOvers(inn.legalBalls)} overs. ${bowlingTeam.name} need ${inn.totalRuns + 1} runs from ${state.totalOvers} overs.`;
  $('breakScorecard').innerHTML = buildScorecardHTML(inn) + buildStatsSectionHTML(state, inn, battingTeam.name);
}

function renderResultScreen() {
  $('resultHeadline').textContent = state.resultText;
  let html = '';
  state.innings.forEach(inn => {
    const team = state[teamKeyToObj(inn.battingTeam)];
    html += buildScorecardHTML(inn) + buildStatsSectionHTML(state, inn, team.name);
  });
  $('resultScorecard').innerHTML = html;
}

/* ============================================================
   SHARE AS TEXT
   ============================================================ */
function buildScorecardText() {
  let lines = [];
  lines.push(state.matchName);
  lines.push(state.resultText);
  lines.push('');
  state.innings.forEach(inn => {
    const battingTeam = state[teamKeyToObj(inn.battingTeam)];
    lines.push(`${battingTeam.name}: ${inn.totalRuns}/${inn.wickets} (${formatOvers(inn.legalBalls)} ov)`);
    battingTeam.players.forEach(name => {
      const c = inn.battingCard[name];
      if (!c) return;
      const status = c.out ? c.howOut : 'not out';
      lines.push(`  ${name} — ${c.runs} (${c.balls}b, ${c.fours}x4, ${c.sixes}x6) ${status}`);
    });
    lines.push('  Bowling:');
    const bowlingTeam = state[teamKeyToObj(inn.bowlingTeam)];
    bowlingTeam.players.forEach(name => {
      const c = inn.bowlingCard[name];
      if (!c) return;
      lines.push(`    ${name} — ${formatOvers(c.legalBalls)}-${c.runsConceded}-${c.wickets}`);
    });
    lines.push('');
  });
  return lines.join('\n');
}

function copyScorecardText() {
  const text = buildScorecardText();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => toast('Scorecard copied — paste it into your group chat.'),
      () => fallbackCopy(text)
    );
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toast('Scorecard copied.'); }
  catch { toast('Could not copy automatically — select the text manually.'); }
  document.body.removeChild(ta);
}