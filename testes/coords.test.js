// Teste das coordenadas (public/js/coords.js) — rode com: node testes/coords.test.js
// Valores de referência gerados com pyproj (UTM) e a biblioteca "mgrs" (MGRS) e astral (sol).
require(require('path').join(__dirname, '../public/js/coords.js'));
const C = globalThis.Coords;
let ok = 0, falha = 0;
const chk = (c, m, x) => { if (c) { ok++; console.log('  ✔ ' + m); } else { falha++; console.log('  ✘ ' + m + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); } };
const REF = [
  [-22.951916, -43.210487, 23, 683477.8, 7460685.5, '23KPQ8347760685'],
  [-22.4515, -42.98, 23, 707870.4, 7515797.1, '23KQR0787015797'],
  [-3.7319, -38.5267, 24, 552556.1, 9587492.9, '24MWA5255687492'],
  [-33.45, -70.66, 19, 345713.2, 6297592.0, '19HCC4571397592'],
  [40.7128, -74.006, 18, 583959.4, 4507351.0, '18TWL8395907350'],
  [64.1466, -21.9426, 27, 454138.4, 7113689.9, '27WVM5413813689'],
  [-0.5, -48.5, 22, 778265.8, 9944682.0, '22MGE7826544681'],
];
console.log('UTM e MGRS');
REF.forEach(([lat, lng, z, e, n, mg]) => {
  const u = C.paraUtm(lat, lng);
  chk(u.zona === z && Math.abs(u.leste - e) < 1 && Math.abs(u.norte - n) < 1, `UTM ${lat},${lng} → ${z} ${Math.round(e)} ${Math.round(n)}`, u);
  const m = C.paraMgrs(lat, lng);
  chk(m.zona + m.banda + m.quadrado + m.leste + m.norte === mg, `MGRS ${mg}`, m);
  const v = C.interpretar(C.formatar(lat, lng, 'utm'));
  chk(v && Math.abs(v.lat - lat) < 2e-5 && Math.abs(v.lng - lng) < 2e-5, 'UTM digitado volta ao mesmo ponto', v);
  const w = C.interpretar(mg);
  chk(w && Math.abs(w.lat - lat) < 3e-5 && Math.abs(w.lng - lng) < 3e-5, 'MGRS digitado volta ao mesmo ponto', w);
});
console.log('Formatos e leitura');
chk(C.formatar(-22.4515, -42.98, 'gms') === '22°27\'05,4"S 42°58\'48,0"O', 'GMS', C.formatar(-22.4515, -42.98, 'gms'));
chk(C.formatar(-22.4515, -42.98, 'gmd') === '22°27,090\'S 42°58,800\'O', 'GMD', C.formatar(-22.4515, -42.98, 'gmd'));
chk(C.formatar(-22.4515, -42.98, 'mgrs') === '23K QR 07870 15797', 'MGRS formatado', C.formatar(-22.4515, -42.98, 'mgrs'));
const casos = [
  ['-22.4515, -42.98', 'dec'], ['-22,4515 -42,98', 'dec'], ['22°27\'05.4"S 42°58\'48.0"W', 'gms'], ['22 27 05,4 S 42 58 48 O', 'gms'],
  ['22°27.090\'S 42°58.800\'O', 'gms'], ['23K 707870 7515797', 'utm'], ['23K QR 07870 15797', 'mgrs'], ['23kqr0787015797', 'mgrs'], ['23K QR 078 157', 'mgrs'],
];
casos.forEach(([t, f]) => {
  const p = C.interpretar(t);
  const tol = f === 'mgrs' && t.length < 16 ? 1e-3 : 1e-4;
  chk(p && p.formato === f && Math.abs(p.lat + 22.4515) < tol && Math.abs(p.lng + 42.98) < tol, 'lê "' + t + '"', p);
});
chk(C.interpretar('abc') === null && C.interpretar('95, 10') === null, 'texto inválido não vira coordenada');
console.log('Rumo e projeção');
chk(Math.abs(C.rumo(-22.45, -42.98, -22.44, -42.98) - 0) < 0.01 && C.cardeal(C.rumo(-22.45, -42.98, -22.45, -42.97)) === 'L', 'rumo norte e leste');
const pj = C.projetar(-22.45, -42.98, 1000, 90);
chk(Math.abs(globalThis.Coords.rumo(-22.45, -42.98, pj.lat, pj.lng) - 90) < 0.1, 'projeção 1 km a leste');
console.log('Sol (12/10/2026, referência astral)');
const hm = (d) => d.toISOString().slice(11, 16);
const min = (a, b) => Math.abs((Number(a.slice(0, 2)) * 60 + Number(a.slice(3))) - (Number(b.slice(0, 2)) * 60 + Number(b.slice(3))));
[[-22.4515, -42.98, '08:22', '20:54', '21:17'], [-3.1, -60.0, '09:41', '21:51', '22:12']].forEach(([lat, lng, n, p, e]) => {
  const s = C.sol(new Date('2026-10-12T15:00:00Z'), lat, lng);
  chk(min(hm(s.nascer), n) <= 2 && min(hm(s.por), p) <= 2 && min(hm(s.escurece), e) <= 2, `nascer ${n}, pôr ${p}, escurece ${e} UTC (±2 min)`, [hm(s.nascer), hm(s.por), hm(s.escurece)]);
});
console.log('\nCoordenadas: ' + ok + ' OK, ' + falha + ' falha(s)');
process.exit(falha ? 1 : 0);
