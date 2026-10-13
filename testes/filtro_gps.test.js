// Teste do filtro de GPS (public/js/gps.js) — rode com: node testes/filtro_gps.test.js
// Simula sequências de leituras como as de um celular (1 leitura por segundo)
// e confere quantos pontos entram na trilha, o atraso e o que é descartado.
require(require('path').join(__dirname, '../public/js/gps.js'));
const GPS = globalThis.GPS;
const M = 1 / 111320;                  // graus de latitude por metro
const ML = 1 / (111320 * Math.cos(22.9 * Math.PI / 180)); // graus de longitude por metro
const pos = (lat, lng, acc, t, speed) => ({ coords: { latitude: lat, longitude: lng, accuracy: acc, speed: speed == null ? null : speed }, timestamp: t });
let ok = 0, falha = 0;
const chk = (c, m, x) => { if (c) { ok++; console.log('  ✔ ' + m); } else { falha++; console.log('  ✘ ' + m + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); } };
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const ruido = (m) => (rnd() - 0.5) * 2 * m;
const t0 = 1.7e12;

// Roda uma sequência: f(i) -> [latMetros, lngMetros, prec, speed|null]
function rodar(n, f, cfg) {
  const fil = new GPS.Filtro(cfg); const pts = []; const mot = [];
  for (let i = 0; i < n; i++) {
    const t = t0 + i * 1000;
    const [y, x, acc, v] = f(i);
    const r = fil.processar(pos(-22.9 + y * M, -43.2 + x * ML, acc, t, v), t);
    mot.push(r.motivo);
    r.pontos.forEach((p) => pts.push(Object.assign({ i }, p)));
  }
  return { pts, mot, fil };
}
const dist = (a, b) => GPS.distancia(a.lat, a.lng, b.lat, b.lng);
const maiorIntervalo = (pts) => pts.slice(1).reduce((m, p, k) => Math.max(m, p.t - pts[k].t), 0) / 1000;

// Erro do GPS parado: deriva lenta (cada leitura parecida com a anterior), como nos aparelhos reais.
function deriva(amp) {
  let x = 0, y = 0;
  return () => { x = 0.9 * x + ruido(amp * 0.45); y = 0.9 * y + ruido(amp * 0.45); return [y, x]; };
}
console.log('Parado');
let dv = deriva(6);
let r = rodar(300, () => dv().concat([10]));
chk(r.pts.length <= 20, 'parado 5 min, erro de ±6 m, precisão 10 m, aparelho SEM velocidade: no máximo 1 ponto a cada 15 s', r.pts.length);
dv = deriva(6);
r = rodar(300, () => dv().concat([10, 0]));
chk(r.pts.length <= 9, 'mesmo caso com o GPS informando velocidade 0 (Android): só a confirmação periódica (a cada 45 s)', r.pts.length);
dv = deriva(20);
r = rodar(300, () => dv().concat([35]));
chk(r.pts.length <= 20, 'parado 5 min, erro de ±20 m, precisão 35 m (mata): poucos pontos (no máximo 1 a cada 15 s)', r.pts.length);
r = rodar(300, () => [ruido(6), ruido(6), 10]);
chk(r.pts.length <= 30, 'ruído extremo (cada leitura sorteada ±6 m): no máximo 1 ponto a cada 10 s', r.pts.length);

console.log('A pé');
r = rodar(120, (i) => [i * 1.4 + ruido(2), ruido(2), 6]);
chk(r.pts.length >= 20, 'andando 1,4 m/s com precisão 6 m, sem velocidade do GPS: ponto a cada ~5 s (≈7 m)', r.pts.length);
chk(maiorIntervalo(r.pts) <= 8, 'maior intervalo entre pontos andando ≤ 8 s', maiorIntervalo(r.pts));
chk(dist(r.pts[0], r.pts[r.pts.length - 1]) > 150, 'percurso registrado até o fim (≈166 m)', Math.round(dist(r.pts[0], r.pts[r.pts.length - 1])));
dv = deriva(8);
r = rodar(120, (i) => { const e = dv(); return [i * 1.2 + e[0], e[1], 30]; });
chk(r.pts.length >= 6 && maiorIntervalo(r.pts) <= 35, 'andando com precisão ruim (30 m, mata), sem velocidade do GPS: ainda registra (≤ 35 s entre pontos)', [r.pts.length, maiorIntervalo(r.pts)]);
r = rodar(120, (i) => [i * 1.2 + ruido(8), ruido(8), 30, 1.2]);
chk(r.pts.length >= 40, 'mesma situação com velocidade do GPS: ponto a cada ~2 s', r.pts.length);
r = rodar(300, (i) => [i * 0.3, 0, 5]);
chk(r.pts.length >= 20, 'passos lentos (0,3 m/s): deslocamento pequeno registrado', r.pts.length);

console.log('Veículo');
r = rodar(120, (i) => [i * 20 + ruido(3), ruido(3), 5]);
chk(r.pts.length >= 100, 'carro a 72 km/h SEM velocidade do GPS: quase 1 ponto por segundo', r.pts.length);
chk(r.pts[0].i === 0 && r.pts.slice(-1)[0].i >= 118, 'trilha do carro vai do início ao fim, sem atraso', [r.pts[0].i, r.pts.slice(-1)[0].i]);
r = rodar(120, (i) => [i * 30 + ruido(3), ruido(3), 5, 30]);
chk(r.pts.length >= 110, 'carro a 108 km/h COM velocidade do GPS: 1 ponto por segundo', r.pts.length);
r = rodar(60, (i) => (i < 20 ? [ruido(3), ruido(3), 6] : [(i - 20) * 15, 0, 6]));
chk(r.mot.slice(20, 25).every((m) => m !== 'salto_suspeito') || r.pts.filter((p) => p.i >= 20 && p.i <= 23).length >= 2, 'parado → arranca de carro: pontos de arrancada entram', r.mot.slice(19, 26));
chk(r.pts.filter((p) => p.i >= 20).length >= 30, 'parado → carro: trilha acompanha', r.pts.filter((p) => p.i >= 20).length);
r = rodar(60, (i) => (i === 30 ? [i * 20 + 900, 0, 8] : [i * 20, 0, 5]));
chk(!r.pts.some((p) => p.i === 30), 'pico de 900 m no meio do trajeto de carro: descartado', r.mot[30]);
r = rodar(60, (i) => (i === 30 ? [i * 1.4 + 400, 0, 8] : [i * 1.4, 0, 5]));
chk(!r.pts.some((p) => p.i === 30), 'pico de 400 m andando: descartado', r.mot[30]);
r = rodar(30, (i) => (i < 10 ? [0, 0, 5] : [3000 + (i - 10) * 1, 0, 5]));
chk(r.mot.includes('salto_confirmado'), 'mudança real de lugar (3 km) confirmada por leituras seguidas', r.mot.slice(9, 14));

console.log('Precisão e leituras ruins');
r = rodar(180, () => [ruido(150), 0, 350]);
chk(r.pts.length <= 7, 'precisão 350 m: só 1 posição aproximada a cada 30 s', r.pts.length);
chk(GPS.trilha(r.pts).segmentos.every((s) => s.length === 0) || GPS.trilha(r.pts).segmentos.length === 0, 'posições aproximadas não entram na linha da trilha');
r = rodar(120, (i) => [i * 1.4, 0, i % 10 === 5 ? 120 : 8]);
chk(r.pts.length >= 18 && maiorIntervalo(r.pts) <= 15, 'andando com algumas leituras de 120 m: não para a trilha', r.pts.length);
let f = new GPS.Filtro();
chk(f.processar(pos(-22.9, -43.2, 5, t0 - 120000), t0).motivo === 'leitura_antiga', 'leitura antiga (cache) descartada');
chk(f.processar(pos(-22.9, -43.2, 5, t0), t0).motivo === 'primeiro_ponto', 'primeira leitura aceita na hora');
chk(f.processar(pos(-22.9, -43.2, 5, t0), t0 + 500).motivo === 'duplicada', 'leitura repetida');
chk(f.processar(pos(-22.91, -43.2, 5, t0 - 5000), t0 + 600).motivo === 'fora_de_ordem', 'fora de ordem');
chk(f.processar(pos(0, 0, 5, t0 + 7000), t0 + 7000).motivo === 'coordenada_invalida', '0,0 inválida');
{ const fl = new GPS.Filtro(); const ms = []; for (let i = 0; i < 10; i++) { const ag = t0 + i * 1000; ms.push(fl.processar(pos(-22.9 + i * 3 * M, -43.2, 5, ag - 300000), ag).motivo); }
  chk(ms.slice(2).every((m) => m !== 'leitura_antiga'), 'relógio do GPS 5 min diferente do celular: corrigido após 3 leituras', ms); }

console.log('Desenho da trilha');
const linha = (n, passo, prec) => Array.from({ length: n }, (_, i) => ({ t: t0 + i * 2000, lat: -22.9 + i * passo * M, lng: -43.2, prec }));
let tr = GPS.trilha(linha(50, 3, 6));
chk(tr.segmentos.length === 1 && tr.segmentos[0].length === 50, 'todos os pontos registrados viram vértices (nada escondido)', tr.segmentos[0].length);
const comLacuna = linha(10, 3, 6).concat(linha(10, 3, 6).map((p) => ({ t: p.t + 400000, lat: p.lat + 500 * M, lng: p.lng, prec: 6 })));
tr = GPS.trilha(comLacuna);
chk(tr.segmentos.length === 2 && tr.lacunas.length === 1, '6 min sem pontos e 500 m adiante: lacuna separada, não uma linha contínua', [tr.segmentos.length, tr.lacunas.length]);
const parada = linha(10, 3, 6).concat([{ t: t0 + 200000, lat: -22.9 + 27 * M, lng: -43.2, prec: 6 }]);
chk(GPS.trilha(parada).lacunas.length === 0, 'pausa longa sem sair do lugar não é lacuna');
const desordem = [{ t: t0, lat: -22.9, lng: -43.2, prec: 5 }, { t: t0, lat: -22.9, lng: -43.2, prec: 5 }, { t: t0 + 2000, lat: -22.9 + 4 * M, lng: -43.2, prec: 5 }];
chk(GPS.trilha(desordem).segmentos[0].length === 2, 'pontos duplicados ignorados no desenho');

console.log('\nFiltro de GPS: ' + ok + ' OK, ' + falha + ' falha(s)');
process.exit(falha ? 1 : 0);
