/* =====================================================================
 * rotas.js — rota por ruas, caminhos e trilhas (não em linha reta)
 * Pede a rota ao servidor (/api/rota → openrouteservice, chave só no servidor),
 * desenha no Leaflet e acompanha o progresso do participante na rota.
 * Usado pela página do participante e pelo painel.
 * ===================================================================== */
(function () {
  'use strict';
  var C = window.Comunicacao;

  var MODOS = {
    a_pe: { rotulo: 'A pé', icone: '🚶', descricao: 'ruas, calçadas e caminhos', google: 'walking' },
    trilha: { rotulo: 'Trilha', icone: '🥾', descricao: 'prioriza trilhas e caminhos de terra', google: 'walking' },
    carro: { rotulo: 'Carro', icone: '🚗', descricao: 'estradas e ruas para veículos', google: 'driving' },
  };

  function dist(a, b) { return window.GPS.distancia(a[0], a[1], b[0], b[1]); }

  // Pede a rota. Devolve { ok: true, rota } ou { ok: false, erro, mensagem }.
  async function calcular(o) {
    var sessao = null;
    try { sessao = (await C.cliente.auth.getSession()).data.session; } catch (e) { /* sem sessão */ }
    if (!sessao) return { ok: false, erro: 'nao_autenticado', mensagem: 'Sessão expirada.' };
    var corpo = { origem: o.origem, destino: o.destino, modo: o.modo || 'a_pe' };
    if (o.participante_id) corpo.participante_id = o.participante_id;
    var r;
    try {
      r = await Promise.race([
        fetch('/api/rota', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessao.access_token },
          body: JSON.stringify(corpo),
        }),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, 20000); }),
      ]);
    } catch (e) {
      return { ok: false, erro: 'rede', mensagem: 'Sem conexão para calcular a rota.' };
    }
    var dados = null;
    try { dados = await r.json(); } catch (e) { /* resposta inválida */ }
    if (!r.ok || !dados || !Array.isArray(dados.geometria)) {
      return { ok: false, erro: (dados && dados.erro) || 'rota_indisponivel', mensagem: (dados && dados.mensagem) || 'Não foi possível calcular a rota agora.' };
    }
    preparar(dados);
    dados.origem = o.origem;
    dados.destino = o.destino;
    return { ok: true, rota: dados };
  }

  // Distâncias acumuladas ao longo da rota.
  function preparar(rota) {
    var g = rota.geometria;
    rota.cumul = [0];
    for (var i = 1; i < g.length; i++) rota.cumul.push(rota.cumul[i - 1] + dist(g[i - 1], g[i]));
    rota.total = rota.cumul[rota.cumul.length - 1];
    return rota;
  }

  // Onde a pessoa está em relação à rota: ponto mais próximo, distância até a
  // rota, quanto falta pela rota, próxima instrução e um ponto ~40 m à frente
  // (para a seta da bússola seguir a rota, e não a linha reta).
  function progresso(rota, lat, lng) {
    var g = rota.geometria, kLat = 111320, kLng = 111320 * Math.cos(lat * Math.PI / 180);
    var melhor = { d: Infinity, i: 0, f: 0 };
    for (var i = 0; i < g.length - 1; i++) {
      var ax = (g[i][1] - lng) * kLng, ay = (g[i][0] - lat) * kLat;
      var bx = (g[i + 1][1] - lng) * kLng, by = (g[i + 1][0] - lat) * kLat;
      var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      var f = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
      var px = ax + f * dx, py = ay + f * dy;
      var d = Math.sqrt(px * px + py * py);
      if (d < melhor.d) melhor = { d: d, i: i, f: f };
    }
    var segLen = rota.cumul[melhor.i + 1] - rota.cumul[melhor.i];
    var percorrido = rota.cumul[melhor.i] + melhor.f * segLen;
    var restante = Math.max(0, rota.total - percorrido) + (rota.fora_fim_m || 0);
    // ponto 40 m à frente na rota
    var alvoDist = Math.min(rota.total, percorrido + 40), j = melhor.i;
    while (j < g.length - 2 && rota.cumul[j + 1] < alvoDist) j++;
    var fj = rota.cumul[j + 1] > rota.cumul[j] ? (alvoDist - rota.cumul[j]) / (rota.cumul[j + 1] - rota.cumul[j]) : 0;
    var alvo = [g[j][0] + fj * (g[j + 1][0] - g[j][0]), g[j][1] + fj * (g[j + 1][1] - g[j][1])];
    // instrução: o passo em que está e a próxima manobra
    var passos = rota.passos || [], k = 0;
    for (var p = 0; p < passos.length; p++) { if (passos[p].de <= melhor.i) k = p; }
    var prox = passos[k + 1] || null;
    var distManobra = prox ? Math.max(0, rota.cumul[Math.min(prox.de, rota.cumul.length - 1)] - percorrido) : restante;
    return {
      distanciaDaRota: melhor.d, indice: melhor.i, percorrido: percorrido, restante: restante, alvo: alvo,
      passoAtual: passos[k] || null, proximo: prox, distManobra: distManobra,
    };
  }

  function formatarDuracao(s) {
    if (!s && s !== 0) return '';
    var m = Math.round(s / 60);
    if (m < 1) return 'menos de 1 min';
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  }

  function formatarDistancia(m) {
    if (m < 1000) return Math.round(m) + ' m';
    return (m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: m < 10000 ? 1 : 0 }) + ' km';
  }

  function resumo(rota) {
    var md = MODOS[rota.modo] || MODOS.a_pe;
    var t = md.icone + ' ' + md.rotulo + ': ' + formatarDistancia(rota.distancia_m + (rota.fora_inicio_m || 0) + (rota.fora_fim_m || 0));
    if (rota.duracao_s) t += ' · ~' + formatarDuracao(rota.duracao_s);
    if (rota.subida_m != null) t += ' · ↑' + rota.subida_m + ' m ↓' + (rota.descida_m || 0) + ' m';
    return t;
  }

  // Desenha a rota num grupo do Leaflet: contorno claro, linha azul, trechos
  // íngremes em laranja e, tracejados em cinza, os trechos sem caminho mapeado.
  function desenhar(grupo, rota, opcoes) {
    opcoes = opcoes || {};
    grupo.clearLayers();
    var pts = rota.geometria.map(function (c) { return [c[0], c[1]]; });
    var peso = opcoes.peso || 5;
    L.polyline(pts, { color: '#ffffff', weight: peso + 4, opacity: 0.7, interactive: false, lineJoin: 'round', className: 'rota-halo' }).addTo(grupo);
    L.polyline(pts, { color: '#2563eb', weight: peso, opacity: 0.95, interactive: false, lineJoin: 'round', className: 'rota-linha' }).addTo(grupo);
    (rota.trechos_ingremes || []).forEach(function (t) {
      var trecho = pts.slice(t[0], t[1] + 1);
      if (trecho.length > 1) {
        L.polyline(trecho, { color: Math.abs(t[2]) >= 5 ? '#dc2626' : '#f97316', weight: peso, opacity: 1, interactive: false, className: 'rota-ingreme' }).addTo(grupo);
      }
    });
    var fora = { color: '#6b7280', weight: 3, dashArray: '4 6', opacity: 0.9, interactive: false, className: 'rota-fora' };
    if (rota.origem && rota.fora_inicio_m > 30) L.polyline([rota.origem, pts[0]], fora).addTo(grupo);
    if (rota.destino && rota.fora_fim_m > 30) L.polyline([pts[pts.length - 1], rota.destino], fora).addTo(grupo);
    return grupo;
  }

  function linkGoogle(destino, modo) {
    return 'https://www.google.com/maps/dir/?api=1&destination=' + destino[0] + ',' + destino[1] + '&travelmode=' + ((MODOS[modo] || MODOS.a_pe).google);
  }

  window.Rotas = {
    MODOS: MODOS, calcular: calcular, preparar: preparar, progresso: progresso, desenhar: desenhar,
    resumo: resumo, formatarDuracao: formatarDuracao, formatarDistancia: formatarDistancia, linkGoogle: linkGoogle,
  };
})();
