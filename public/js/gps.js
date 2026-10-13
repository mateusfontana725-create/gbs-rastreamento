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

  // Valores revisados (v3). A versão anterior (v2) era restritiva demais: exigia
  // afastamento de até 40 m parado, juntava os envios em lotes de 10 s e
  // rejeitava qualquer velocidade acima de 43 km/h (quem ia de carro ficava sem
  // trilha). Aqui: pontos frequentes andando, 1 por segundo em veículo, envio
  // rápido, e "salto" só quando a velocidade é incoerente com o movimento recente.
  var PADRAO = {
    precisaoBoaM: 20,           // até aqui a leitura é "boa"
    precisaoTrilhaM: 150,       // pior que isso: só posição aproximada (não entra na linha da trilha)
    intervaloRuimMs: 30000,     // posição aproximada: no máximo 1 a cada 30 s
    distanciaMinimaM: 3,        // deslocamento mínimo considerado
    fatorOscilacao: 0.6,        // parado: afastamento menor que 0,6 × precisão é oscilação…
    limiteOscilacaoM: 25,       // …limitado a 25 m (mata/vale com precisão ruim não "congela" a trilha)
    confirmacoesMovimento: 3,   // afastamento ainda dentro da precisão: precisa se repetir em 3 leituras na mesma direção
    velocidadeMinimaMs: 0.7,    // velocidade medida pelo GPS que indica movimento real
    intervaloMinimoMs: 2000,    // a pé: no máximo 1 ponto a cada 2 s
    velocidadeRapidaMs: 5,      // acima de 18 km/h: modo veículo
    intervaloMinimoRapidoMs: 1000, // veículo: até 1 ponto por segundo…
    distanciaMinimaRapidoM: 8,     // …a cada 8 m ou mais
    intervaloParadoMs: 45000,   // parado: confirma a posição a cada 45 s
    velocidadeBaseMs: 12,       // velocidade máxima aceita sem histórico (a pé/bicicleta)
    fatorVelocidade: 2.5,       // ou 2,5 × a velocidade recente (carro acelerando, rodovia…)
    velocidadeAbsurdaMs: 70,    // 252 km/h: nunca é movimento terrestre
    confirmacoesSalto: 2,       // 2 leituras seguidas e coerentes confirmam um deslocamento brusco
    idadeMaximaMs: 30000,       // leitura mais velha que isso é antiga (cache do aparelho)
    // painel (desenho da trilha)
    lacunaMs: 120000,           // sem pontos por 2 min e deslocou: lacuna (não liga com linha cheia)
    lacunaDistanciaM: 50,
    lacunaMaximaMs: 10 * 60000, // sem pontos por 10 min: sempre lacuna
    diagnosticoMax: 400,
  };

  function mesclar(cfg) {
    var r = {};
    Object.keys(PADRAO).forEach(function (k) { r[k] = cfg && cfg[k] != null ? cfg[k] : PADRAO[k]; });
    r.objetos = Boolean(cfg && cfg.objetos);   // trilha(): segmentos com os pontos originais (para exportar)
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
  function med1(v) { v = v.slice().sort(function (a, b) { return a - b; }); return v[Math.floor(v.length / 2)]; }
  function mediana(ls) {
    return { lat: med1(ls.map(function (l) { return l.lat; })), lng: med1(ls.map(function (l) { return l.lng; })) };
  }
  function r5(v) { return Math.round(v * 1e5) / 1e5; }

  var MOTIVOS = {
    primeiro_ponto: 'primeira leitura',
    primeiro_ponto_impreciso: 'primeira leitura (imprecisa, só aproximada)',
    movimento: 'deslocamento',
    movimento_rapido: 'deslocamento (veículo)',
    parado_periodico: 'parado (confirmação periódica)',
    aproximado: 'imprecisa: posição aproximada, fora da linha da trilha',
    salto_confirmado: 'deslocamento brusco confirmado por leituras seguidas',
    coordenada_invalida: 'coordenada inválida',
    leitura_antiga: 'leitura antiga (cache)',
    duplicada: 'leitura repetida',
    fora_de_ordem: 'fora de ordem',
    baixa_precisao: 'precisão ruim (aguardando)',
    salto_suspeito: 'salto incoerente (aguardando confirmação)',
    intervalo_curto: 'intervalo curto',
    oscilacao_parado: 'oscilação parado',
    negado: 'erro: permissão negada',
    indisponivel: 'erro: localização do aparelho desligada/indisponível',
    sem_sinal: 'erro: sem leitura no tempo limite',
    servidor_recusou: 'servidor recusou pontos (horário fora da operação)',
  };

  /* ------------------------------------------------------------------ */
  /* Filtro de leituras (no aparelho que coleta)                          */
  /* ------------------------------------------------------------------ */
  function Filtro(cfg) {
    this.cfg = mesclar(cfg);
    this.diag = [];
    this.contagem = {};
    this.offsets = [];
    this.reiniciar();
  }

  Filtro.prototype.reiniciar = function () {
    this.ancora = null;          // último ponto aceito na linha da trilha
    this.ultimoRuimT = 0;        // último ponto impreciso aceito (aproximado)
    this.ultimaLeitura = null;   // última leitura válida (para a tela)
    this.suspeitos = [];
    this.foraDoLimiar = 0;
    this.velRecente = 0;         // m/s: velocidade recente (GPS ou deslocamento líquido dos últimos pontos)
    this.recentes = [];          // últimas 3 leituras válidas (decisão parado/andando)
    this.ancoraMed = null;
    this.aceitos = [];           // últimos 4 pontos aceitos (velocidade líquida e retidão)
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
      idade_s: leitura ? Math.round((leitura.recebidaEm - leitura.t) / 100) / 10 : null,
      vel: leitura && leitura.vel != null ? Math.round(leitura.vel * 10) / 10 : null,
      dist: extra && extra.dist != null ? Math.round(extra.dist) : null,
      dt_s: extra && extra.dt != null ? Math.round(extra.dt / 100) / 10 : null,
    };
    this.diag.push(e);
    if (this.diag.length > this.cfg.diagnosticoMax) this.diag.splice(0, this.diag.length - this.cfg.diagnosticoMax);
    return e;
  };

  // Velocidade máxima aceitável agora (sem confirmação), conforme o movimento recente.
  Filtro.prototype.velocidadeMaxima = function (vel) {
    var cfg = this.cfg;
    var v = Math.max(cfg.velocidadeBaseMs, cfg.fatorVelocidade * this.velRecente, vel != null ? vel * 1.5 + 5 : 0);
    return Math.min(v, cfg.velocidadeAbsurdaMs);
  };

  // Veículo: velocidade do GPS alta, ou deslocamento recente rápido E em linha
  // (a oscilação de quem está parado vai e volta e não forma uma linha).
  Filtro.prototype.emMovimentoRapido = function (vel) {
    if (vel != null) return vel >= this.cfg.velocidadeRapidaMs;
    return this.velRecente >= this.cfg.velocidadeRapidaMs && this.retidao() >= 0.7;
  };

  Filtro.prototype.retidao = function () {
    var p = this.aceitos;
    if (p.length < 3) return 0;
    var soma = 0;
    for (var i = 1; i < p.length; i++) soma += distancia(p[i - 1].lat, p[i - 1].lng, p[i].lat, p[i].lng);
    return soma > 0 ? distancia(p[0].lat, p[0].lng, p[p.length - 1].lat, p[p.length - 1].lng) / soma : 0;
  };

  // Recebe a posição do navegador (GeolocationPosition) e devolve:
  //   atual  -> leitura que pode ser mostrada como "onde estou agora" (ou null)
  //   pontos -> pontos a gravar na trilha, em ordem ([] se nenhum) { lat, lng, prec, t }
  //   ponto  -> o último deles (ou null)
  //   motivo -> código do motivo (MOTIVOS)
  //   rapido -> true se está em deslocamento rápido (veículo)
  Filtro.prototype.processar = function (pos, agora) {
    var cfg = this.cfg;
    agora = agora || Date.now();
    var c = pos && pos.coords;
    var lat = c ? num(c.latitude) : null, lng = c ? num(c.longitude) : null;
    if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) {
      this.registrar(null, false, 'coordenada_invalida');
      return this.resultado(null, [], 'coordenada_invalida');
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
    if (vel != null && (vel < 0 || vel > cfg.velocidadeAbsurdaMs)) vel = null;
    var leitura = { lat: lat, lng: lng, prec: prec, t: t, vel: vel, recebidaEm: agora };

    if (agora - t > cfg.idadeMaximaMs) {
      this.registrar(leitura, false, 'leitura_antiga');
      return this.resultado(null, [], 'leitura_antiga');
    }
    var u = this.ultimaLeitura;
    if (u && u.t === t && u.lat === lat && u.lng === lng) {
      // a mesma leitura repetida não é sinal novo: não "renova" a posição atual
      this.registrar(leitura, false, 'duplicada');
      return this.resultado(null, [], 'duplicada');
    }
    var a = this.ancora;
    if (a && t <= a.t) {
      this.registrar(leitura, false, 'fora_de_ordem');
      return this.resultado(null, [], 'fora_de_ordem');
    }
    this.ultimaLeitura = leitura;
    if (vel != null) this.velRecente = 0.5 * this.velRecente + 0.5 * vel;
    this.recentes.push(leitura);
    if (this.recentes.length > 3) this.recentes.shift();
    var ruim = prec != null && prec > cfg.precisaoTrilhaM;

    if (!a) {
      if (ruim) {
        if (this.ultimoRuimT && t - this.ultimoRuimT < cfg.intervaloRuimMs) return this.descartar(leitura, 'baixa_precisao');
        this.ultimoRuimT = t;
        return this.aceitar([leitura], 'primeiro_ponto_impreciso', null, true);
      }
      return this.aceitar([leitura], 'primeiro_ponto');
    }

    var dt = t - a.t;
    var d = distancia(a.lat, a.lng, lat, lng);
    var extra = { dist: d, dt: dt };

    if (ruim) {
      // Não move a âncora: a linha continua a partir do último ponto confiável.
      if (t - Math.max(this.ultimoRuimT, a.t) < cfg.intervaloRuimMs) return this.descartar(leitura, 'baixa_precisao', extra);
      this.ultimoRuimT = t;
      return this.aceitar([leitura], 'aproximado', extra, true);
    }

    // Salto: distância maior que a soma das incertezas, numa velocidade incoerente
    // com o movimento recente. Não descarta de vez: se as leituras seguintes
    // confirmarem o novo local (ex.: entrou num carro), todas entram na trilha.
    var incerteza = (prec || 0) + (a.prec || 0) + 20;
    var vImplicita = d / Math.max(dt / 1000, 0.5);
    if (d > incerteza && vImplicita > this.velocidadeMaxima(vel)) {
      var s = this.suspeitos;
      var ult = s[s.length - 1];
      if (ult) {
        var ds = distancia(ult.lat, ult.lng, lat, lng);
        var dts = Math.max((t - ult.t) / 1000, 0.5);
        var coerente = ds <= (prec || 0) + (ult.prec || 0) + 20 || ds / dts <= cfg.velocidadeAbsurdaMs;
        if (!coerente) s.length = 0;
      }
      s.push(leitura);
      if (s.length >= cfg.confirmacoesSalto) {
        var conf = s.slice();
        this.suspeitos = [];
        var ultimo = conf[conf.length - 1], primeiro = conf[0];
        var dtc = Math.max((ultimo.t - primeiro.t) / 1000, 0.5);
        this.velRecente = Math.max(this.velRecente, distancia(primeiro.lat, primeiro.lng, ultimo.lat, ultimo.lng) / dtc);
        return this.aceitar(conf, 'salto_confirmado', extra);
      }
      return this.descartar(leitura, 'salto_suspeito', extra);
    }
    this.suspeitos = [];

    var rapido = this.emMovimentoRapido(vel);
    if (rapido) {
      if (dt < cfg.intervaloMinimoRapidoMs) return this.descartar(leitura, 'intervalo_curto', extra);
      if (d >= cfg.distanciaMinimaRapidoM) return this.aceitar([leitura], 'movimento_rapido', extra);
    }

    // Parado x andando. Afastamento fora do círculo de precisão = movimento.
    // Dentro dele: vale a velocidade medida pelo GPS (efeito Doppler) ou o
    // afastamento se repetir (a oscilação vai e volta; o deslocamento real se mantém).
    // A decisão usa também a mediana das 3 últimas leituras (só para decidir: o
    // ponto gravado é sempre a leitura real) — um pico isolado não vira passo.
    var maiorPrec = Math.max(prec || 0, a.prec || 0);
    var limiar = Math.max(cfg.distanciaMinimaM, Math.min(cfg.limiteOscilacaoM, cfg.fatorOscilacao * maiorPrec));
    var med = mediana(this.recentes);
    var ref = this.ancoraMed || a;   // mediana no momento do último ponto (menos sensível à oscilação)
    var dMed = distancia(ref.lat, ref.lng, med.lat, med.lng);
    var porVelocidade = vel != null && vel >= cfg.velocidadeMinimaMs && d >= cfg.distanciaMinimaM;
    // GPS informa que está parado (velocidade ~0): só um afastamento claro conta.
    var gpsParado = vel != null && vel < 0.3 && d < 1.5 * Math.max(maiorPrec, limiar);
    // o afastamento precisa manter a mesma direção (a oscilação muda de direção a cada leitura)
    var kLng = Math.cos(ref.lat * Math.PI / 180);
    var vet = [(med.lat - ref.lat) * 111320, (med.lng - ref.lng) * 111320 * kLng];
    var mesmaDirecao = !this.vetorAnterior || (vet[0] * this.vetorAnterior[0] + vet[1] * this.vetorAnterior[1]) >
      0.5 * Math.hypot(vet[0], vet[1]) * Math.hypot(this.vetorAnterior[0], this.vetorAnterior[1]);
    if (d >= limiar && dMed >= limiar && mesmaDirecao) this.foraDoLimiar++;
    else this.foraDoLimiar = d >= limiar && dMed >= limiar ? 1 : 0;
    this.vetorAnterior = dMed >= limiar ? vet : null;
    var movendo = porVelocidade || (!gpsParado && d >= limiar && dMed >= limiar &&
      (dMed >= Math.max(maiorPrec, 2 * limiar) || this.foraDoLimiar >= cfg.confirmacoesMovimento));
    if (dt < cfg.intervaloMinimoMs) return this.descartar(leitura, 'intervalo_curto', extra);
    if (movendo) return this.aceitar([leitura], 'movimento', extra);
    if (dt >= cfg.intervaloParadoMs) return this.aceitar([leitura], 'parado_periodico', extra);
    return this.descartar(leitura, 'oscilacao_parado', extra);
  };

  Filtro.prototype.resultado = function (atual, pontos, motivo) {
    return { atual: atual, pontos: pontos, ponto: pontos.length ? pontos[pontos.length - 1] : null, motivo: motivo, rapido: this.emMovimentoRapido(null) };
  };

  Filtro.prototype.aceitar = function (leituras, motivo, extra, aproximado) {
    var self = this;
    var pontos = leituras.map(function (l) {
      return {
        lat: Math.round(l.lat * 1e7) / 1e7,
        lng: Math.round(l.lng * 1e7) / 1e7,
        prec: l.prec == null ? null : Math.round(l.prec * 10) / 10,
        t: l.t,
      };
    });
    var ultima = leituras[leituras.length - 1];
    if (!aproximado) {
      leituras.forEach(function (l) { self.aceitos.push(l); });
      while (this.aceitos.length > 4) this.aceitos.shift();
      // sem velocidade do GPS: velocidade LÍQUIDA (primeiro→último dos últimos pontos)
      if (ultima.vel == null && this.aceitos.length >= 2) {
        var p0 = this.aceitos[0];
        var dtA = (ultima.t - p0.t) / 1000;
        if (dtA > 0) this.velRecente = 0.5 * this.velRecente + 0.5 * (distancia(p0.lat, p0.lng, ultima.lat, ultima.lng) / dtA);
      }
      if (motivo === 'parado_periodico') this.velRecente *= 0.3;
      this.ancora = { lat: ultima.lat, lng: ultima.lng, prec: ultima.prec, t: ultima.t };
      // referência para decidir o próximo passo: a mediana das últimas leituras
      // (em veículo, a própria leitura)
      this.ancoraMed = this.recentes.length >= 3 && !this.emMovimentoRapido(ultima.vel) ? mediana(this.recentes) : null;
      this.foraDoLimiar = 0;
      this.vetorAnterior = null;
    }
    leituras.forEach(function (l, i) { self.registrar(l, true, motivo, i === leituras.length - 1 ? extra : null); });
    return this.resultado(ultima, pontos, motivo);
  };

  Filtro.prototype.descartar = function (leitura, motivo, extra) {
    this.registrar(leitura, false, motivo, extra);
    return this.resultado(leitura, [], motivo);
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
  // Devolve { segmentos: [[lat,lng]…], lacunas: [{ de:[lat,lng], ate:[lat,lng], t0, t1 }] }.
  // Liga TODOS os pontos registrados (nenhum vértice é escondido), exceto:
  //   - pontos aproximados (precisão pior que precisaoTrilhaM): não entram na linha;
  //   - repetidos (mesmo horário e lugar);
  //   - intervalos sem registro (lacuna) e saltos impossíveis: a linha é interrompida
  //     e a lacuna é devolvida à parte, para ser desenhada de forma diferente.
  function trilha(pontos, cfg) {
    cfg = mesclar(cfg);
    var segs = [], seg = [], lacunas = [], ant = null;
    for (var i = 0; i < pontos.length; i++) {
      var pt = pontos[i];
      if (pt == null || num(pt.lat) == null || num(pt.lng) == null) continue;
      if (pt.prec != null && pt.prec > cfg.precisaoTrilhaM) continue;
      if (ant) {
        var dt = pt.t - ant.t;
        if (dt <= 0 && pt.lat === ant.lat && pt.lng === ant.lng) continue;   // repetido
        var d = distancia(ant.lat, ant.lng, pt.lat, pt.lng);
        var incerteza = (pt.prec || 0) + (ant.prec || 0) + 20;
        var impossivel = d > incerteza && d / Math.max(dt / 1000, 0.5) > cfg.velocidadeAbsurdaMs;
        var semRegistro = dt > cfg.lacunaMaximaMs || (dt > cfg.lacunaMs && d > Math.max(cfg.lacunaDistanciaM, incerteza));
        if (impossivel || semRegistro) {
          if (seg.length) segs.push(seg);
          seg = [];
          lacunas.push({ de: [ant.lat, ant.lng], ate: [pt.lat, pt.lng], t0: ant.t, t1: pt.t, impossivel: impossivel });
        }
      }
      seg.push(cfg.objetos ? pt : [pt.lat, pt.lng]);
      ant = pt;
    }
    if (seg.length) segs.push(seg);
    return { segmentos: segs, lacunas: lacunas };
  }

  // Compatibilidade: só os segmentos.
  function segmentosTrilha(pontos, cfg) { return trilha(pontos, cfg).segmentos; }

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
    trilha: trilha,
    consultarPermissao: consultarPermissao,
    ambiente: ambiente,
    instrucoesLocalizacao: instrucoesLocalizacao,
    tabelaDiagnostico: tabelaDiagnostico,
  };
})(typeof window !== 'undefined' ? window : globalThis);
