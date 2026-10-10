/* =====================================================================
 * militar.js — painel do bombeiro responsável
 *   - login (e-mail/senha) + verificação na lista de responsáveis
 *   - criação, listagem, encerramento e limpeza de operações
 *   - mapa em tempo real (Leaflet), lista de participantes, trilhas
 *   - ficha individual, envio de orientações e estado das mensagens
 *   - equipe de responsáveis: posição do próprio responsável no mapa,
 *     outros responsáveis da operação e mensagens entre eles
 * ===================================================================== */
(function () {
  'use strict';

  var C = window.Comunicacao;
  var UI = window.UI;
  function $(id) { return document.getElementById(id); }

  var LIM = {
    conectadoMs: 45000,          // contato nos últimos 45 s = conectado
    instavelMs: 120000,          // 45 s a 2 min = sinal instável; acima = sem atualização
    posicaoAntigaMs: 120000,     // posição com mais de 2 min = "antiga"
    lacunaTrilhaMs: 5 * 60000,   // intervalo maior que 5 min quebra a trilha (não liga pontos)
    precisaoTrilhaM: 100,        // pontos com precisão pior não entram na trilha
    pollingOkMs: 20000,          // conferência periódica com tempo real funcionando
    pollingFalhaMs: 8000,        // conferência periódica quando o tempo real cai
  };

  var PALETA = {
    militar: ['#1d4ed8', '#0e7490', '#4338ca', '#0369a1', '#1e40af', '#155e75', '#3730a3', '#2563eb'],
    civil: ['#15803d', '#4d7c0f', '#047857', '#166534', '#65a30d', '#0f766e', '#3f6212', '#059669'],
    responsavel: ['#0891b2', '#0e7490', '#06b6d4', '#155e75'],
  };

  // Tipos exibidos no painel. "responsavel" = militar responsável com o painel aberto
  // (só os responsáveis da operação veem esses marcadores).
  var TIPOS = {
    militar: { letra: 'M', rotulo: 'Militar', selo: 'selo-militar', trilha: null },
    civil: { letra: 'C', rotulo: 'Civil', selo: 'selo-civil', trilha: '10 7' },
    responsavel: { letra: 'R', rotulo: 'Responsável', selo: 'selo-responsavel', trilha: '2 7' },
  };
  // Comandos que fazem sentido entre responsáveis.
  var COMANDOS_RESPONSAVEL = ['ATENCAO', 'CONFIRME', 'PERSONALIZADA'];

  var CFG_GPS = { intervaloMinimoMs: 5000, intervaloMaximoMs: 30000, distanciaMinimaM: 5, precisaoMaximaM: 100, sinalVidaMs: 15000 };

  var CHAVE_AJUDA_VISTA = 'sar-militar-ajuda-vista';

  var est = {
    usuario: null,
    responsavel: null,
    op: null,
    mapa: null,
    participantes: new Map(),   // id → P
    pontosOrfaos: [],
    posIds: new Set(),
    maxPosId: 0,
    mensagens: new Map(),       // id → mensagem
    canal: null,
    geracaoCanal: 0,
    tempoReal: 'conectando',    // conectando | ok | falha
    precisaRecarregar: false,
    ultimoSyncOk: 0,
    ultimaTentativaSync: 0,
    syncFalhou: false,
    sincronizando: false,
    timerStatus: null,
    timerPoll: null,
    timerReassinar: null,
    selecionado: null,
    circuloPrecisao: null,
    jaEnquadrou: false,
    trilhasSujas: new Set(),
    rafTrilhas: null,
    listaSuja: false,
    abrirConvite: false,
    rotulosVisiveis: true,
    ajudaVista: new Set(C.local.ler(CHAVE_AJUDA_VISTA, [])),
    audio: null,
    // presença e posição do próprio responsável
    meuPart: null,
    compartilhando: false,
    watchId: null,
    gpsMeu: 'aguardando',
    ultimoAceitoMeu: null,
    filaMinha: [],
    enviandoMinha: false,
    timerMinhaFila: null,
    timerMeuSinal: null,
    wakeLock: null,
    // mensagens recebidas por este responsável
    entregando: new Set(),
    confirmadasLocal: new Set(),
    alertasTocados: new Set(),
    alertaAtual: null,
    cpfVisivel: new Set(),
  };

  /* ------------------------------------------------------------------ */
  /* Telas e navegação                                                    */
  /* ------------------------------------------------------------------ */
  var TELAS = ['carregando', 'login', 'sem-permissao', 'operacoes', 'responsaveis', 'painel'];
  function mostrarTela(nome) {
    TELAS.forEach(function (t) { $('tela-' + t).hidden = t !== nome; });
    document.body.classList.toggle('no-painel', nome === 'painel');
  }

  function opDoHash() {
    var m = /(?:^#|&)op=([0-9a-f-]{36})/i.exec(location.hash);
    return m ? m[1] : null;
  }

  function rotear() {
    if (!est.responsavel) return;
    if (location.hash === '#responsaveis') {
      fecharPainel();
      if (est.responsavel.admin) mostrarResponsaveis();
      else location.hash = '';
      return;
    }
    var id = opDoHash();
    if (id) {
      if (!est.op || est.op.id !== id) abrirPainel(id);
    } else {
      fecharPainel();
      mostrarOperacoes();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Autenticação                                                         */
  /* ------------------------------------------------------------------ */
  async function iniciar() {
    document.querySelectorAll('[data-acao="sair"]').forEach(function (b) { b.addEventListener('click', sair); });
    $('form-login').addEventListener('submit', entrar);
    $('form-nova').addEventListener('submit', criarOperacao);
    $('btn-voltar').addEventListener('click', function () { location.hash = ''; });
    $('btn-convite').addEventListener('click', abrirConvite);
    $('btn-encerrar').addEventListener('click', encerrarOperacao);
    $('btn-apagar-faixa').addEventListener('click', function () { apagarDados(est.op); });
    $('btn-trilhas-on').addEventListener('click', function () { definirTodasTrilhas(true); });
    $('btn-trilhas-off').addEventListener('click', function () { definirTodasTrilhas(false); });
    $('busca').addEventListener('input', function () { est.listaSuja = true; renderizarLista(); });
    $('btn-recolher').addEventListener('click', alternarLateral);
    $('ficha-fechar').addEventListener('click', fecharFicha);
    $('ficha-centralizar').addEventListener('click', function () { centralizar(est.selecionado); });
    $('ficha-trilha').addEventListener('click', function () { alternarTrilha(est.selecionado); });
    $('ficha-remover').addEventListener('click', removerParticipante);
    $('btn-minha-pos').addEventListener('click', alternarMinhaPosicao);
    $('btn-minha-conta').addEventListener('click', abrirMinhaConta);
    $('form-resp').addEventListener('submit', cadastrarResponsavel);
    $('resp-gerar').addEventListener('click', function () { $('resp-senha').value = gerarSenha(); });
    $('resp-cred-fechar').addEventListener('click', function () { $('resp-credenciais').hidden = true; $('resp-cred-texto').textContent = ''; });
    $('resp-cred-copiar').addEventListener('click', function () { copiarTexto($('resp-cred-texto').textContent); });
    $('btn-equipe').addEventListener('click', abrirEquipe);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && est.compartilhando) {
        pedirTelaLigada();
        enviarMeuSinal();
        enviarMinhaFila();
      }
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !$('ficha').hidden && !document.querySelector('.modal-fundo')) fecharFicha();
    });
    document.addEventListener('pointerdown', prepararAudio, { once: true });
    window.addEventListener('hashchange', rotear);
    window.addEventListener('online', function () { if (est.op) sincronizar(); });

    if (!C.configurado) {
      mostrarTela('login');
      erroLogin('O aplicativo não está configurado no servidor (variáveis SUPABASE_URL e SUPABASE_PUBLISHABLE_KEY).');
      $('btn-entrar').disabled = true;
      return;
    }

    C.cliente.auth.onAuthStateChange(function (evento) {
      if (evento === 'SIGNED_OUT') {
        est.responsavel = null;
        fecharPainel();
        mostrarTela('login');
      }
    });

    try {
      var r = await C.cliente.auth.getSession();
      var sessao = r.data && r.data.session;
      if (sessao && sessao.user && !sessao.user.is_anonymous) await aposLogin(sessao.user);
      else mostrarTela('login');
    } catch (e) {
      mostrarTela('login');
      erroLogin(C.traduzirErro(e));
    }
  }

  function erroLogin(t) {
    $('login-erro').textContent = t || '';
    $('login-erro').hidden = !t;
  }

  async function entrar(ev) {
    ev.preventDefault();
    erroLogin('');
    var email = $('login-email').value.trim();
    var senha = $('login-senha').value;
    if (!email || !senha) return erroLogin('Informe e-mail e senha.');
    var btn = $('btn-entrar');
    btn.disabled = true;
    btn.textContent = 'ENTRANDO…';
    try {
      var r = await C.cliente.auth.signInWithPassword({ email: email, password: senha });
      if (r.error) throw C.criarErro(r.error);
      $('login-senha').value = '';
      await aposLogin(r.data.user);
    } catch (e) {
      erroLogin(e.message || C.traduzirErro(e));
    } finally {
      btn.disabled = false;
      btn.textContent = 'ENTRAR';
    }
  }

  async function aposLogin(usuario) {
    est.usuario = usuario;
    var resp;
    try {
      resp = await C.consultar(C.cliente.from('responsaveis').select('nome,admin,ativo').eq('user_id', usuario.id).maybeSingle());
    } catch (e) {
      mostrarTela('login');
      erroLogin(e.message);
      return;
    }
    if (!resp || resp.ativo === false) {
      mostrarTela('sem-permissao');
      return;
    }
    est.responsavel = resp;
    $('usuario-nome').textContent = resp.nome + ' · ' + (usuario.email || '') + (resp.admin ? ' · administrador' : '');
    $('btn-responsaveis').hidden = !resp.admin;
    C.sincronizarRelogio();
    rotear();
  }

  async function sair() {
    fecharPainel();
    try { await C.cliente.auth.signOut(); } catch (e) { /* ignora */ }
    est.responsavel = null;
    location.hash = '';
    mostrarTela('login');
  }

  /* ------------------------------------------------------------------ */
  /* Operações                                                            */
  /* ------------------------------------------------------------------ */
  function textoRetencao(h) {
    if (!h) return 'dados apagados ao encerrar';
    if (h < 48) return 'dados apagados ' + h + ' h após encerrar';
    return 'dados apagados ' + Math.round(h / 24) + ' dias após encerrar';
  }

  function descricaoOp(op) {
    if (op.status === 'ativa') return 'Ativa desde ' + C.hora(op.criada_em, false) + ' · ' + textoRetencao(op.retencao_horas);
    var t = 'Encerrada em ' + C.hora(op.encerrada_em, false);
    if (op.dados_apagados_em) return t + ' · dados apagados';
    return t + ' · dados serão apagados em ' + C.hora(op.expira_em, false);
  }

  async function mostrarOperacoes() {
    mostrarTela('operacoes');
    var ul = $('lista-ops');
    ul.innerHTML = '<li class="muted">Carregando…</li>';
    var ops;
    try {
      ops = await C.consultar(
        C.cliente.from('operacoes')
          .select('id,codigo,status,retencao_horas,criada_em,encerrada_em,expira_em,dados_apagados_em,responsavel_id')
          .order('criada_em', { ascending: false })
          .limit(100)
      );
    } catch (e) {
      ul.innerHTML = '';
      ul.appendChild(UI.el('li', { classe: 'erro-form', texto: e.message }));
      return;
    }
    ul.innerHTML = '';
    $('ops-vazio').hidden = ops.length > 0;
    ops.forEach(function (op) {
      var selo = op.status === 'ativa'
        ? UI.el('span', { classe: 'selo selo-ok', texto: 'Ativa' })
        : UI.el('span', { classe: 'selo selo-neutro', texto: 'Encerrada' });
      var acoes = UI.el('div', { classe: 'op-acoes' });
      if (!op.dados_apagados_em) {
        acoes.appendChild(UI.el('a', { classe: 'btn ' + (op.status === 'ativa' ? 'btn-escuro' : ''), href: '#op=' + op.id, texto: op.status === 'ativa' ? 'Abrir painel' : 'Ver dados' }));
      }
      if (op.status !== 'ativa' && !op.dados_apagados_em) {
        acoes.appendChild(UI.el('button', { classe: 'btn btn-perigo', type: 'button', texto: 'Apagar dados agora', onclick: function () { apagarDados(op); } }));
      }
      var deEquipe = est.usuario && op.responsavel_id !== est.usuario.id
        ? UI.el('span', { classe: 'selo selo-responsavel', title: 'Você foi adicionado como responsável', texto: 'Equipe' }) : null;
      ul.appendChild(UI.el('li', null, [
        UI.el('div', { classe: 'op-info' }, [
          UI.el('strong', null, [op.codigo + ' ', selo, deEquipe ? ' ' : null, deEquipe]),
          UI.el('span', { texto: descricaoOp(op) }),
        ]),
        acoes,
      ]));
    });
  }

  async function criarOperacao(ev) {
    ev.preventDefault();
    var erro = $('nova-erro');
    erro.hidden = true;
    var codigo = $('nova-codigo').value.trim();
    if (codigo.length < 2) {
      erro.textContent = 'Informe o nome ou código da operação.';
      erro.hidden = false;
      return;
    }
    var btn = $('btn-criar');
    btn.disabled = true;
    try {
      var op = await C.rpc('criar_operacao', { p_codigo: codigo, p_retencao_horas: Number($('nova-retencao').value) });
      $('nova-codigo').value = '';
      est.abrirConvite = true;
      location.hash = '#op=' + op.id;
    } catch (e) {
      erro.textContent = e.message;
      erro.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  async function apagarDados(op) {
    if (!op) return;
    var r = await UI.confirmar({
      titulo: 'Apagar os dados agora?',
      texto: 'Serão apagados definitivamente todos os participantes, posições, trilhas e mensagens da operação "' +
        op.codigo + '". Esta ação não pode ser desfeita.',
      ok: 'Apagar definitivamente',
      perigo: true,
    });
    if (!r) return;
    try {
      var atual = await C.rpc('apagar_dados_operacao', { p_operacao: op.id });
      UI.aviso('Dados da operação apagados.', 'ok');
      if (est.op && est.op.id === op.id) {
        est.op = Object.assign(est.op, atual);
        limparDadosDoMapa();
        renderizarCabecalho();
      } else {
        mostrarOperacoes();
      }
    } catch (e) {
      UI.aviso(e.message, 'erro');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Painel: abertura e fechamento                                        */
  /* ------------------------------------------------------------------ */
  async function abrirPainel(id) {
    fecharPainel();
    mostrarTela('painel');
    var op;
    try {
      op = await C.consultar(C.cliente.from('operacoes').select('*').eq('id', id).maybeSingle());
    } catch (e) {
      UI.aviso(e.message, 'erro');
      location.hash = '';
      return;
    }
    if (!op) {
      UI.aviso('Operação não encontrada ou sem permissão de acesso.', 'erro');
      location.hash = '';
      return;
    }
    est.op = op;
    renderizarCabecalho();
    criarMapa();
    await carregarTudo();
    assinarTempoReal();
    est.timerStatus = setInterval(atualizarEstados, 5000);
    iniciarPolling();
    if (op.status === 'ativa') {
      await entrarComoResponsavel();
      est.timerMeuSinal = setInterval(function () {
        if (!est.op || est.op.status !== 'ativa') return;
        if (!est.meuPart) entrarComoResponsavel();
        else enviarMeuSinal();
        lerPosicaoSeParado();
        enviarMinhaFila();
      }, CFG_GPS.sinalVidaMs);
    }
    atualizarBotaoMinhaPos();
    if (est.abrirConvite) {
      est.abrirConvite = false;
      abrirConvite();
    }
  }

  function fecharPainel() {
    pararMinhaPosicao(true);
    clearInterval(est.timerMeuSinal);
    est.timerMeuSinal = null;
    est.meuPart = null;
    est.filaMinha = [];
    est.ultimoAceitoMeu = null;
    est.entregando = new Set();
    est.alertaAtual = null;
    if ($('alerta-cmd')) $('alerta-cmd').hidden = true;
    clearInterval(est.timerStatus);
    clearInterval(est.timerPoll);
    clearTimeout(est.timerReassinar);
    est.timerStatus = est.timerPoll = est.timerReassinar = null;
    if (est.canal) {
      try { C.cliente.removeChannel(est.canal); } catch (e) { /* ignora */ }
      est.canal = null;
    }
    est.geracaoCanal++;
    fecharFicha();
    UI.fecharModal();
    if (est.mapa) {
      est.mapa.remove();
      est.mapa = null;
    }
    est.op = null;
    est.participantes = new Map();
    est.pontosOrfaos = [];
    est.posIds = new Set();
    est.maxPosId = 0;
    est.mensagens = new Map();
    est.selecionado = null;
    est.circuloPrecisao = null;
    est.jaEnquadrou = false;
    est.tempoReal = 'conectando';
    est.precisaRecarregar = false;
    est.ultimoSyncOk = 0;
    est.syncFalhou = false;
    $('lista-part').innerHTML = '';
  }

  function limparDadosDoMapa() {
    est.participantes.forEach(function (p) {
      if (p.marcador) p.marcador.remove();
      if (p.trilha) p.trilha.remove();
    });
    if (est.circuloPrecisao) { est.circuloPrecisao.remove(); est.circuloPrecisao = null; }
    est.participantes = new Map();
    est.posIds = new Set();
    est.mensagens = new Map();
    fecharFicha();
    $('lista-part').innerHTML = '';
    renderizarLista();
  }

  function renderizarCabecalho() {
    var op = est.op;
    $('op-codigo').textContent = op.codigo;
    $('op-sub').textContent = op.status === 'ativa' ? 'Operação ativa · ' + textoRetencao(op.retencao_horas) : 'Operação encerrada';
    $('btn-encerrar').hidden = op.status !== 'ativa';
    $('btn-convite').hidden = op.status !== 'ativa';
    $('btn-minha-pos').hidden = op.status !== 'ativa';
    if (op.status !== 'ativa' && est.compartilhando) pararMinhaPosicao(true);
    var faixa = $('faixa-encerrada');
    faixa.hidden = op.status === 'ativa';
    if (op.status !== 'ativa') {
      $('faixa-encerrada-texto').textContent = 'Operação encerrada em ' + C.hora(op.encerrada_em) + '. ' +
        (op.dados_apagados_em ? 'Os dados foram apagados.' : 'Os dados serão apagados automaticamente em ' + C.hora(op.expira_em, false) + '.');
      $('btn-apagar-faixa').hidden = Boolean(op.dados_apagados_em);
    }
    document.title = op.codigo + ' — Painel GBS';
  }

  /* ------------------------------------------------------------------ */
  /* Mapa                                                                 */
  /* ------------------------------------------------------------------ */
  function criarMapa() {
    var mapa = L.map('mapa', { zoomControl: true, preferCanvas: false, worldCopyJump: true }).setView([-15.79, -47.88], 4);
    var osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    });
    var topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      subdomains: 'abc',
      attribution: '&copy; OpenStreetMap, SRTM | Estilo: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    });
    var satelite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Imagens &copy; Esri, Maxar, Earthstar Geographics',
    });
    osm.addTo(mapa);
    L.control.layers({ 'Mapa (OpenStreetMap)': osm, 'Relevo (OpenTopoMap)': topo, 'Satélite (Esri)': satelite }, null, { position: 'topright' }).addTo(mapa);
    L.control.scale({ metric: true, imperial: false, position: 'bottomleft' }).addTo(mapa);

    // Botões: enquadrar todos e mostrar/ocultar rótulos
    var Botoes = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        var div = L.DomUtil.create('div', 'leaflet-bar');
        var b1 = L.DomUtil.create('a', 'btn-mapa', div);
        b1.href = '#';
        b1.title = 'Enquadrar todos os participantes';
        b1.setAttribute('role', 'button');
        b1.setAttribute('aria-label', b1.title);
        b1.textContent = '⤢';
        var b2 = L.DomUtil.create('a', 'btn-mapa', div);
        b2.href = '#';
        b2.title = 'Mostrar/ocultar nomes no mapa';
        b2.setAttribute('role', 'button');
        b2.setAttribute('aria-label', b2.title);
        b2.textContent = 'Aa';
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.on(b1, 'click', function (e) { L.DomEvent.preventDefault(e); enquadrarTodos(); });
        L.DomEvent.on(b2, 'click', function (e) {
          L.DomEvent.preventDefault(e);
          est.rotulosVisiveis = !est.rotulosVisiveis;
          $('mapa').classList.toggle('esconder-rotulos', !est.rotulosVisiveis);
        });
        return div;
      },
    });
    new Botoes().addTo(mapa);

    var Legenda = L.Control.extend({
      options: { position: 'bottomleft' },
      onAdd: function () {
        var div = L.DomUtil.create('div', 'legenda');
        // Em telas pequenas a legenda começa recolhida para não cobrir o mapa.
        var aberta = !window.matchMedia || !window.matchMedia('(max-width: 860px)').matches;
        div.innerHTML = '<details' + (aberta ? ' open' : '') + '><summary>Legenda</summary>' +
          '<div><span class="simbolo simbolo-militar"><span>M</span></span> Militar (vermelho) — trilha contínua</div>' +
          '<div><span class="simbolo simbolo-civil"><span>C</span></span> Civil (verde) — trilha tracejada</div>' +
          '<div><span class="simbolo simbolo-responsavel"><span>R</span></span> Responsável (ciano) — trilha pontilhada</div>' +
          '<div><span class="antigo"><span class="simbolo simbolo-civil" style="background:#6b7280">C</span></span> Última posição antiga (+2 min)</div>' +
          '</details>';
        L.DomEvent.disableClickPropagation(div);
        return div;
      },
    });
    new Legenda().addTo(mapa);

    est.mapa = mapa;
    setTimeout(function () { mapa.invalidateSize(); }, 50);
  }

  function enquadrarTodos() {
    var pts = [];
    est.participantes.forEach(function (p) {
      var pos = posicaoAtual(p);
      if (pos) pts.push([pos.lat, pos.lng]);
    });
    if (!pts.length) {
      UI.aviso('Nenhum participante com posição ainda.');
      return;
    }
    if (pts.length === 1) est.mapa.setView(pts[0], Math.max(est.mapa.getZoom(), 16));
    else est.mapa.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 17 });
  }

  function centralizar(id) {
    var p = est.participantes.get(id);
    var pos = p && posicaoAtual(p);
    if (!pos) {
      UI.aviso('Este participante ainda não enviou posição.');
      return;
    }
    est.mapa.setView([pos.lat, pos.lng], Math.max(est.mapa.getZoom(), 17));
  }

  /* ------------------------------------------------------------------ */
  /* Carga de dados e sincronização                                       */
  /* ------------------------------------------------------------------ */
  async function carregarTudo() {
    var opId = est.op.id;
    try {
      var parts = await C.consultarTudo(function () {
        return C.cliente.from('participantes').select('*').eq('operacao_id', opId).order('criado_em', { ascending: true });
      });
      if (!est.op || est.op.id !== opId) return;
      parts.forEach(upsertParticipante);

      var pontos = await C.consultarTudo(function () {
        return C.cliente.from('posicoes').select('id,participante_id,lat,lng,precisao,registrado_em')
          .eq('operacao_id', opId).order('id', { ascending: true });
      });
      if (!est.op || est.op.id !== opId) return;
      pontos.forEach(adicionarPonto);

      var msgs = await C.consultarTudo(function () {
        return C.cliente.from('mensagens').select('*').eq('operacao_id', opId).order('criada_em', { ascending: true });
      });
      if (!est.op || est.op.id !== opId) return;
      msgs.forEach(function (m) { receberMensagem(m, true); });

      est.ultimoSyncOk = Date.now();
      est.syncFalhou = false;
    } catch (e) {
      est.syncFalhou = true;
      UI.aviso('Falha ao carregar dados: ' + e.message, 'erro');
    }
    renderizarLista();
    atualizarPilula();
    if (!est.jaEnquadrou && temAlgumaPosicao()) {
      est.jaEnquadrou = true;
      enquadrarTodos();
    }
  }

  // Conferência periódica: recupera eventos perdidos (queda do tempo real,
  // celular do responsável sem internet etc.). Busca só posições novas (id > último).
  async function sincronizar() {
    if (!est.op || est.sincronizando) return;
    est.sincronizando = true;
    var opId = est.op.id;
    try {
      var op = await C.consultar(C.cliente.from('operacoes').select('*').eq('id', opId).maybeSingle());
      if (!est.op || est.op.id !== opId) return;
      if (!op) {
        UI.aviso('Você não tem mais acesso a esta operação.', 'erro', 8000);
        location.hash = '';
        return;
      }
      if (op) {
        var mudou = op.status !== est.op.status || op.dados_apagados_em !== est.op.dados_apagados_em;
        est.op = op;
        if (mudou) {
          renderizarCabecalho();
          if (op.dados_apagados_em) limparDadosDoMapa();
        }
      }
      var parts = await C.consultarTudo(function () {
        return C.cliente.from('participantes').select('*').eq('operacao_id', opId).order('criado_em', { ascending: true });
      });
      if (!est.op || est.op.id !== opId) return;
      parts.forEach(upsertParticipante);

      var novos = await C.consultarTudo(function () {
        return C.cliente.from('posicoes').select('id,participante_id,lat,lng,precisao,registrado_em')
          .eq('operacao_id', opId).gt('id', est.maxPosId).order('id', { ascending: true });
      });
      if (!est.op || est.op.id !== opId) return;
      novos.forEach(adicionarPonto);

      var msgs = await C.consultar(
        C.cliente.from('mensagens').select('*').eq('operacao_id', opId).order('criada_em', { ascending: false }).limit(500)
      );
      if (!est.op || est.op.id !== opId) return;
      msgs.forEach(function (m) { receberMensagem(m, false); });

      est.ultimoSyncOk = Date.now();
      est.syncFalhou = false;
    } catch (e) {
      est.syncFalhou = true;
    } finally {
      est.sincronizando = false;
      atualizarPilula();
    }
  }

  // Ciclo independente do tempo real: verifica a cada 2 s se já passou o
  // intervalo (20 s com tempo real ativo, 8 s sem ele) e então sincroniza.
  function iniciarPolling() {
    clearInterval(est.timerPoll);
    est.ultimaTentativaSync = Date.now();
    est.timerPoll = setInterval(function () {
      if (!est.op || est.sincronizando) return;
      var ms = est.tempoReal === 'ok' && !est.syncFalhou ? LIM.pollingOkMs : LIM.pollingFalhaMs;
      if (Date.now() - est.ultimaTentativaSync >= ms) {
        est.ultimaTentativaSync = Date.now();
        sincronizar();
      }
    }, 2000);
  }

  function assinarTempoReal() {
    if (!est.op) return;
    var opId = est.op.id;
    var geracao = ++est.geracaoCanal;
    if (est.canal) {
      try { C.cliente.removeChannel(est.canal); } catch (e) { /* ignora */ }
    }
    est.tempoReal = 'conectando';
    var filtro = 'operacao_id=eq.' + opId;
    est.canal = C.cliente.channel('op-' + opId + '-' + geracao)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'participantes', filter: filtro }, function (ev) {
        if (ev.eventType === 'DELETE') return;
        if (ev.new && ev.new.id) { upsertParticipante(ev.new); renderizarLista(); }
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posicoes', filter: filtro }, function (ev) {
        if (ev.new && ev.new.id) adicionarPonto(ev.new);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mensagens', filter: filtro }, function (ev) {
        if (ev.new && ev.new.id) receberMensagem(ev.new, false);
      })
      .subscribe(function (status) {
        if (geracao !== est.geracaoCanal) return;
        if (status === 'SUBSCRIBED') {
          est.tempoReal = 'ok';
          clearTimeout(est.timerReassinar);
          if (est.precisaRecarregar) {
            est.precisaRecarregar = false;
            sincronizar();
          }
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          est.tempoReal = 'falha';
          est.precisaRecarregar = true;
          clearTimeout(est.timerReassinar);
          est.timerReassinar = setTimeout(function () {
            if (geracao === est.geracaoCanal && est.tempoReal !== 'ok') assinarTempoReal();
          }, 15000);
        }
        atualizarPilula();
      });
  }

  function atualizarPilula() {
    var pil = $('pilula');
    if (!pil) return;
    var cls, txt;
    if (navigator.onLine === false || (est.syncFalhou && est.tempoReal !== 'ok')) {
      cls = 'sem_atualizacao'; txt = 'Sem conexão — reconectando';
    } else if (est.tempoReal === 'ok') {
      cls = 'conectado'; txt = 'Tempo real ativo';
    } else if (est.tempoReal === 'falha') {
      cls = 'instavel'; txt = 'Atualizando a cada ' + Math.round(LIM.pollingFalhaMs / 1000) + ' s';
    } else {
      cls = 'aguardando'; txt = 'Conectando…';
    }
    pil.innerHTML = '<span class="ponto ponto-' + cls + '"></span><span>' + C.esc(txt) + '</span>';
  }

  /* ------------------------------------------------------------------ */
  /* Participantes                                                        */
  /* ------------------------------------------------------------------ */
  function upsertParticipante(row) {
    var p = est.participantes.get(row.id);
    if (!p) {
      p = { id: row.id, dados: row, pontos: [], trilhaVisivel: true, marcador: null, trilha: null, li: null, cor: null };
      est.participantes.set(row.id, p);
      atribuirCores();
      // pontos que chegaram antes do cadastro do participante
      var orfaos = est.pontosOrfaos.filter(function (o) { return o.participante_id === row.id; });
      if (orfaos.length) {
        est.pontosOrfaos = est.pontosOrfaos.filter(function (o) { return o.participante_id !== row.id; });
        orfaos.forEach(function (o) { est.posIds.delete(o.id); adicionarPonto(o); });
      }
    } else {
      var antigo = p.dados;
      if (row.saida_solicitada_em && !antigo.saida_solicitada_em && !row.liberado_em) {
        UI.aviso((row.nome || 'Participante') + ' PEDIU PARA ENCERRAR o rastreamento. Abra a ficha para liberar.', 'erro', 15000);
        alarme();
      }
      p.dados = Object.assign({}, antigo, row);
      // não regride a última posição se um ponto mais novo já chegou pelo fluxo de posições
      if (antigo.ultima_posicao_em && row.ultima_posicao_em &&
          C.paraMs(row.ultima_posicao_em) < C.paraMs(antigo.ultima_posicao_em)) {
        p.dados.ultima_lat = antigo.ultima_lat;
        p.dados.ultima_lng = antigo.ultima_lng;
        p.dados.ultima_precisao = antigo.ultima_precisao;
        p.dados.ultima_posicao_em = antigo.ultima_posicao_em;
      }
      if (antigo.tipo !== row.tipo) atribuirCores();
    }
    atualizarMarcador(p);
    est.listaSuja = true;
    if (est.selecionado === p.id) atualizarFicha();
    if (!est.jaEnquadrou && posicaoAtual(p)) {
      est.jaEnquadrou = true;
      setTimeout(enquadrarTodos, 100);
    }
  }

  function atribuirCores() {
    var cont = { militar: 0, civil: 0, responsavel: 0 };
    Array.from(est.participantes.values())
      .sort(function (a, b) { return C.paraMs(a.dados.criado_em) - C.paraMs(b.dados.criado_em); })
      .forEach(function (p) {
        var tipo = tipoDe(p.dados);
        var cor = PALETA[tipo][cont[tipo]++ % PALETA[tipo].length];
        if (p.cor !== cor) {
          p.cor = cor;
          if (p.trilha) p.trilha.setStyle({ color: cor, dashArray: TIPOS[tipo].trilha });
          if (p.marcador) { p.marcador.setIcon(criarIcone(p)); }
          if (p.li) p.li = null; // força recriar o item da lista
        }
      });
    $('lista-part').innerHTML = '';
    est.listaSuja = true;
  }

  function tipoDe(d) {
    return d.tipo === 'militar' ? 'militar' : d.tipo === 'responsavel' ? 'responsavel' : 'civil';
  }

  function ehEu(p) {
    return Boolean(est.usuario && p.dados.user_id === est.usuario.id);
  }

  function nomeExibido(p) {
    return ehEu(p) ? p.dados.nome + ' (você)' : p.dados.nome;
  }

  function htmlSimbolo(p) {
    var t = tipoDe(p.dados);
    return '<div class="simbolo simbolo-' + t + (ehEu(p) ? ' simbolo-eu' : '') + '" style="background:' + p.cor + '"><span>' + TIPOS[t].letra + '</span></div>';
  }

  function htmlSeloTipo(d) {
    var t = TIPOS[tipoDe(d)];
    return '<span class="selo ' + t.selo + '">' + t.rotulo + '</span>';
  }

  function saidaPendente(p) {
    var d = p.dados;
    return Boolean(d.saida_solicitada_em && !d.liberado_em && !d.removido);
  }

  function formatarCpf(d, visivel) {
    if (!d) return '—';
    d = String(d);
    if (!visivel) return '***.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-**';
    return d.slice(0, 3) + '.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-' + d.slice(9);
  }

  function formatarTelefone(d) {
    if (!d) return '—';
    d = String(d);
    return '(' + d.slice(0, 2) + ') ' + (d.length === 11 ? d.slice(2, 7) + '-' + d.slice(7) : d.slice(2, 6) + '-' + d.slice(6));
  }

  function posicaoAtual(p) {
    var d = p.dados;
    if (d.ultima_lat == null || d.ultima_lng == null) return null;
    return { lat: d.ultima_lat, lng: d.ultima_lng, prec: d.ultima_precisao, t: C.paraMs(d.ultima_posicao_em) };
  }

  function temAlgumaPosicao() {
    var tem = false;
    est.participantes.forEach(function (p) { if (posicaoAtual(p)) tem = true; });
    return tem;
  }

  function temAjuda(p) {
    var ultima = null;
    est.mensagens.forEach(function (m) {
      if (m.participante_id === p.id && m.resposta && m.confirmada_em) {
        if (!ultima || C.paraMs(m.confirmada_em) > C.paraMs(ultima.confirmada_em)) ultima = m;
      }
    });
    return ultima && ultima.resposta === 'PRECISO_AJUDA' && !est.ajudaVista.has(ultima.id) ? ultima : null;
  }

  function mensagensPendentes(p) {
    var n = 0;
    est.mensagens.forEach(function (m) { if (m.participante_id === p.id && !m.confirmada_em) n++; });
    return n;
  }

  // Estado de conexão do participante (nunca trata posição antiga como atual).
  function estadoDe(p) {
    var d = p.dados;
    var agora = C.agora();
    if (d.liberado_em) return { cod: 'removido', rot: 'Saída liberada às ' + C.hora(d.liberado_em, false) };
    if (d.removido) return { cod: 'removido', rot: 'Removido da operação' };
    if (est.op && est.op.status !== 'ativa') return { cod: 'encerrado', rot: 'Operação encerrada' };
    var contato = C.paraMs(d.ultimo_contato_em);
    if (!contato) return { cod: 'aguardando', rot: 'Aguardando primeiro contato' };
    var dt = agora - contato;
    if (tipoDe(d) === 'responsavel') {
      if (dt > LIM.instavelMs) return { cod: 'sem_atualizacao', rot: 'Painel fechado ou sem conexão · último contato ' + C.idade(contato) };
      if (dt > LIM.conectadoMs) return { cod: 'instavel', rot: 'Sinal instável · último contato ' + C.idade(contato) };
      return { cod: 'conectado', rot: d.rastreando ? 'No painel · compartilhando posição' : 'No painel · sem posição' };
    }
    if (!d.rastreando) {
      return { cod: 'parado', rot: 'Interrompeu o compartilhamento' + (dt > LIM.instavelMs ? ' · sem contato ' + C.idade(contato) : '') };
    }
    if (dt > LIM.instavelMs) return { cod: 'sem_atualizacao', rot: 'Sem atualização ' + C.idade(contato) };
    if (dt > LIM.conectadoMs) return { cod: 'instavel', rot: 'Sinal instável · último contato ' + C.idade(contato) };
    return { cod: 'conectado', rot: 'Conectado' };
  }

  function textoGps(g) {
    return {
      aguardando: 'Aguardando GPS', ok: 'GPS ativo', fraco: 'GPS com sinal fraco', sem_sinal: 'GPS sem sinal',
      negado: 'Localização negada no aparelho', indisponivel: 'GPS desligado/indisponível',
    }[g] || g;
  }

  function posicaoAntiga(p) {
    var pos = posicaoAtual(p);
    return !pos || !pos.t || C.agora() - pos.t > LIM.posicaoAntigaMs;
  }

  /* ---------- Marcadores ------------------------------------------- */
  function classesMarcador(p) {
    var c = ['mk'];
    if (posicaoAntiga(p) || estadoDe(p).cod !== 'conectado') c.push('antigo');
    if (temAjuda(p)) c.push('ajuda');
    if (saidaPendente(p)) c.push('saida');
    if (est.selecionado === p.id) c.push('selecionado');
    if (ehEu(p)) c.push('eu');
    return c.join(' ');
  }

  function textoRotulo(p) {
    var pos = posicaoAtual(p);
    return pos ? C.idade(pos.t) : '';
  }

  function criarIcone(p) {
    var html = '<div class="' + classesMarcador(p) + '">' + htmlSimbolo(p) +
      '<div class="mk-rotulo"><span class="mk-nome">' + C.esc(nomeExibido(p)) + '</span><small class="mk-idade">' + C.esc(textoRotulo(p)) + '</small></div>' +
      '</div>';
    return L.divIcon({ className: 'mk-wrap', html: html, iconSize: [0, 0] });
  }

  function atualizarMarcador(p) {
    if (!est.mapa) return;
    var pos = posicaoAtual(p);
    if (!pos || p.dados.removido) {
      if (p.marcador) { p.marcador.remove(); p.marcador = null; }
      return;
    }
    if (!p.marcador) {
      p.marcador = L.marker([pos.lat, pos.lng], {
        icon: criarIcone(p),
        keyboard: true,
        title: nomeExibido(p) + ' (' + TIPOS[tipoDe(p.dados)].rotulo + ')',
        alt: p.dados.nome,
        zIndexOffset: tipoDe(p.dados) === 'responsavel' ? 200 : tipoDe(p.dados) === 'militar' ? 100 : 0,
      }).addTo(est.mapa);
      p.marcador.on('click', function () { selecionar(p.id); });
      return;
    }
    var atual = p.marcador.getLatLng();
    if (atual.lat !== pos.lat || atual.lng !== pos.lng) p.marcador.setLatLng([pos.lat, pos.lng]);
    atualizarAparenciaMarcador(p);
  }

  function atualizarAparenciaMarcador(p) {
    if (!p.marcador) return;
    var el = p.marcador.getElement();
    if (!el) return;
    var mk = el.querySelector('.mk');
    if (!mk) return;
    var cls = classesMarcador(p);
    if (mk.className !== cls) mk.className = cls;
    var nome = el.querySelector('.mk-nome');
    if (nome && nome.textContent !== nomeExibido(p)) nome.textContent = nomeExibido(p);
    var idade = el.querySelector('.mk-idade');
    var txt = textoRotulo(p);
    if (idade && idade.textContent !== txt) idade.textContent = txt;
    if (est.selecionado === p.id && est.circuloPrecisao) {
      var pos = posicaoAtual(p);
      if (pos) {
        est.circuloPrecisao.setLatLng([pos.lat, pos.lng]);
        est.circuloPrecisao.setRadius(pos.prec || 0);
      }
    }
  }

  /* ---------- Trilhas ---------------------------------------------- */
  function adicionarPonto(row) {
    if (est.posIds.has(row.id)) return;
    est.posIds.add(row.id);
    if (row.id > est.maxPosId) est.maxPosId = row.id;
    var p = est.participantes.get(row.participante_id);
    if (!p) {
      est.pontosOrfaos.push(row);
      return;
    }
    var pt = { id: row.id, t: C.paraMs(row.registrado_em), lat: row.lat, lng: row.lng, prec: row.precisao };
    // insere na ordem temporal correta (pontos enviados depois de uma queda chegam fora de ordem)
    var arr = p.pontos;
    var i = arr.length;
    while (i > 0 && arr[i - 1].t > pt.t) i--;
    arr.splice(i, 0, pt);

    var d = p.dados;
    if (!d.ultima_posicao_em || pt.t > C.paraMs(d.ultima_posicao_em)) {
      d.ultima_lat = pt.lat;
      d.ultima_lng = pt.lng;
      d.ultima_precisao = pt.prec;
      d.ultima_posicao_em = new Date(pt.t).toISOString();
      atualizarMarcador(p);
      est.listaSuja = true;
      if (!est.jaEnquadrou) {
        est.jaEnquadrou = true;
        setTimeout(enquadrarTodos, 100);
      }
    }
    sujarTrilha(p);
    if (est.selecionado === p.id) atualizarFicha();
  }

  function sujarTrilha(p) {
    est.trilhasSujas.add(p.id);
    if (est.rafTrilhas) return;
    est.rafTrilhas = requestAnimationFrame(function () {
      est.rafTrilhas = null;
      est.trilhasSujas.forEach(function (id) {
        var x = est.participantes.get(id);
        if (x) desenharTrilha(x);
      });
      est.trilhasSujas.clear();
      if (est.listaSuja) renderizarLista();
    });
  }

  function segmentosDe(p) {
    var segs = [], seg = [], anterior = null;
    for (var i = 0; i < p.pontos.length; i++) {
      var pt = p.pontos[i];
      if (pt.prec != null && pt.prec > LIM.precisaoTrilhaM) continue;
      if (anterior && pt.t - anterior.t > LIM.lacunaTrilhaMs) {
        if (seg.length) segs.push(seg);
        seg = [];
      }
      seg.push([pt.lat, pt.lng]);
      anterior = pt;
    }
    if (seg.length) segs.push(seg);
    return segs;
  }

  function desenharTrilha(p) {
    if (!est.mapa) return;
    if (!p.trilhaVisivel) {
      if (p.trilha) p.trilha.remove();
      return;
    }
    var segs = segmentosDe(p);
    if (!segs.length) {   // sem pontos: nada a desenhar
      if (p.trilha) p.trilha.remove();
      return;
    }
    if (!p.trilha) {
      p.trilha = L.polyline(segs, {
        color: p.cor,
        weight: 4,
        opacity: 0.85,
        dashArray: TIPOS[tipoDe(p.dados)].trilha,
        interactive: false,
        lineJoin: 'round',
        className: 'trilha trilha-' + tipoDe(p.dados),
      });
    } else {
      p.trilha.setLatLngs(segs);
    }
    if (!est.mapa.hasLayer(p.trilha)) p.trilha.addTo(est.mapa);
  }

  // Ocultar a trilha afeta só o mapa: os pontos continuam chegando e sendo guardados.
  function alternarTrilha(id, valor) {
    var p = est.participantes.get(id);
    if (!p) return;
    p.trilhaVisivel = typeof valor === 'boolean' ? valor : !p.trilhaVisivel;
    desenharTrilha(p);
    est.listaSuja = true;
    renderizarLista();
    if (est.selecionado === id) atualizarFicha();
  }

  function definirTodasTrilhas(visivel) {
    est.participantes.forEach(function (p) {
      p.trilhaVisivel = visivel;
      desenharTrilha(p);
    });
    est.listaSuja = true;
    renderizarLista();
    if (est.selecionado) atualizarFicha();
    UI.aviso(visivel ? 'Todas as trilhas visíveis.' : 'Trilhas ocultas (o rastreamento continua).');
  }

  /* ---------- Lista lateral ---------------------------------------- */
  function alternarLateral() {
    var lat = $('lateral');
    var recolhida = lat.classList.toggle('recolhida');
    $('btn-recolher').textContent = recolhida ? 'Expandir' : 'Recolher';
    $('btn-recolher').setAttribute('aria-expanded', String(!recolhida));
    setTimeout(function () { if (est.mapa) est.mapa.invalidateSize(); }, 50);
  }

  function criarItemLista(p) {
    var li = UI.el('li', { classe: 'lista-item', tabindex: '0', 'data-id': p.id });
    var simbolo = UI.el('div', { classe: 'li-simbolo' });
    var nome = UI.el('div', { classe: 'li-nome' });
    var acoes = UI.el('div', { classe: 'li-acoes' });
    var estado = UI.el('div', { classe: 'li-estado' });
    var bLoc = UI.el('button', { classe: 'btn btn-pequeno', type: 'button', title: 'Localizar no mapa', 'aria-label': 'Localizar ' + p.dados.nome + ' no mapa', texto: '◎' });
    var bTri = UI.el('button', { classe: 'btn btn-pequeno btn-trilha', type: 'button', title: 'Mostrar/ocultar trilha', texto: 'Trilha' });
    bLoc.addEventListener('click', function (ev) { ev.stopPropagation(); centralizar(p.id); });
    bTri.addEventListener('click', function (ev) { ev.stopPropagation(); alternarTrilha(p.id); });
    acoes.appendChild(bLoc);
    acoes.appendChild(bTri);
    li.appendChild(simbolo);
    li.appendChild(nome);
    li.appendChild(acoes);
    li.appendChild(estado);
    li.addEventListener('click', function () { selecionar(p.id); });
    li.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selecionar(p.id); }
    });
    p.li = li;
    p.liPartes = { simbolo: simbolo, nome: nome, estado: estado, bTri: bTri, bLoc: bLoc };
    return li;
  }

  function atualizarItemLista(p) {
    if (!p.li) criarItemLista(p);
    var d = p.dados;
    var e = estadoDe(p);
    var ajuda = temAjuda(p);
    var pend = mensagensPendentes(p);
    var pos = posicaoAtual(p);
    var partes = p.liPartes;

    var htmlSimb = '<div class="' + (posicaoAntiga(p) ? 'antigo' : '') + '">' + htmlSimbolo(p) + '</div>';
    if (partes.simbolo.innerHTML !== htmlSimb) partes.simbolo.innerHTML = htmlSimb;

    var htmlNome = '<span class="nome-txt">' + C.esc(nomeExibido(p)) + '</span>' + htmlSeloTipo(d) +
      (ajuda ? '<span class="selo selo-perigo">Pediu ajuda</span>' : '') +
      (saidaPendente(p) ? '<span class="selo selo-alerta">Pediu para sair</span>' : '') +
      (pend ? '<span class="selo selo-alerta" title="Mensagens aguardando confirmação">✉ ' + pend + '</span>' : '');
    if (partes.nome.innerHTML !== htmlNome) partes.nome.innerHTML = htmlNome;

    var gpsRuim = d.rastreando && ['sem_sinal', 'negado', 'indisponivel'].indexOf(d.gps_estado) !== -1;
    var htmlEstado = '<span class="ponto ponto-' + e.cod + '"></span><span>' + C.esc(e.rot) + '</span>' +
      (gpsRuim ? '<span class="selo selo-alerta">' + C.esc(textoGps(d.gps_estado)) + '</span>' : '') +
      '<span class="muted">· ' + (pos ? 'posição ' + C.hora(pos.t) + ' (' + C.idade(pos.t) + ')' : 'sem posição ainda') + '</span>';
    if (partes.estado.innerHTML !== htmlEstado) partes.estado.innerHTML = htmlEstado;

    partes.bTri.setAttribute('aria-pressed', String(p.trilhaVisivel));
    partes.bTri.setAttribute('aria-label', (p.trilhaVisivel ? 'Ocultar' : 'Mostrar') + ' trilha de ' + d.nome);
    partes.bLoc.disabled = !pos;
    p.li.classList.toggle('selecionado', est.selecionado === p.id);
    p.li.classList.toggle('alerta-ajuda', Boolean(ajuda));
    p.li.classList.toggle('alerta-saida', saidaPendente(p) && !ajuda);
    var busca = $('busca').value.trim().toLowerCase();
    p.li.hidden = Boolean(busca) && d.nome.toLowerCase().indexOf(busca) === -1;
  }

  function ordemLista(a, b) {
    var aa = temAjuda(a) ? 0 : saidaPendente(a) ? 1 : 2, bb = temAjuda(b) ? 0 : saidaPendente(b) ? 1 : 2;
    if (aa !== bb) return aa - bb;
    var ra = tipoDe(a.dados) === 'responsavel' ? 0 : 1, rb = tipoDe(b.dados) === 'responsavel' ? 0 : 1;
    if (ra !== rb) return ra - rb;
    var ar = a.dados.removido ? 1 : 0, br = b.dados.removido ? 1 : 0;
    if (ar !== br) return ar - br;
    return a.dados.nome.localeCompare(b.dados.nome, 'pt-BR', { sensitivity: 'base' });
  }

  function renderizarLista() {
    est.listaSuja = false;
    var ul = $('lista-part');
    var lista = Array.from(est.participantes.values()).sort(ordemLista);
    lista.forEach(function (p, i) {
      atualizarItemLista(p);
      if (ul.children[i] !== p.li) ul.insertBefore(p.li, ul.children[i] || null);
    });
    while (ul.children.length > lista.length) ul.removeChild(ul.lastChild);
    $('lista-vazia').hidden = lista.length > 0;
    $('qtd-part').textContent = String(lista.length);

    var cont = { conectado: 0, instavel: 0, sem_atualizacao: 0, parado: 0, militar: 0, civil: 0, responsavel: 0 };
    lista.forEach(function (p) {
      if (p.dados.removido) return;
      var t = tipoDe(p.dados);
      cont[t]++;
      if (t === 'responsavel') return;   // os contadores de estado são das equipes de campo
      var c = estadoDe(p).cod;
      if (cont[c] != null) cont[c]++;
    });
    $('resumo').innerHTML =
      '<span><span class="ponto ponto-conectado"></span> <b>' + cont.conectado + '</b> conectados</span>' +
      '<span><span class="ponto ponto-instavel"></span> <b>' + cont.instavel + '</b> instáveis</span>' +
      '<span><span class="ponto ponto-sem_atualizacao"></span> <b>' + cont.sem_atualizacao + '</b> sem atualização</span>' +
      (cont.parado ? '<span><span class="ponto ponto-parado"></span> <b>' + cont.parado + '</b> interrompidos</span>' : '') +
      '<span class="muted">' + cont.militar + ' militar(es) · ' + cont.civil + ' civil(is) · ' + cont.responsavel + ' responsável(is)</span>';
  }

  // Executado a cada 5 s: atualiza "há X s", estados e cores de conexão.
  function atualizarEstados() {
    est.participantes.forEach(atualizarAparenciaMarcador);
    renderizarLista();
    if (est.selecionado) atualizarFicha();
    atualizarPilula();
  }

  /* ------------------------------------------------------------------ */
  /* Ficha do participante                                                */
  /* ------------------------------------------------------------------ */
  function selecionar(id) {
    var anterior = est.participantes.get(est.selecionado);
    est.selecionado = id;
    if (anterior) atualizarAparenciaMarcador(anterior);
    var p = est.participantes.get(id);
    if (!p) return;
    atualizarAparenciaMarcador(p);
    if (est.circuloPrecisao) { est.circuloPrecisao.remove(); est.circuloPrecisao = null; }
    var pos = posicaoAtual(p);
    if (pos && pos.prec) {
      est.circuloPrecisao = L.circle([pos.lat, pos.lng], {
        radius: pos.prec, color: p.cor, weight: 1, fillOpacity: 0.08, interactive: false, className: 'circulo-precisao',
      }).addTo(est.mapa);
    }
    montarComandos(p);
    $('ficha').hidden = false;
    $('ficha').querySelector('.ficha-corpo').scrollTop = 0;
    atualizarFicha();
    renderizarLista();
  }

  function fecharFicha() {
    $('ficha').hidden = true;
    var p = est.participantes.get(est.selecionado);
    est.selecionado = null;
    if (p) atualizarAparenciaMarcador(p);
    if (est.circuloPrecisao) { est.circuloPrecisao.remove(); est.circuloPrecisao = null; }
    if (est.participantes.size) renderizarLista();
  }

  function montarComandos(p) {
    var cont = $('ficha-comandos');
    cont.innerHTML = '';
    if (ehEu(p)) return;   // ninguém envia orientação para si mesmo
    var tipos = tipoDe(p.dados) === 'responsavel' ? COMANDOS_RESPONSAVEL : Object.keys(C.TIPOS_MENSAGEM);
    tipos.forEach(function (tipo) {
      var t = C.TIPOS_MENSAGEM[tipo];
      cont.appendChild(UI.el('button', {
        classe: 'btn ' + t.classe, type: 'button', texto: t.rotulo,
        onclick: function () { enviarComando(p.id, tipo); },
      }));
    });
  }

  function estadoMensagem(m, p) {
    if (m.confirmada_em) {
      var resp = m.resposta ? ' · ' + (C.RESPOSTAS[m.resposta] || m.resposta) : '';
      return { cls: m.resposta === 'PRECISO_AJUDA' ? 'selo-perigo' : 'selo-ok', txt: 'Confirmada às ' + C.hora(m.confirmada_em) + resp };
    }
    if (m.entregue_em) return { cls: 'selo-alerta', txt: 'Recebida pelo aparelho às ' + C.hora(m.entregue_em) + ' · aguardando confirmação' };
    var e = estadoDe(p).cod;
    if (e === 'conectado' || e === 'instavel' || e === 'parado') {
      return { cls: 'selo-neutro', txt: 'Enviada às ' + C.hora(m.criada_em) + ' · aguardando entrega no aparelho' };
    }
    return { cls: 'selo-perigo', txt: 'Enviada às ' + C.hora(m.criada_em) + ' · participante sem conexão: será entregue quando ele reconectar' };
  }

  function atualizarFicha() {
    var p = est.participantes.get(est.selecionado);
    if (!p || $('ficha').hidden) return;
    var d = p.dados;
    var e = estadoDe(p);
    var pos = posicaoAtual(p);

    var eu = ehEu(p);
    var ehResp = tipoDe(d) === 'responsavel';
    $('ficha-nome').textContent = nomeExibido(p);
    $('ficha-simbolo').innerHTML = htmlSimbolo(p);

    var linhas = [
      ['Tipo', htmlSeloTipo(d)],
      ['CPF', d.cpf ? '<span class="mono">' + formatarCpf(d.cpf, est.cpfVisivel.has(p.id)) + '</span> ' +
        '<button type="button" class="btn btn-pequeno btn-link" data-cpf="' + p.id + '">' + (est.cpfVisivel.has(p.id) ? 'ocultar' : 'mostrar') + '</button>' : '—'],
      ['Celular', d.telefone ? '<a class="tel" href="tel:+55' + C.esc(d.telefone) + '">' + formatarTelefone(d.telefone) + '</a>' : '—'],
      ['Operação', C.esc(est.op.codigo) + '<br><span class="muted mono" style="font-size:.75rem">' + C.esc(est.op.id) + '</span>'],
      ['Conexão', '<span class="ponto ponto-' + e.cod + '"></span> ' + C.esc(e.rot)],
      ['Rastreamento', ehResp ? (d.rastreando ? 'Compartilhando posição' : 'Posição não compartilhada') : (d.rastreando ? 'Ativo' : 'Interrompido')],
      ['GPS', C.esc(textoGps(d.gps_estado))],
      ['Latitude', '<span class="mono">' + C.coord(pos && pos.lat) + '</span>'],
      ['Longitude', '<span class="mono">' + C.coord(pos && pos.lng) + '</span>'],
      ['Precisão', C.esc(C.precisao(pos && pos.prec))],
      ['Última posição', pos ? C.hora(pos.t) + ' <span class="muted">(' + C.idade(pos.t) + ')</span>' + (posicaoAntiga(p) ? ' <span class="selo selo-alerta">antiga</span>' : '') : '—'],
      ['Último contato', d.ultimo_contato_em ? C.hora(d.ultimo_contato_em) + ' <span class="muted">(' + C.idade(d.ultimo_contato_em) + ')</span>' : '—'],
      [ehResp ? 'Entrou no painel' : 'Ingressou', C.hora(d.criado_em)],
    ];
    if (ehResp) linhas = linhas.filter(function (l) { return l[0] !== 'CPF' && l[0] !== 'Celular'; });
    $('ficha-dados').innerHTML = linhas.map(function (l) { return '<dt>' + l[0] + '</dt><dd>' + l[1] + '</dd>'; }).join('');
    var bCpf = $('ficha-dados').querySelector('[data-cpf]');
    if (bCpf) bCpf.addEventListener('click', function () {
      if (est.cpfVisivel.has(p.id)) est.cpfVisivel.delete(p.id); else est.cpfVisivel.add(p.id);
      atualizarFicha();
    });

    // Pedido de encerramento
    var caixaSaida = $('ficha-saida');
    var pendente = saidaPendente(p) && est.op.status === 'ativa';
    caixaSaida.hidden = !pendente;
    if (pendente) {
      caixaSaida.innerHTML = '';
      caixaSaida.appendChild(UI.el('div', { classe: 'nota nota-saida' }, [
        UI.el('strong', { texto: 'PEDIU PARA ENCERRAR às ' + C.hora(d.saida_solicitada_em, false) + '.' }),
        d.saida_motivo ? UI.el('div', { texto: 'Motivo: ' + d.saida_motivo }) : null,
        UI.el('div', { classe: 'muted', texto: 'O rastreamento continua até você decidir.' }),
        UI.el('div', { classe: 'acoes-linha' }, [
          UI.el('button', { classe: 'btn btn-ok btn-pequeno', type: 'button', texto: 'Liberar saída', onclick: function () { liberarSaida(p.id); } }),
          UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Pedir para continuar', onclick: function () { recusarSaida(p.id); } }),
        ]),
      ]));
    }

    var bTri = $('ficha-trilha');
    bTri.setAttribute('aria-pressed', String(p.trilhaVisivel));
    bTri.textContent = p.trilhaVisivel ? 'Ocultar trilha' : 'Mostrar trilha';
    $('ficha-centralizar').disabled = !pos;

    // Pedido de ajuda
    var ajuda = temAjuda(p);
    var caixaAjuda = $('ficha-alerta');
    caixaAjuda.hidden = !ajuda;
    if (ajuda) {
      caixaAjuda.innerHTML = '';
      caixaAjuda.appendChild(UI.el('div', { classe: 'nota', style: 'background:#fee2e2;border-color:#b91c1c;color:#7f1d1d' }, [
        UI.el('strong', { texto: 'PEDIU AJUDA às ' + C.hora(ajuda.confirmada_em) + '. ' }),
        'Em resposta a: ' + (C.TIPOS_MENSAGEM[ajuda.tipo] || {}).rotulo + '. ',
        UI.el('button', {
          classe: 'btn btn-pequeno', type: 'button', texto: 'Marcar como atendido',
          onclick: function () {
            est.ajudaVista.add(ajuda.id);
            C.local.gravar(CHAVE_AJUDA_VISTA, Array.from(est.ajudaVista).slice(-500));
            atualizarEstados();
          },
        }),
      ]));
    }

    // Comandos
    var podeEnviar = est.op.status === 'ativa' && !d.removido && !eu;
    $('ficha-comandos').querySelectorAll('button').forEach(function (b) { b.disabled = !podeEnviar; });
    $('ficha-cmd-titulo').textContent = ehResp ? 'Mensagem para este responsável' : 'Enviar orientação';
    var aviso = $('ficha-cmd-aviso');
    aviso.hidden = !eu && podeEnviar && (e.cod === 'conectado' || e.cod === 'instavel' || e.cod === 'parado');
    aviso.textContent = eu
      ? 'Esta é a sua ficha. Use o botão "Minha posição" no topo para compartilhar ou parar de compartilhar sua localização com os outros responsáveis.'
      : !podeEnviar ? 'Não é possível enviar mensagens: ' + (d.removido ? 'participante removido.' : 'operação encerrada.')
      : ehResp ? 'Este responsável está com o painel fechado ou sem conexão. A mensagem será entregue quando ele abrir o painel da operação.'
      : 'Atenção: o participante está sem conexão. A mensagem ficará aguardando e só será entregue quando o celular dele reconectar.';
    $('ficha-msgs-titulo').textContent = eu ? 'Mensagens recebidas' : 'Mensagens enviadas';

    // Mensagens
    var msgs = [];
    est.mensagens.forEach(function (m) { if (m.participante_id === p.id) msgs.push(m); });
    msgs.sort(function (a, b) { return C.paraMs(b.criada_em) - C.paraMs(a.criada_em); });
    var ul = $('ficha-msgs');
    ul.innerHTML = msgs.length ? '' : '<li class="muted">Nenhuma mensagem.</li>';
    msgs.forEach(function (m) {
      var t = C.TIPOS_MENSAGEM[m.tipo] || C.TIPOS_MENSAGEM.PERSONALIZADA;
      var st = estadoMensagem(m, p);
      ul.appendChild(UI.el('li', null, [
        UI.el('div', { classe: 'msg-topo' }, [UI.el('span', { texto: t.rotulo }), UI.el('span', { classe: 'muted num', texto: C.hora(m.criada_em) })]),
        UI.el('div', { classe: 'msg-texto', texto: m.texto || t.padrao }),
        UI.el('div', { classe: 'msg-estado' }, [UI.el('span', { classe: 'selo ' + st.cls, texto: st.txt })]),
        UI.el('div', { classe: 'muted', style: 'font-size:.78rem', texto: 'Por ' + (m.remetente_nome || '—') }),
      ]));
    });

    // Histórico de posições (últimos 50)
    $('ficha-qtd-pontos').textContent = String(p.pontos.length);
    var linhasHist = p.pontos.slice(-50).reverse().map(function (pt) {
      return '<tr><td class="num">' + C.hora(pt.t) + '</td><td class="mono">' + C.coord(pt.lat) + '</td><td class="mono">' +
        C.coord(pt.lng) + '</td><td class="num">' + C.esc(C.precisao(pt.prec)) + '</td></tr>';
    }).join('');
    $('ficha-hist').innerHTML = linhasHist || '<tr><td colspan="4" class="muted">Sem posições registradas.</td></tr>';

    $('ficha-remover').hidden = d.removido || est.op.status !== 'ativa' || ehResp;
  }

  /* ------------------------------------------------------------------ */
  /* Mensagens                                                            */
  /* ------------------------------------------------------------------ */
  async function enviarComando(participanteId, tipo) {
    var p = est.participantes.get(participanteId);
    if (!p) return;
    var t = C.TIPOS_MENSAGEM[tipo];
    var e = estadoDe(p);
    var semConexao = !(e.cod === 'conectado' || e.cod === 'instavel' || e.cod === 'parado');
    var detalhe = UI.el('div', null, [
      UI.el('p', null, ['Destinatário: ', UI.el('strong', { texto: p.dados.nome }), ' (' + TIPOS[tipoDe(p.dados)].rotulo.toLowerCase() + ')']),
      semConexao ? UI.el('p', { classe: 'nota', texto: 'O participante está sem conexão (' + e.rot + '). A mensagem ficará aguardando e só será entregue quando o celular dele reconectar.' }) : null,
    ]);
    var r = await UI.confirmar({
      titulo: (t.critico ? 'Confirmar envio: ' : 'Enviar: ') + t.rotulo,
      detalhe: detalhe,
      campo: {
        rotulo: tipo === 'PERSONALIZADA' ? 'Mensagem' : 'Texto da orientação (pode complementar)',
        valor: t.padrao,
        max: 500,
        obrigatorio: tipo === 'PERSONALIZADA',
      },
      ok: 'ENVIAR PARA ' + p.dados.nome.toUpperCase(),
      perigo: t.critico,
    });
    if (!r) return;
    try {
      var m = await C.rpc('enviar_mensagem', { p_participante: p.id, p_tipo: tipo, p_texto: r.texto });
      receberMensagem(m, true);
      UI.aviso('Mensagem enviada. Acompanhe a entrega na ficha.', 'ok');
    } catch (err) {
      UI.aviso(err.message, 'erro');
    }
  }

  function receberMensagem(m, silencioso) {
    var antiga = est.mensagens.get(m.id);
    est.mensagens.set(m.id, m);
    var p = est.participantes.get(m.participante_id);
    if (!silencioso && m.resposta === 'PRECISO_AJUDA' && (!antiga || antiga.resposta !== 'PRECISO_AJUDA') && !est.ajudaVista.has(m.id)) {
      UI.aviso('PEDIDO DE AJUDA: ' + (p ? p.dados.nome : 'participante'), 'erro', 15000);
      alarme();
    }
    if (!silencioso && est.meuPart && m.participante_id === est.meuPart && !antiga && !m.confirmada_em) {
      alarme();
      try { if (navigator.vibrate) navigator.vibrate([400, 150, 400]); } catch (e) { /* ignora */ }
    }
    if (p) {
      atualizarAparenciaMarcador(p);
      est.listaSuja = true;
      if (est.selecionado === p.id) atualizarFicha();
    }
    verificarMensagensParaMim();
    renderizarLista();
  }

  function prepararAudio() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !est.audio) est.audio = new AC();
    } catch (e) { /* sem áudio */ }
  }

  function alarme() {
    var ac = est.audio;
    if (!ac) return;
    try {
      if (ac.state === 'suspended') ac.resume();
      var t = ac.currentTime;
      [0, 0.3, 0.6, 0.9].forEach(function (d, i) {
        var o = ac.createOscillator(), g = ac.createGain();
        o.type = 'square';
        o.frequency.value = i % 2 ? 660 : 990;
        g.gain.setValueAtTime(0.0001, t + d);
        g.gain.exponentialRampToValueAtTime(0.3, t + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.25);
        o.connect(g); g.connect(ac.destination);
        o.start(t + d); o.stop(t + d + 0.28);
      });
    } catch (e) { /* ignora */ }
  }

  async function liberarSaida(id) {
    var p = est.participantes.get(id);
    if (!p) return;
    var r = await UI.confirmar({
      titulo: 'Liberar a saída de ' + p.dados.nome + '?',
      texto: 'O celular dele para de enviar a localização e mostra "Saída liberada". A trilha já registrada continua guardada.',
      ok: 'Liberar saída',
    });
    if (!r) return;
    try {
      await C.rpc('liberar_participante', { p_participante: id });
      p.dados.liberado_em = new Date().toISOString();
      p.dados.removido = true;
      p.dados.rastreando = false;
      atualizarMarcador(p);
      atualizarFicha();
      renderizarLista();
      UI.aviso('Saída de ' + p.dados.nome + ' liberada.', 'ok');
    } catch (e) {
      UI.aviso(e.message, 'erro');
    }
  }

  async function recusarSaida(id) {
    var p = est.participantes.get(id);
    if (!p) return;
    var r = await UI.confirmar({
      titulo: 'Pedir para ' + p.dados.nome + ' continuar?',
      texto: 'O pedido de encerramento é cancelado e ele recebe a mensagem abaixo no celular.',
      campo: { rotulo: 'Mensagem', valor: 'Permaneça na operação até nova orientação. Seu rastreamento continua ativo.', max: 500, obrigatorio: true },
      ok: 'Enviar e manter rastreamento',
    });
    if (!r) return;
    try {
      await C.rpc('recusar_saida', { p_participante: id });
      var m = await C.rpc('enviar_mensagem', { p_participante: id, p_tipo: 'PERSONALIZADA', p_texto: r.texto });
      p.dados.saida_solicitada_em = null;
      p.dados.saida_motivo = null;
      receberMensagem(m, true);
      atualizarAparenciaMarcador(p);
      atualizarFicha();
      renderizarLista();
      UI.aviso('Pedido recusado e mensagem enviada.', 'ok');
    } catch (e) {
      UI.aviso(e.message, 'erro');
    }
  }

  async function removerParticipante() {
    var p = est.participantes.get(est.selecionado);
    if (!p) return;
    var r = await UI.confirmar({
      titulo: 'Remover ' + p.dados.nome + '?',
      texto: 'O participante deixará de enviar posições e não poderá voltar a esta operação com o mesmo aparelho. A trilha já registrada continua disponível.',
      ok: 'Remover',
      perigo: true,
    });
    if (!r) return;
    try {
      await C.rpc('remover_participante', { p_participante: p.id });
      p.dados.removido = true;
      p.dados.rastreando = false;
      atualizarMarcador(p);
      atualizarFicha();
      renderizarLista();
      UI.aviso('Participante removido.', 'ok');
    } catch (e) {
      UI.aviso(e.message, 'erro');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Encerramento                                                         */
  /* ------------------------------------------------------------------ */
  async function encerrarOperacao() {
    var op = est.op;
    if (!op || op.status !== 'ativa') return;
    var ret = op.retencao_horas
      ? 'As posições, trilhas e mensagens ficarão disponíveis para consulta e serão apagadas automaticamente ' + textoRetencao(op.retencao_horas).replace('dados apagados ', '') + '.'
      : 'Todas as posições, trilhas e mensagens serão APAGADAS IMEDIATAMENTE.';
    var r = await UI.confirmar({
      titulo: 'Encerrar a operação "' + op.codigo + '"?',
      texto: 'Os celulares dos participantes vão parar de enviar a localização e os links deixarão de funcionar. ' + ret,
      ok: 'Encerrar operação',
      perigo: true,
    });
    if (!r) return;
    try {
      var atual = await C.rpc('encerrar_operacao', { p_operacao: op.id });
      est.op = Object.assign(est.op, atual);
      renderizarCabecalho();
      if (est.op.dados_apagados_em) limparDadosDoMapa();
      else atualizarEstados();
      UI.aviso('Operação encerrada.', 'ok');
    } catch (e) {
      UI.aviso(e.message, 'erro');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Convite: links e QR Code                                             */
  /* ------------------------------------------------------------------ */
  function linkPara(token) {
    var u = new URL('civil.html', location.href);
    u.search = '';
    u.hash = 't=' + token;
    return u.href;
  }

  function abrirConvite() {
    var op = est.op;
    if (!op || op.status !== 'ativa') return;
    var links = { civil: linkPara(op.token_civil), militar: linkPara(op.token_militar) };
    var atual = 'civil';

    var entrada = UI.el('input', { classe: 'campo', readonly: true, 'aria-label': 'Link de convite' });
    var qr = UI.el('div', { classe: 'qr', 'aria-label': 'QR Code do link' });
    var nota = UI.el('p', { classe: 'nota' });
    var abaCivil = UI.el('button', { classe: 'btn btn-ativo', type: 'button', texto: '● Link para CIVIS' });
    var abaMil = UI.el('button', { classe: 'btn', type: 'button', texto: '■ Link para MILITARES' });

    function mostrar(tipo) {
      atual = tipo;
      entrada.value = links[tipo];
      abaCivil.className = 'btn' + (tipo === 'civil' ? ' btn-ativo' : '');
      abaMil.className = 'btn' + (tipo === 'militar' ? ' btn-ativo' : '');
      nota.textContent = tipo === 'civil'
        ? 'Compartilhe com os voluntários civis. Quem entrar por este link sempre aparecerá como CIVIL. O link não dá acesso a este painel.'
        : 'Compartilhe SOMENTE com militares. Este link permite ao participante se identificar como MILITAR. O link não dá acesso a este painel.';
      if (window.qrcode) {
        try {
          var q = window.qrcode(0, 'M');
          q.addData(links[tipo]);
          q.make();
          qr.innerHTML = q.createSvgTag({ cellSize: 6, margin: 4, scalable: true, title: 'QR Code — link para ' + (tipo === 'civil' ? 'civis' : 'militares') });
        } catch (e) { qr.textContent = 'Não foi possível gerar o QR Code.'; }
      } else {
        qr.textContent = 'QR Code indisponível (biblioteca não carregada).';
      }
    }

    async function copiar() {
      try {
        await navigator.clipboard.writeText(entrada.value);
        UI.aviso('Link copiado.', 'ok');
      } catch (e) {
        entrada.select();
        try { document.execCommand('copy'); UI.aviso('Link copiado.', 'ok'); } catch (e2) { UI.aviso('Copie o link manualmente.', 'erro'); }
      }
    }

    async function compartilhar() {
      try {
        await navigator.share({
          title: 'Operação ' + op.codigo,
          text: 'Operação de busca "' + op.codigo + '" — abra o link para compartilhar sua localização com a equipe do Corpo de Bombeiros:',
          url: entrada.value,
        });
      } catch (e) { /* cancelado */ }
    }

    abaCivil.addEventListener('click', function () { mostrar('civil'); });
    abaMil.addEventListener('click', function () { mostrar('militar'); });

    var botoes = [UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Copiar', onclick: copiar })];
    if (navigator.share) botoes.push(UI.el('button', { classe: 'btn', type: 'button', texto: 'Compartilhar', onclick: compartilhar }));

    var fechar = UI.abrirModal(UI.el('div', null, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Convidar participantes' }),
      UI.el('div', { classe: 'abas' }, [abaCivil, abaMil]),
      UI.el('div', { classe: 'link-caixa' }, [entrada].concat(botoes)),
      qr,
      nota,
      UI.el('div', { classe: 'modal-acoes' }, [UI.el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]),
    ]));
    mostrar(atual);
  }

  /* ------------------------------------------------------------------ */
  /* Presença e posição do próprio responsável                            */
  /* ------------------------------------------------------------------ */
  // Registra este responsável no mapa da operação (sem posição até ele ligar "Minha posição").
  async function entrarComoResponsavel() {
    if (!est.op || est.op.status !== 'ativa') return;
    var opId = est.op.id;
    try {
      var row = await C.rpc('entrar_como_responsavel', { p_operacao: opId });
      if (!est.op || est.op.id !== opId || !row) return;
      est.meuPart = row.id;
      upsertParticipante(row);
      renderizarLista();
      verificarMensagensParaMim();
      if (est.compartilhando) enviarMeuSinal();
    } catch (e) { /* tenta de novo no próximo ciclo */ }
  }

  function atualizarBotaoMinhaPos() {
    var b = $('btn-minha-pos');
    if (!b) return;
    b.setAttribute('aria-pressed', String(est.compartilhando));
    b.classList.toggle('ligado', est.compartilhando);
    var txt = { ok: 'GPS ativo', fraco: 'GPS com sinal fraco', sem_sinal: 'procurando sinal de GPS', negado: 'localização negada', indisponivel: 'GPS indisponível', aguardando: 'aguardando GPS' }[est.gpsMeu] || '';
    b.title = est.compartilhando
      ? 'Sua posição está sendo compartilhada com os outros responsáveis (' + txt + '). Toque para parar.'
      : 'Compartilhar sua posição com os outros responsáveis desta operação';
  }

  async function alternarMinhaPosicao() {
    if (est.compartilhando) {
      pararMinhaPosicao(false);
      UI.aviso('Sua posição deixou de ser compartilhada.');
      return;
    }
    if (!est.op || est.op.status !== 'ativa') return;
    if (!('geolocation' in navigator) || !window.isSecureContext) {
      UI.aviso('Este navegador não oferece localização (é preciso abrir o painel por https://).', 'erro', 7000);
      return;
    }
    prepararAudio();
    var btn = $('btn-minha-pos');
    btn.disabled = true;
    try {
      if (!est.meuPart) await entrarComoResponsavel();
      if (!est.meuPart) throw new Error('Não foi possível registrar você no mapa. Verifique a conexão.');
      var teste = await new Promise(function (resolve) {
        navigator.geolocation.getCurrentPosition(
          function (pos) { resolve({ ok: true, pos: pos }); },
          function (err) { resolve({ ok: false, codigo: err.code }); },
          { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
        );
      });
      if (!teste.ok && teste.codigo === 1) {
        UI.aviso('Permissão de localização negada. Libere a localização deste site nas configurações do navegador e tente de novo.', 'erro', 9000);
        return;
      }
      est.compartilhando = true;
      est.ultimoAceitoMeu = null;
      if (teste.ok) processarMinhaPosicao(teste.pos);
      else est.gpsMeu = teste.codigo === 2 ? 'indisponivel' : 'sem_sinal';
      if (est.watchId == null) {
        est.watchId = navigator.geolocation.watchPosition(processarMinhaPosicao, erroMeuGps, {
          enableHighAccuracy: true, maximumAge: 0, timeout: 30000,
        });
      }
      pedirTelaLigada();
      enviarMeuSinal();
      UI.aviso(teste.ok ? 'Sua posição está sendo compartilhada com os responsáveis da operação.'
        : 'Compartilhamento ligado, mas ainda sem sinal de GPS.', teste.ok ? 'ok' : 'erro');
    } catch (e) {
      UI.aviso(e.message, 'erro');
    } finally {
      btn.disabled = false;
      atualizarBotaoMinhaPos();
    }
  }

  function processarMinhaPosicao(pos) {
    if (!est.compartilhando) return;
    var c = pos.coords;
    if (!c || !isFinite(c.latitude) || !isFinite(c.longitude)) return;
    var agora = Date.now();
    var t = pos.timestamp && Math.abs(pos.timestamp - agora) < 24 * 3600 * 1000 ? pos.timestamp : agora;
    var prec = isFinite(c.accuracy) ? c.accuracy : null;
    est.gpsMeu = prec != null && prec > 50 ? 'fraco' : 'ok';

    var u = est.ultimoAceitoMeu;
    var aceitar;
    if (!u) aceitar = true;
    else {
      var dt = t - u.t;
      var d = C.distancia(u.lat, u.lng, c.latitude, c.longitude);
      if (dt < CFG_GPS.intervaloMinimoMs) aceitar = false;
      else if (prec != null && prec > CFG_GPS.precisaoMaximaM) aceitar = dt >= 60000;
      else aceitar = d >= CFG_GPS.distanciaMinimaM || dt >= CFG_GPS.intervaloMaximoMs;
    }
    if (aceitar) {
      est.ultimoAceitoMeu = { lat: c.latitude, lng: c.longitude, t: t };
      est.filaMinha.push({
        id: C.uuid(),
        lat: Math.round(c.latitude * 1e7) / 1e7,
        lng: Math.round(c.longitude * 1e7) / 1e7,
        prec: prec == null ? null : Math.round(prec * 10) / 10,
        t: t,
      });
      if (est.filaMinha.length > 2000) est.filaMinha.splice(0, est.filaMinha.length - 2000);
      clearTimeout(est.timerMinhaFila);
      est.timerMinhaFila = setTimeout(enviarMinhaFila, 800);
    }
    atualizarBotaoMinhaPos();
  }

  // Parado no mesmo lugar, o navegador pode não avisar novas leituras; então
  // pedimos uma leitura nova para a posição não ficar marcada como antiga.
  function lerPosicaoSeParado() {
    if (!est.compartilhando || !est.ultimoAceitoMeu) return;
    if (Date.now() - est.ultimoAceitoMeu.t < CFG_GPS.intervaloMaximoMs - 5000) return;
    navigator.geolocation.getCurrentPosition(processarMinhaPosicao, function () {}, {
      enableHighAccuracy: true, maximumAge: 10000, timeout: 20000,
    });
  }

  function erroMeuGps(err) {
    est.gpsMeu = err.code === 1 ? 'negado' : err.code === 2 ? 'indisponivel' : 'sem_sinal';
    atualizarBotaoMinhaPos();
  }

  async function enviarMinhaFila() {
    if (est.enviandoMinha || !est.meuPart || !est.filaMinha.length) return;
    est.enviandoMinha = true;
    var lote = est.filaMinha.slice(0, 200);
    try {
      await C.rpc('enviar_posicoes', { p_participante: est.meuPart, p_pontos: lote, p_gps: est.compartilhando ? est.gpsMeu : null }, 20000);
      var enviados = new Set(lote.map(function (x) { return x.id; }));
      est.filaMinha = est.filaMinha.filter(function (x) { return !enviados.has(x.id); });
      if (est.filaMinha.length) setTimeout(enviarMinhaFila, 300);
    } catch (e) {
      if (e.codigo === 'operacao_encerrada' || e.codigo === 'participante_invalido' || e.codigo === 'lote_invalido') {
        est.filaMinha = [];
        if (e.codigo === 'participante_invalido') est.meuPart = null;
      } else {
        clearTimeout(est.timerMinhaFila);
        est.timerMinhaFila = setTimeout(enviarMinhaFila, 5000);
      }
    } finally {
      est.enviandoMinha = false;
    }
  }

  async function enviarMeuSinal() {
    if (!est.meuPart) return;
    try {
      // Só o aparelho que está compartilhando diz "rastreando". Um segundo aparelho
      // do mesmo responsável (ex.: computador + celular) manda null e não apaga o estado.
      // O aviso de que parou é enviado uma única vez, em pararMinhaPosicao().
      var r = await C.rpc('sinal_vida', {
        p_participante: est.meuPart,
        p_rastreando: est.compartilhando ? true : null,
        p_gps: est.compartilhando ? est.gpsMeu : null,
      }, 12000);
      if (r && r.status === 'inexistente') est.meuPart = null;   // registro apagado: será recriado
    } catch (e) { /* tenta de novo no próximo ciclo */ }
  }

  function pararMinhaPosicao(silencioso) {
    var estava = est.compartilhando;
    est.compartilhando = false;
    if (est.watchId != null) {
      navigator.geolocation.clearWatch(est.watchId);
      est.watchId = null;
    }
    liberarTelaLigada();
    if (estava) {
      // envia o que ficou na fila e depois avisa que parou (guarda o registro
      // agora, porque ao sair do painel ele é limpo logo em seguida)
      var part = est.meuPart;
      enviarMinhaFila().then(function () {
        if (part) C.rpc('sinal_vida', { p_participante: part, p_rastreando: false, p_gps: null }).catch(function () {});
      });
    }
    if (!silencioso) atualizarBotaoMinhaPos();
  }

  async function pedirTelaLigada() {
    if (!est.compartilhando || est.wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      est.wakeLock = await navigator.wakeLock.request('screen');
      est.wakeLock.addEventListener('release', function () { est.wakeLock = null; });
    } catch (e) { est.wakeLock = null; }
  }

  function liberarTelaLigada() {
    if (est.wakeLock) {
      try { est.wakeLock.release(); } catch (e) { /* ignora */ }
      est.wakeLock = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Mensagens recebidas por este responsável (de outros responsáveis)    */
  /* ------------------------------------------------------------------ */
  function verificarMensagensParaMim() {
    if (!est.meuPart) return;
    var paraEntregar = [];
    est.mensagens.forEach(function (m) {
      if (m.participante_id === est.meuPart && !m.entregue_em && !est.entregando.has(m.id)) {
        est.entregando.add(m.id);
        paraEntregar.push(m.id);
      }
    });
    if (paraEntregar.length) {
      C.rpc('marcar_entregues', { p_ids: paraEntregar }).catch(function () {
        paraEntregar.forEach(function (id) { est.entregando.delete(id); });
      });
    }
    mostrarAlertaParaMim();
  }

  function pendentesParaMim() {
    var lista = [];
    est.mensagens.forEach(function (m) {
      if (est.meuPart && m.participante_id === est.meuPart && !m.confirmada_em && !est.confirmadasLocal.has(m.id)) lista.push(m);
    });
    return lista.sort(function (a, b) { return C.paraMs(b.criada_em) - C.paraMs(a.criada_em); });
  }

  function mostrarAlertaParaMim() {
    var caixa = $('alerta-cmd');
    if (!caixa) return;
    var pend = pendentesParaMim();
    if (!pend.length) {
      caixa.hidden = true;
      est.alertaAtual = null;
      return;
    }
    var m = pend[0];
    var fila = pend.length > 1 ? 'Mais ' + (pend.length - 1) + ' mensagem(ns) aguardando confirmação' : '';
    if (est.alertaAtual === m.id && !caixa.hidden) {
      $('alerta-cmd-fila').textContent = fila;
      return;
    }
    est.alertaAtual = m.id;
    var tipo = C.TIPOS_MENSAGEM[m.tipo] || C.TIPOS_MENSAGEM.PERSONALIZADA;
    caixa.className = 'alerta-msg alerta-painel alerta-' + tipo.classe;
    $('alerta-cmd-tit').textContent = tipo.titulo;
    $('alerta-cmd-texto').textContent = m.texto || tipo.padrao;
    $('alerta-cmd-meta').textContent = 'De ' + (m.remetente_nome || 'outro responsável') + ' · ' + (est.op ? est.op.codigo : '') + ' · às ' + C.hora(m.criada_em);
    $('alerta-cmd-fila').textContent = fila;
    var botoes = $('alerta-cmd-botoes');
    botoes.innerHTML = '';
    if (m.tipo === 'CONFIRME') {
      botoes.appendChild(UI.el('button', { classe: 'btn btn-ok btn-gigante', type: 'button', texto: 'ESTOU BEM', onclick: function () { confirmarParaMim(m.id, 'ESTOU_BEM'); } }));
      botoes.appendChild(UI.el('button', { classe: 'btn btn-primario btn-gigante', type: 'button', texto: 'PRECISO DE AJUDA', onclick: function () { confirmarParaMim(m.id, 'PRECISO_AJUDA'); } }));
    } else {
      botoes.appendChild(UI.el('button', { classe: 'btn btn-escuro btn-gigante', type: 'button', texto: 'CONFIRMAR LEITURA', onclick: function () { confirmarParaMim(m.id, 'CIENTE'); } }));
    }
    caixa.hidden = false;
    var b = botoes.querySelector('button');
    if (b) b.focus();
  }

  async function confirmarParaMim(id, resposta) {
    est.confirmadasLocal.add(id);
    est.alertaAtual = null;
    mostrarAlertaParaMim();
    try {
      var m = await C.rpc('confirmar_mensagem', { p_mensagem: id, p_resposta: resposta });
      if (m && m.id) receberMensagem(m, true);
      UI.aviso('Confirmação enviada.', 'ok');
    } catch (e) {
      est.confirmadasLocal.delete(id);
      mostrarAlertaParaMim();
      UI.aviso(e.message, 'erro');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Equipe: responsáveis da operação                                     */
  /* ------------------------------------------------------------------ */
  function abrirEquipe() {
    var op = est.op;
    if (!op) return;
    var souCriador = est.usuario && op.responsavel_id === est.usuario.id;
    var lista = UI.el('ul', { classe: 'lista-equipe' }, [UI.el('li', { classe: 'muted', texto: 'Carregando…' })]);
    var entrada = UI.el('input', { classe: 'campo', type: 'email', id: 'equipe-email', autocomplete: 'off', placeholder: 'email@cbm…', 'aria-describedby': 'equipe-ajuda' });
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btnAdd = UI.el('button', { classe: 'btn btn-escuro', type: 'submit', texto: 'Adicionar' });
    var form = UI.el('form', { classe: 'equipe-form', novalidate: true }, [
      UI.el('label', { classe: 'rotulo', for: 'equipe-email', texto: 'Adicionar responsável pelo e-mail' }),
      UI.el('div', { classe: 'link-caixa' }, [entrada, btnAdd]),
      UI.el('p', { classe: 'ajuda', id: 'equipe-ajuda', texto: 'Só é possível adicionar quem já tem acesso ao painel (cadastrado pelo administrador).' }),
      erro,
    ]);

    function render(itens) {
      lista.innerHTML = '';
      (itens || []).forEach(function (r) {
        var eu = est.usuario && r.user_id === est.usuario.id;
        var li = UI.el('li', null, [
          UI.el('div', { classe: 'equipe-info' }, [
            UI.el('strong', { texto: r.nome }),
            r.criador ? UI.el('span', { classe: 'selo selo-responsavel', texto: 'Criador' }) : null,
            eu ? UI.el('span', { classe: 'selo selo-neutro', texto: 'Você' }) : null,
            UI.el('div', { classe: 'muted', texto: r.email || '' }),
          ]),
        ]);
        if (souCriador && !r.criador && !eu) {
          var confirmando = false;
          var bRem = UI.el('button', { classe: 'btn btn-perigo btn-pequeno', type: 'button', texto: 'Remover' });
          bRem.addEventListener('click', async function () {
            if (!confirmando) {
              confirmando = true;
              bRem.textContent = 'Confirmar remoção';
              setTimeout(function () { confirmando = false; bRem.textContent = 'Remover'; }, 5000);
              return;
            }
            bRem.disabled = true;
            try {
              render(await C.rpc('remover_responsavel', { p_operacao: op.id, p_user: r.user_id }));
              UI.aviso(r.nome + ' foi removido da operação.', 'ok');
              sincronizar();
            } catch (e) {
              bRem.disabled = false;
              UI.aviso(e.message, 'erro');
            }
          });
          li.appendChild(bRem);
        }
        lista.appendChild(li);
      });
    }

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      var email = entrada.value.trim();
      if (!email || email.indexOf('@') === -1) {
        erro.textContent = 'Informe o e-mail do responsável.';
        erro.hidden = false;
        return;
      }
      btnAdd.disabled = true;
      try {
        render(await C.rpc('adicionar_responsavel', { p_operacao: op.id, p_email: email }));
        entrada.value = '';
        UI.aviso('Responsável adicionado. Ele já vê esta operação na lista dele.', 'ok');
      } catch (e) {
        erro.textContent = e.message;
        erro.hidden = false;
      } finally {
        btnAdd.disabled = false;
      }
    });

    var fechar = UI.abrirModal(UI.el('div', null, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Responsáveis da operação' }),
      UI.el('p', { classe: 'ajuda', texto: 'Todos os responsáveis abaixo veem o mapa, os participantes, as posições uns dos outros e as mensagens desta operação, e podem enviar orientações.' + (souCriador ? '' : ' Só quem criou a operação pode remover responsáveis.') }),
      lista,
      form,
      UI.el('div', { classe: 'modal-acoes' }, [UI.el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]),
    ]));

    C.rpc('listar_responsaveis', { p_operacao: op.id }).then(render).catch(function (e) {
      lista.innerHTML = '';
      lista.appendChild(UI.el('li', { classe: 'erro-form', texto: e.message }));
    });
  }

  /* ------------------------------------------------------------------ */
  /* Minha conta: troca da própria senha                                  */
  /* ------------------------------------------------------------------ */
  function abrirMinhaConta() {
    var s1 = UI.el('input', { classe: 'campo', type: 'password', id: 'conta-senha1', autocomplete: 'new-password', maxlength: '72' });
    var s2 = UI.el('input', { classe: 'campo', type: 'password', id: 'conta-senha2', autocomplete: 'new-password', maxlength: '72' });
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = UI.el('button', { classe: 'btn btn-escuro', type: 'submit', texto: 'Salvar nova senha' });
    var form = UI.el('form', { novalidate: true }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Minha conta' }),
      UI.el('p', { classe: 'ajuda', texto: (est.responsavel ? est.responsavel.nome + ' · ' : '') + (est.usuario && est.usuario.email || '') }),
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'conta-senha1', texto: 'Nova senha (mínimo 8 caracteres)' }), s1]),
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'conta-senha2', texto: 'Repita a nova senha' }), s2]),
      erro,
      UI.el('div', { classe: 'modal-acoes' }, [UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btn]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      if (s1.value.length < 8) { erro.textContent = 'A senha precisa ter pelo menos 8 caracteres.'; erro.hidden = false; return; }
      if (s1.value !== s2.value) { erro.textContent = 'As duas senhas não são iguais.'; erro.hidden = false; return; }
      btn.disabled = true;
      try {
        var r = await C.cliente.auth.updateUser({ password: s1.value });
        if (r.error) throw C.criarErro(r.error);
        fechar();
        UI.aviso('Senha alterada.', 'ok');
      } catch (e) {
        erro.textContent = /weak|password/i.test(String(e.original && e.original.message)) ? 'Senha fraca. Use pelo menos 8 caracteres, misturando letras e números.' : e.message;
        erro.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
    var fechar = UI.abrirModal(form);
  }

  /* ------------------------------------------------------------------ */
  /* Responsáveis (somente administradores)                               */
  /* ------------------------------------------------------------------ */
  var ERROS_API = {
    nome_invalido: 'Informe o nome (2 a 60 caracteres).',
    email_invalido: 'E-mail inválido.',
    senha_fraca: 'Senha fraca: use pelo menos 8 caracteres.',
    ja_cadastrado: 'Este e-mail já está cadastrado como responsável.',
    sem_permissao: 'Somente administradores podem fazer isso.',
    nao_autenticado: 'Sessão expirada. Entre novamente.',
    responsavel_nao_encontrado: 'Responsável não encontrado.',
    variaveis_de_ambiente_ausentes: 'Servidor sem a chave secreta do Supabase (variável SUPABASE_SECRET_KEY no Vercel).',
    falha_supabase: 'O Supabase recusou a operação. Tente de novo em instantes.',
    falha_rede: 'Falha de comunicação com o Supabase.',
  };

  function gerarSenha() {
    var alfabeto = 'abcdefghjkmnpqrstuvwxyz23456789';
    var b = new Uint8Array(12);
    crypto.getRandomValues(b);
    var s = '';
    for (var i = 0; i < 12; i++) {
      s += alfabeto[b[i] % alfabeto.length];
      if (i === 3 || i === 7) s += '-';
    }
    return s;
  }

  async function copiarTexto(t) {
    try { await navigator.clipboard.writeText(t); UI.aviso('Copiado.', 'ok'); }
    catch (e) { UI.aviso('Selecione e copie manualmente.', 'erro'); }
  }

  async function chamarApiResponsaveis(corpo) {
    var sessao = (await C.cliente.auth.getSession()).data.session;
    if (!sessao) throw new Error(ERROS_API.nao_autenticado);
    var r;
    try {
      r = await fetch('/api/responsaveis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessao.access_token },
        body: JSON.stringify(corpo),
      });
    } catch (e) {
      throw new Error('Sem conexão com o servidor.');
    }
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(ERROS_API[j.erro] || ('Erro ' + r.status + (j.erro ? ': ' + j.erro : '')));
    return j;
  }

  async function mostrarResponsaveis() {
    mostrarTela('responsaveis');
    document.title = 'Responsáveis — Painel GBS';
    if (!$('resp-senha').value) $('resp-senha').value = gerarSenha();
    await carregarResponsaveis();
  }

  async function carregarResponsaveis() {
    var ul = $('lista-resp');
    ul.innerHTML = '<li class="muted">Carregando…</li>';
    try {
      renderizarResponsaveis(await C.rpc('admin_listar_responsaveis'));
    } catch (e) {
      ul.innerHTML = '';
      ul.appendChild(UI.el('li', { classe: 'erro-form', texto: e.message }));
    }
  }

  function renderizarResponsaveis(lista) {
    var ul = $('lista-resp');
    ul.innerHTML = '';
    (lista || []).forEach(function (r) {
      var acoes = UI.el('div', { classe: 'op-acoes' });
      if (!r.eu) {
        acoes.appendChild(UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Redefinir senha', onclick: function () { redefinirSenha(r); } }));
        acoes.appendChild(UI.el('button', {
          classe: 'btn btn-pequeno', type: 'button', texto: r.admin ? 'Tirar administrador' : 'Tornar administrador',
          onclick: function () { alterarResponsavel(r, { p_admin: !r.admin }, r.admin ? 'deixará de ser administrador' : 'passará a ser administrador'); },
        }));
        acoes.appendChild(UI.el('button', {
          classe: 'btn btn-pequeno ' + (r.ativo ? 'btn-perigo' : 'btn-ok'), type: 'button', texto: r.ativo ? 'Desativar acesso' : 'Reativar acesso',
          onclick: function () { alterarResponsavel(r, { p_ativo: !r.ativo }, r.ativo ? 'perderá o acesso ao painel na hora' : 'voltará a acessar o painel'); },
        }));
      }
      acoes.appendChild(UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Renomear', onclick: function () { renomearResponsavel(r); } }));
      ul.appendChild(UI.el('li', { classe: r.ativo ? '' : 'inativo' }, [
        UI.el('div', { classe: 'op-info' }, [
          UI.el('strong', null, [
            r.nome + ' ',
            r.admin ? UI.el('span', { classe: 'selo selo-responsavel', texto: 'Administrador' }) : null,
            r.ativo ? null : UI.el('span', { classe: 'selo selo-perigo', texto: 'Desativado' }),
            r.eu ? UI.el('span', { classe: 'selo selo-neutro', texto: 'Você' }) : null,
          ]),
          UI.el('span', { texto: (r.email || '') + ' · último acesso: ' + (r.ultimo_acesso ? C.hora(r.ultimo_acesso, false) : 'nunca entrou') }),
        ]),
        acoes,
      ]));
    });
  }

  async function cadastrarResponsavel(ev) {
    ev.preventDefault();
    var erro = $('resp-erro');
    erro.hidden = true;
    var nome = $('resp-nome').value.replace(/\s+/g, ' ').trim();
    var email = $('resp-email').value.trim().toLowerCase();
    var senha = $('resp-senha').value;
    var admin = $('resp-admin').checked;
    var msg = nome.length < 2 ? ERROS_API.nome_invalido
      : !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? ERROS_API.email_invalido
      : senha.length < 8 ? ERROS_API.senha_fraca : '';
    if (msg) { erro.textContent = msg; erro.hidden = false; return; }
    var btn = $('resp-cadastrar');
    btn.disabled = true;
    try {
      var r = await chamarApiResponsaveis({ acao: 'criar', nome: nome, email: email, senha: senha, admin: admin });
      var painel = new URL('militar.html', location.href);
      painel.hash = '';
      $('resp-cred-texto').textContent = r.ja_existia
        ? 'Painel: ' + painel.href + '\nE-mail: ' + email + '\nSenha: a mesma que essa pessoa já usava (o login já existia).'
        : 'Painel: ' + painel.href + '\nE-mail: ' + email + '\nSenha provisória: ' + senha + '\n\nTroque a senha em "Minha conta" no primeiro acesso.';
      $('resp-credenciais').hidden = false;
      $('resp-nome').value = '';
      $('resp-email').value = '';
      $('resp-admin').checked = false;
      $('resp-senha').value = gerarSenha();
      UI.aviso(nome + ' cadastrado.', 'ok');
      carregarResponsaveis();
    } catch (e) {
      erro.textContent = e.message;
      erro.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  async function alterarResponsavel(r, campos, efeito) {
    var ok = await UI.confirmar({ titulo: r.nome, texto: r.nome + ' ' + efeito + '. Confirma?', ok: 'Confirmar', perigo: campos.p_ativo === false });
    if (!ok) return;
    try {
      renderizarResponsaveis(await C.rpc('admin_alterar_responsavel', Object.assign({ p_user: r.user_id }, campos)));
      UI.aviso('Alteração salva.', 'ok');
    } catch (e) {
      UI.aviso(e.message, 'erro', 7000);
    }
  }

  async function renomearResponsavel(r) {
    var res = await UI.confirmar({ titulo: 'Renomear', campo: { rotulo: 'Nome / posto e graduação', valor: r.nome, max: 60, obrigatorio: true }, ok: 'Salvar' });
    if (!res) return;
    try {
      renderizarResponsaveis(await C.rpc('admin_alterar_responsavel', { p_user: r.user_id, p_nome: res.texto }));
      UI.aviso('Nome atualizado.', 'ok');
    } catch (e) {
      UI.aviso(e.message, 'erro');
    }
  }

  async function redefinirSenha(r) {
    var res = await UI.confirmar({
      titulo: 'Redefinir senha de ' + r.nome,
      texto: 'A senha atual deixa de funcionar. Passe a nova senha para ' + r.nome + ' por um canal seguro.',
      campo: { rotulo: 'Nova senha provisória', valor: gerarSenha(), max: 72, obrigatorio: true },
      ok: 'Redefinir senha',
    });
    if (!res) return;
    if (res.texto.length < 8) { UI.aviso(ERROS_API.senha_fraca, 'erro'); return; }
    try {
      await chamarApiResponsaveis({ acao: 'senha', user_id: r.user_id, senha: res.texto });
      $('resp-cred-texto').textContent = 'E-mail: ' + (r.email || '') + '\nNova senha provisória: ' + res.texto;
      $('resp-credenciais').hidden = false;
      window.scrollTo(0, 0);
      UI.aviso('Senha redefinida.', 'ok');
    } catch (e) {
      UI.aviso(e.message, 'erro', 7000);
    }
  }

  iniciar();
})();
