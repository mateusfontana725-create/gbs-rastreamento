/* =====================================================================
 * ferramentas.js — ferramentas de mapa do painel (inspiradas no AlpineQuest)
 *   - coordenadas do ponto tocado (toque longo / botão direito) e altitude
 *   - ir para coordenada (decimal, GMS, GMD, UTM, MGRS)
 *   - medir distância, rumo, área e perímetro
 *   - exportar GPX/KML/GeoJSON/CSV · importar GPX/KML/KMZ/GeoJSON/CSV
 *   - estatísticas e perfil de altitude da trilha
 *   - alarmes de proximidade: saiu do setor / entrou em área de risco
 *   - anéis de distância em torno de um ponto
 *   - nascer/pôr do sol e aviso de que vai escurecer
 * Usa a interface window.Painel (militar.js). Nada aqui grava posições.
 * ===================================================================== */
(function () {
  'use strict';
  var C = window.Comunicacao, UI = window.UI, P = window.Painel, Co = window.Coords, G = window.GPS;
  if (!P || !Co || !G) return;
  function $(id) { return document.getElementById(id); }
  function dist(a, b) { return G.distancia(a[0], a[1], b[0], b[1]); }
  function fmtDist(m) {
    if (m < 1000) return Math.round(m) + ' m';
    return (m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: m < 10000 ? 2 : 1 }) + ' km';
  }
  function fmtArea(m2) {
    if (m2 < 10000) return Math.round(m2).toLocaleString('pt-BR') + ' m²';
    if (m2 < 1e6) return (m2 / 10000).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' ha';
    return (m2 / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' km² (' + Math.round(m2 / 10000).toLocaleString('pt-BR') + ' ha)';
  }
  function fmtDur(ms) {
    var m = Math.round(ms / 60000);
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }
  function hhmm(d) { return d ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—'; }
  function lerLocal(k, padrao) { return C.local.ler(k, padrao); }
  function gravarLocal(k, v) { try { C.local.gravar(k, v); return true; } catch (e) { return false; } }

  // Área de um polígono na superfície da Terra (m²).
  function areaPoligono(pts) {
    if (pts.length < 3) return 0;
    var R = 6371000, k = Math.PI / 180, s = 0;
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      s += (b[1] - a[1]) * k * (2 + Math.sin(a[0] * k) + Math.sin(b[0] * k));
    }
    return Math.abs(s * R * R / 2);
  }

  // Distância (m) de um ponto até um segmento, numa projeção local plana.
  function distSegmento(p, a, b) {
    var kx = 111320 * Math.cos(p[0] * Math.PI / 180), ky = 111320;
    var ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky, bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
    var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    var t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    return Math.hypot(ax + t * dx, ay + t * dy);
  }
  function dentroPoligono(p, pts) {
    var dentro = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var yi = pts[i][0], xi = pts[i][1], yj = pts[j][0], xj = pts[j][1];
      if (((yi > p[0]) !== (yj > p[0])) && (p[1] < (xj - xi) * (p[0] - yi) / (yj - yi) + xi)) dentro = !dentro;
    }
    return dentro;
  }
  // > 0: fora do setor (metros até a borda); <= 0: dentro.
  function foraDoSetor(p, s) {
    if (s.forma === 'circulo') return dist(p, [s.centro_lat, s.centro_lng]) - s.raio_m;
    var pts = s.pontos || [];
    if (pts.length < 3) return -1;
    var borda = Infinity;
    for (var i = 0; i < pts.length; i++) borda = Math.min(borda, distSegmento(p, pts[i], pts[(i + 1) % pts.length]));
    return dentroPoligono(p, pts) ? -borda : borda;
  }

  /* ------------------------------------------------------------------ */
  /* Estado por operação (camadas importadas, anéis, sol)                 */
  /* ------------------------------------------------------------------ */
  var atual = { opId: null, mapa: null, camadaImport: null, camadaAneis: null, importados: [], aneis: {}, estadoAlertas: {}, marcaTemp: null };

  function chaveImport() { return 'gbs-importados:' + atual.opId; }
  function chaveAneis() { return 'gbs-aneis:' + atual.opId; }

  function vigiarPainel() {
    var op = P.op(), mapa = P.mapa();
    var opId = op && op.id;
    if (opId === atual.opId && mapa === atual.mapa) return;
    atual.opId = opId;
    atual.mapa = mapa;
    atual.estadoAlertas = {};
    atual.importados = [];
    atual.aneis = {};
    atual.camadaImport = atual.camadaAneis = atual.marcaTemp = null;
    if (!opId || !mapa) return;
    atual.camadaImport = L.layerGroup().addTo(mapa);
    atual.camadaAneis = L.layerGroup().addTo(mapa);
    atual.importados = lerLocal(chaveImport(), []) || [];
    atual.aneis = lerLocal(chaveAneis(), {}) || {};
    desenharImportados();
    desenharAneis();
    atualizarSol(true);
  }

  /* ------------------------------------------------------------------ */
  /* Coordenadas do ponto tocado                                          */
  /* ------------------------------------------------------------------ */
  function infoPonto(latlng) {
    var mapa = P.mapa();
    if (!mapa) return;
    var lat = Math.round(latlng.lat * 1e7) / 1e7, lng = Math.round(latlng.lng * 1e7) / 1e7;
    var alt = UI.el('span', { classe: 'muted', texto: 'consultando…' });
    var deMim = UI.el('span', { classe: 'muted', texto: 'calculando…' });
    var ativa = P.op() && P.op().status === 'ativa';
    var caixa = UI.el('div', { classe: 'info-ponto' }, [
      UI.el('strong', { texto: 'Ponto no mapa' }),
      P.blocoCoordenadas(lat, lng),
      UI.el('div', null, ['Altitude: ', alt]),
      UI.el('div', null, ['Da sua posição: ', deMim]),
      UI.el('div', { classe: 'info-ponto-acoes' }, [
        ativa || !P.op().dados_apagados_em ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '⚑ Marcar ponto', onclick: function () { mapa.closePopup(); P.marcarPonto(lat, lng); } }) : null,
        ativa ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '🧭 Enviar como destino', onclick: function () { mapa.closePopup(); P.enviarDestino(lat, lng); } }) : null,
        UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '📏 Medir daqui', onclick: function () { mapa.closePopup(); medir([lat, lng]); } }),
        UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '◎ Anéis aqui', onclick: function () { mapa.closePopup(); alternarAneis({ id: 'p' + lat + ',' + lng, lat: lat, lng: lng, nome: 'Ponto' }); } }),
      ]),
    ]);
    L.popup({ maxWidth: 320, className: 'popup-info-ponto' }).setLatLng([lat, lng]).setContent(caixa).openOn(mapa);
    P.altitudeEm(lat, lng).then(function (m) { alt.textContent = m == null ? 'indisponível' : '≈ ' + Math.round(m).toLocaleString('pt-BR') + ' m (modelo de terreno)'; });
    P.minhaPosicao().then(function (r) {
      if (!r || !r.ok) { deMim.textContent = 'sem a sua localização'; return; }
      var d = G.distancia(r.lat, r.lng, lat, lng), b = Co.rumo(r.lat, r.lng, lat, lng);
      deMim.textContent = fmtDist(d) + ' · rumo ' + Math.round(b) + '° (' + Co.cardeal(b) + ')';
    });
  }

  /* ------------------------------------------------------------------ */
  /* Ir para coordenada                                                   */
  /* ------------------------------------------------------------------ */
  function irParaCoordenada() {
    var entrada = UI.el('input', { classe: 'campo mono', id: 'ir-coord', autocomplete: 'off', spellcheck: 'false',
      placeholder: '-22.4515, -42.98 · 23K 707870 7515797 · 22°27\'05"S 42°58\'48"O' });
    var previa = UI.el('div', { classe: 'ir-coord-previa', 'aria-live': 'polite' });
    var btnIr = UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'ir-coord-ir', texto: 'Ir', disabled: true });
    var achado = null;
    function ler() {
      achado = Co.interpretar(entrada.value);
      btnIr.disabled = !achado;
      previa.innerHTML = '';
      if (!entrada.value.trim()) return;
      if (!achado) { previa.appendChild(UI.el('p', { classe: 'erro-form', texto: 'Formato não reconhecido.' })); return; }
      var t = Co.todos(achado.lat, achado.lng);
      Object.keys(Co.FORMATOS).forEach(function (f) { previa.appendChild(UI.el('div', { classe: 'mono' + (f === achado.formato ? '' : ' muted'), texto: t[f] })); });
    }
    entrada.addEventListener('input', ler);
    var form = UI.el('form', { novalidate: true }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Ir para coordenada' }),
      UI.el('p', { classe: 'ajuda', texto: 'Aceita graus decimais, graus-minutos-segundos (N/S, L/O ou E/W), graus e minutos decimais, UTM (zona + banda, ex.: 23K) e MGRS. Datum WGS 84 (o mesmo do GPS).' }),
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'ir-coord', texto: 'Coordenada' }), entrada]),
      previa,
      UI.el('div', { classe: 'modal-acoes' }, [UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btnIr]),
    ]);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!achado) return;
      fechar();
      var mapa = P.mapa();
      mapa.setView([achado.lat, achado.lng], Math.max(mapa.getZoom(), 15));
      if (atual.marcaTemp) atual.marcaTemp.remove();
      atual.marcaTemp = L.marker([achado.lat, achado.lng], { icon: L.divIcon({ className: 'mk-alvo-wrap', html: '<div class="mk-alvo">⌖</div>', iconSize: [0, 0] }), interactive: false }).addTo(mapa);
      setTimeout(function () { infoPonto(L.latLng(achado.lat, achado.lng)); }, 350);
    });
    var fechar = UI.abrirModal(form);
  }

  /* ------------------------------------------------------------------ */
  /* Medir distância, rumo, área                                          */
  /* ------------------------------------------------------------------ */
  function medir(inicio) {
    var pts = inicio ? [inicio] : [];
    var fechada = false;
    var ctl = P.iniciarDesenho({ aoClicar: function (ll) { pts.push(ll); redesenhar(); } });
    if (!ctl) return;
    function botao(texto, id, fn, desab) { return UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: id, texto: texto, disabled: desab ? true : null, onclick: fn }); }
    function redesenhar() {
      ctl.camada.clearLayers();
      var total = 0;
      for (var i = 1; i < pts.length; i++) {
        var d = dist(pts[i - 1], pts[i]), b = Co.rumo(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
        total += d;
        var meio = [(pts[i - 1][0] + pts[i][0]) / 2, (pts[i - 1][1] + pts[i][1]) / 2];
        L.marker(meio, { icon: L.divIcon({ className: 'rotulo-medida-wrap', html: '<div class="rotulo-medida">' + fmtDist(d) + ' · ' + Math.round(b) + '°</div>', iconSize: [0, 0] }), interactive: false }).addTo(ctl.camada);
      }
      if (pts.length >= 2) {
        (fechada && pts.length >= 3 ? L.polygon(pts, { color: '#facc15', weight: 3, fillOpacity: 0.12, interactive: false })
          : L.polyline(pts, { color: '#facc15', weight: 3, dashArray: '8 6', interactive: false })).addTo(ctl.camada);
      }
      pts.forEach(function (p) { L.circleMarker(p, { radius: 5, color: '#000', weight: 1.5, fillColor: '#facc15', fillOpacity: 1, interactive: false }).addTo(ctl.camada); });
      var texto;
      if (!pts.length) texto = 'Toque no mapa para começar a medir.';
      else if (pts.length === 1) texto = 'Toque no próximo ponto.';
      else if (fechada && pts.length >= 3) {
        var perim = total + dist(pts[pts.length - 1], pts[0]);
        texto = 'Área: ' + fmtArea(areaPoligono(pts)) + ' · perímetro ' + fmtDist(perim);
      } else texto = 'Distância: ' + fmtDist(total) + ' (' + (pts.length - 1) + ' trecho' + (pts.length > 2 ? 's' : '') + ')';
      var b = [
        botao('Desfazer', 'medir-desfazer', function () { pts.pop(); if (pts.length < 3) fechada = false; redesenhar(); }, !pts.length),
        botao(fechada ? 'Abrir linha' : 'Fechar área', 'medir-area', function () { fechada = !fechada; redesenhar(); }, pts.length < 3),
        fechada && pts.length >= 3 && P.op() && !P.op().dados_apagados_em ? botao('Salvar como setor', 'medir-setor', function () { var c = pts.slice(); ctl.encerrar(); P.criarSetor(c); }) : null,
        botao('Sair', 'medir-sair', function () { ctl.encerrar(); }),
      ];
      ctl.barra(texto, null, b);
      var el = $('barra-desenho-texto');
      if (el) el.setAttribute('data-medida', texto);
    }
    redesenhar();
  }

  /* ------------------------------------------------------------------ */
  /* Exportar                                                             */
  /* ------------------------------------------------------------------ */
  function dadosParaExportar(o) {
    var dados = { nome: P.op().codigo, trilhas: [], pontos: [], setores: [] };
    if (o.trilhas) {
      P.participantes().forEach(function (p) {
        if (o.participante && p.id !== o.participante) return;
        var tr = P.trilha(p);
        if (!tr.segmentos.length) return;
        dados.trilhas.push({ nome: p.dados.nome + ' (' + P.tipo(p) + ')', tipo: P.tipo(p), cor: p.cor, segmentos: tr.segmentos });
      });
    }
    if (o.pontos) {
      P.pontosInteresse().forEach(function (d) {
        dados.pontos.push({ nome: d.titulo, lat: d.lat, lng: d.lng, descricao: d.descricao, categoria: (P.categorias[d.categoria] || {}).rotulo || d.categoria });
      });
    }
    if (o.setores) dados.setores = P.setores();
    return dados;
  }

  function abrirExportar(participanteId) {
    var sel = UI.el('select', { classe: 'campo', id: 'exp-quem' }, [UI.el('option', { value: '', texto: 'Todos os participantes' })].concat(
      P.participantes().map(function (p) { return UI.el('option', { value: p.id, selected: p.id === participanteId ? true : null, texto: P.nome(p) }); })));
    function caixa(id, texto, marcado) { return UI.el('label', { classe: 'linha-opcao' }, [UI.el('input', { type: 'checkbox', id: id, checked: marcado ? true : null }), ' ' + texto]); }
    var formatos = [['gpx', 'GPX', 'AlpineQuest, Garmin, OsmAnd, Wikiloc'], ['kml', 'KML', 'Google Earth e Google Maps'], ['geojson', 'GeoJSON', 'QGIS e outros SIG'], ['csv', 'CSV', 'planilha (Excel, LibreOffice)']];
    var radios = UI.el('div', { classe: 'opcoes-modo' }, formatos.map(function (f, i) {
      return UI.el('label', { classe: 'opcao-modo' }, [UI.el('input', { type: 'radio', name: 'exp-formato', value: f[0], checked: i === 0 ? true : null }),
        UI.el('span', null, [UI.el('strong', { texto: f[1] }), UI.el('small', { texto: f[2] })])]);
    }));
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var form = UI.el('form', { novalidate: true }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Exportar dados da operação' }),
      UI.el('div', { classe: 'grupo' }, [caixa('exp-trilhas', 'Trilhas de', true), sel]),
      UI.el('div', { classe: 'grupo' }, [caixa('exp-pontos', 'Pontos de interesse', !participanteId), caixa('exp-setores', 'Setores de busca (no GPX, como contorno)', !participanteId)]),
      UI.el('div', { classe: 'grupo' }, [UI.el('span', { classe: 'rotulo', texto: 'Formato' }), radios]),
      UI.el('p', { classe: 'nota', texto: 'O arquivo contém a localização de pessoas: guarde e compartilhe com o mesmo cuidado dos dados da operação.' }),
      erro,
      UI.el('div', { classe: 'modal-acoes' }, [UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }),
        UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'exp-baixar', texto: 'Baixar arquivo' })]),
    ]);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var fmt = form.querySelector('input[name="exp-formato"]:checked').value;
      var o = { trilhas: $('exp-trilhas').checked, participante: sel.value || null, pontos: $('exp-pontos').checked, setores: $('exp-setores').checked };
      var dados = dadosParaExportar(o);
      if (!dados.trilhas.length && !dados.pontos.length && !dados.setores.length) { erro.textContent = 'Nada para exportar com essas opções.'; erro.hidden = false; return; }
      var nome = (P.op().codigo + (o.participante ? '-' + (P.participante(o.participante) || { dados: { nome: '' } }).dados.nome : '') + '-' +
        new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '_') + '.' + fmt;
      window.Arquivos.baixar(nome, window.Arquivos.exportar(fmt, dados), fmt);
      window.__ultimaExportacao = { nome: nome, formato: fmt, dados: dados };   // para conferência/testes
      fechar();
      UI.aviso('Arquivo "' + nome + '" gerado.', 'ok');
    });
    var fechar = UI.abrirModal(form);
  }

  /* ------------------------------------------------------------------ */
  /* Importar                                                             */
  /* ------------------------------------------------------------------ */
  var COR_IMPORT = '#84cc16';
  function desenharImportados() {
    if (!atual.camadaImport) return;
    atual.camadaImport.clearLayers();
    atual.importados.forEach(function (imp) {
      if (!imp.visivel) return;
      var d = imp.dados;
      d.areas.forEach(function (a) { L.polygon(a.pts, { color: COR_IMPORT, weight: 2, fillOpacity: 0.08, dashArray: '4 4', className: 'importado' }).bindTooltip(a.nome).addTo(atual.camadaImport); });
      d.linhas.forEach(function (l) { L.polyline(l.pts, { color: COR_IMPORT, weight: 3, opacity: 0.9, className: 'importado' }).bindTooltip(l.nome).addTo(atual.camadaImport); });
      d.pontos.forEach(function (p) {
        L.marker([p.lat, p.lng], { icon: L.divIcon({ className: 'mk-import-wrap', html: '<div class="mk-import"></div><div class="mk-import-rotulo">' + C.esc(p.nome) + '</div>', iconSize: [0, 0] }), title: p.nome })
          .bindPopup(function () { return infoImportado(p); }).addTo(atual.camadaImport);
      });
    });
    var el = $('menu-importados-qtd');
    if (el) el.textContent = atual.importados.length ? atual.importados.length + ' camada(s)' : '';
  }

  function infoImportado(p) {
    var ativa = P.op() && !P.op().dados_apagados_em;
    return UI.el('div', { classe: 'info-ponto' }, [
      UI.el('strong', { texto: p.nome }), p.descricao ? UI.el('div', { classe: 'muted', texto: p.descricao }) : null,
      P.blocoCoordenadas(p.lat, p.lng),
      ativa ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '⚑ Salvar como ponto de interesse', onclick: function () {
        P.mapa().closePopup(); P.marcarPonto(p.lat, p.lng, { titulo: p.nome.slice(0, 80), descricao: (p.descricao || '').slice(0, 1000), categoria: 'OUTRO' }); } }) : null,
    ]);
  }

  function salvarImportados() {
    if (!gravarLocal(chaveImport(), atual.importados)) UI.aviso('Camada grande demais para ficar guardada neste aparelho: ela some ao recarregar a página.', 'erro', 8000);
  }

  function abrirImportar() {
    var entrada = UI.el('input', { type: 'file', id: 'imp-arquivo', accept: '.gpx,.kml,.kmz,.geojson,.json,.csv,.txt', classe: 'campo' });
    var lista = UI.el('ul', { classe: 'lista-importados' });
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    function render() {
      lista.innerHTML = '';
      if (!atual.importados.length) { lista.appendChild(UI.el('li', { classe: 'muted', texto: 'Nenhuma camada importada.' })); return; }
      atual.importados.forEach(function (imp) {
        var d = imp.dados;
        var resumo = [d.pontos.length + ' ponto(s)', d.linhas.length + ' trilha(s)/rota(s)', d.areas.length + ' área(s)'].join(' · ');
        var ativa = P.op() && !P.op().dados_apagados_em;
        lista.appendChild(UI.el('li', { classe: 'item-importado' }, [
          UI.el('label', { classe: 'linha-opcao' }, [UI.el('input', { type: 'checkbox', checked: imp.visivel ? true : null, onchange: function () { imp.visivel = this.checked; salvarImportados(); desenharImportados(); } }),
            UI.el('strong', { texto: ' ' + imp.nome })]),
          UI.el('small', { classe: 'muted', texto: resumo }),
          UI.el('div', { classe: 'acoes-linha' }, [
            UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Ver no mapa', onclick: function () { fechar(); enquadrar(imp); } }),
            ativa && d.pontos.length ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Pontos → pontos de interesse', onclick: function () { fechar(); converterPontos(imp); } }) : null,
            ativa && d.areas.length ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Área → setor', onclick: function () {
              fechar(); var a = d.areas[0]; P.criarSetor(a.pts.slice(0, 300).map(function (q) { return [Math.round(q[0] * 1e7) / 1e7, Math.round(q[1] * 1e7) / 1e7]; }), a.nome); } }) : null,
            UI.el('button', { classe: 'btn btn-pequeno btn-perigo', type: 'button', texto: 'Remover', onclick: function () {
              atual.importados = atual.importados.filter(function (x) { return x !== imp; }); salvarImportados(); desenharImportados(); render(); } }),
          ]),
        ]));
      });
    }
    entrada.addEventListener('change', async function () {
      var f = entrada.files && entrada.files[0];
      entrada.value = '';
      if (!f) return;
      erro.hidden = true;
      try {
        var d = await window.Arquivos.importar(f);
        var imp = { id: C.uuid(), nome: f.name, dados: { pontos: d.pontos, linhas: d.linhas, areas: d.areas }, visivel: true, em: Date.now() };
        atual.importados.push(imp);
        salvarImportados();
        desenharImportados();
        render();
        enquadrar(imp, true);
        UI.aviso('Importado: ' + f.name + ' (' + d.pontos.length + ' pontos, ' + d.linhas.length + ' trilhas/rotas, ' + d.areas.length + ' áreas).', 'ok', 7000);
      } catch (e) {
        erro.textContent = 'Não foi possível importar "' + f.name + '": ' + (e.message || e);
        erro.hidden = false;
      }
    });
    render();
    var fechar = UI.abrirModal(UI.el('div', null, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Importar arquivo de mapa' }),
      UI.el('p', { classe: 'ajuda', texto: 'GPX, KML, KMZ, GeoJSON ou CSV (com colunas latitude e longitude) — por exemplo, trilhas conhecidas, a última rota da vítima ou áreas de outro órgão. ' +
        'A camada aparece em verde-limão e fica guardada só neste aparelho; para todos os responsáveis verem, converta em pontos de interesse ou setor.' }),
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'imp-arquivo', texto: 'Arquivo' }), entrada]),
      erro,
      UI.el('h3', { texto: 'Camadas importadas' }),
      lista,
      UI.el('div', { classe: 'modal-acoes' }, [UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]),
    ]));
  }

  function enquadrar(imp, silencioso) {
    var pts = [];
    imp.dados.pontos.forEach(function (p) { pts.push([p.lat, p.lng]); });
    imp.dados.linhas.forEach(function (l) { pts = pts.concat(l.pts); });
    imp.dados.areas.forEach(function (a) { pts = pts.concat(a.pts); });
    if (!pts.length) return;
    imp.visivel = true;
    desenharImportados();
    P.mapa().fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 16 });
    void silencioso;
  }

  async function converterPontos(imp) {
    var pts = imp.dados.pontos.slice(0, 100);
    var r = await UI.confirmar({ titulo: 'Criar ' + pts.length + ' ponto(s) de interesse?', ok: 'Criar pontos',
      texto: 'Os pontos do arquivo "' + imp.nome + '" passam a ser vistos por todos os responsáveis da operação (categoria "Outro"; dá para editar depois).' +
        (imp.dados.pontos.length > 100 ? ' Só os 100 primeiros serão criados.' : '') });
    if (!r) return;
    var ok = 0, falhas = 0;
    for (var i = 0; i < pts.length; i++) {
      try {
        await P.salvarPonto({ categoria: 'OUTRO', titulo: String(pts[i].nome || 'Ponto importado').slice(0, 80), descricao: ('Importado de ' + imp.nome + (pts[i].descricao ? ' — ' + pts[i].descricao : '')).slice(0, 1000), lat: pts[i].lat, lng: pts[i].lng });
        ok++;
      } catch (e) { falhas++; }
    }
    UI.aviso(ok + ' ponto(s) criados' + (falhas ? '; ' + falhas + ' com erro' : '') + '.', falhas ? 'erro' : 'ok', 7000);
  }

  /* ------------------------------------------------------------------ */
  /* Anéis de distância                                                   */
  /* ------------------------------------------------------------------ */
  var DIST_ANEIS = [500, 1000, 2000, 5000];
  function desenharAneis() {
    if (!atual.camadaAneis) return;
    atual.camadaAneis.clearLayers();
    Object.keys(atual.aneis).forEach(function (id) {
      var a = atual.aneis[id];
      (a.dist || DIST_ANEIS).forEach(function (r) {
        L.circle([a.lat, a.lng], { radius: r, color: '#e5e7eb', weight: 1.5, opacity: 0.85, dashArray: '3 6', fill: false, interactive: false, className: 'anel-distancia' }).addTo(atual.camadaAneis);
        var topo = Co.projetar(a.lat, a.lng, r, 0);
        L.marker([topo.lat, topo.lng], { icon: L.divIcon({ className: 'rotulo-anel-wrap', html: '<div class="rotulo-anel">' + fmtDist(r) + '</div>', iconSize: [0, 0] }), interactive: false }).addTo(atual.camadaAneis);
      });
    });
  }
  function temAneis(id) { return Boolean(atual.aneis[id]); }
  async function alternarAneis(o) {
    if (atual.aneis[o.id]) {
      delete atual.aneis[o.id];
    } else {
      var r = await UI.confirmar({ titulo: 'Anéis de distância — ' + o.nome, ok: 'Mostrar anéis',
        texto: 'Círculos de distância em torno do ponto (ex.: raio de busca a partir da última localização conhecida).',
        campo: { rotulo: 'Distâncias em km, separadas por espaço', valor: '0,5 1 2 5', max: 80, obrigatorio: true } });
      if (!r) return;
      var lista = r.texto.split(/[\s;]+/).map(function (v) { return Math.round(Number(v.replace(',', '.')) * 1000); }).filter(function (v) { return v >= 10 && v <= 100000; }).slice(0, 8);
      if (!lista.length) { UI.aviso('Informe ao menos uma distância válida.', 'erro'); return; }
      atual.aneis[o.id] = { lat: o.lat, lng: o.lng, nome: o.nome, dist: lista };
    }
    gravarLocal(chaveAneis(), atual.aneis);
    desenharAneis();
  }

  /* ------------------------------------------------------------------ */
  /* Estatísticas e perfil de altitude da trilha                          */
  /* ------------------------------------------------------------------ */
  function estatisticas(p) {
    var tr = P.trilha(p);
    var s = { pontos: 0, distancia: 0, emMovimento: 0, distMovimento: 0, velMax: 0, inicio: null, fim: null, segmentos: tr.segmentos.length, lacunas: tr.lacunas.length };
    var vels = [];
    tr.segmentos.forEach(function (seg) {
      seg.forEach(function (q, i) {
        s.pontos++;
        if (!s.inicio || q.t < s.inicio) s.inicio = q.t;
        if (!s.fim || q.t > s.fim) s.fim = q.t;
        if (!i) return;
        var a = seg[i - 1], d = G.distancia(a.lat, a.lng, q.lat, q.lng), dt = (q.t - a.t) / 1000;
        s.distancia += d;
        if (dt > 0 && dt <= 180 && d / dt >= 0.3) { s.emMovimento += dt * 1000; s.distMovimento += d; }
        if (dt >= 3) vels.push(d / dt);
      });
    });
    vels.sort(function (a, b) { return a - b; });
    s.velMax = vels.length ? vels[Math.floor(vels.length * 0.95)] || vels[vels.length - 1] : 0;
    s.velMedia = s.emMovimento ? s.distMovimento / (s.emMovimento / 1000) : 0;
    s.trilha = tr;
    return s;
  }

  function kmh(ms) { return (ms * 3.6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' km/h'; }

  function abrirEstatisticas(pid) {
    var p = P.participante(pid);
    if (!p) return;
    var s = estatisticas(p);
    var dl = UI.el('dl', { classe: 'dados' });
    function linha(r, v) { dl.appendChild(UI.el('dt', { texto: r })); dl.appendChild(UI.el('dd', { texto: v })); }
    linha('Distância percorrida', fmtDist(s.distancia));
    linha('Período', s.inicio ? C.hora(s.inicio) + ' a ' + C.hora(s.fim) + ' (' + fmtDur(s.fim - s.inicio) + ')' : '—');
    linha('Tempo em movimento', fmtDur(s.emMovimento));
    linha('Velocidade média em movimento', s.velMedia ? kmh(s.velMedia) : '—');
    linha('Velocidade máxima (aprox.)', s.velMax ? kmh(s.velMax) : '—');
    linha('Pontos registrados', String(s.pontos) + (s.lacunas ? ' · ' + s.lacunas + ' lacuna(s) sem registro' : ''));
    var subida = UI.el('dd', { texto: 'calculando…' }), descida = UI.el('dd', { texto: 'calculando…' }), extremos = UI.el('dd', { texto: 'calculando…' });
    dl.appendChild(UI.el('dt', { texto: 'Subida acumulada' })); dl.appendChild(subida);
    dl.appendChild(UI.el('dt', { texto: 'Descida acumulada' })); dl.appendChild(descida);
    dl.appendChild(UI.el('dt', { texto: 'Altitude mínima / máxima' })); dl.appendChild(extremos);
    var grafico = UI.el('div', { classe: 'perfil-altitude', id: 'perfil-altitude' }, [UI.el('p', { classe: 'muted', texto: s.distancia ? 'Montando o perfil de altitude…' : 'Sem trilha para o perfil.' })]);
    var tabela = UI.el('details', { classe: 'perfil-tabela' }, [UI.el('summary', { texto: 'Ver perfil em tabela' })]);
    var fechar = UI.abrirModal(UI.el('div', { classe: 'modal-estatisticas' }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Trilha de ' + P.nome(p) }),
      dl,
      UI.el('h3', { texto: 'Perfil de altitude' }),
      grafico,
      tabela,
      UI.el('p', { classe: 'ajuda', texto: 'Altitude do modelo de terreno (≈ 20–30 m de resolução) nos pontos da trilha, não a do GPS. Velocidade máxima: valor alto típico (percentil 95), para não contar erro de GPS.' }),
      UI.el('div', { classe: 'modal-acoes' }, [UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]),
    ]), { aoFechar: function () { if (atual.marcaPerfil) { atual.marcaPerfil.remove(); atual.marcaPerfil = null; } } });
    if (!s.distancia) { subida.textContent = descida.textContent = extremos.textContent = '—'; return; }
    perfil(s.trilha).then(function (r) {
      if (!r.amostras.length) { grafico.innerHTML = '<p class="muted">Modelo de terreno indisponível agora (sem conexão).</p>'; subida.textContent = descida.textContent = extremos.textContent = '—'; return; }
      subida.textContent = '≈ ' + Math.round(r.subida) + ' m';
      descida.textContent = '≈ ' + Math.round(r.descida) + ' m';
      extremos.textContent = Math.round(r.min) + ' m / ' + Math.round(r.max) + ' m';
      desenharPerfil(grafico, r);
      var tb = UI.el('table', { classe: 'tabela-hist' }, [UI.el('thead', null, [UI.el('tr', null, [UI.el('th', { texto: 'Distância' }), UI.el('th', { texto: 'Altitude' })])])]);
      var corpo = UI.el('tbody');
      r.amostras.forEach(function (a) { corpo.appendChild(UI.el('tr', null, [UI.el('td', { classe: 'num', texto: fmtDist(a.d) }), UI.el('td', { classe: 'num', texto: a.alt == null ? '—' : Math.round(a.alt) + ' m' })])); });
      tb.appendChild(corpo);
      tabela.appendChild(tb);
    });
  }

  // Amostra a altitude ao longo da trilha (no máximo ~150 pontos).
  async function perfil(tr) {
    var total = 0;
    tr.segmentos.forEach(function (seg) { for (var i = 1; i < seg.length; i++) total += G.distancia(seg[i - 1].lat, seg[i - 1].lng, seg[i].lat, seg[i].lng); });
    var passo = Math.max(15, total / 150);
    var amostras = [], acum = 0;
    tr.segmentos.forEach(function (seg, si) {
      var proximo = acum;
      for (var i = 0; i < seg.length; i++) {
        if (i) {
          var a = seg[i - 1], b = seg[i], d = G.distancia(a.lat, a.lng, b.lat, b.lng);
          while (proximo <= acum + d && d > 0) {
            var f = (proximo - acum) / d;
            amostras.push({ d: proximo, lat: a.lat + f * (b.lat - a.lat), lng: a.lng + f * (b.lng - a.lng), seg: si });
            proximo += passo;
          }
          acum += d;
        } else {
          amostras.push({ d: acum, lat: seg[0].lat, lng: seg[0].lng, seg: si });
          proximo = acum + passo;
        }
      }
    });
    await Promise.all(amostras.map(function (a) { return P.altitudeEm(a.lat, a.lng).then(function (m) { a.alt = m; }); }));
    var validas = amostras.filter(function (a) { return a.alt != null; });
    if (!validas.length) return { amostras: [] };
    // subida/descida com histerese de 5 m (o modelo de terreno tem degraus)
    var subida = 0, descida = 0, ref = validas[0].alt, min = Infinity, max = -Infinity;
    validas.forEach(function (a) {
      min = Math.min(min, a.alt); max = Math.max(max, a.alt);
      if (a.alt - ref >= 5) { subida += a.alt - ref; ref = a.alt; } else if (ref - a.alt >= 5) { descida += ref - a.alt; ref = a.alt; }
    });
    return { amostras: amostras, total: acum, subida: subida, descida: descida, min: min, max: max };
  }

  // Gráfico de linha (uma série): distância × altitude, com cruz e dica ao passar o dedo/mouse.
  function desenharPerfil(caixa, r) {
    var W = 640, H = 200, ml = 48, mr = 12, mt = 12, mb = 28;
    var vmin = Math.floor((r.min - 10) / 10) * 10, vmax = Math.ceil((r.max + 10) / 10) * 10;
    var x = function (d) { return ml + (W - ml - mr) * d / (r.total || 1); };
    var y = function (v) { return mt + (H - mt - mb) * (1 - (v - vmin) / ((vmax - vmin) || 1)); };
    var caminhos = [], atualSeg = null, cam = '';
    r.amostras.forEach(function (a) {
      if (a.alt == null) return;
      if (a.seg !== atualSeg) { if (cam) caminhos.push(cam); cam = 'M'; atualSeg = a.seg; } else cam += 'L';
      cam += x(a.d).toFixed(1) + ' ' + y(a.alt).toFixed(1) + ' ';
    });
    if (cam) caminhos.push(cam);
    var grade = '';
    for (var k = 0; k <= 4; k++) {
      var v = vmin + (vmax - vmin) * k / 4, yy = y(v).toFixed(1);
      grade += '<line x1="' + ml + '" x2="' + (W - mr) + '" y1="' + yy + '" y2="' + yy + '" class="perfil-grade"/>' +
        '<text x="' + (ml - 6) + '" y="' + yy + '" class="perfil-eixo" text-anchor="end" dominant-baseline="middle">' + Math.round(v) + '</text>';
    }
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="perfil-svg" role="img" aria-label="Perfil de altitude: de ' + Math.round(r.min) + ' a ' + Math.round(r.max) + ' metros em ' + fmtDist(r.total) + '">' +
      grade +
      '<text x="' + ml + '" y="' + (H - 8) + '" class="perfil-eixo">0</text>' +
      '<text x="' + (W - mr) + '" y="' + (H - 8) + '" class="perfil-eixo" text-anchor="end">' + fmtDist(r.total) + '</text>' +
      '<text x="' + ((ml + W - mr) / 2) + '" y="' + (H - 8) + '" class="perfil-eixo" text-anchor="middle">distância ao longo da trilha · altitude em m</text>' +
      caminhos.map(function (c) { return '<path d="' + c + '" class="perfil-linha"/>'; }).join('') +
      '<line class="perfil-cursor" x1="0" x2="0" y1="' + mt + '" y2="' + (H - mb) + '" visibility="hidden"/>' +
      '<circle class="perfil-ponto" r="4" cx="0" cy="0" visibility="hidden"/>' +
      '<rect class="perfil-alvo" x="' + ml + '" y="' + mt + '" width="' + (W - ml - mr) + '" height="' + (H - mt - mb) + '" fill="transparent"/></svg>';
    caixa.innerHTML = svg + '<div class="perfil-dica" hidden></div>';
    var el = caixa.querySelector('svg'), alvo = caixa.querySelector('.perfil-alvo'), cursor = caixa.querySelector('.perfil-cursor'),
      ponto = caixa.querySelector('.perfil-ponto'), dica = caixa.querySelector('.perfil-dica');
    var validas = r.amostras.filter(function (a) { return a.alt != null; });
    function mover(ev) {
      var b = el.getBoundingClientRect();
      var px = (ev.clientX - b.left) / b.width * W;
      var d = (px - ml) / (W - ml - mr) * r.total;
      var a = validas.reduce(function (m, q) { return Math.abs(q.d - d) < Math.abs(m.d - d) ? q : m; }, validas[0]);
      cursor.setAttribute('x1', x(a.d)); cursor.setAttribute('x2', x(a.d)); cursor.setAttribute('visibility', 'visible');
      ponto.setAttribute('cx', x(a.d)); ponto.setAttribute('cy', y(a.alt)); ponto.setAttribute('visibility', 'visible');
      dica.hidden = false;
      dica.textContent = fmtDist(a.d) + ' · ' + Math.round(a.alt) + ' m';
      dica.style.left = Math.min(b.width - 120, Math.max(0, x(a.d) / W * b.width - 50)) + 'px';
      if (!atual.marcaPerfil) atual.marcaPerfil = L.circleMarker([a.lat, a.lng], { radius: 7, color: '#000', weight: 2, fillColor: '#facc15', fillOpacity: 1, interactive: false }).addTo(P.mapa());
      else atual.marcaPerfil.setLatLng([a.lat, a.lng]);
    }
    function sair() { cursor.setAttribute('visibility', 'hidden'); ponto.setAttribute('visibility', 'hidden'); dica.hidden = true; }
    alvo.addEventListener('pointermove', mover);
    alvo.addEventListener('pointerdown', mover);
    alvo.addEventListener('pointerleave', sair);
  }

  /* ------------------------------------------------------------------ */
  /* Alarmes de proximidade                                               */
  /* ------------------------------------------------------------------ */
  function aoNovoPonto(p, pt) {
    if (P.tipo(p) === 'responsavel' || p.dados.removido) return;
    var pos = [pt.lat, pt.lng], margem = Math.max(25, pt.prec || 0);
    var nome = p.dados.nome;
    // setor atribuído a esta pessoa
    P.setores().forEach(function (s) {
      if (s.participante_id !== p.id || s.status === 'concluido') return;
      var chave = p.id + ':s:' + s.id;
      var f = foraDoSetor(pos, s);
      var antes = atual.estadoAlertas[chave];
      var agora = f > margem ? 'fora' : f <= 0 ? 'dentro' : antes || 'dentro';
      atual.estadoAlertas[chave] = agora;
      if (antes === 'dentro' && agora === 'fora') {
        UI.aviso('⚠ ' + nome + ' SAIU do setor ' + s.nome + ' (≈ ' + fmtDist(f) + ' fora).', 'erro', 15000);
        P.alarme();
        registrarAlerta(nome + ' saiu do setor ' + s.nome);
      } else if (antes === 'fora' && agora === 'dentro') {
        UI.aviso(nome + ' voltou ao setor ' + s.nome + '.', 'ok', 6000);
      }
    });
    // áreas de risco
    P.pontosInteresse().forEach(function (d) {
      if (d.categoria !== 'RISCO') return;
      var chave = p.id + ':r:' + d.id;
      var raio = d.raio_m || P.raioAlertaPadrao;
      var dd = G.distancia(pt.lat, pt.lng, d.lat, d.lng);
      var antes = atual.estadoAlertas[chave];
      var agora = dd <= raio ? 'dentro' : dd > raio + Math.max(10, (pt.prec || 0) / 2) ? 'fora' : antes || 'fora';
      atual.estadoAlertas[chave] = agora;
      if (agora === 'dentro' && antes !== 'dentro') {
        UI.aviso('⚠ ' + nome + ' ENTROU na área de risco "' + d.titulo + '" (a ' + fmtDist(dd) + ' do ponto).', 'erro', 15000);
        P.alarme();
        registrarAlerta(nome + ' entrou na área de risco ' + d.titulo);
      }
    });
  }

  var alertas = [];
  function registrarAlerta(texto) {
    alertas.unshift({ em: Date.now(), texto: texto });
    alertas = alertas.slice(0, 50);
    window.__alertasProximidade = alertas;
  }

  /* ------------------------------------------------------------------ */
  /* Sol: nascer, pôr e quando escurece                                   */
  /* ------------------------------------------------------------------ */
  function atualizarSol(forcar) {
    var el = $('menu-sol'), mapa = P.mapa(), op = P.op();
    if (!el || !mapa || !op) return;
    var c = mapa.getCenter();
    var agora = new Date();
    var s = Co.sol(agora, c.lat, c.lng);
    if (!s.nascer) { el.hidden = true; return; }
    var txt = '☀ Nascer ' + hhmm(s.nascer) + ' · pôr ' + hhmm(s.por) + ' · escurece ' + hhmm(s.escurece);
    var falta = s.escurece - agora;
    if (falta > 0 && agora > s.amanhecer) txt += ' — faltam ' + fmtDur(falta) + ' de claridade';
    else if (falta <= 0) txt += ' — já escureceu';
    el.textContent = txt;
    el.hidden = false;
    if (op.status !== 'ativa' || forcar === true) return;
    // avisos 60 e 30 min antes de escurecer (uma vez por operação e dia)
    [60, 30].forEach(function (min) {
      if (falta <= min * 60000 && falta > (min - 1) * 60000 - 60000) {
        var k = 'gbs-sol-aviso:' + op.id + ':' + agora.toDateString() + ':' + min;
        try { if (sessionStorage.getItem(k)) return; sessionStorage.setItem(k, '1'); } catch (e) { /* ignora */ }
        UI.aviso('🌇 Faltam ' + min + ' min para escurecer (às ' + hhmm(s.escurece) + '). Planeje o retorno das equipes.', 'erro', 15000);
        P.alarme();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Ligações com o menu                                                  */
  /* ------------------------------------------------------------------ */
  function ligar(id, fn) { var b = $(id); if (b) b.addEventListener('click', fn); }
  ligar('menu-ir-coord', irParaCoordenada);
  ligar('menu-medir', function () { medir(null); });
  ligar('menu-exportar', function () { abrirExportar(null); });
  ligar('menu-importar', abrirImportar);
  setInterval(vigiarPainel, 700);
  setInterval(function () { atualizarSol(false); }, 60000);
  document.addEventListener('click', function (ev) { if (ev.target.closest && ev.target.closest('#btn-ferramentas')) setTimeout(function () { atualizarSol(true); }, 0); });

  window.Ferramentas = {
    infoPonto: infoPonto, irParaCoordenada: irParaCoordenada, medir: medir,
    abrirExportar: abrirExportar, abrirImportar: abrirImportar,
    abrirEstatisticas: abrirEstatisticas, estatisticas: estatisticas,
    alternarAneis: alternarAneis, temAneis: temAneis,
    aoNovoPonto: aoNovoPonto, foraDoSetor: foraDoSetor, areaPoligono: areaPoligono,
  };
})();
