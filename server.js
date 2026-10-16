// Church Family Feud - turn-based, zero-dependency Node server (Node 18+)
// Local:   HOST_PIN=2468 node server.js
// Hosted:  set HOST_PIN as an environment variable on your host; PORT is provided by the platform.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PIN_GENERATED = !process.env.HOST_PIN;
const HOST_PIN = process.env.HOST_PIN || String(crypto.randomInt(100000, 999999));
const DATA_DIR = process.env.DATA_DIR || __dirname;
const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const N = QUESTIONS.length;
const MAX_AUDIENCE = 1000;

const fresh = () => ({
  phase: 'lobby',               // lobby -> playing -> done
  teams: { A: null, B: null },  // {name, token}
  queues: { A: [], B: [] },     // question ids each team will answer, in order
  turn: 0,                      // 0..N-1, teams alternate A,B,A,B...
  turnPhase: 'voting',          // voting -> answering -> revealed
  audience: {},                 // token -> {name}
  votes: {},                    // token -> {qid: optionIndex}
  answers: {},                  // qid -> {team, opt, points, turn}
  hostTokens: [],
});
let st = fresh();
try { st = Object.assign(fresh(), JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch (e) {}

const save = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(st)); } catch (e) {} };
const tok = () => crypto.randomBytes(12).toString('hex');
const qById = id => QUESTIONS.find(q => q.id === id);
const shuffled = () => st.queues.A.length + st.queues.B.length === N;

function cur() {
  if (st.phase !== 'playing') return null;
  const team = st.turn % 2 === 0 ? 'A' : 'B';
  return { team, qid: st.queues[team][Math.floor(st.turn / 2)], turn: st.turn };
}
function counts(qid) {
  const q = qById(qid);
  const c = q.options.map(() => 0);
  for (const t in st.votes) { const v = st.votes[t][qid]; if (v !== undefined && c[v] !== undefined) c[v]++; }
  return c;
}
function totals() {
  const s = { A: 0, B: 0 };
  for (const qid in st.answers) s[st.answers[qid].team] += st.answers[qid].points;
  return s;
}
function roleOf(t) {
  if (!t) return null;
  if (st.hostTokens.includes(t)) return { role: 'host' };
  if (st.teams.A && st.teams.A.token === t) return { role: 'team', slot: 'A' };
  if (st.teams.B && st.teams.B.token === t) return { role: 'team', slot: 'B' };
  if (st.audience[t]) return { role: 'audience' };
  return null;
}

function view(t) {
  const r = roleOf(t);
  if (!r) return null;
  const c = cur();
  const base = {
    role: r.role, phase: st.phase, turn: st.turn, turnPhase: st.turnPhase, total: N,
    current: c,
    teamNames: { A: st.teams.A ? st.teams.A.name : null, B: st.teams.B ? st.teams.B.name : null },
    shuffled: shuffled(),
  };
  if (r.role === 'team') {
    // Teams see only their own current question, never scores or results.
    const mine = c && c.team === r.slot;
    base.slot = r.slot;
    base.questions = mine ? [qById(c.qid)] : [];
    base.myTurn = !!mine;
    base.myAnswer = mine && st.answers[c.qid] ? st.answers[c.qid].opt : null;
    return base;
  }
  // host + audience
  const results = {};
  for (const qid in st.answers) results[qid] = Object.assign({}, st.answers[qid], { counts: counts(+qid) });
  base.scores = totals();
  base.results = results;
  base.audienceCount = Object.keys(st.audience).length;
  if (r.role === 'audience') {
    const visible = new Set(Object.keys(st.answers).map(Number));
    if (c) visible.add(c.qid);
    base.questions = QUESTIONS.filter(q => visible.has(q.id));
    base.myVotes = st.votes[t] || {};
  } else {
    base.questions = QUESTIONS;
    base.schedule = shuffled() ? Array.from({ length: N }, (_, i) => ({ turn: i, team: i % 2 === 0 ? 'A' : 'B', qid: st.queues[i % 2 === 0 ? 'A' : 'B'][Math.floor(i / 2)] })) : [];
    base.liveCounts = {}; base.voterCounts = {};
    QUESTIONS.forEach(q => {
      base.liveCounts[q.id] = counts(q.id);
      base.voterCounts[q.id] = Object.values(st.votes).filter(v => v[q.id] !== undefined).length;
    });
  }
  return base;
}

// ---- live updates (Server-Sent Events)
const clients = new Set();
function broadcast() {
  save();
  for (const c of clients) {
    const v = view(c.token);
    if (!v) { c.res.write('event: invalid\ndata: {}\n\n'); continue; }
    c.res.write('data: ' + JSON.stringify(v) + '\n\n');
  }
}
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 20000); // keeps proxies from closing idle streams

function body(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
  });
}
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const clean = s => String(s || '').trim().slice(0, 40);

// simple brute-force guard for the host PIN: 10 tries per minute per IP
const tries = new Map();
function pinAllowed(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now(); let e = tries.get(ip);
  if (!e || now > e.reset) e = { n: 0, reset: now + 60000 };
  e.n++; tries.set(ip, e);
  return e.n <= 10;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    const t = url.searchParams.get('token');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const c = { token: t, res };
    clients.add(c);
    req.on('close', () => clients.delete(c));
    const v = view(t);
    res.write(v ? 'data: ' + JSON.stringify(v) + '\n\n' : 'event: invalid\ndata: {}\n\n');
    return;
  }

  if (req.method !== 'POST') { res.writeHead(404); return res.end(); }
  const b = await body(req);

  if (url.pathname === '/api/join') {
    const name = clean(b.name);
    if (!name) return send(res, 400, { error: 'Please enter a name.' });
    if (b.role === 'team') {
      if (st.phase !== 'lobby') return send(res, 400, { error: 'Team registration is closed (game already started).' });
      const taken = ['A', 'B'].some(s => st.teams[s] && st.teams[s].name.toLowerCase() === name.toLowerCase());
      if (taken) return send(res, 400, { error: 'That team name is taken.' });
      const slot = !st.teams.A ? 'A' : !st.teams.B ? 'B' : null;
      if (!slot) return send(res, 400, { error: 'Both team slots are already taken. Join as audience.' });
      const t = tok();
      st.teams[slot] = { name, token: t };
      broadcast();
      return send(res, 200, { token: t });
    }
    if (Object.keys(st.audience).length >= MAX_AUDIENCE) return send(res, 400, { error: 'The room is full.' });
    const t = tok();
    st.audience[t] = { name };
    broadcast();
    return send(res, 200, { token: t });
  }

  if (url.pathname === '/api/host') {
    if (!pinAllowed(req)) return send(res, 429, { error: 'Too many attempts. Wait a minute.' });
    if (String(b.pin) !== String(HOST_PIN)) return send(res, 403, { error: 'Wrong PIN.' });
    const t = tok();
    st.hostTokens.push(t);
    broadcast();
    return send(res, 200, { token: t });
  }

  const r = roleOf(b.token);
  if (!r) return send(res, 401, { error: 'Not registered.' });

  if (url.pathname === '/api/vote') {
    if (r.role !== 'audience') return send(res, 403, { error: 'Only audience can vote.' });
    const c = cur();
    if (!c || st.turnPhase !== 'voting') return send(res, 400, { error: 'Voting is not open right now.' });
    if (+b.qid !== c.qid) return send(res, 400, { error: 'That is not the current question.' });
    const q = qById(c.qid);
    if (!(b.opt >= 0 && b.opt < q.options.length)) return send(res, 400, { error: 'Bad vote.' });
    st.votes[b.token] = st.votes[b.token] || {};
    if (st.votes[b.token][q.id] !== undefined) return send(res, 400, { error: 'You already answered this one.' });
    st.votes[b.token][q.id] = +b.opt;
    broadcast();
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/answer') {
    if (r.role !== 'team') return send(res, 403, { error: 'Only teams can answer.' });
    const c = cur();
    if (!c || c.team !== r.slot) return send(res, 400, { error: "It is not your team's turn." });
    if (st.turnPhase !== 'answering') return send(res, 400, { error: 'Wait for the host to close audience voting.' });
    if (+b.qid !== c.qid) return send(res, 400, { error: 'That is not the current question.' });
    const q = qById(c.qid);
    if (!(b.opt >= 0 && b.opt < q.options.length)) return send(res, 400, { error: 'Bad answer.' });
    const points = counts(q.id)[+b.opt];   // points = number of audience members who picked this answer
    st.answers[q.id] = { team: r.slot, opt: +b.opt, points, turn: c.turn };
    st.turnPhase = 'revealed';
    broadcast();
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/host/action') {
    if (r.role !== 'host') return send(res, 403, { error: 'Host only.' });
    const a = b.action;
    if (a === 'shuffle') {
      if (st.phase !== 'lobby') return send(res, 400, { error: 'Only before the game starts.' });
      if (!st.teams.A || !st.teams.B) return send(res, 400, { error: 'Both teams must register first.' });
      const ids = QUESTIONS.map(q => q.id);
      for (let i = ids.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [ids[i], ids[j]] = [ids[j], ids[i]]; }
      st.queues = { A: ids.slice(0, N / 2), B: ids.slice(N / 2) };
    } else if (a === 'start') {
      if (st.phase !== 'lobby') return send(res, 400, { error: 'Already started.' });
      if (!st.teams.A || !st.teams.B) return send(res, 400, { error: 'Both teams must register first.' });
      if (!shuffled()) return send(res, 400, { error: 'Shuffle the questions first.' });
      st.phase = 'playing'; st.turn = 0; st.turnPhase = 'voting';
    } else if (a === 'closeVoting') {
      if (st.phase !== 'playing' || st.turnPhase !== 'voting') return send(res, 400, { error: 'Voting is not open.' });
      st.turnPhase = 'answering';
    } else if (a === 'reopenVoting') {
      if (st.phase !== 'playing' || st.turnPhase !== 'answering') return send(res, 400, { error: 'Only while the team is still answering.' });
      st.turnPhase = 'voting';
    } else if (a === 'nextTurn') {
      if (st.phase !== 'playing' || st.turnPhase !== 'revealed') return send(res, 400, { error: 'The team has not answered yet.' });
      if (st.turn >= N - 1) st.phase = 'done';
      else { st.turn++; st.turnPhase = 'voting'; }
    } else if (a === 'removeTeam') {
      if (st.phase !== 'lobby') return send(res, 400, { error: 'Only in the lobby.' });
      st.teams[b.slot] = null; st.queues = { A: [], B: [] };
    } else if (a === 'reset') {
      const hosts = st.hostTokens;
      st = fresh(); st.hostTokens = hosts;
    } else return send(res, 400, { error: 'Unknown action.' });
    broadcast();
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\nChurch Family Feud is running on port ' + PORT + '.');
  console.log('Host PIN: ' + HOST_PIN + (PIN_GENERATED ? '  (randomly generated; set HOST_PIN to choose your own)' : ''));
  console.log('Open locally: http://localhost:' + PORT);
  const nets = require('os').networkInterfaces();
  for (const n in nets) for (const i of nets[n]) if (i.family === 'IPv4' && !i.internal) console.log('Same Wi-Fi:   http://' + i.address + ':' + PORT);
  console.log('');
});
