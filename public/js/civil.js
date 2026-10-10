/* =====================================================================
 * civil.js — página do participante (civil ou militar de campo)
 *   1. Lê o token do link (#t=...), mostra a operação.
 *   2. Só depois do toque em INICIAR: pede a permissão de localização,
 *      cria uma sessão anônima e ingressa na operação.
 *   3. Coleta posições, guarda numa fila local e envia em lotes.
 *   4. Recebe mensagens em tempo real e envia as confirmações.
 * ===================================================================== */
(function () {
  'use strict';

  var C = window.Comunicacao;
  var UI = window.UI;
  function $(id) { return document.getElementById(id); }

  var CHAVE_PART = 'sar-civil-participacao';
  var CHAVE_FILA = 'sar-civil-fila';
  var CHAVE_CONF = 'sar-civil-confirmacoes';

  var CFG = {
    intervaloMinimoMs: 5000,     // no máximo 1 ponto a cada 5 s
    intervaloMaximoMs: 30000,    // parado: ao menos 1 ponto a cada 30 s
    distanciaMinimaM: 5,         // registra quando andar 5 m ou mais
    precisaoMaximaM: 100,        // pontos piores só entram 1x por minuto
    sinalVidaMs: 15000,          // "estou conectado" a cada 15 s
    semGpsMs: 60000,             // sem leitura por 60 s = "sem sinal"
    loteMaximo: 200,
    filaMaxima: 5000,
  };

  var estado = {
    token: null,
    info: null,
    part: null,               // { participante_id, nome, tipo, operacao }
    rastreando: false,
    watchId: null,
    gps: 'aguardando',
    ultimaLeitura: null,      // { lat, lng, prec, recebidaEm }
    ultimoAceito: null,       // { lat, lng, t }
    fila: [],
    enviando: false,
    timerEnvio: null,
    falhas: 0,
    ultimoSucesso: 0,
    ultimoEnviadoT: null,
    timerSinal: null,
    timerUI: null,
    ultimoTique: Date.now(),
    wakeLock: null,
    canal: null,
    mensagens: new Map(),
    confirmadasLocal: new Set(),
    confPendentes: [],
    alertaAtual: null,
    alertadas: new Set(),
    audio: null,
    swReg: null,
    finalizado: false,
  };

  /* ------------------------------------------------------------------ */
  /* Telas                                                               */
  /* ------------------------------------------------------------------ */
  var TELAS = ['carregando', 'erro', 'inicio', 'rastreio', 'encerrado'];
  function mostrarTela(nome) {
    TELAS.forEach(function (t) { $('tela-' + t).hidden = t !== nome; });
    window.scrollTo(0, 0);
  }

  function mostrarErro(texto) {
    $('erro-texto').textContent = texto;
    mostrarTela('erro');
  }

  /* ------------------------------------------------------------------ */
  /* Inicialização                                                       */
  /* ------------------------------------------------------------------ */
  function lerToken() {
    var doHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('t');
    var daBusca = new URLSearchParams(location.search).get('t');
    var t = (doHash || daBusca || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(t) ? t : null;
  }

  async function iniciar() {
    $('btn-recarregar').addEventListener('click', function () { location.reload(); });

    if (!C.configurado) {
      return mostrarErro('O aplicativo não está configurado no servidor (variáveis do Supabase ausentes). Avise o responsável.');
    }
    if (!window.isSecureContext) {
      return mostrarErro('Esta página precisa ser aberta por um endereço seguro (https://).');
    }
    if (!('geolocation' in navigator)) {
      return mostrarErro('Este navegador não oferece acesso à localização. Use o Google Chrome atualizado.');
    }
    estado.token = lerToken();
    if (!estado.token) {
      return mostrarErro('Link incompleto. Abra o link completo enviado pelo responsável ou leia o QR Code novamente.');
    }

    try {
      estado.info = await C.rpc('info_operacao', { p_token: estado.token });
    } catch (e) {
      return mostrarErro(e.rede ? 'Sem conexão com a internet. Conecte-se e toque em TENTAR NOVAMENTE.' : e.message);
    }
    if (!estado.info) {
      return mostrarErro('Link de operação inválido. Peça um novo link ao responsável.');
    }
    if (!estado.info.ativa) {
      return finalizar('encerrada');
    }

    // Tela inicial
    $('ini-operacao').textContent = estado.info.operacao;
    var permiteMilitar = (estado.info.tipos_permitidos || []).indexOf('militar') !== -1;
    $('ini-tipo-escolha').hidden = !permiteMilitar;
    $('ini-tipo-fixo').hidden = permiteMilitar;

    var salvo = C.local.ler(CHAVE_PART, null);
    if (salvo && salvo.token === estado.token) {
      $('ini-nome').value = salvo.nome || '';
      if (permiteMilitar && salvo.tipo) {
        var r = document.querySelector('input[name="tipo"][value="' + salvo.tipo + '"]');
        if (r) r.checked = true;
      }
      if (salvo.ativo) $('btn-iniciar').textContent = 'CONTINUAR RASTREAMENTO';
      var fila = C.local.ler(CHAVE_FILA, null);
      if (fila && fila.participante_id === salvo.participante_id && Array.isArray(fila.pontos)) {
        estado.fila = fila.pontos;
      }
      var conf = C.local.ler(CHAVE_CONF, null);
      if (conf && conf.participante_id === salvo.participante_id && Array.isArray(conf.itens)) {
        estado.confPendentes = conf.itens;
        conf.itens.forEach(function (c) { estado.confirmadasLocal.add(c.id); });
      }
    } else {
      C.local.apagar(CHAVE_FILA);
      C.local.apagar(CHAVE_CONF);
    }

    $('form-inicio').addEventListener('submit', aoIniciar);
    $('btn-parar').addEventListener('click', aoParar);
    $('btn-retomar').addEventListener('click', aoRetomar);
    $('opt-tela').addEventListener('change', function () {
      if (this.checked) pedirTelaLigada(); else liberarTelaLigada();
    });
    $('btn-notif').addEventListener('click', ativarNotificacoes);

    mostrarTela('inicio');
  }

  /* ------------------------------------------------------------------ */
  /* Início do rastreamento (somente após o toque do usuário)            */
  /* ------------------------------------------------------------------ */
  function erroInicio(texto) {
    var p = $('ini-erro');
    p.textContent = texto;
    p.hidden = !texto;
  }

  function obterPosicaoInicial() {
    return new Promise(function (resolve) {
      navigator.geolocation.getCurrentPosition(
        function (pos) { resolve({ ok: true, pos: pos }); },
        function (err) { resolve({ ok: false, codigo: err.code, mensagem: err.message }); },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
      );
    });
  }

  async function garantirSessao() {
    var r = await C.cliente.auth.getSession();
    if (r.data && r.data.session) return r.data.session;
    var s = await C.cliente.auth.signInAnonymously();
    if (s.error) throw C.criarErro(s.error);
    return s.data.session;
  }

  async function aoIniciar(ev) {
    ev.preventDefault();
    erroInicio('');
    var nome = $('ini-nome').value.replace(/\s+/g, ' ').trim();
    if (nome.length < 2 || nome.length > 40) {
      erroInicio('Informe seu nome ou indicativo (2 a 40 caracteres).');
      $('ini-nome').focus();
      return;
    }
    var marcado = document.querySelector('input[name="tipo"]:checked');
    var tipo = !$('ini-tipo-escolha').hidden && marcado ? marcado.value : 'civil';

    var btn = $('btn-iniciar');
    var textoOriginal = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'OBTENDO LOCALIZAÇÃO…';
    prepararAudio();

    try {
      // 1. Permissão e teste do GPS
      var teste = await obterPosicaoInicial();
      if (!teste.ok && teste.codigo === 1) {
        erroInicio('A permissão de localização foi negada. Toque no cadeado ao lado do endereço do site, ' +
          'permita "Localização" e tente novamente. Verifique também se a localização (GPS) do celular está ligada.');
        return;
      }

      // 2. Sessão anônima e ingresso
      btn.textContent = 'CONECTANDO…';
      await garantirSessao();
      var part = await C.rpc('ingressar', { p_token: estado.token, p_nome: nome, p_tipo: tipo });

      if (estado.part && estado.part.participante_id !== part.participante_id) estado.fila = [];
      var salvo = C.local.ler(CHAVE_PART, null);
      if (salvo && salvo.participante_id !== part.participante_id) {
        estado.fila = [];
        estado.confPendentes = [];
        estado.confirmadasLocal.clear();
      }
      estado.part = part;
      salvarParticipacao(true);

      mostrarTela('rastreio');
      registrarServiceWorker();
      comecarRastreamento(teste.ok ? teste.pos : null);
      if (!teste.ok) {
        estado.gps = teste.codigo === 2 ? 'indisponivel' : 'sem_sinal';
        UI.aviso('Ainda sem sinal de GPS. Se possível, vá para um local aberto. O rastreamento continua tentando.', 'erro', 7000);
      }
    } catch (e) {
      if (e.codigo === 'operacao_encerrada' || e.codigo === 'participante_removido') {
        finalizar(e.codigo === 'operacao_encerrada' ? 'encerrada' : 'removido');
        return;
      }
      erroInicio(e.rede ? 'Sem conexão com a internet. Verifique os dados móveis ou o Wi-Fi e tente novamente.' : e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = textoOriginal;
    }
  }

  function salvarParticipacao(ativo) {
    if (!estado.part) return;
    C.local.gravar(CHAVE_PART, {
      token: estado.token,
      participante_id: estado.part.participante_id,
      nome: estado.part.nome,
      tipo: estado.part.tipo,
      ativo: Boolean(ativo),
    });
  }

  function comecarRastreamento(posInicial) {
    estado.rastreando = true;
    estado.ultimoTique = Date.now();
    salvarParticipacao(true);
    if (posInicial) processarPosicao(posInicial);

    if (estado.watchId == null) {
      estado.watchId = navigator.geolocation.watchPosition(processarPosicao, erroGps, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 30000,
      });
    }
    pedirTelaLigada();
    conectarMensagens();

    if (!estado.timerSinal) estado.timerSinal = setInterval(enviarSinal, CFG.sinalVidaMs);
    if (!estado.timerUI) estado.timerUI = setInterval(tique, 2000);
    enviarSinal();
    agendarEnvio(0);
    atualizarNotifBotao();
    atualizarUI();
  }

  /* ------------------------------------------------------------------ */
  /* GPS                                                                  */
  /* ------------------------------------------------------------------ */
  function processarPosicao(pos) {
    if (!estado.rastreando) return;
    var c = pos.coords;
    if (!c || !isFinite(c.latitude) || !isFinite(c.longitude)) return;
    var agora = Date.now();
    var t = pos.timestamp && Math.abs(pos.timestamp - agora) < 24 * 3600 * 1000 ? pos.timestamp : agora;
    var prec = isFinite(c.accuracy) ? c.accuracy : null;

    estado.ultimaLeitura = { lat: c.latitude, lng: c.longitude, prec: prec, recebidaEm: agora };
    estado.gps = prec != null && prec > 50 ? 'fraco' : 'ok';

    var u = estado.ultimoAceito;
    var aceitar;
    if (!u) {
      aceitar = true;
    } else {
      var dt = t - u.t;
      var d = C.distancia(u.lat, u.lng, c.latitude, c.longitude);
      if (dt < CFG.intervaloMinimoMs) aceitar = false;
      else if (prec != null && prec > CFG.precisaoMaximaM) aceitar = dt >= 60000;
      else aceitar = d >= CFG.distanciaMinimaM || dt >= CFG.intervaloMaximoMs;
    }

    if (aceitar) {
      estado.ultimoAceito = { lat: c.latitude, lng: c.longitude, t: t };
      estado.fila.push({
        id: C.uuid(),
        lat: Math.round(c.latitude * 1e7) / 1e7,
        lng: Math.round(c.longitude * 1e7) / 1e7,
        prec: prec == null ? null : Math.round(prec * 10) / 10,
        t: t,
      });
      if (estado.fila.length > CFG.filaMaxima) estado.fila.splice(0, estado.fila.length - CFG.filaMaxima);
      salvarFila();
      agendarEnvio(800);
    }
    atualizarUI();
  }

  function erroGps(err) {
    if (err.code === 1) estado.gps = 'negado';
    else if (err.code === 2) estado.gps = 'indisponivel';
    else estado.gps = 'sem_sinal';
    atualizarUI();
  }

  function salvarFila() {
    if (!estado.part) return;
    C.local.gravar(CHAVE_FILA, { participante_id: estado.part.participante_id, pontos: estado.fila });
  }

  /* ------------------------------------------------------------------ */
  /* Envio ao servidor                                                    */
  /* ------------------------------------------------------------------ */
  function agendarEnvio(ms) {
    clearTimeout(estado.timerEnvio);
    estado.timerEnvio = setTimeout(enviarFila, ms);
  }

  async function enviarFila() {
    if (estado.enviando || !estado.part || estado.finalizado || !estado.fila.length) return;
    estado.enviando = true;
    var lote = estado.fila.slice(0, CFG.loteMaximo);
    try {
      await C.rpc('enviar_posicoes', {
        p_participante: estado.part.participante_id,
        p_pontos: lote,
        p_gps: estado.rastreando ? estado.gps : null,
      }, 20000);
      var enviados = new Set(lote.map(function (p) { return p.id; }));
      estado.fila = estado.fila.filter(function (p) { return !enviados.has(p.id); });
      salvarFila();
      lote.forEach(function (p) { if (!estado.ultimoEnviadoT || p.t > estado.ultimoEnviadoT) estado.ultimoEnviadoT = p.t; });
      marcarSucesso();
      if (estado.fila.length) agendarEnvio(300);
    } catch (e) {
      if (!tratarErroFatal(e)) {
        if (e.codigo === 'lote_invalido') {
          // Dados corrompidos: descarta este lote para não travar a fila.
          var ruins = new Set(lote.map(function (p) { return p.id; }));
          estado.fila = estado.fila.filter(function (p) { return !ruins.has(p.id); });
          salvarFila();
        } else {
          marcarFalha(e);
          agendarEnvio(Math.min(30000, 2000 * Math.pow(2, Math.min(estado.falhas, 5) - 1)));
        }
      }
    } finally {
      estado.enviando = false;
      atualizarUI();
    }
  }

  async function enviarSinal() {
    if (!estado.part || estado.finalizado) return;
    try {
      var r = await C.rpc('sinal_vida', {
        p_participante: estado.part.participante_id,
        p_rastreando: estado.rastreando,
        p_gps: estado.rastreando ? estado.gps : null,
      }, 12000);
      if (!r || r.status !== 'ativa') {
        finalizar(r && r.status === 'removido' ? 'removido' : (r && r.status === 'inexistente' ? 'inexistente' : 'encerrada'));
        return;
      }
      marcarSucesso();
      if (estado.fila.length) agendarEnvio(0);
      await buscarMensagens();
      await reenviarConfirmacoes();
    } catch (e) {
      if (!tratarErroFatal(e)) marcarFalha(e);
    }
    atualizarUI();
  }

  function tratarErroFatal(e) {
    if (e.codigo === 'operacao_encerrada') { finalizar('encerrada'); return true; }
    if (e.codigo === 'participante_removido') { finalizar('removido'); return true; }
    if (e.codigo === 'participante_invalido') { finalizar('inexistente'); return true; }
    return false;
  }

  function marcarSucesso() {
    estado.ultimoSucesso = Date.now();
    estado.falhas = 0;
  }

  function marcarFalha() {
    estado.falhas++;
  }

  function estadoInternet() {
    if (navigator.onLine === false) return 'offline';
    if (estado.ultimoSucesso && Date.now() - estado.ultimoSucesso < 40000 && estado.falhas === 0) return 'ok';
    if (!estado.ultimoSucesso && estado.falhas === 0) return 'conectando';
    return estado.falhas >= 2 || (estado.ultimoSucesso && Date.now() - estado.ultimoSucesso >= 40000) ? 'falha' : 'conectando';
  }

  /* ------------------------------------------------------------------ */
  /* Mensagens                                                            */
  /* ------------------------------------------------------------------ */
  function conectarMensagens() {
    if (estado.canal || !estado.part) return;
    var pid = estado.part.participante_id;
    estado.canal = C.cliente
      .channel('mensagens-' + pid)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mensagens', filter: 'participante_id=eq.' + pid },
        function (carga) { if (carga.new && carga.new.id) receberMensagens([carga.new]); })
      .subscribe(function (status) {
        if (status === 'SUBSCRIBED') buscarMensagens();
      });
  }

  async function buscarMensagens() {
    if (!estado.part) return;
    try {
      var dados = await C.consultar(
        C.cliente.from('mensagens').select('*')
          .eq('participante_id', estado.part.participante_id)
          .order('criada_em', { ascending: false })
          .limit(30)
      );
      receberMensagens(dados || []);
    } catch (e) { /* tenta de novo no próximo sinal de vida */ }
  }

  function receberMensagens(lista) {
    var paraEntregar = [];
    var houveNova = false;
    lista.forEach(function (m) {
      var antiga = estado.mensagens.get(m.id);
      estado.mensagens.set(m.id, m);
      if (!m.entregue_em) paraEntregar.push(m.id);
      if (!antiga && !m.confirmada_em && !estado.confirmadasLocal.has(m.id) && !estado.alertadas.has(m.id)) {
        houveNova = true;
        estado.alertadas.add(m.id);
      }
    });
    if (paraEntregar.length) {
      C.rpc('marcar_entregues', { p_ids: paraEntregar }).catch(function () { /* nova tentativa depois */ });
    }
    if (houveNova) chamarAtencao();
    renderizarHistorico();
    mostrarProximoAlerta();
  }

  function pendentesDeConfirmacao() {
    var lista = [];
    estado.mensagens.forEach(function (m) {
      if (!m.confirmada_em && !estado.confirmadasLocal.has(m.id)) lista.push(m);
    });
    return lista.sort(function (a, b) { return C.paraMs(b.criada_em) - C.paraMs(a.criada_em); });
  }

  function mostrarProximoAlerta() {
    var pend = pendentesDeConfirmacao();
    var caixa = $('alerta-msg');
    if (!pend.length) {
      caixa.hidden = true;
      estado.alertaAtual = null;
      return;
    }
    var m = pend[0];
    if (estado.alertaAtual === m.id && !caixa.hidden) {
      $('alerta-fila').textContent = pend.length > 1 ? 'Mais ' + (pend.length - 1) + ' mensagem(ns) aguardando confirmação' : '';
      return;
    }
    estado.alertaAtual = m.id;
    var tipo = C.TIPOS_MENSAGEM[m.tipo] || C.TIPOS_MENSAGEM.PERSONALIZADA;
    caixa.className = 'alerta-msg alerta-' + tipo.classe;
    $('alerta-tit').textContent = tipo.titulo;
    $('alerta-texto').textContent = m.texto || tipo.padrao;
    $('alerta-meta').textContent = 'Enviada por ' + (m.remetente_nome || 'responsável da operação') +
      ' · ' + (estado.part ? estado.part.operacao : '') + ' · às ' + C.hora(m.criada_em);
    var botoes = $('alerta-botoes');
    botoes.innerHTML = '';
    if (m.tipo === 'CONFIRME') {
      botoes.appendChild(UI.el('button', { classe: 'btn btn-ok btn-gigante', type: 'button', texto: 'ESTOU BEM', onclick: function () { confirmarMensagem(m.id, 'ESTOU_BEM'); } }));
      botoes.appendChild(UI.el('button', { classe: 'btn btn-primario btn-gigante', type: 'button', texto: 'PRECISO DE AJUDA', onclick: function () { confirmarMensagem(m.id, 'PRECISO_AJUDA'); } }));
    } else {
      botoes.appendChild(UI.el('button', { classe: 'btn btn-escuro btn-gigante', type: 'button', texto: 'CONFIRMAR RECEBIMENTO', onclick: function () { confirmarMensagem(m.id, 'CIENTE'); } }));
    }
    $('alerta-fila').textContent = pend.length > 1 ? 'Mais ' + (pend.length - 1) + ' mensagem(ns) aguardando confirmação' : '';
    caixa.hidden = false;
    var b = botoes.querySelector('button');
    if (b) b.focus();
  }

  async function confirmarMensagem(id, resposta) {
    estado.confirmadasLocal.add(id);
    estado.confPendentes = estado.confPendentes.filter(function (c) { return c.id !== id; });
    estado.confPendentes.push({ id: id, resposta: resposta });
    salvarConfirmacoes();
    estado.alertaAtual = null;
    mostrarProximoAlerta();
    renderizarHistorico();
    var ok = await enviarConfirmacao(id, resposta);
    if (ok) UI.aviso(resposta === 'PRECISO_AJUDA' ? 'Pedido de ajuda enviado à equipe.' : 'Confirmação enviada.', 'ok');
    else UI.aviso('Sem conexão: a confirmação será enviada automaticamente quando a internet voltar.', 'erro', 7000);
  }

  async function enviarConfirmacao(id, resposta) {
    try {
      var m = await C.rpc('confirmar_mensagem', { p_mensagem: id, p_resposta: resposta });
      estado.confPendentes = estado.confPendentes.filter(function (c) { return c.id !== id; });
      salvarConfirmacoes();
      if (m && m.id) estado.mensagens.set(m.id, m);
      marcarSucesso();
      renderizarHistorico();
      return true;
    } catch (e) {
      if (!e.rede) {
        // Erro definitivo (ex.: mensagem apagada) — não tenta de novo.
        estado.confPendentes = estado.confPendentes.filter(function (c) { return c.id !== id; });
        salvarConfirmacoes();
        return true;
      }
      return false;
    }
  }

  async function reenviarConfirmacoes() {
    var copia = estado.confPendentes.slice();
    for (var i = 0; i < copia.length; i++) await enviarConfirmacao(copia[i].id, copia[i].resposta);
  }

  function salvarConfirmacoes() {
    if (!estado.part) return;
    C.local.gravar(CHAVE_CONF, { participante_id: estado.part.participante_id, itens: estado.confPendentes });
  }

  function renderizarHistorico() {
    var ul = $('hist-msgs');
    var lista = Array.from(estado.mensagens.values()).sort(function (a, b) {
      return C.paraMs(b.criada_em) - C.paraMs(a.criada_em);
    });
    $('hist-vazio').hidden = lista.length > 0;
    ul.innerHTML = '';
    lista.forEach(function (m) {
      var tipo = C.TIPOS_MENSAGEM[m.tipo] || C.TIPOS_MENSAGEM.PERSONALIZADA;
      var confirmada = m.confirmada_em || estado.confirmadasLocal.has(m.id);
      var estadoTxt;
      if (m.confirmada_em) {
        estadoTxt = 'Confirmada às ' + C.hora(m.confirmada_em) + (m.resposta ? ' · ' + (C.RESPOSTAS[m.resposta] || m.resposta) : '');
      } else if (confirmada) {
        estadoTxt = 'Confirmação aguardando internet';
      } else {
        estadoTxt = 'AGUARDANDO SUA CONFIRMAÇÃO';
      }
      var li = UI.el('li', null, [
        UI.el('div', { classe: 't', texto: tipo.titulo }),
        UI.el('div', { texto: m.texto || tipo.padrao }),
        UI.el('div', { classe: 'm', texto: 'Recebida às ' + C.hora(m.criada_em) + ' · ' + estadoTxt }),
      ]);
      if (!confirmada) {
        li.appendChild(UI.el('button', {
          classe: 'btn btn-pequeno btn-escuro', type: 'button', texto: 'Abrir e confirmar',
          onclick: function () { estado.alertaAtual = null; mostrarProximoAlerta(); },
        }));
      }
      ul.appendChild(li);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Alertas sonoros, vibração e notificações                            */
  /* ------------------------------------------------------------------ */
  function prepararAudio() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !estado.audio) estado.audio = new AC();
      if (estado.audio && estado.audio.state === 'suspended') estado.audio.resume();
    } catch (e) { /* sem áudio */ }
  }

  function bipe() {
    var ac = estado.audio;
    if (!ac) return;
    try {
      var t = ac.currentTime;
      [0, 0.35, 0.7].forEach(function (d) {
        var o = ac.createOscillator();
        var g = ac.createGain();
        o.type = 'square';
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, t + d);
        g.gain.exponentialRampToValueAtTime(0.35, t + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.25);
        o.connect(g);
        g.connect(ac.destination);
        o.start(t + d);
        o.stop(t + d + 0.3);
      });
    } catch (e) { /* ignora */ }
  }

  function chamarAtencao() {
    try { if (navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 800]); } catch (e) { /* ignora */ }
    bipe();
    if (document.hidden && estado.swReg && window.Notification && Notification.permission === 'granted') {
      var pend = pendentesDeConfirmacao();
      var m = pend[0];
      var tipo = m ? (C.TIPOS_MENSAGEM[m.tipo] || C.TIPOS_MENSAGEM.PERSONALIZADA) : null;
      try {
        estado.swReg.showNotification(tipo ? tipo.titulo : 'Nova mensagem', {
          body: m ? (m.texto || tipo.padrao) : 'Abra a página da operação.',
          tag: 'sar-msg',
          renotify: true,
          requireInteraction: true,
          vibrate: [400, 150, 400, 150, 800],
        });
      } catch (e) { /* ignora */ }
    }
  }

  function registrarServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      estado.swReg = reg;
      atualizarNotifBotao();
    }).catch(function () { /* sem SW: notificações indisponíveis */ });
  }

  function atualizarNotifBotao() {
    var b = $('btn-notif');
    b.hidden = !(window.Notification && Notification.permission === 'default' && 'serviceWorker' in navigator);
  }

  function ativarNotificacoes() {
    if (!window.Notification) return;
    Notification.requestPermission().then(function (p) {
      atualizarNotifBotao();
      if (p === 'granted') UI.aviso('Alertas ativados. Mesmo assim, mantenha esta página aberta.', 'ok');
    });
  }

  /* ------------------------------------------------------------------ */
  /* Tela ligada (Wake Lock)                                              */
  /* ------------------------------------------------------------------ */
  async function pedirTelaLigada() {
    if (!estado.rastreando || !$('opt-tela').checked || estado.wakeLock || !('wakeLock' in navigator)) return;
    if (document.visibilityState !== 'visible') return;
    try {
      estado.wakeLock = await navigator.wakeLock.request('screen');
      estado.wakeLock.addEventListener('release', function () { estado.wakeLock = null; });
    } catch (e) { estado.wakeLock = null; }
  }

  function liberarTelaLigada() {
    if (estado.wakeLock) {
      try { estado.wakeLock.release(); } catch (e) { /* ignora */ }
      estado.wakeLock = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Segundo plano: detecção de pausas                                    */
  /* ------------------------------------------------------------------ */
  function avisarPausa(ms) {
    var min = Math.max(1, Math.round(ms / 60000));
    var caixa = $('aviso-fundo');
    caixa.textContent = 'Atenção: o celular pausou esta página por cerca de ' + min + ' min (tela bloqueada ou outro aplicativo). ' +
      'Nesse período sua posição pode não ter sido registrada. Mantenha esta página aberta e a tela ligada.';
    caixa.hidden = false;
  }

  function tique() {
    var agora = Date.now();
    var gap = agora - estado.ultimoTique;
    estado.ultimoTique = agora;
    if (estado.rastreando && gap > 30000) {
      avisarPausa(gap);
      enviarSinal();
      agendarEnvio(0);
    }
    if (estado.rastreando && estado.ultimaLeitura && agora - estado.ultimaLeitura.recebidaEm > CFG.semGpsMs &&
        (estado.gps === 'ok' || estado.gps === 'fraco')) {
      estado.gps = 'sem_sinal';
    }
    atualizarUI();
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && estado.part && !estado.finalizado) {
      pedirTelaLigada();
      enviarSinal();
      agendarEnvio(0);
    }
  });
  window.addEventListener('online', function () {
    if (estado.part && !estado.finalizado) { enviarSinal(); agendarEnvio(0); }
    atualizarUI();
  });
  window.addEventListener('offline', function () { atualizarUI(); });
  window.addEventListener('beforeunload', function (ev) {
    if (estado.rastreando) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });

  /* ------------------------------------------------------------------ */
  /* Parar / retomar / encerrar                                           */
  /* ------------------------------------------------------------------ */
  async function aoParar() {
    var r = await UI.confirmar({
      titulo: 'Interromper o compartilhamento?',
      texto: 'A equipe deixará de receber sua localização. Você continuará recebendo mensagens enquanto esta página estiver aberta.',
      ok: 'Interromper',
      cancelar: 'Continuar rastreando',
      perigo: true,
    });
    if (!r) return;
    pararColeta();
    salvarParticipacao(false);
    await enviarFila();
    await enviarSinal();
    UI.aviso('Compartilhamento interrompido.');
  }

  function aoRetomar() {
    prepararAudio();
    comecarRastreamento(null);
    UI.aviso('Rastreamento retomado.', 'ok');
  }

  function pararColeta() {
    estado.rastreando = false;
    if (estado.watchId != null) {
      navigator.geolocation.clearWatch(estado.watchId);
      estado.watchId = null;
    }
    liberarTelaLigada();
    atualizarUI();
  }

  function finalizar(motivo) {
    estado.finalizado = true;
    pararColeta();
    clearInterval(estado.timerSinal);
    clearInterval(estado.timerUI);
    clearTimeout(estado.timerEnvio);
    estado.timerSinal = estado.timerUI = null;
    if (estado.canal) {
      try { C.cliente.removeChannel(estado.canal); } catch (e) { /* ignora */ }
      estado.canal = null;
    }
    $('alerta-msg').hidden = true;
    C.local.apagar(CHAVE_PART);
    C.local.apagar(CHAVE_FILA);
    C.local.apagar(CHAVE_CONF);
    var textos = {
      encerrada: ['Operação encerrada', 'Esta operação foi encerrada pelo responsável. Obrigado pela sua participação.'],
      removido: ['Participação encerrada', 'O responsável encerrou a sua participação nesta operação.'],
      inexistente: ['Participação encerrada', 'Os dados desta operação foram apagados pelo responsável.'],
    };
    var t = textos[motivo] || textos.encerrada;
    $('fim-titulo').textContent = t[0];
    $('fim-texto').textContent = t[1];
    mostrarTela('encerrado');
  }

  /* ------------------------------------------------------------------ */
  /* Atualização da interface                                             */
  /* ------------------------------------------------------------------ */
  function caixaEstado(id, classe) {
    var e = $(id);
    e.classList.remove('ok', 'alerta', 'perigo');
    if (classe) e.classList.add(classe);
  }

  function atualizarUI() {
    if (!estado.part || estado.finalizado) return;

    $('st-nome').textContent = estado.part.nome + (estado.part.tipo === 'militar' ? ' · MILITAR' : ' · CIVIL');
    $('st-op').textContent = 'Operação: ' + estado.part.operacao;

    // GPS
    var gpsVal, gpsSub = '', gpsClasse;
    var leit = estado.ultimaLeitura;
    if (!estado.rastreando) { gpsVal = 'Desligado'; gpsClasse = ''; }
    else if (estado.gps === 'ok') { gpsVal = 'Ativo'; gpsClasse = 'ok'; }
    else if (estado.gps === 'fraco') { gpsVal = 'Sinal fraco'; gpsClasse = 'alerta'; }
    else if (estado.gps === 'negado') { gpsVal = 'Permissão negada'; gpsClasse = 'perigo'; gpsSub = 'Libere a localização nas configurações do navegador.'; }
    else if (estado.gps === 'indisponivel') { gpsVal = 'Indisponível'; gpsClasse = 'perigo'; gpsSub = 'Ligue a localização (GPS) do celular.'; }
    else { gpsVal = 'Procurando sinal…'; gpsClasse = 'alerta'; gpsSub = 'Se possível, vá para um local aberto.'; }
    if (estado.rastreando && leit && !gpsSub) gpsSub = C.precisao(leit.prec) + ' · leitura ' + C.idade(leit.recebidaEm, Date.now());
    $('st-gps').textContent = gpsVal;
    $('st-gps-sub').textContent = gpsSub;
    caixaEstado('cx-gps', gpsClasse);

    // Internet
    var net = estadoInternet();
    var pend = estado.fila.length;
    var netVal = { ok: 'Conectado', offline: 'Sem internet', falha: 'Reconectando…', conectando: 'Conectando…' }[net];
    var netSub = pend ? pend + ' posição(ões) guardada(s) no aparelho' : (net === 'ok' ? 'Envio em dia' : '');
    $('st-net').textContent = netVal;
    $('st-net-sub').textContent = netSub;
    caixaEstado('cx-net', net === 'ok' ? 'ok' : (net === 'offline' ? 'perigo' : 'alerta'));

    // Último envio
    if (estado.ultimoEnviadoT) {
      $('st-envio').textContent = C.hora(estado.ultimoEnviadoT);
      $('st-envio-sub').textContent = C.idade(estado.ultimoEnviadoT, Date.now()) + (pend ? ' · ' + pend + ' aguardando envio' : '');
    } else {
      $('st-envio').textContent = '—';
      $('st-envio-sub').textContent = pend ? pend + ' aguardando envio' : 'Nenhuma posição enviada ainda';
    }
    caixaEstado('cx-envio', '');

    // Faixa principal e botões
    var faixa = $('faixa');
    faixa.classList.remove('pausado', 'problema');
    if (!estado.rastreando) {
      faixa.classList.add('pausado');
      $('faixa-texto').textContent = 'COMPARTILHAMENTO INTERROMPIDO';
    } else if (estado.gps !== 'ok' && estado.gps !== 'fraco') {
      faixa.classList.add('problema');
      $('faixa-texto').textContent = 'RASTREAMENTO ATIVO — SEM GPS';
    } else if (net !== 'ok') {
      faixa.classList.add('problema');
      $('faixa-texto').textContent = 'RASTREAMENTO ATIVO — SEM CONEXÃO';
    } else {
      $('faixa-texto').textContent = 'RASTREAMENTO ATIVO';
    }
    $('btn-parar').hidden = !estado.rastreando;
    $('btn-retomar').hidden = estado.rastreando;
  }

  iniciar();
})();
