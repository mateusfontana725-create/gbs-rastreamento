/* =====================================================================
 * gps.js — filtro das leituras do GPS e montagem das trilhas
 * Usado pela página do participante, pela "Minha posição" do responsável
 * e pelo desenho das trilhas no painel.
 *
 * Princípios
 *   - Nenhuma posição é inventada nem "suavizada": cada ponto gravado é uma
 *     leitura real do aparelho. O filtro só decide QUAIS leituras entram.
 *   - Leituras imprecisas, antigas, repetidas, fora de ordem ou com salto
 *     impossível não entram na trilha. O motivo fica no diagnóstico local.
 *   - Parado, a oscilação natural do GPS (alguns metros para lá e para cá)
 *     não vira trilha; pequenos deslocamentos reais acumulam e entram.
 *   - O diagnóstico fica só na memória do aparelho (nunca é enviado) e guarda
 *     apenas horário, coordenadas arredondadas (~1 m), precisão e motivo.
 * ===================================================================== */
(function (global) {
  'use strict';

  var PADRAO = {
    precisaoBoaM: 25,          // até aqui a leitura é "boa"
    precisaoMaximaM: 100,      // acima disso a leitura não entra na trilha
    intervaloRuimMs: 60000,    // leitura imprecisa: no máximo 1 a cada 60 s, só como posição aproximada
    intervaloMinimoMs: 4000,   // no máximo 1 ponto a cada 4 s
    intervaloParadoMs: 60000,  // parado: 1 ponto a cada 60 s (confirma que continua ali)
    distanciaMinimaM: 5,       // deslocamento mínimo considerado
    fatorPrecisao: 1.5,        // mover menos que 1,5 × a precisão = oscilação de quem está parado
    limiteOscilacaoM: 40,      // teto do limiar de oscilação
    velocidadeMinimaMs: 0.7,   // velocidade informada pelo GPS que indica movimento real
    confirmacoesMovimento: 2,  // sem velocidade do GPS: leituras seguidas fora do limiar para contar como movimento
    velocidadeMaximaMs: 12,    // acima disso (≈43 km/h) entre dois pontos = salto suspeito
    confirmacoesSalto: 3,      // leituras seguidas e coerentes para aceitar um deslocamento brusco
    idadeMaximaMs: 30000,      // leitura mais velha que isso é antiga (cache do aparelho)
    fatorDesenho: 0.75,        // painel: ponto a menos de 0,75 × precisão do anterior desenhado não vira vértice
    lacunaTrilhaMs: 5 * 60000, // painel: sem pontos por mais que isso, a trilha é interrompida
    diagnosticoMax: 300,
  };

  function mesclar(cfg) {
    var r = {};
    Object.keys(PADRAO).forEach(function (k) { r[k] = cfg && cfg[k] != null ? cfg[k] : PADRAO[k]; });
    return r;
  }

  function distancia(lat1, lng1, lat2, lng2) {
    var R = 6371000, k = Math.PI / 180;
    var dLat = (lat2 - lat1) * k, dLng = (lng2 - lng1) * k;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * k) * Math.cos(lat2 * k) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function r5(v) { return Math.round(v * 1e5) / 1e5; }

  var MOTIVOS = {
    primeiro_ponto: 'primeira leitura',
    primeiro_ponto_impreciso: 'primeira leitura (imprecisa, só aproximada)',
    movimento: 'deslocamento',
    parado_periodico: 'parado (confirmação periódica)',
    aproximado: 'imprecisa: só posição aproximada, fora da trilha',
    salto_confirmado: 'deslocamento brusco confirmado (trilha interrompida)',
    coordenada_invalida: 'coordenada inválida',
    leitura_antiga: 'leitura antiga (cache)',
    duplicada: 'leitura repetida',
    fora_de_ordem: 'fora de ordem',
    baixa_precisao: 'precisão ruim',
    salto_suspeito: 'salto/velocidade impossível',
    intervalo_curto: 'intervalo curto',
    oscilacao_parado: 'oscilação parado',
    negado: 'erro: permissão negada',
    indisponivel: 'erro: localização do aparelho desligada/indisponível',
    sem_sinal: 'erro: sem leitura no tempo limite',
  };

  /* ------------------------------------------------------------------ */
  /* Filtro de leituras (no aparelho que coleta)                          */
  /* ------------------------------------------------------------------ */
  function Filtro(cfg) {
    this.cfg = mesclar(cfg);
    this.ancora = null;          // último ponto BOM aceito na trilha
    this.ultimoRuimT = 0;        // último ponto impreciso aceito (aproximado)
    this.ultimaLeitura = null;   // última leitura válida (para a tela)
    this.suspeitos = [];
    this.foraDoLimiar = 0;
    this.offsets = [];
    this.diag = [];
    this.contagem = {};
  }

  Filtro.prototype.reiniciar = function () {
    this.ancora = null;
    this.ultimoRuimT = 0;
    this.suspeitos = [];
    this.foraDoLimiar = 0;
  };

  Filtro.prototype.registrar = function (leitura, aceito, motivo, extra) {
    this.contagem[motivo] = (this.contagem[motivo] || 0) + 1;
    var e = {
      em: Date.now(),
      aceito: aceito,
      motivo: motivo,
      lat: leitura ? r5(leitura.lat) : null,
      lng: leitura ? r5(leitura.lng) : null,
      prec: leitura && leitura.prec != null ? Math.round(leitura.prec) : null,
      idade_s: leitura ? Math.round((leitura.recebidaEm - leitura.t) / 1000) : null,
      vel: leitura && leitura.vel != null ? Math.round(leitura.vel * 10) / 10 : null,
      dist: extra && extra.dist != null ? Math.round(extra.dist) : null,
      dt_s: extra && extra.dt != null ? Math.round(extra.dt / 1000) : null,
    };
    this.diag.push(e);
    if (this.diag.length > this.cfg.diagnosticoMax) this.diag.splice(0, this.diag.length - this.cfg.diagnosticoMax);
    return e;
  };

  // Recebe a posição do navegador (GeolocationPosition) e devolve:
  //   atual  -> leitura que pode ser mostrada como "onde estou agora" (ou null)
  //   ponto  -> ponto a gravar na trilha (ou null)  { lat, lng, prec, t, quebra? }
  //   motivo -> código do motivo (MOTIVOS)
  Filtro.prototype.processar = function (pos, agora) {
    var cfg = this.cfg;
    agora = agora || Date.now();
    var c = pos && pos.coords;
    var lat = c ? num(c.latitude) : null, lng = c ? num(c.longitude) : null;
    if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) {
      this.registrar(null, false, 'coordenada_invalida');
      return { atual: null, ponto: null, motivo: 'coordenada_invalida' };
    }
    var ts = num(pos.timestamp);
    var t;
    if (ts && Math.abs(ts - agora) < 24 * 3600 * 1000) {
      // Alguns aparelhos marcam a leitura com o horário do GPS, e o relógio do
      // celular pode estar adiantado/atrasado. Se a diferença for estável em 3
      // leituras seguidas, é relógio (não leitura velha): corrige o horário.
      this.offsets.push(agora - ts);
      if (this.offsets.length > 3) this.offsets.shift();
      var minO = Math.min.apply(null, this.offsets), maxO = Math.max.apply(null, this.offsets);
      var desvio = this.offsets.length === 3 && maxO - minO < 5000 && Math.abs(minO) > 5000 ? minO : 0;
      t = Math.min(ts + desvio, agora);
    } else {
      t = agora;
    }
    var prec = num(c.accuracy);
    if (prec != null && prec < 0) prec = null;
    var vel = num(c.speed);
    if (vel != null && vel < 0) vel = null;
    var leitura = { lat: lat, lng: lng, prec: prec, t: t, vel: vel, recebidaEm: agora };

    if (agora - t > cfg.idadeMaximaMs) {
      this.registrar(leitura, false, 'leitura_antiga');
      return { atual: null, ponto: null, motivo: 'leitura_antiga' };
    }
    var u = this.ultimaLeitura;
    if (u && u.t === t && u.lat === lat && u.lng === lng) {
      // a mesma leitura repetida não é sinal novo: não "renova" a posição atual
      this.registrar(leitura, false, 'duplicada');
      return { atual: null, ponto: null, motivo: 'duplicada' };
    }
    var a = this.ancora;
    if (a && t <= a.t) {
      this.registrar(leitura, false, 'fora_de_ordem');
      return { atual: null, ponto: null, motivo: 'fora_de_ordem' };
    }
    this.ultimaLeitura = leitura;
    var ruim = prec != null && prec > cfg.precisaoMaximaM;

    if (!a) {
      if (ruim) {
        if (t - this.ultimoRuimT < cfg.intervaloRuimMs) return this.descartar(leitura, 'baixa_precisao');
        this.ultimoRuimT = t;
        return this.aceitar(leitura, 'primeiro_ponto_impreciso', null, true);
      }
      return this.aceitar(leitura, 'primeiro_ponto');
    }

    var dt = t - a.t;
    var d = distancia(a.lat, a.lng, lat, lng);
    var extra = { dist: d, dt: dt };

    if (ruim) {
      // Não move a âncora: a trilha continua a partir do último ponto bom.
      if (t - Math.max(this.ultimoRuimT, a.t) < cfg.intervaloRuimMs) return this.descartar(leitura, 'baixa_precisao', extra);
      this.ultimoRuimT = t;
      return this.aceitar(leitura, 'aproximado', extra, true);
    }

    // Salto: distância maior que a soma das incertezas, a uma velocidade impossível a pé.
    var incerteza = (prec || 0) + (a.prec || 0) + 20;
    if (d > incerteza && d / Math.max(dt / 1000, 1) > cfg.velocidadeMaximaMs) {
      var s = this.suspeitos;
      var ult = s[s.length - 1];
      if (ult) {
        var ds = distancia(ult.lat, ult.lng, lat, lng);
        var dts = Math.max((t - ult.t) / 1000, 1);
        var coerente = ds <= (prec || 0) + (ult.prec || 0) + 20 || ds / dts <= cfg.velocidadeMaximaMs;
        if (!coerente) s.length = 0;
      }
      s.push(leitura);
      if (s.length >= cfg.confirmacoesSalto) {
        this.suspeitos = [];
        return this.aceitar(leitura, 'salto_confirmado', extra, false, true);
      }
      return this.descartar(leitura, 'salto_suspeito', extra);
    }
    this.suspeitos = [];

    // Parado x andando. Com a velocidade medida pelo GPS (efeito Doppler), basta ela.
    // Sem ela, o afastamento precisa se repetir em leituras seguidas: a oscilação
    // de quem está parado vai e volta; o deslocamento real se mantém.
    var limiar = Math.max(cfg.distanciaMinimaM,
      Math.min(cfg.limiteOscilacaoM, cfg.fatorPrecisao * Math.max(prec || 0, a.prec || 0)));
    var porVelocidade = vel != null && vel >= cfg.velocidadeMinimaMs && d >= cfg.distanciaMinimaM;
    if (d >= limiar) this.foraDoLimiar++; else this.foraDoLimiar = 0;
    // Afastamento de mais que o dobro do limiar já é deslocamento claro (leituras espaçadas).
    var movendo = porVelocidade || d >= 2 * limiar || this.foraDoLimiar >= cfg.confirmacoesMovimento;
    if (dt < cfg.intervaloMinimoMs) return this.descartar(leitura, 'intervalo_curto', extra);
    if (movendo) return this.aceitar(leitura, 'movimento', extra);
    if (dt >= cfg.intervaloParadoMs) return this.aceitar(leitura, 'parado_periodico', extra);
    return this.descartar(leitura, 'oscilacao_parado', extra);
  };

  Filtro.prototype.aceitar = function (leitura, motivo, extra, aproximado, quebra) {
    if (!aproximado) {
      this.ancora = { lat: leitura.lat, lng: leitura.lng, prec: leitura.prec, t: leitura.t };
      this.foraDoLimiar = 0;
    }
    this.registrar(leitura, true, motivo, extra);
    var ponto = {
      lat: Math.round(leitura.lat * 1e7) / 1e7,
      lng: Math.round(leitura.lng * 1e7) / 1e7,
      prec: leitura.prec == null ? null : Math.round(leitura.prec * 10) / 10,
      t: leitura.t,
    };
    if (quebra) ponto.quebra = true;
    return { atual: leitura, ponto: ponto, motivo: motivo };
  };

  Filtro.prototype.descartar = function (leitura, motivo, extra) {
    this.registrar(leitura, false, motivo, extra);
    return { atual: leitura, ponto: null, motivo: motivo };
  };

  Filtro.prototype.resumo = function () {
    var self = this;
    return Object.keys(this.contagem).map(function (k) {
      return { motivo: k, texto: MOTIVOS[k] || k, qtd: self.contagem[k] };
    }).sort(function (a, b) { return b.qtd - a.qtd; });
  };

  /* ------------------------------------------------------------------ */
  /* Trilha no painel: segmentos a desenhar                               */
  /* ------------------------------------------------------------------ */
  // pontos: [{ t, lat, lng, prec }] em ordem cronológica.
  // Não liga pontos imprecisos, separados por longa pausa ou por um salto
  // impossível; parado, não desenha o vaivém da oscilação. Os dados
  // guardados não mudam — só o que é desenhado.
  function segmentosTrilha(pontos, cfg) {
    cfg = mesclar(cfg);
    var segs = [], seg = [], ant = null, ultDesenhado = null;
    for (var i = 0; i < pontos.length; i++) {
      var pt = pontos[i];
      if (pt == null || num(pt.lat) == null || num(pt.lng) == null) continue;
      if (pt.prec != null && pt.prec > cfg.precisaoMaximaM) continue;
      if (ant) {
        var dt = pt.t - ant.t;
        if (dt <= 0 && pt.lat === ant.lat && pt.lng === ant.lng) continue;   // repetido
        var d = distancia(ant.lat, ant.lng, pt.lat, pt.lng);
        var salto = d > (pt.prec || 0) + (ant.prec || 0) + 20 && d / Math.max(dt / 1000, 1) > cfg.velocidadeMaximaMs;
        if (dt > cfg.lacunaTrilhaMs || salto) {
          if (seg.length) segs.push(seg);
          seg = [];
          ultDesenhado = null;
        }
      }
      ant = pt;
      if (ultDesenhado) {
        var dd = distancia(ultDesenhado.lat, ultDesenhado.lng, pt.lat, pt.lng);
        var lim = Math.max(cfg.distanciaMinimaM * 0.6,
          Math.min(cfg.limiteOscilacaoM, cfg.fatorDesenho * Math.max(pt.prec || 0, ultDesenhado.prec || 0)));
        if (dd < lim) continue;   // oscilação: não desenha o vaivém
      }
      seg.push([pt.lat, pt.lng]);
      ultDesenhado = pt;
    }
    if (seg.length) segs.push(seg);
    return segs;
  }

  /* ------------------------------------------------------------------ */
  /* Permissão de localização                                             */
  /* ------------------------------------------------------------------ */
  // Estado da permissão do NAVEGADOR para este site: 'granted', 'denied',
  // 'prompt' ou 'desconhecido' (navegador sem a Permissions API).
  // Não diz nada sobre a localização do sistema (GPS do celular ligado ou não):
  // isso só aparece quando o navegador tenta ler a posição (erro 2).
  function consultarPermissao() {
    try {
      if (!global.navigator || !navigator.permissions || !navigator.permissions.query) {
        return Promise.resolve({ estado: 'desconhecido', status: null });
      }
      return navigator.permissions.query({ name: 'geolocation' }).then(
        function (st) { return { estado: st.state, status: st }; },
        function () { return { estado: 'desconhecido', status: null }; });
    } catch (e) {
      return Promise.resolve({ estado: 'desconhecido', status: null });
    }
  }

  function ambiente() {
    var ua = (global.navigator && navigator.userAgent) || '';
    var ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && global.navigator && navigator.maxTouchPoints > 1);
    var android = /Android/i.test(ua);
    var nav = /SamsungBrowser/i.test(ua) ? 'samsung'
      : /EdgA?\//i.test(ua) ? 'edge'
      : /FxiOS|Firefox/i.test(ua) ? 'firefox'
      : /CriOS/i.test(ua) ? 'chrome'
      : /Chrome/i.test(ua) ? 'chrome'
      : /Safari/i.test(ua) ? 'safari' : 'outro';
    return { so: ios ? 'ios' : android ? 'android' : 'computador', navegador: nav };
  }

  // Instruções para o aparelho e o navegador em uso.
  //   problema: 'navegador' (site bloqueado), 'sistema' (localização do celular
  //   desligada) ou 'sinal' (ligada, mas sem sinal de GPS).
  // Não existe forma padronizada de uma página abrir as configurações do
  // celular; por isso não há botão "Abrir configurações": só os passos.
  function instrucoesLocalizacao(problema) {
    var a = ambiente();
    var passos = [];
    if (problema === 'sistema') {
      if (a.so === 'android') {
        passos = ['Puxe a barra de notificações do topo da tela para baixo.',
          'Toque em "Localização" para ligar (ou abra Configurações › Localização › Usar localização).',
          'Se aparecer "Precisão da localização", deixe ligada.',
          'Volte para esta página e toque em VERIFICAR DE NOVO.'];
      } else if (a.so === 'ios') {
        passos = ['Abra os Ajustes do iPhone › Privacidade e Segurança › Serviços de Localização.',
          'Ligue "Serviços de Localização".',
          'Na mesma tela, toque em ' + (a.navegador === 'chrome' ? '"Chrome"' : '"Sites do Safari"') + ' e escolha "Ao Usar o App".',
          'Volte para esta página e toque em VERIFICAR DE NOVO.'];
      } else {
        passos = ['Ligue a localização do computador nas configurações do sistema (Privacidade › Localização).',
          'Permita a localização para o navegador.', 'Volte e clique em VERIFICAR DE NOVO.'];
      }
      return { titulo: 'A localização do celular está desligada', passos: passos };
    }
    if (problema === 'sinal') {
      return { titulo: 'O celular ainda não encontrou o sinal de GPS', passos: [
        'Vá para um lugar aberto, longe de paredes, telhados e árvores densas.',
        'Espere alguns segundos com esta tela aberta.',
        a.so === 'android' ? 'Confira se a "Precisão da localização" está ligada nas configurações de Localização.' : 'Confira se a localização está ligada no celular.'] };
    }
    if (a.so === 'android') {
      if (a.navegador === 'samsung') {
        passos = ['Toque no cadeado ao lado do endereço do site.', 'Toque em "Permissões" e ligue "Localização".'];
      } else if (a.navegador === 'firefox') {
        passos = ['Toque no cadeado ao lado do endereço do site.', 'Toque em "Editar permissões do site" e marque Localização como "Permitida".'];
      } else {
        passos = ['Toque no ícone ao lado do endereço do site (cadeado ou ajustes).', 'Toque em "Permissões" › "Localização" e escolha "Permitir".'];
      }
      passos.push('Se não aparecer: Configurações do celular › Apps › ' +
        ({ samsung: 'Samsung Internet', firefox: 'Firefox', edge: 'Edge' }[a.navegador] || 'Chrome') + ' › Permissões › Localização › Permitir.');
    } else if (a.so === 'ios') {
      if (a.navegador === 'chrome') {
        passos = ['Abra os Ajustes do iPhone › Chrome › Localização e escolha "Ao Usar o App".'];
      } else {
        passos = ['Toque em "aA" na barra de endereço › "Ajustes do Site" › Localização › "Permitir".',
          'Se não houver essa opção: Ajustes do iPhone › Apps › Safari › Localização › "Perguntar" ou "Permitir".'];
      }
      passos.push('No iPhone, depois de liberar, pode ser preciso recarregar esta página (seus dados continuam).');
    } else {
      passos = ['Clique no cadeado (ou ícone de ajustes) à esquerda do endereço do site.', 'Em "Localização", escolha "Permitir".'];
    }
    passos.push('Volte para esta página e toque em VERIFICAR DE NOVO.');
    return { titulo: 'A localização está bloqueada para este site', passos: passos };
  }

  // Tabela do diagnóstico (só números e textos fixos; seguro para innerHTML).
  function tabelaDiagnostico(filtro, max) {
    var linhas = filtro.diag.slice(-(max || 60)).reverse().map(function (e) {
      var h = new Date(e.em);
      var hora = ('0' + h.getHours()).slice(-2) + ':' + ('0' + h.getMinutes()).slice(-2) + ':' + ('0' + h.getSeconds()).slice(-2);
      function v(x, suf) { return x == null ? '—' : String(x) + (suf || ''); }
      return '<tr class="' + (e.aceito ? 'diag-ok' : 'diag-desc') + '"><td>' + hora + '</td><td>' + (e.aceito ? '✓' : '✗') + ' ' +
        (MOTIVOS[e.motivo] || 'outro') + '</td><td class="num">' + v(e.prec, ' m') + '</td><td class="num">' + v(e.dist, ' m') +
        '</td><td class="num">' + v(e.idade_s, ' s') + '</td><td class="mono">' + (e.lat == null ? '—' : e.lat.toFixed(5) + ', ' + e.lng.toFixed(5)) + '</td></tr>';
    }).join('');
    return '<table class="tabela-diag"><thead><tr><th>Hora</th><th>Resultado</th><th>Precisão</th><th>Distância</th><th>Idade</th><th>Coordenadas</th></tr></thead><tbody>' +
      (linhas || '<tr><td colspan="6">Nenhuma leitura ainda.</td></tr>') + '</tbody></table>';
  }

  global.GPS = {
    PADRAO: PADRAO,
    MOTIVOS: MOTIVOS,
    Filtro: Filtro,
    distancia: distancia,
    segmentosTrilha: segmentosTrilha,
    consultarPermissao: consultarPermissao,
    ambiente: ambiente,
    instrucoesLocalizacao: instrucoesLocalizacao,
    tabelaDiagnostico: tabelaDiagnostico,
  };
})(typeof window !== 'undefined' ? window : globalThis);
