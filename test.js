// End-to-end check of a full 10-turn game.
// Start the server first:  PORT=3111 HOST_PIN=1234 node server.js   then:  node test.js
const base = 'http://localhost:3111';
const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { ok: r.ok, ...(await r.json()) }; };
let n = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } n++; console.log('ok  -', m); };
const getView = async t => { const r = await fetch(base + '/events?token=' + t); const rd = r.body.getReader(); const { value } = await rd.read(); rd.cancel(); return JSON.parse(new TextDecoder().decode(value).replace(/^data: /, '')); };

(async () => {
  assert((await (await fetch(base + '/healthz')).text()) === 'ok', 'health check');
  const host = (await post('/api/host', { pin: '1234' })).token;
  assert(!(await post('/api/host', { pin: 'bad' })).ok, 'wrong PIN rejected');
  const ta = (await post('/api/join', { role: 'team', name: 'Grace' })).token;
  const tb = (await post('/api/join', { role: 'team', name: 'Glory' })).token;
  assert(!(await post('/api/join', { role: 'team', name: 'Third' })).ok, 'third team rejected');
  const aud = [];
  for (let i = 0; i < 10; i++) aud.push((await post('/api/join', { role: 'audience', name: 'p' + i })).token);

  assert(!(await post('/api/host/action', { token: ta, action: 'shuffle' })).ok, 'team cannot shuffle');
  assert(!(await post('/api/host/action', { token: host, action: 'start' })).ok, 'cannot start before shuffle');
  assert((await post('/api/host/action', { token: host, action: 'shuffle' })).ok, 'host shuffles');
  assert((await post('/api/host/action', { token: host, action: 'start' })).ok, 'host starts');
  let hv = await getView(host);
  assert(hv.schedule.length === 10, 'schedule has 10 turns');
  const sa = hv.schedule.filter(s => s.team === 'A').map(s => s.qid), sb = hv.schedule.filter(s => s.team === 'B').map(s => s.qid);
  assert(sa.length === 5 && sb.length === 5 && !sa.some(i => sb.includes(i)), 'each team gets 5 distinct questions');
  assert(hv.schedule.every((s, i) => s.team === (i % 2 ? 'B' : 'A')), 'teams alternate');
  assert(!(await post('/api/join', { role: 'team', name: 'Late' })).ok, 'no team registration after start');

  let expectA = 0, expectB = 0;
  for (let turn = 0; turn < 10; turn++) {
    const s = hv.schedule[turn], team = s.team === 'A' ? ta : tb, other = s.team === 'A' ? tb : ta;
    const q = hv.questions.find(x => x.id === s.qid);
    // audience sees only the current question (plus finished ones), teams only their own current one
    const av = await getView(aud[0]);
    assert(av.current.qid === s.qid && av.questions.length === turn + 1, `turn ${turn + 1}: audience sees current question only`);
    const tv = await getView(team), ov = await getView(other);
    assert(tv.myTurn && tv.questions.length === 1 && ov.questions.length === 0, `turn ${turn + 1}: only the playing team sees the question`);
    assert(tv.scores === undefined && tv.results === undefined, `turn ${turn + 1}: team sees no scores`);

    // 10 audience votes: 6 pick option 2, 3 pick option 0, 1 picks option 4
    const picks = [2, 2, 2, 2, 2, 2, 0, 0, 0, 4];
    for (let i = 0; i < 10; i++) await post('/api/vote', { token: aud[i], qid: s.qid, opt: picks[i] });
    assert(!(await post('/api/vote', { token: aud[0], qid: s.qid, opt: 1 })).ok, `turn ${turn + 1}: double vote rejected`);
    const futureQ = hv.schedule[Math.min(turn + 1, 9)].qid;
    if (turn < 9) assert(!(await post('/api/vote', { token: aud[1], qid: futureQ, opt: 0 })).ok, `turn ${turn + 1}: cannot vote on a future question`);
    assert(!(await post('/api/answer', { token: team, qid: s.qid, opt: 2 })).ok, `turn ${turn + 1}: team cannot answer while voting is open`);
    assert((await post('/api/host/action', { token: host, action: 'closeVoting' })).ok, `turn ${turn + 1}: host closes voting`);
    assert(!(await post('/api/vote', { token: aud[0], qid: s.qid, opt: 0 })).ok, `turn ${turn + 1}: late vote rejected`);
    assert(!(await post('/api/answer', { token: other, qid: s.qid, opt: 2 })).ok, `turn ${turn + 1}: other team cannot answer`);
    assert(!(await post('/api/host/action', { token: host, action: 'nextTurn' })).ok, `turn ${turn + 1}: cannot skip before answer`);
    const opt = turn === 9 ? 1 : 2;               // last turn: pick an option nobody voted for -> 0 points
    assert((await post('/api/answer', { token: team, qid: s.qid, opt })).ok, `turn ${turn + 1}: team answers`);
    assert(!(await post('/api/answer', { token: team, qid: s.qid, opt: 0 })).ok, `turn ${turn + 1}: no second answer`);
    const pts = turn === 9 ? 0 : 6;
    if (s.team === 'A') expectA += pts; else expectB += pts;
    hv = await getView(host);
    const av2 = await getView(aud[0]);
    assert(hv.results[s.qid].points === pts && av2.results[s.qid].points === pts, `turn ${turn + 1}: ${pts} points awarded and visible to host and audience`);
    assert(av2.scores.A === expectA && av2.scores.B === expectB && hv.scores.A === expectA && hv.scores.B === expectB, `turn ${turn + 1}: scoreboard correct (${expectA}-${expectB})`);
    assert((await post('/api/host/action', { token: host, action: 'nextTurn' })).ok, `turn ${turn + 1}: next turn`);
    hv = await getView(host);
  }
  assert(hv.phase === 'done', 'game finishes after turn 10');
  assert(hv.scores.A === 30 && hv.scores.B === 24, 'final scores are 30 to 24 (last answer scored 0)');
  console.log('\nALL ' + n + ' CHECKS PASSED');
  process.exit(0);
})();
