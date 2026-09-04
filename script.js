// ==========================================
// 1. CONFIGURACIÓN SUPABASE Y MULTIJUGADOR
// (mismo proyecto/tabla "perfiles" que usa el resto del casino)
// ==========================================
const supabaseUrl = 'https://wgqqbahoalozgfukioza.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndncXFiYWhvYWxvemdmdWtpb3phIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyNTA3OTYsImV4cCI6MjA5OTgyNjc5Nn0.v_kpYceS8ceIUBNaLLHjfyBeFA2Y3lDRy7Yn6cb5Uz8';
const supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey);

let displayUsername = localStorage.getItem('pk_username');
if (!displayUsername) {
    displayUsername = "Jugador_" + Math.floor(Math.random() * 9999);
    localStorage.setItem('pk_username', displayUsername);
}
let myPresenceKey = localStorage.getItem('pk_presence_key');
if (!myPresenceKey) {
    myPresenceKey = 'guest_' + Math.floor(Math.random() * 1000000);
    localStorage.setItem('pk_presence_key', myPresenceKey);
}
let usuarioAutenticado = null;
let pokerChannel = null;
let onlineCount = 1;
let isHost = false;

// ==========================================
// 2. CONSTANTES DE LA MESA
// ==========================================
const MAX_SEATS = 6;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
let bigBlindGlobal = BIG_BLIND; // usado desde el HTML (botones +/- de subida)
const ACTION_TIME = 20000;      // ms para actuar en el turno
const HAND_OVER_PAUSE = 12000;  // pausa mostrando resultados (da tiempo a levantarse antes de la próxima mano)
const WAITING_COUNTDOWN = 8000; // cuenta regresiva antes de arrancar mano

const suitMap = { '♥': 'corazones', '♦': 'diamantes', '♣': 'treboles', '♠': 'picas' };
const RANK_ORDER = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
function rankVal(v) { return RANK_ORDER.indexOf(v) + 2; }
function cardFile(c) { return `${c.v}_${suitMap[c.s]}.png`; }

// ==========================================
// 3. ESTADO GLOBAL COMPARTIDO
// ==========================================
let sharedState = {
    phase: 'WAITING', // WAITING, PREFLOP, FLOP, TURN, RIVER, SHOWDOWN, HAND_OVER
    phaseEndTime: Date.now() + WAITING_COUNTDOWN,
    seats: Array(MAX_SEATS).fill(null),
    dealerSeat: -1,
    sbSeat: -1,
    bbSeat: -1,
    handSeatOrder: [],
    communityCards: [],
    pot: 0,
    currentBet: 0,
    minRaise: BIG_BLIND,
    turnSeat: -1,
    message: '',
    pendingCashouts: {}
};

let savedHostState = localStorage.getItem('pk_host_state');
if (savedHostState) {
    try { sharedState = JSON.parse(savedHostState); } catch (e) {}
}

let secretHostDeck = [];
let savedHostDeck = localStorage.getItem('pk_host_deck');
if (savedHostDeck) {
    try { secretHostDeck = JSON.parse(savedHostDeck); } catch (e) {}
}

// ==========================================
// 4. ESTADO LOCAL DEL CLIENTE
// ==========================================
let balance = 5000;
let selectedBuyIn = 1000;
let raiseTarget = 0;
let lastMessageShown = '';

// Control de re-render: evita reconstruir las cartas cuando el estado no cambió
// (esto es lo que hacía que "saltaran" cada segundo) y recuerda cuántas cartas
// ya se mostraron para animar solo las nuevas.
let lastRenderSnapshot = null;
let prevCommunityCount = 0;
let prevSeatCardCount = {};

function cardImgHtml(src, isNew, delayMs) {
    let cls = isNew ? ' card-img deal-anim' : ' card-img';
    let style = isNew ? ` style="animation-delay:${delayMs}ms"` : '';
    return `<img src="${src}" class="${cls.trim()}"${style}>`;
}

window.onload = async () => {
    document.getElementById('rules-sb').innerText = SMALL_BLIND;
    document.getElementById('rules-bb').innerText = BIG_BLIND;
    await cargarPerfil();
    iniciarConexionMultijugador();
    renderGameUI();
    setInterval(gameLoop, 1000);
};

// ==========================================
// SALDO Y PERFIL
// ==========================================
async function cargarPerfil() {
    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session && session.user) {
            usuarioAutenticado = session.user;
            displayUsername = session.user.email ? session.user.email.split('@')[0] : "Jugador_VIP";
            localStorage.setItem('pk_username', displayUsername);

            const { data } = await supabaseClient.from('perfiles').select('saldo').eq('id', session.user.id).single();
            if (data && data.saldo != null) balance = data.saldo;
        } else {
            let savedBalance = localStorage.getItem('pk_balance');
            balance = savedBalance ? parseInt(savedBalance) : 5000;
        }
    } catch (e) { console.log("Error cargando perfil:", e); }
    updateBalanceUI();
}

async function modificarSaldo(monto) {
    balance += monto;
    updateBalanceUI();
    if (usuarioAutenticado) {
        try {
            await supabaseClient.from('perfiles').update({ saldo: balance }).eq('id', usuarioAutenticado.id);
        } catch (e) { console.log("Error guardando saldo:", e); }
    } else {
        localStorage.setItem('pk_balance', balance);
    }
}
function updateBalanceUI() { document.getElementById('balance').textContent = balance; }

// ==========================================
// 5. CONEXIÓN MULTIJUGADOR
// ==========================================
function iniciarConexionMultijugador() {
    pokerChannel = supabaseClient.channel('poker_room_sync', { config: { presence: { key: myPresenceKey } } });

    pokerChannel.on('presence', { event: 'sync' }, () => {
        let presences = pokerChannel.presenceState();
        let keys = Object.keys(presences).sort();
        onlineCount = keys.length || 1;
        document.getElementById('online-count-value').innerText = onlineCount;

        isHost = keys[0] === myPresenceKey;
        if (!isHost) {
            pokerChannel.send({ type: 'broadcast', event: 'request_state', payload: {} });
        }
    });

    pokerChannel.on('broadcast', { event: 'chat_message' }, (payload) => {
        mostrarMensajeEnChat(payload.payload.user, payload.payload.text);
    });

    pokerChannel.on('broadcast', { event: 'sync_state' }, (payload) => {
        sharedState = payload.payload.state;
        checkMyCashout();
        renderGameUI();
    });

    pokerChannel.on('broadcast', { event: 'request_state' }, () => {
        if (isHost) emitState();
    });

    pokerChannel.on('broadcast', { event: 'player_action' }, (payload) => {
        if (isHost) processAction(payload.payload);
    });

    pokerChannel.on('broadcast', { event: 'ack_cashout' }, (payload) => {
        if (isHost && sharedState.pendingCashouts) delete sharedState.pendingCashouts[payload.payload.user];
    });

    pokerChannel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') await pokerChannel.track({ online_at: new Date().toISOString() });
    });
}

function checkMyCashout() {
    if (sharedState.pendingCashouts && sharedState.pendingCashouts[displayUsername] != null) {
        let amt = sharedState.pendingCashouts[displayUsername];
        delete sharedState.pendingCashouts[displayUsername];
        modificarSaldo(amt);
        showToast(`Te levantaste de la mesa. +$${amt}`, true);
        if (pokerChannel) pokerChannel.send({ type: 'broadcast', event: 'ack_cashout', payload: { user: displayUsername } });
    }
}

function emitState() {
    if (isHost) {
        localStorage.setItem('pk_host_state', JSON.stringify(sharedState));
        localStorage.setItem('pk_host_deck', JSON.stringify(secretHostDeck));
    }
    if (pokerChannel) pokerChannel.send({ type: 'broadcast', event: 'sync_state', payload: { state: sharedState } });
    // El anfitrión no recibe su propio broadcast (Supabase no reenvía al emisor),
    // así que si es él quien tiene un cashout pendiente (p. ej. se levantó de la
    // mesa siendo host), hay que acreditárselo acá mismo o nunca cobra.
    checkMyCashout();
    renderGameUI();
}

function sendPlayerAction(action, extra = {}) {
    const payload = { action, user: displayUsername, ...extra };
    if (isHost) processAction(payload);
    if (pokerChannel) pokerChannel.send({ type: 'broadcast', event: 'player_action', payload });
}

// ==========================================
// 6. LÓGICA DEL ANFITRIÓN (HOST) - PROCESA ACCIONES
// ==========================================
function processAction(data) {
    switch (data.action) {
        case 'sit': handleSit(data.user, data.buyIn); break;
        case 'leave': handleLeaveRequest(data.user); break;
        case 'fold': applyPlayerAction(data.user, 'fold'); break;
        case 'check': applyPlayerAction(data.user, 'check'); break;
        case 'call': applyPlayerAction(data.user, 'call'); break;
        case 'raise': applyPlayerAction(data.user, 'raise', data.amount); break;
        case 'allin': applyPlayerAction(data.user, 'allin'); break;
    }
}

function findSeatByUser(user) { return sharedState.seats.findIndex(s => s && s.user === user); }
function seatedCount() { return sharedState.seats.filter(s => s).length; }
function hasEmptySeat() { return sharedState.seats.some(s => s === null); }

function handleSit(user, buyIn) {
    if (findSeatByUser(user) !== -1) return;
    let idx = sharedState.seats.findIndex(s => s === null);
    if (idx === -1) return;
    sharedState.seats[idx] = {
        user, stack: buyIn, holeCards: [], folded: false, allIn: false,
        betThisRound: 0, totalBetThisHand: 0, acted: false, sittingOut: false, leaving: false
    };
    if (sharedState.phase === 'WAITING' && seatedCount() >= 2) {
        sharedState.phaseEndTime = Date.now() + WAITING_COUNTDOWN;
    }
    emitState();
}

function handleLeaveRequest(user) {
    let idx = findSeatByUser(user);
    if (idx === -1) return;
    if (['WAITING', 'HAND_OVER'].includes(sharedState.phase)) {
        sharedState.pendingCashouts = sharedState.pendingCashouts || {};
        sharedState.pendingCashouts[user] = sharedState.seats[idx].stack;
        sharedState.seats[idx] = null;
    } else {
        sharedState.seats[idx].leaving = true;
        if (!sharedState.seats[idx].folded && sharedState.turnSeat === idx) {
            applyPlayerAction(user, 'fold'); // ya llama emitState()
            return;
        } else if (!sharedState.seats[idx].folded) {
            sharedState.seats[idx].folded = true;
        }
    }
    emitState();
}

function nextOccupied(fromIdx, activeSet) {
    for (let k = 1; k <= MAX_SEATS; k++) {
        let cand = (fromIdx + k) % MAX_SEATS;
        if (activeSet.has(cand)) return cand;
    }
    return fromIdx;
}

function generateSecureDeck() {
    let full = [];
    ['♥', '♦', '♣', '♠'].forEach(s => RANK_ORDER.forEach(v => full.push({ v, s })));
    full.sort(() => Math.random() - 0.5);
    return full;
}

function startNewHandIfReady() {
    let activeIdx = [];
    sharedState.seats.forEach((s, i) => { if (s && s.stack > 0 && !s.sittingOut) activeIdx.push(i); });

    if (activeIdx.length < 2) {
        sharedState.phase = 'WAITING';
        sharedState.turnSeat = -1;
        sharedState.communityCards = [];
        sharedState.pot = 0;
        sharedState.phaseEndTime = Date.now() + WAITING_COUNTDOWN;
        emitState();
        return;
    }

    const activeSet = new Set(activeIdx);
    sharedState.dealerSeat = sharedState.dealerSeat === -1 || !activeSet.has(sharedState.dealerSeat)
        ? activeIdx[0]
        : nextOccupied(sharedState.dealerSeat, activeSet);

    if (activeIdx.length === 2) {
        sharedState.sbSeat = sharedState.dealerSeat;
        sharedState.bbSeat = nextOccupied(sharedState.dealerSeat, activeSet);
    } else {
        sharedState.sbSeat = nextOccupied(sharedState.dealerSeat, activeSet);
        sharedState.bbSeat = nextOccupied(sharedState.sbSeat, activeSet);
    }

    // orden de la mano empezando en el SB
    let order = [];
    let idx = sharedState.sbSeat;
    for (let k = 0; k < activeIdx.length; k++) {
        order.push(idx);
        idx = nextOccupied(idx, activeSet);
    }
    sharedState.handSeatOrder = order;

    order.forEach(i => {
        sharedState.seats[i].holeCards = [];
        sharedState.seats[i].folded = false;
        sharedState.seats[i].allIn = false;
        sharedState.seats[i].betThisRound = 0;
        sharedState.seats[i].totalBetThisHand = 0;
        sharedState.seats[i].acted = false;
    });

    sharedState.communityCards = [];
    sharedState.pot = 0;
    sharedState.currentBet = 0;
    sharedState.minRaise = BIG_BLIND;
    sharedState.message = '';

    secretHostDeck = generateSecureDeck();

    postBlind(sharedState.sbSeat, SMALL_BLIND);
    postBlind(sharedState.bbSeat, BIG_BLIND);
    sharedState.currentBet = BIG_BLIND;

    order.forEach(i => { sharedState.seats[i].holeCards = [secretHostDeck.pop(), secretHostDeck.pop()]; });

    sharedState.turnSeat = findNextToAct(sharedState.bbSeat);
    sharedState.phase = 'PREFLOP';
    sharedState.phaseEndTime = Date.now() + ACTION_TIME;
    emitState();
}

function postBlind(seatIdx, amount) {
    let seat = sharedState.seats[seatIdx];
    let pay = Math.min(amount, seat.stack);
    seat.stack -= pay;
    seat.betThisRound += pay;
    seat.totalBetThisHand += pay;
    sharedState.pot += pay;
    if (seat.stack === 0) seat.allIn = true;
}

function findNextToAct(referenceSeatIdx) {
    const order = sharedState.handSeatOrder;
    let pos = order.indexOf(referenceSeatIdx);
    if (pos === -1) return -1;
    for (let k = 1; k <= order.length; k++) {
        let cand = order[(pos + k) % order.length];
        let s = sharedState.seats[cand];
        if (s && !s.folded && !s.allIn) return cand;
    }
    return -1;
}

function applyPlayerAction(user, action, amount) {
    let idx = findSeatByUser(user);
    if (idx === -1 || idx !== sharedState.turnSeat) return;
    if (!['PREFLOP', 'FLOP', 'TURN', 'RIVER'].includes(sharedState.phase)) return;
    let seat = sharedState.seats[idx];
    const prevCurrentBet = sharedState.currentBet;

    if (action === 'fold') {
        seat.folded = true; seat.acted = true;
    } else if (action === 'check') {
        if (seat.betThisRound !== sharedState.currentBet) return;
        seat.acted = true;
    } else if (action === 'call') {
        let diff = sharedState.currentBet - seat.betThisRound;
        let pay = Math.max(0, Math.min(diff, seat.stack));
        seat.stack -= pay; seat.betThisRound += pay; seat.totalBetThisHand += pay; sharedState.pot += pay;
        if (seat.stack === 0) seat.allIn = true;
        seat.acted = true;
    } else if (action === 'allin') {
        let pay = seat.stack;
        if (pay <= 0) return;
        seat.stack = 0; seat.betThisRound += pay; seat.totalBetThisHand += pay; sharedState.pot += pay;
        seat.allIn = true; seat.acted = true;
        if (seat.betThisRound > sharedState.currentBet) {
            sharedState.minRaise = Math.max(sharedState.minRaise, seat.betThisRound - prevCurrentBet);
            sharedState.currentBet = seat.betThisRound;
            sharedState.handSeatOrder.forEach(i => { if (i !== idx && sharedState.seats[i] && !sharedState.seats[i].folded && !sharedState.seats[i].allIn) sharedState.seats[i].acted = false; });
        }
    } else if (action === 'raise') {
        let target = Math.floor(amount);
        let maxTotal = seat.stack + seat.betThisRound;
        if (target > maxTotal) target = maxTotal;
        if (target <= sharedState.currentBet) return;
        if (target < maxTotal && (target - sharedState.currentBet) < sharedState.minRaise) return;
        let pay = target - seat.betThisRound;
        seat.stack -= pay; seat.betThisRound += pay; seat.totalBetThisHand += pay; sharedState.pot += pay;
        if (seat.stack === 0) seat.allIn = true;
        sharedState.minRaise = target - sharedState.currentBet;
        sharedState.currentBet = target;
        seat.acted = true;
        sharedState.handSeatOrder.forEach(i => { if (i !== idx && sharedState.seats[i] && !sharedState.seats[i].folded && !sharedState.seats[i].allIn) sharedState.seats[i].acted = false; });
    } else {
        return;
    }

    checkHandOrRoundProgress();
}

function checkHandOrRoundProgress() {
    const order = sharedState.handSeatOrder;
    let remaining = order.filter(i => sharedState.seats[i] && !sharedState.seats[i].folded);

    if (remaining.length === 1) {
        awardPotToSingleWinner(remaining[0]);
        return;
    }

    let activeToAct = remaining.filter(i => !sharedState.seats[i].allIn);
    let roundComplete = activeToAct.length === 0 || activeToAct.every(i => sharedState.seats[i].acted && sharedState.seats[i].betThisRound === sharedState.currentBet);

    if (roundComplete) {
        advancePhase();
    } else {
        sharedState.turnSeat = findNextToAct(sharedState.turnSeat);
        sharedState.phaseEndTime = Date.now() + ACTION_TIME;
        emitState();
    }
}

function dealCommunity(n) { for (let i = 0; i < n; i++) sharedState.communityCards.push(secretHostDeck.pop()); }

function advancePhase() {
    sharedState.handSeatOrder.forEach(i => { if (sharedState.seats[i]) { sharedState.seats[i].betThisRound = 0; sharedState.seats[i].acted = false; } });
    sharedState.currentBet = 0;
    sharedState.minRaise = BIG_BLIND;

    if (sharedState.phase === 'PREFLOP') { dealCommunity(3); sharedState.phase = 'FLOP'; }
    else if (sharedState.phase === 'FLOP') { dealCommunity(1); sharedState.phase = 'TURN'; }
    else if (sharedState.phase === 'TURN') { dealCommunity(1); sharedState.phase = 'RIVER'; }
    else if (sharedState.phase === 'RIVER') { doShowdown(); return; }

    const order = sharedState.handSeatOrder;
    let remaining = order.filter(i => sharedState.seats[i] && !sharedState.seats[i].folded);
    let activeToAct = remaining.filter(i => !sharedState.seats[i].allIn);

    if (activeToAct.length <= 1) {
        // todos (o casi todos) all-in: se revela el resto de la mesa solo, sin apuestas
        sharedState.turnSeat = -1;
        sharedState.phaseEndTime = Date.now() + 1600;
        emitState();
        setTimeout(() => { if (isHost) advancePhase(); }, 1700);
        return;
    }

    sharedState.turnSeat = findNextToAct(sharedState.dealerSeat);
    sharedState.phaseEndTime = Date.now() + ACTION_TIME;
    emitState();
}

function calculateSidePots() {
    const contributions = sharedState.handSeatOrder
        .map(i => ({ idx: i, total: sharedState.seats[i].totalBetThisHand, folded: sharedState.seats[i].folded }))
        .filter(x => x.total > 0);
    const levels = [...new Set(contributions.map(x => x.total))].sort((a, b) => a - b);
    let prev = 0, pots = [], sumAssigned = 0;
    levels.forEach(level => {
        let payers = contributions.filter(x => x.total >= level);
        let amount = (level - prev) * payers.length;
        let eligible = payers.filter(x => !x.folded).map(x => x.idx);
        if (amount > 0 && eligible.length > 0) { pots.push({ amount, eligible }); sumAssigned += amount; }
        else if (amount > 0 && pots.length > 0) { pots[pots.length - 1].amount += amount; sumAssigned += amount; }
        prev = level;
    });
    // red de seguridad por redondeos/casos borde
    let diff = sharedState.pot - sumAssigned;
    if (diff !== 0 && pots.length > 0) pots[pots.length - 1].amount += diff;
    return pots;
}

function doShowdown() {
    sharedState.phase = 'SHOWDOWN';
    const pots = calculateSidePots();
    let winnersMsgs = [];

    pots.forEach(potObj => {
        let best = null, winners = [];
        potObj.eligible.forEach(i => {
            let ev = evaluateBestHand(sharedState.seats[i].holeCards, sharedState.communityCards);
            sharedState.seats[i]._lastEvalName = ev.name;
            if (!best || compareRank(ev.rank, best) > 0) { best = ev.rank; winners = [i]; }
            else if (compareRank(ev.rank, best) === 0) { winners.push(i); }
        });
        let share = Math.floor(potObj.amount / winners.length);
        let remainder = potObj.amount - share * winners.length;
        winners.forEach((i, k) => {
            let amt = share + (k === 0 ? remainder : 0);
            sharedState.seats[i].stack += amt;
            winnersMsgs.push(`${sharedState.seats[i].user} +$${amt} (${sharedState.seats[i]._lastEvalName})`);
        });
    });

    sharedState.message = winnersMsgs.join(' | ');
    sharedState.pot = 0;
    sharedState.turnSeat = -1;
    sharedState.phase = 'HAND_OVER';
    sharedState.phaseEndTime = Date.now() + HAND_OVER_PAUSE;
    finalizarLimpiezaDeAsientos();
    emitState();
}

function awardPotToSingleWinner(idx) {
    sharedState.seats[idx].stack += sharedState.pot;
    sharedState.message = `${sharedState.seats[idx].user} gana $${sharedState.pot} (el resto se retiró)`;
    sharedState.pot = 0;
    sharedState.turnSeat = -1;
    sharedState.phase = 'HAND_OVER';
    sharedState.phaseEndTime = Date.now() + HAND_OVER_PAUSE;
    finalizarLimpiezaDeAsientos();
    emitState();
}

function finalizarLimpiezaDeAsientos() {
    sharedState.pendingCashouts = sharedState.pendingCashouts || {};
    sharedState.seats.forEach((s, i) => {
        if (s && (s.stack === 0 || s.leaving)) {
            sharedState.pendingCashouts[s.user] = s.stack;
            sharedState.seats[i] = null;
        }
    });
}

function autoActTimeout() {
    let seat = sharedState.seats[sharedState.turnSeat];
    if (!seat) return;
    let action = (seat.betThisRound === sharedState.currentBet) ? 'check' : 'fold';
    applyPlayerAction(seat.user, action);
}

// ==========================================
// 7. EVALUADOR DE MANOS DE POKER
// ==========================================
function combinations5(cards) {
    const result = [], n = cards.length;
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++)
            result.push([cards[a], cards[b], cards[c], cards[d], cards[e]]);
    return result;
}

function evaluate5(cards) {
    let values = cards.map(c => rankVal(c.v)).sort((a, b) => b - a);
    let suits = cards.map(c => c.s);
    let isFlush = suits.every(s => s === suits[0]);
    let uniqueVals = [...new Set(values)];
    let isStraight = false, straightHigh = 0;
    if (uniqueVals.length === 5) {
        if (uniqueVals[0] - uniqueVals[4] === 4) { isStraight = true; straightHigh = uniqueVals[0]; }
        else if (uniqueVals[0] === 14 && uniqueVals[1] === 5 && uniqueVals[2] === 4 && uniqueVals[3] === 3 && uniqueVals[4] === 2) { isStraight = true; straightHigh = 5; }
    }
    let counts = {};
    values.forEach(v => counts[v] = (counts[v] || 0) + 1);
    let groups = Object.entries(counts).map(([v, c]) => ({ v: parseInt(v), c })).sort((a, b) => b.c - a.c || b.v - a.v);

    if (isStraight && isFlush) return { rank: [8, straightHigh], name: 'Escalera de color' };
    if (groups[0].c === 4) return { rank: [7, groups[0].v, groups[1].v], name: 'Póker' };
    if (groups[0].c === 3 && groups[1] && groups[1].c === 2) return { rank: [6, groups[0].v, groups[1].v], name: 'Full house' };
    if (isFlush) return { rank: [5, ...values], name: 'Color' };
    if (isStraight) return { rank: [4, straightHigh], name: 'Escalera' };
    if (groups[0].c === 3) return { rank: [3, groups[0].v, ...groups.slice(1).map(g => g.v)], name: 'Trío' };
    if (groups[0].c === 2 && groups[1] && groups[1].c === 2) {
        let hi = Math.max(groups[0].v, groups[1].v), lo = Math.min(groups[0].v, groups[1].v);
        let kick = groups[2] ? groups[2].v : 0;
        return { rank: [2, hi, lo, kick], name: 'Doble par' };
    }
    if (groups[0].c === 2) return { rank: [1, groups[0].v, ...groups.slice(1).map(g => g.v)], name: 'Par' };
    return { rank: [0, ...values], name: 'Carta alta' };
}

function compareRank(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        let av = a[i] || 0, bv = b[i] || 0;
        if (av !== bv) return av - bv;
    }
    return 0;
}

function evaluateBestHand(holeCards, community) {
    let all = holeCards.concat(community);
    let combos = combinations5(all);
    let best = null;
    combos.forEach(c => {
        let ev = evaluate5(c);
        if (!best || compareRank(ev.rank, best.rank) > 0) best = ev;
    });
    return best;
}

// ==========================================
// 8. GAME LOOP (host)
// ==========================================
function gameLoop() {
    let timeLeft = Math.max(0, Math.ceil((sharedState.phaseEndTime - Date.now()) / 1000));
    actualizarTextosEstado(timeLeft);

    if (isHost) {
        if (sharedState.phase === 'WAITING' && sharedState.phaseEndTime <= Date.now()) {
            startNewHandIfReady();
        } else if (sharedState.phase === 'HAND_OVER' && sharedState.phaseEndTime <= Date.now()) {
            startNewHandIfReady();
        } else if (['PREFLOP', 'FLOP', 'TURN', 'RIVER'].includes(sharedState.phase) && sharedState.turnSeat !== -1 && sharedState.phaseEndTime <= Date.now()) {
            autoActTimeout();
        }
        if (['WAITING', 'HAND_OVER'].includes(sharedState.phase)) {
            let changed = false;
            sharedState.seats.forEach((s, i) => {
                if (s && (s.stack === 0 || s.leaving)) {
                    sharedState.pendingCashouts = sharedState.pendingCashouts || {};
                    sharedState.pendingCashouts[s.user] = s.stack;
                    sharedState.seats[i] = null;
                    changed = true;
                }
            });
            if (changed) emitState();
        }
    }
    renderGameUI();
}

// ==========================================
// 9. ACCIONES DEL JUGADOR (UI)
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('#buyin-selector .selector-chip').forEach(chip => {
        chip.addEventListener('click', function () {
            document.querySelector('#buyin-selector .selector-chip.active').classList.remove('active');
            this.classList.add('active');
            selectedBuyIn = parseInt(this.getAttribute('data-value'));
        });
    });
});

function mySeatIndex() { return sharedState.seats.findIndex(s => s && s.user === displayUsername); }

function sentarme() {
    if (mySeatIndex() !== -1) return;
    if (!hasEmptySeat()) return showToast('Mesa llena', false);
    if (balance < selectedBuyIn) return showToast('Saldo insuficiente', false);
    modificarSaldo(-selectedBuyIn);
    sendPlayerAction('sit', { buyIn: selectedBuyIn });
}

function levantarme() {
    if (mySeatIndex() === -1) return;
    sendPlayerAction('leave', {});
}

function sendAction(action) {
    let idx = mySeatIndex();
    if (idx === -1 || idx !== sharedState.turnSeat) return;
    sendPlayerAction(action, {});
}

function abrirRaise() {
    let idx = mySeatIndex();
    if (idx === -1) return;
    let seat = sharedState.seats[idx];
    raiseTarget = Math.min(sharedState.currentBet + sharedState.minRaise, seat.stack + seat.betThisRound);
    document.getElementById('raise-value').innerText = raiseTarget;
    document.getElementById('raise-panel').style.display = 'block';
}
function cancelarRaise() { document.getElementById('raise-panel').style.display = 'none'; }

function ajustarRaise(delta) {
    let idx = mySeatIndex(); if (idx === -1) return;
    let seat = sharedState.seats[idx];
    let maxTotal = seat.stack + seat.betThisRound;
    let minTotal = sharedState.currentBet + sharedState.minRaise;
    raiseTarget = Math.max(minTotal, Math.min(maxTotal, raiseTarget + delta));
    document.getElementById('raise-value').innerText = raiseTarget;
}

function setRaisePreset(type) {
    let idx = mySeatIndex(); if (idx === -1) return;
    let seat = sharedState.seats[idx];
    let maxTotal = seat.stack + seat.betThisRound;
    let minTotal = sharedState.currentBet + sharedState.minRaise;
    if (type === 'min') raiseTarget = minTotal;
    else if (type === 'half') raiseTarget = sharedState.currentBet + Math.max(sharedState.minRaise, Math.floor(sharedState.pot / 2));
    else if (type === 'pot') raiseTarget = sharedState.currentBet + Math.max(sharedState.minRaise, sharedState.pot);
    else if (type === 'allin') raiseTarget = maxTotal;
    raiseTarget = Math.max(minTotal, Math.min(maxTotal, raiseTarget));
    document.getElementById('raise-value').innerText = raiseTarget;
}

function confirmarRaise() {
    let idx = mySeatIndex(); if (idx === -1) return;
    let seat = sharedState.seats[idx];
    let maxTotal = seat.stack + seat.betThisRound;
    document.getElementById('raise-panel').style.display = 'none';
    if (raiseTarget >= maxTotal) sendPlayerAction('allin', {});
    else sendPlayerAction('raise', { amount: raiseTarget });
}

// ==========================================
// 10. RENDERIZADO VISUAL
// ==========================================
function actualizarTextosEstado(timeLeft) {
    const st = sharedState;
    let statusText = '', subText = '';
    if (st.phase === 'WAITING') {
        statusText = seatedCount() >= 2 ? `NUEVA MANO EN ${timeLeft}s` : 'ESPERANDO JUGADORES (MÍN. 2)';
        subText = `Sentados: ${seatedCount()}/${MAX_SEATS}`;
    } else if (['PREFLOP', 'FLOP', 'TURN', 'RIVER'].includes(st.phase)) {
        statusText = st.phase;
        if (st.turnSeat !== -1 && st.seats[st.turnSeat]) subText = `Turno de ${st.seats[st.turnSeat].user} (${timeLeft}s)`;
        else subText = 'Repartiendo...';
    } else if (st.phase === 'SHOWDOWN') {
        statusText = 'SHOWDOWN'; subText = 'Mostrando manos...';
    } else if (st.phase === 'HAND_OVER') {
        statusText = 'MANO FINALIZADA';
        subText = (st.message || '') + ` · Podés levantarte antes de la próxima mano (${timeLeft}s)`;
    }
    document.getElementById('game-status').innerText = statusText;
    document.getElementById('sub-status').innerText = subText;

    if (st.phase === 'HAND_OVER' && st.message && st.message !== lastMessageShown) {
        lastMessageShown = st.message;
        showToast(st.message, true);
    }
    if (st.phase !== 'HAND_OVER') lastMessageShown = '';
}

function renderGameUI() {
    const st = sharedState;

    // Si nada relevante cambió desde el último render, no tocamos el DOM.
    // Esto es lo que evitaba que las cartas "saltaran": antes se reconstruía
    // todo cada 1 segundo (gameLoop) aunque el estado fuera idéntico.
    const snapshot = JSON.stringify({
        seats: st.seats, communityCards: st.communityCards, turnSeat: st.turnSeat,
        dealerSeat: st.dealerSeat, phase: st.phase, pot: st.pot
    });
    if (snapshot === lastRenderSnapshot) { renderControls(); return; }
    lastRenderSnapshot = snapshot;

    document.getElementById('pot-value').innerText = st.pot;

    // Cartas del medio: si hay menos que antes es porque arrancó una mano nueva.
    // Solo animamos las cartas que son realmente nuevas, y las repartimos
    // "una por una" con un pequeño delay entre cada una.
    if (st.communityCards.length < prevCommunityCount) prevCommunityCount = 0;
    document.getElementById('community-cards').innerHTML = st.communityCards.map((c, i) => {
        let isNew = i >= prevCommunityCount;
        let delay = isNew ? (i - prevCommunityCount) * 250 : 0;
        return cardImgHtml(`cartas/${cardFile(c)}`, isNew, delay);
    }).join('');
    prevCommunityCount = st.communityCards.length;

    const myIdx = mySeatIndex();
    const container = document.getElementById('seats-container');
    container.innerHTML = '';

    for (let i = 0; i < MAX_SEATS; i++) {
        let pos = myIdx === -1 ? i : (i - myIdx + MAX_SEATS) % MAX_SEATS;
        let seat = st.seats[i];
        let div = document.createElement('div');
        div.className = 'seat';
        div.setAttribute('data-pos', pos);

        if (!seat) {
            div.classList.add('empty');
            div.innerHTML = `<div class="seat-name">Asiento libre</div>`;
        } else {
            if (seat.folded) div.classList.add('folded');
            if (i === st.turnSeat) div.classList.add('active-turn');
            if (seat.user === displayUsername) div.classList.add('me');

            let cardsHtml = '';
            if (seat.holeCards && seat.holeCards.length === 2) {
                let revealToAll = ['SHOWDOWN', 'HAND_OVER'].includes(st.phase) && !seat.folded;
                let isMine = seat.user === displayUsername;
                // Solo son "nuevas" (y por lo tanto se animan) la primera vez que
                // este asiento pasa de 0 a 2 cartas en la mano. Así, aunque se
                // vuelva a renderizar por una apuesta de otro jugador, tus cartas
                // ya no vuelven a "saltar".
                let isNewDeal = (prevSeatCardCount[i] || 0) < 2;
                if (isMine || revealToAll) {
                    cardsHtml = seat.holeCards.map((c, k) =>
                        cardImgHtml(`cartas/${cardFile(c)}`, isNewDeal, k * 150)).join('');
                } else {
                    cardsHtml = cardImgHtml('cartas/dorso.png', isNewDeal, 0) + cardImgHtml('cartas/dorso.png', isNewDeal, 150);
                }
                prevSeatCardCount[i] = 2;
            } else {
                prevSeatCardCount[i] = 0;
            }

            div.innerHTML = `
                ${i === st.dealerSeat ? '<div class="dealer-chip">D</div>' : ''}
                <div class="seat-name">${seat.user}${seat.allIn ? ' (ALL-IN)' : ''}</div>
                <div class="seat-cards">${cardsHtml}</div>
                <div class="seat-stack">$${seat.stack}</div>
                ${seat.betThisRound > 0 ? `<div class="seat-bet">$${seat.betThisRound}</div>` : ''}
                ${seat.folded ? '<div class="seat-tag">RETIRADO</div>' : ''}
            `;
        }
        container.appendChild(div);
    }

    renderControls();
}

function renderControls() {
    const st = sharedState;
    const myIdx = mySeatIndex();
    const seated = myIdx !== -1;

    document.getElementById('leave-btn').disabled = !seated;
    document.getElementById('join-panel').style.display = (!seated && hasEmptySeat()) ? 'flex' : 'none';

    const isMyTurn = seated && st.turnSeat === myIdx && ['PREFLOP', 'FLOP', 'TURN', 'RIVER'].includes(st.phase);
    const foldBtn = document.getElementById('fold-btn');
    const checkBtn = document.getElementById('check-btn');
    const callBtn = document.getElementById('call-btn');
    const raiseBtn = document.getElementById('raise-btn');
    const allinBtn = document.getElementById('allin-btn');

    foldBtn.disabled = !isMyTurn;
    allinBtn.disabled = !isMyTurn || st.seats[myIdx]?.stack <= 0;

    if (isMyTurn) {
        let seat = st.seats[myIdx];
        let toCall = st.currentBet - seat.betThisRound;
        if (toCall <= 0) {
            checkBtn.style.display = 'inline-block'; checkBtn.disabled = false;
            callBtn.style.display = 'none'; callBtn.disabled = true;
        } else {
            checkBtn.style.display = 'none'; checkBtn.disabled = true;
            callBtn.style.display = 'inline-block'; callBtn.disabled = false;
            callBtn.innerText = `IGUALAR $${Math.min(toCall, seat.stack)}`;
        }
        let maxTotal = seat.stack + seat.betThisRound;
        raiseBtn.disabled = maxTotal <= st.currentBet || seat.stack <= 0;
    } else {
        checkBtn.disabled = true; checkBtn.style.display = 'inline-block'; checkBtn.innerText = 'PASAR';
        callBtn.disabled = true; callBtn.style.display = 'none';
        raiseBtn.disabled = true;
        document.getElementById('raise-panel').style.display = 'none';
    }
}

// ==========================================
// 11. UTILIDADES: TOASTS, MODAL, CHAT
// ==========================================
function showToast(msg, isWin) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast-msg ${isWin ? 'win' : 'lose'}`;
    toast.innerText = msg;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 500); }, 3500);
}

function toggleModal(show) { document.getElementById('rules-modal').style.display = show ? 'flex' : 'none'; }
function toggleChat() {
    const popup = document.getElementById("chat-popup");
    popup.style.display = (popup.style.display === "flex") ? "none" : "flex";
    if (popup.style.display === "flex") {
        document.getElementById("chat-messages").scrollTop = document.getElementById("chat-messages").scrollHeight;
        document.getElementById("chat-input").focus();
    }
}
function manejarEnterChat(e) { if (e.key === 'Enter') enviarMensajeChat(); }
function enviarMensajeChat() {
    const input = document.getElementById("chat-input");
    const text = input.value.trim();
    if (!text) return;
    mostrarMensajeEnChat(displayUsername, text);
    if (pokerChannel) pokerChannel.send({ type: 'broadcast', event: 'chat_message', payload: { user: displayUsername, text } });
    input.value = "";
}
function mostrarMensajeEnChat(user, text) {
    const container = document.getElementById("chat-messages");
    const msgDiv = document.createElement("div");
    msgDiv.classList.add("chat-msg");
    msgDiv.innerHTML = `<span class="user">${user}:</span><span> ${text}</span>`;
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
}
