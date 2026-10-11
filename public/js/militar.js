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
  var CHAVE_LATERAL = 'gbs-painel-lateral-oculta';
  var CHAVE_PREFS_MAPA = 'gbs-painel-mapa';

  // Relatos de campo enviados pelos participantes (mensagens com categoria).
  var CATEGORIAS = {
    MENSAGEM: { rotulo: 'Mensagem', letra: '✉' },
    PISTA: { rotulo: 'Possível pista', letra: 'P' },
    VESTIGIO: { rotulo: 'Vestígio', letra: 'V' },
    OBJETO: { rotulo: 'Objeto encontrado', letra: 'O' },
    OBSTACULO: { rotulo: 'Obstáculo', letra: '!' },
    OUTRO: { rotulo: 'Outro', letra: '?' },
    AJUDA: { rotulo: 'PEDIDO DE AJUDA', letra: 'SOS' },
  };
  var ORIGEM_FOTO = { gps: 'GPS do aparelho no momento do registro', exif: 'gravada na própria foto (EXIF)', nenhuma: 'sem localização' };

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
    // mensagens e relatos recebidos dos participantes
    lidasLocal: new Set(),
    marcandoLidas: new Set(),
    destaqueNovas: new Set(),
    filaNotif: [],
    timerNotif: null,
    relatosMarc: new Map(),     // id da mensagem → marcador
    // fotos
    fotos: new Map(),           // id → foto
    fotosMarc: new Map(),       // id → marcador
    fotosFila: [],              // fotos tiradas por este responsável aguardando envio
    enviandoFotos: false,
    // mapa e interface
    camadasBase: null,
    camadaAtual: 'osm',
    camadaPontos: null,         // fotos e relatos (agrupados quando próximos)
    legenda: null,
    prefsMapa: Object.assign({ camada: 'osm', fotos: true, relatos: true, nomes: true, legenda: true }, C.local.ler(CHAVE_PREFS_MAPA, {}) || {}),
    lateralOculta: Boolean(C.local.ler(CHAVE_LATERAL, false)),
    centralAba: 'msgs',
    centralFiltro: 'todas',
    centralVoltar: false,
    assinaturaConversa: '',
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
    // Menu de ferramentas
    $('btn-ferramentas').addEventListener('click', function () { alternarMenu(); });
    $('menu-fechar').addEventListener('click', function () { fecharMenu(true); });
    $('menu-ferramentas').addEventListener('click', function (ev) {
      // fecha ao escolher uma opção (na captura: antes de a ação desabilitar o botão)
      var item = ev.target.closest('.menu-item');
      if (item && !item.disabled) fecharMenu(false);
    }, true);
    document.addEventListener('pointerdown', function (ev) {
      if (!$('menu-ferramentas').hidden && !$('ferramentas').contains(ev.target)) fecharMenu(false);
    });
    $('btn-registrar-foto').addEventListener('click', abrirRegistrarFoto);
    $('menu-central').addEventListener('click', function () { abrirCentral('msgs'); });
    $('btn-excluir-op').addEventListener('click', function () { excluirOperacao(est.op); });
    document.querySelectorAll('[data-camada]').forEach(function (b) {
      b.addEventListener('click', function () { trocarCamada(b.getAttribute('data-camada')); });
    });
    $('opt-fotos').addEventListener('click', function () { definirPrefMapa('fotos', !est.prefsMapa.fotos); });
    $('opt-relatos').addEventListener('click', function () { definirPrefMapa('relatos', !est.prefsMapa.relatos); });
    $('opt-nomes').addEventListener('click', function () { definirPrefMapa('nomes', !est.prefsMapa.nomes); });
    $('opt-legenda').addEventListener('click', function () { definirPrefMapa('legenda', !est.prefsMapa.legenda); });
    $('opt-trilhas').addEventListener('click', function () { definirTodasTrilhas(!todasTrilhasVisiveis()); });
    $('menu-enquadrar').addEventListener('click', enquadrarTodos);
    $('opt-lateral').addEventListener('click', function () { definirLateral(est.lateralOculta); });
    // Lista lateral: ocultar / reabrir
    $('btn-ocultar-lateral').addEventListener('click', function () { definirLateral(false); });
    $('btn-mostrar-lateral').addEventListener('click', function () { definirLateral(true); });
    $('painel-corpo').addEventListener('transitionend', function (ev) {
      if (ev.target === $('painel-corpo') && est.mapa) est.mapa.invalidateSize({ pan: false });
    });
    // Central de comunicação
    $('btn-mensagens').addEventListener('click', function () { if ($('central').hidden) abrirCentral(); else fecharCentral(); });
    $('central-fechar').addEventListener('click', fecharCentral);
    $('aba-msgs').addEventListener('click', function () { mostrarAbaCentral('msgs'); });
    $('aba-fotos').addEventListener('click', function () { mostrarAbaCentral('fotos'); });
    document.querySelectorAll('[data-filtro]').forEach(function (b) {
      b.addEventListener('click', function () { est.centralFiltro = b.getAttribute('data-filtro'); renderizarCentral(); });
    });
    $('form-resposta').addEventListener('submit', enviarResposta);
    $('resposta-texto').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); enviarResposta(ev); }
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && est.compartilhando) {
        pedirTelaLigada();
        enviarMeuSinal();
        enviarMinhaFila();
      }
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' || document.querySelector('.modal-fundo') || document.querySelector('.lightbox')) return;
      if (!$('menu-ferramentas').hidden) fecharMenu(true);
      else if (!$('ficha').hidden) fecharFicha();
      else if (!$('central').hidden) fecharCentral();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') marcarLidasVisiveis();
    });
    document.addEventListener('pointerdown', prepararAudio, { once: true });
    window.addEventListener('hashchange', rotear);
    window.addEventListener('online', function () { if (est.op) { sincronizar(); enviarFilaFotos(); } });
    window.addEventListener('beforeunload', function (ev) {
      if (est.fotosFila.length) { ev.preventDefault(); ev.returnValue = ''; }
    });

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
      if (podeExcluir(op)) {
        acoes.appendChild(UI.el('button', { classe: 'btn btn-perigo', type: 'button', texto: 'Excluir operação', 'data-excluir': op.id, onclick: function () { excluirOperacao(op); } }));
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
      var arq = await limparArquivosPendentes();
      UI.aviso('Dados da operação apagados.' + (arq.falhas ? ' ' + textoFalhaArquivos(arq.falhas) : ''), arq.falhas ? 'erro' : 'ok', arq.falhas ? 12000 : 4000);
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
  /* Exclusão definitiva de uma operação                                  */
  /* ------------------------------------------------------------------ */
  // Mostrado só a quem pode excluir: quem criou a operação ou um administrador.
  // A regra que vale é a do banco (função excluir_operacao); isto só esconde o botão.
  function podeExcluir(op) {
    return Boolean(op && est.usuario && est.responsavel && (op.responsavel_id === est.usuario.id || est.responsavel.admin));
  }

  function textoFalhaArquivos(n) {
    return n + ' arquivo(s) de foto não puderam ser apagados agora. Eles ficaram registrados e serão apagados automaticamente pela limpeza diária.';
  }

  // Apaga do Storage os arquivos de fotos cujos registros este responsável acabou
  // de excluir. O que falhar continua na fila (arquivos_pendentes) e é apagado
  // depois pela limpeza diária (/api/limpeza), sem ficar esquecido.
  async function limparArquivosPendentes() {
    var caminhos;
    try {
      caminhos = await C.rpc('meus_arquivos_pendentes');
    } catch (e) {
      return { apagados: 0, falhas: 0, erro: e.message };
    }
    caminhos = caminhos || [];
    var apagados = 0;
    for (var i = 0; i < caminhos.length; i += 100) {
      var lote = caminhos.slice(i, i + 100);
      try {
        var r = await C.cliente.storage.from('fotos').remove(lote);
        if (r.error) continue;
        var conf = await C.rpc('confirmar_arquivos_removidos', { p_caminhos: lote });
        apagados += Number(conf) || 0;
      } catch (e) { /* fica na fila para a limpeza diária */ }
    }
    return { apagados: apagados, falhas: caminhos.length - apagados };
  }

  function excluirOperacao(op) {
    if (!op || !podeExcluir(op)) return;
    var nFotos = est.op && est.op.id === op.id ? est.fotos.size : null;
    var entrada = UI.el('input', { classe: 'campo', id: 'excluir-codigo', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'excluir-ajuda' });
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btnOk = UI.el('button', { classe: 'btn btn-primario', type: 'submit', id: 'excluir-confirmar', texto: 'Excluir definitivamente', disabled: true });
    var btnCancelar = UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } });
    function confere() { return entrada.value.trim().toUpperCase() === String(op.codigo).trim().toUpperCase(); }
    entrada.addEventListener('input', function () { btnOk.disabled = !confere(); erro.hidden = true; });

    var form = UI.el('form', { classe: 'form-excluir', novalidate: true }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Excluir a operação "' + op.codigo + '"?' }),
      UI.el('p', { classe: 'nota nota-perigo', texto: 'A exclusão é DEFINITIVA e não pode ser desfeita. Serão apagados a operação e todos os dados vinculados a ela:' }),
      UI.el('ul', { classe: 'lista-exclusao' }, [
        UI.el('li', { texto: 'participantes civis e militares cadastrados na operação;' }),
        UI.el('li', { texto: 'todo o histórico de localizações e as trilhas GPS;' }),
        UI.el('li', { texto: 'mensagens trocadas e relatos de campo (objetos, vestígios, pistas, obstáculos);' }),
        UI.el('li', { texto: 'fotografias registradas no mapa' + (nFotos ? ' (' + nFotos + ')' : '') + ' e os arquivos armazenados;' }),
        UI.el('li', { texto: 'equipe de responsáveis da operação e os links/QR Codes de convite, que deixam de funcionar na hora.' }),
      ]),
      UI.el('p', { classe: 'ajuda', texto: 'Quem ainda estiver com o link aberto deixa de enviar localização, mensagens e fotos. Outras operações não são afetadas.' }),
      UI.el('div', { classe: 'grupo' }, [
        UI.el('label', { classe: 'rotulo', for: 'excluir-codigo', texto: 'Para confirmar, digite o nome da operação' }),
        UI.el('p', { classe: 'ajuda mono', id: 'excluir-ajuda', texto: op.codigo }),
        entrada,
      ]),
      erro,
      UI.el('div', { classe: 'modal-acoes' }, [btnCancelar, btnOk]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      if (!confere()) {
        erro.textContent = 'O nome digitado não confere com o da operação.';
        erro.hidden = false;
        return;
      }
      btnOk.disabled = true;
      btnCancelar.disabled = true;
      btnOk.textContent = 'EXCLUINDO…';
      var r;
      try {
        r = await C.rpc('excluir_operacao', { p_operacao: op.id }, 30000);
      } catch (e) {
        erro.textContent = 'Não foi possível excluir: ' + e.message + (e.rede ? ' Nada foi apagado; tente de novo quando a conexão voltar.' : '');
        erro.hidden = false;
        btnOk.disabled = false;
        btnCancelar.disabled = false;
        btnOk.textContent = 'Excluir definitivamente';
        return;
      }
      btnOk.textContent = 'APAGANDO FOTOS…';
      var arq = await limparArquivosPendentes();
      fechar(true);
      var resumo = 'Operação "' + (r && r.operacao || op.codigo) + '" excluída' +
        (r ? ' (' + r.participantes + ' participante(s), ' + r.fotos + ' foto(s))' : '') + '.';
      if (arq.falhas) UI.aviso(resumo + ' ' + textoFalhaArquivos(arq.falhas), 'erro', 15000);
      else UI.aviso(resumo + ' Todos os dados foram apagados.', 'ok', 8000);
      if (est.op && est.op.id === op.id) {
        fecharPainel();
        if (location.hash) location.hash = '';
        else mostrarOperacoes();
      } else {
        mostrarOperacoes();
      }
    });
    var fechar = UI.abrirModal(form, { fecharNoFundo: false });
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
    aplicarLateral(false);
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
        enviarFilaFotos();
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
    fecharMenu(false);
    fecharCentral();
    fecharLightbox();
    est.centralVoltar = false;
    clearTimeout(est.timerNotif);
    est.filaNotif = [];
    est.lidasLocal = new Set();
    est.marcandoLidas = new Set();
    est.destaqueNovas = new Set();
    est.relatosMarc = new Map();
    est.fotos = new Map();
    est.fotosMarc = new Map();
    est.camadaPontos = est.legenda = est.camadasBase = null;
    est.assinaturaConversa = '';
    if (est.fotosFila.length) UI.aviso(est.fotosFila.length + ' foto(s) sua(s) não chegaram a ser enviadas e foram descartadas ao sair do painel.', 'erro', 10000);
    est.fotosFila = [];
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
    $('feed-msgs').innerHTML = '';
    $('galeria').innerHTML = '';
    atualizarContadorMsgs();
  }

  function limparDadosDoMapa() {
    est.participantes.forEach(function (p) {
      if (p.marcador) p.marcador.remove();
      if (p.trilha) p.trilha.remove();
    });
    if (est.circuloPrecisao) { est.circuloPrecisao.remove(); est.circuloPrecisao = null; }
    if (est.camadaPontos) est.camadaPontos.clearLayers();
    est.participantes = new Map();
    est.posIds = new Set();
    est.mensagens = new Map();
    est.fotos = new Map();
    est.fotosMarc = new Map();
    est.relatosMarc = new Map();
    fecharFicha();
    $('lista-part').innerHTML = '';
    renderizarLista();
    renderizarCentral();
    atualizarContadorMsgs();
  }

  function renderizarCabecalho() {
    var op = est.op;
    $('op-codigo').textContent = op.codigo;
    $('op-sub').textContent = op.status === 'ativa' ? 'Operação ativa · ' + textoRetencao(op.retencao_horas) : 'Operação encerrada';
    $('btn-encerrar').hidden = op.status !== 'ativa';
    $('btn-convite').hidden = op.status !== 'ativa';
    $('btn-minha-pos').hidden = op.status !== 'ativa';
    $('btn-registrar-foto').hidden = op.status !== 'ativa';
    $('btn-excluir-op').hidden = !podeExcluir(op);
    if (op.status !== 'ativa' && est.compartilhando) pararMinhaPosicao(true);
    var faixa = $('faixa-encerrada');
    faixa.hidden = op.status === 'ativa';
    if (op.status !== 'ativa') {
      $('faixa-encerrada-texto').textContent = 'Operação encerrada em ' + C.hora(op.encerrada_em) + '. ' +
        (op.dados_apagados_em ? 'Os dados foram apagados.' : 'Os dados serão apagados automaticamente em ' + C.hora(op.expira_em, false) + '.');
      $('btn-apagar-faixa').hidden = Boolean(op.dados_apagados_em);
    }
    atualizarTitulo();
  }

  function atualizarTitulo() {
    if (!est.op) return;
    var n = naoLidas().length;
    document.title = (n ? '(' + n + ') ' : '') + est.op.codigo + ' — Painel GBS';
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
    // As camadas de fundo são escolhidas no menu "Ferramentas" (Camadas do mapa).
    est.camadasBase = { osm: osm, topo: topo, satelite: satelite };
    est.camadaAtual = est.camadasBase[est.prefsMapa.camada] ? est.prefsMapa.camada : 'osm';
    est.camadasBase[est.camadaAtual].addTo(mapa);
    L.control.scale({ metric: true, imperial: false, position: 'bottomleft' }).addTo(mapa);

    // Controle essencial de orientação que fica sempre no mapa: enquadrar todos.
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
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.on(b1, 'click', function (e) { L.DomEvent.preventDefault(e); enquadrarTodos(); });
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
          '<div><span class="mk-foto mk-foto-legenda"><span class="ico-camera"></span></span> Foto registrada no local</div>' +
          '<div><span class="mk-relato mk-relato-legenda"><span>P</span></span> Relato do participante</div>' +
          '</details>';
        L.DomEvent.disableClickPropagation(div);
        return div;
      },
    });
    est.legenda = new Legenda();
    if (est.prefsMapa.legenda) est.legenda.addTo(mapa);

    // Fotos e relatos: agrupados quando estão próximos (o número indica quantos),
    // para não poluir o mapa. Ao aproximar, cada um aparece no seu local; vários
    // no mesmo ponto se abrem em leque ao tocar no grupo.
    // Camada própria, abaixo dos participantes: quem está em campo fica sempre visível por cima.
    var painelPontos = mapa.createPane('pontos');
    painelPontos.style.zIndex = 550;
    est.camadaPontos = criarGrupo().addTo(mapa);
    // Grupo aberto em leque: as fotos e relatos sobem para ficar fáceis de tocar.
    est.camadaPontos.on('spiderfied', function () { painelPontos.style.zIndex = 650; });
    est.camadaPontos.on('unspiderfied', function () { painelPontos.style.zIndex = 550; });

    est.mapa = mapa;
    $('mapa').classList.toggle('esconder-rotulos', !est.prefsMapa.nomes);
    atualizarMenu();
    setTimeout(function () { mapa.invalidateSize(); }, 50);
  }

  function criarGrupo() {
    if (!L.markerClusterGroup) return L.featureGroup();   // biblioteca indisponível: sem agrupamento
    return L.markerClusterGroup({
      clusterPane: 'pontos',
      showCoverageOnHover: false,
      maxClusterRadius: 45,
      spiderfyOnMaxZoom: true,
      zoomToBoundsOnClick: true,
      iconCreateFunction: function (grupo) {
        var nf = 0, nr = 0;
        grupo.getAllChildMarkers().forEach(function (m) { if (m.options.tipoPonto === 'foto') nf++; else nr++; });
        var tipo = nf && nr ? 'misto' : nf ? 'fotos' : 'relatos';
        var miolo = tipo === 'relatos' ? '<span class="cl-letra">!</span>' : '<span class="ico-camera"></span>';
        return L.divIcon({
          className: 'cluster-wrap',
          html: '<div class="cluster cluster-' + tipo + '" title="' + nf + ' foto(s), ' + nr + ' relato(s)">' + miolo + '<b>' + (nf + nr) + '</b></div>',
          iconSize: [40, 40],
          iconAnchor: [20, 20],
        });
      },
    });
  }

  function marcadoresDe(tipo) {
    return Array.from((tipo === 'fotos' ? est.fotosMarc : est.relatosMarc).values());
  }

  function trocarCamada(nome) {
    if (!est.mapa || !est.camadasBase || !est.camadasBase[nome]) return;
    if (nome !== est.camadaAtual) {
      est.mapa.removeLayer(est.camadasBase[est.camadaAtual]);
      est.camadasBase[nome].addTo(est.mapa);
      est.camadaAtual = nome;
    }
    definirPrefMapa('camada', nome);
  }

  function definirPrefMapa(chave, valor) {
    est.prefsMapa[chave] = valor;
    C.local.gravar(CHAVE_PREFS_MAPA, est.prefsMapa);
    if (est.mapa) {
      if ((chave === 'fotos' || chave === 'relatos') && est.camadaPontos) {
        var lista = marcadoresDe(chave);
        if (est.camadaPontos.addLayers) {
          if (valor) est.camadaPontos.addLayers(lista); else est.camadaPontos.removeLayers(lista);
        } else {
          lista.forEach(function (mk) { if (valor) est.camadaPontos.addLayer(mk); else est.camadaPontos.removeLayer(mk); });
        }
      }
      if (chave === 'legenda' && est.legenda) { if (valor) est.legenda.addTo(est.mapa); else est.legenda.remove(); }
      if (chave === 'nomes') $('mapa').classList.toggle('esconder-rotulos', !valor);
    }
    atualizarMenu();
  }

  /* ---------- Menu de ferramentas ---------------------------------- */
  function alternarMenu() {
    if ($('menu-ferramentas').hidden) abrirMenu(); else fecharMenu(true);
  }

  function abrirMenu() {
    atualizarMenu();
    $('menu-ferramentas').hidden = false;
    $('btn-ferramentas').setAttribute('aria-expanded', 'true');
    document.body.classList.add('menu-aberto');
    var primeiro = $('menu-ferramentas').querySelector('.menu-item:not([hidden]):not([disabled])');
    if (primeiro) setTimeout(function () { primeiro.focus(); }, 20);
  }

  function fecharMenu(devolverFoco) {
    var menu = $('menu-ferramentas');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    $('btn-ferramentas').setAttribute('aria-expanded', 'false');
    document.body.classList.remove('menu-aberto');
    if (devolverFoco) $('btn-ferramentas').focus();
  }

  function todasTrilhasVisiveis() {
    var todas = true;
    est.participantes.forEach(function (p) { if (!p.trilhaVisivel) todas = false; });
    return todas;
  }

  // Mantém os estados (marcado/desmarcado) dos itens do menu iguais ao que está no mapa.
  function atualizarMenu() {
    document.querySelectorAll('[data-camada]').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.getAttribute('data-camada') === est.camadaAtual));
    });
    $('opt-fotos').setAttribute('aria-pressed', String(Boolean(est.prefsMapa.fotos)));
    $('opt-relatos').setAttribute('aria-pressed', String(Boolean(est.prefsMapa.relatos)));
    $('opt-nomes').setAttribute('aria-pressed', String(Boolean(est.prefsMapa.nomes)));
    $('opt-legenda').setAttribute('aria-pressed', String(Boolean(est.prefsMapa.legenda)));
    $('opt-trilhas').setAttribute('aria-pressed', String(todasTrilhasVisiveis()));
    $('opt-lateral').setAttribute('aria-pressed', String(!est.lateralOculta));
  }

  /* ---------- Lista lateral: ocultar e reabrir ----------------------- */
  function definirLateral(visivel) {
    est.lateralOculta = !visivel;
    C.local.gravar(CHAVE_LATERAL, est.lateralOculta);
    aplicarLateral(true);
    if (visivel) {
      var b = $('btn-ocultar-lateral');
      if (b) setTimeout(function () { b.focus(); }, 30);
    } else {
      setTimeout(function () { $('btn-mostrar-lateral').focus(); }, 30);
    }
  }

  // Ocultar a lista muda só a interface: dados, rastreamento e tempo real seguem iguais.
  function aplicarLateral(animar) {
    var oculta = est.lateralOculta;
    document.body.classList.toggle('lateral-oculta', oculta);
    $('lateral').setAttribute('aria-hidden', String(oculta));
    if (oculta) $('lateral').setAttribute('inert', ''); else $('lateral').removeAttribute('inert');
    $('btn-mostrar-lateral').hidden = !oculta;
    atualizarBotaoReabrir();
    atualizarMenu();
    if (!est.mapa) return;
    // Acompanha a transição para o mapa ocupar o espaço sem "pular".
    var mapa = est.mapa;
    var fim = Date.now() + (animar ? 400 : 0);
    (function passo() {
      if (est.mapa !== mapa) return;
      mapa.invalidateSize({ pan: false });
      if (Date.now() < fim) requestAnimationFrame(passo);
    })();
  }

  function atualizarBotaoReabrir() {
    var b = $('btn-mostrar-lateral');
    if (!b || b.hidden) return;
    var n = 0, alerta = false;
    est.participantes.forEach(function (p) {
      if (!p.dados.removido) n++;
      if (temAjuda(p) || saidaPendente(p) || naoLidasDe(p.id).length) alerta = true;
    });
    $('reabrir-qtd').textContent = String(n);
    $('reabrir-alerta').hidden = !alerta;
    b.title = 'Mostrar a lista de participantes' + (alerta ? ' (há alertas)' : '');
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

      await carregarFotos(true);
      if (!est.op || est.op.id !== opId) return;

      est.ultimoSyncOk = Date.now();
      est.syncFalhou = false;
    } catch (e) {
      est.syncFalhou = true;
      UI.aviso('Falha ao carregar dados: ' + e.message, 'erro');
    }
    renderizarLista();
    renderizarCentral();
    atualizarContadorMsgs();
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
        UI.aviso('Esta operação foi excluída ou você não tem mais acesso a ela.', 'erro', 8000);
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

      await carregarFotos(false);
      if (!est.op || est.op.id !== opId) return;

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
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'fotos', filter: filtro }, function (ev) {
        if (ev.new && ev.new.id) adicionarFoto(ev.new, false);
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

  // Pedido de ajuda ainda não atendido: resposta "PRECISO DE AJUDA" a um CONFIRME
  // ou o botão "Preciso de ajuda" da página do participante.
  function temAjuda(p) {
    var ultima = null, sos = null;
    est.mensagens.forEach(function (m) {
      if (m.participante_id !== p.id) return;
      if (m.direcao === 'entrada') {
        if (m.categoria === 'AJUDA' && (!sos || C.paraMs(m.criada_em) > C.paraMs(sos.criada_em))) sos = m;
      } else if (m.resposta && m.confirmada_em) {
        if (!ultima || C.paraMs(m.confirmada_em) > C.paraMs(ultima.confirmada_em)) ultima = m;
      }
    });
    var resp = ultima && ultima.resposta === 'PRECISO_AJUDA' && !est.ajudaVista.has(ultima.id) ? ultima : null;
    if (sos && est.ajudaVista.has(sos.id)) sos = null;
    if (resp && sos) return C.paraMs(sos.criada_em) > C.paraMs(resp.confirmada_em) ? sos : resp;
    return resp || sos;
  }

  function mensagensPendentes(p) {
    var n = 0;
    est.mensagens.forEach(function (m) { if (m.participante_id === p.id && m.direcao !== 'entrada' && !m.confirmada_em) n++; });
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
    if (naoLidasDe(p.id).length) c.push('msg-nova');
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
    atualizarMenu();
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
    var novas = naoLidasDe(p.id).length;
    var pos = posicaoAtual(p);
    var partes = p.liPartes;

    var htmlSimb = '<div class="' + (posicaoAntiga(p) ? 'antigo' : '') + '">' + htmlSimbolo(p) + '</div>';
    if (partes.simbolo.innerHTML !== htmlSimb) partes.simbolo.innerHTML = htmlSimb;

    var htmlNome = '<span class="nome-txt">' + C.esc(nomeExibido(p)) + '</span>' + htmlSeloTipo(d) +
      (ajuda ? '<span class="selo selo-perigo">Pediu ajuda</span>' : '') +
      (saidaPendente(p) ? '<span class="selo selo-alerta">Pediu para sair</span>' : '') +
      (pend ? '<span class="selo selo-alerta" title="Mensagens aguardando confirmação">✉ ' + pend + '</span>' : '') +
      (novas ? '<span class="selo selo-responsavel selo-msg-nova" title="Mensagens novas deste participante">' + (novas === 1 ? 'Mensagem nova' : novas + ' mensagens novas') + '</span>' : '');
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
    var aa = temAjuda(a) ? 0 : saidaPendente(a) ? 1 : naoLidasDe(a.id).length ? 2 : 3;
    var bb = temAjuda(b) ? 0 : saidaPendente(b) ? 1 : naoLidasDe(b.id).length ? 2 : 3;
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
    atualizarBotaoReabrir();
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
    // Em telas pequenas a ficha e a central ocupam o mesmo espaço: guarda a central para voltar depois.
    if (!$('central').hidden && telaPequena()) {
      est.centralVoltar = true;
      $('central').hidden = true;
    }
    if ($('ficha').hidden || anterior !== p) $('resposta-texto').value = '';
    est.assinaturaConversa = '';
    $('ficha').hidden = false;
    $('ficha').querySelector('.ficha-corpo').scrollTop = 0;
    atualizarFicha();
    renderizarLista();
    marcarLidasVisiveis();
  }

  function telaPequena() {
    return Boolean(window.matchMedia && window.matchMedia('(max-width: 860px)').matches);
  }

  function fecharFicha() {
    $('ficha').hidden = true;
    var p = est.participantes.get(est.selecionado);
    est.selecionado = null;
    if (p) atualizarAparenciaMarcador(p);
    if (est.circuloPrecisao) { est.circuloPrecisao.remove(); est.circuloPrecisao = null; }
    if (est.participantes.size) renderizarLista();
    if (est.centralVoltar) {
      est.centralVoltar = false;
      if (est.op) abrirCentral();
    }
  }

  function montarComandos(p) {
    var cont = $('ficha-comandos');
    cont.innerHTML = '';
    if (ehEu(p)) return;   // ninguém envia orientação para si mesmo
    // A mensagem livre é escrita no campo logo abaixo; aqui ficam só as orientações prontas.
    var tipos = (tipoDe(p.dados) === 'responsavel' ? COMANDOS_RESPONSAVEL : Object.keys(C.TIPOS_MENSAGEM))
      .filter(function (t) { return t !== 'PERSONALIZADA'; });
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

    // Topo da ficha: tipo e situação numa linha só. O essencial fica à vista;
    // CPF, coordenadas e histórico ficam em "Mais detalhes".
    $('ficha-resumo').innerHTML = htmlSeloTipo(d) + ' <span class="ponto ponto-' + e.cod + '"></span> ' + C.esc(e.rot);
    var posTxt;
    if (!pos) posTxt = 'Ainda sem posição';
    else posTxt = 'Posição ' + C.idade(pos.t) + ' · ' + C.precisao(pos.prec) + (posicaoAntiga(p) ? ' · antiga' : '');
    var gpsRuim = d.rastreando && ['sem_sinal', 'negado', 'indisponivel'].indexOf(d.gps_estado) !== -1;
    $('ficha-pos').textContent = posTxt + (gpsRuim ? ' · ' + textoGps(d.gps_estado) : '');
    $('ficha-pos').classList.toggle('antiga', !pos || posicaoAntiga(p) || gpsRuim);
    var ligar = $('ficha-ligar');
    ligar.hidden = !d.telefone;
    if (d.telefone) {
      ligar.href = 'tel:+55' + d.telefone;
      ligar.textContent = '📞 Ligar';
      ligar.title = 'Ligar para ' + formatarTelefone(d.telefone);
      ligar.setAttribute('aria-label', ligar.title);
    }

    var linhas = [
      ['CPF', d.cpf ? '<span class="mono">' + formatarCpf(d.cpf, est.cpfVisivel.has(p.id)) + '</span> ' +
        '<button type="button" class="btn btn-pequeno btn-link" data-cpf="' + p.id + '">' + (est.cpfVisivel.has(p.id) ? 'ocultar' : 'mostrar') + '</button>' : '—'],
      ['Celular', d.telefone ? '<a class="tel" href="tel:+55' + C.esc(d.telefone) + '">' + formatarTelefone(d.telefone) + '</a>' : '—'],
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
        UI.el('strong', { texto: 'PEDIU AJUDA às ' + C.hora(ajuda.direcao === 'entrada' ? ajuda.criada_em : ajuda.confirmada_em) + '. ' }),
        ajuda.direcao === 'entrada'
          ? 'Pelo botão "Preciso de ajuda"' + (ajuda.lat != null ? ', com a localização. ' : ' (sem localização). ')
          : 'Em resposta a: ' + (C.TIPOS_MENSAGEM[ajuda.tipo] || {}).rotulo + '. ',
        ajuda.direcao === 'entrada' && ajuda.lat != null
          ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Ver no mapa', onclick: function () { verRelatoNoMapa(ajuda); } }) : null,
        ' ',
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
    $('ficha-cmd-rapidos').hidden = eu || !podeEnviar;
    var aviso = $('ficha-cmd-aviso');
    aviso.hidden = !eu && podeEnviar && (e.cod === 'conectado' || e.cod === 'instavel' || e.cod === 'parado');
    aviso.textContent = eu
      ? 'Esta é a sua ficha. Para compartilhar sua localização com os outros responsáveis, use Ferramentas → Minha posição.'
      : !podeEnviar ? 'Não é possível enviar mensagens: ' + (d.removido ? 'participante removido.' : 'operação encerrada.')
      : ehResp ? 'Este responsável está com o painel fechado ou sem conexão. A mensagem será entregue quando ele abrir o painel da operação.'
      : 'Atenção: o participante está sem conexão. A mensagem ficará aguardando e só será entregue quando o celular dele reconectar.';
    $('ficha-msgs-titulo').textContent = eu ? 'Mensagens recebidas' : 'Mensagens';
    renderizarConversa(p);
    var formResp = $('form-resposta');
    formResp.hidden = eu || !podeEnviar;
    $('resposta-texto').placeholder = 'Mensagem para ' + d.nome + '…';

    // Fotos registradas por este participante
    renderizarFotosFicha(p);

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
    if (!silencioso && est.meuPart && m.participante_id === est.meuPart && m.direcao !== 'entrada' && !antiga && !m.confirmada_em) {
      alarme();
      try { if (navigator.vibrate) navigator.vibrate([400, 150, 400]); } catch (e) { /* ignora */ }
    }
    if (m.direcao === 'entrada') {
      // Mensagem ou relato do participante para os responsáveis.
      if (antiga && antiga.lida_em == null && m.lida_em != null) est.lidasLocal.delete(m.id);
      if (!antiga && !silencioso && m.categoria === 'AJUDA' && !est.ajudaVista.has(m.id)) {
        UI.aviso('PEDIDO DE AJUDA: ' + nomeDoParticipante(m.participante_id, m.remetente_nome) + (m.lat != null ? ' (com localização)' : ''), 'erro', 15000);
        alarme();
      } else if (!antiga && !silencioso && !m.lida_em) {
        notificarEntrada(m);
      }
      atualizarRelato(m);
      agendarCentral();
      atualizarContadorMsgs();
      if (!antiga && est.selecionado === m.participante_id && !$('ficha').hidden) marcarLidasVisiveis();
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
      if (est.op.dados_apagados_em) {
        limparDadosDoMapa();
        var arq = await limparArquivosPendentes();
        if (arq.falhas) UI.aviso(textoFalhaArquivos(arq.falhas), 'erro', 12000);
      } else {
        atualizarEstados();
      }
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
  /* Mensagens e relatos recebidos dos participantes                      */
  /* ------------------------------------------------------------------ */
  function jaLida(m) {
    return Boolean(m.lida_em) || est.lidasLocal.has(m.id);
  }

  function naoLidas() {
    var lista = [];
    est.mensagens.forEach(function (m) { if (m.direcao === 'entrada' && !jaLida(m)) lista.push(m); });
    return lista;
  }

  function naoLidasDe(pid) {
    return naoLidas().filter(function (m) { return m.participante_id === pid; });
  }

  function nomeDoParticipante(pid, reserva) {
    var p = est.participantes.get(pid);
    return p ? nomeExibido(p) : (reserva || 'Participante');
  }

  function resumir(t, n) {
    t = String(t || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  function atualizarContadorMsgs() {
    var n = est.op ? naoLidas().length : 0;
    var c = $('contador-msgs');
    if (c) {
      c.textContent = n > 99 ? '99+' : String(n);
      c.hidden = !n;
    }
    var b = $('btn-mensagens');
    if (b) {
      b.classList.toggle('tem-novas', n > 0);
      b.title = n ? n + ' mensagem(ns) ou relato(s) não lido(s)' : 'Mensagens, relatos e fotos dos participantes';
    }
    atualizarTitulo();
    atualizarBotaoReabrir();
  }

  // Aviso visual + sonoro de mensagem nova. Várias de uma vez (ex.: reconexão) viram um aviso só.
  function notificarEntrada(m) {
    est.filaNotif.push(m);
    clearTimeout(est.timerNotif);
    est.timerNotif = setTimeout(descarregarNotificacoes, 400);
  }

  function descarregarNotificacoes() {
    var fila = est.filaNotif.filter(function (m) { return !jaLida(m); });
    est.filaNotif = [];
    if (!fila.length || !est.op) return;
    var texto;
    if (fila.length === 1) {
      var m = fila[0];
      var cat = CATEGORIAS[m.categoria] || CATEGORIAS.MENSAGEM;
      var relato = m.categoria && m.categoria !== 'MENSAGEM';
      texto = (relato ? 'RELATO (' + cat.rotulo + ') de ' : 'Mensagem de ') + nomeDoParticipante(m.participante_id, m.remetente_nome) +
        ': ' + resumir(m.texto, 140);
    } else {
      texto = fila.length + ' novas mensagens/relatos dos participantes.';
    }
    avisoClicavel(texto + ' Toque para abrir.', function () {
      if (fila.length === 1) abrirConversa(fila[0].participante_id);
      else abrirCentral('msgs');
    });
    bipeMensagem();
    var b = $('btn-mensagens');
    b.classList.remove('pulsar');
    void b.offsetWidth;
    b.classList.add('pulsar');
  }

  function avisoClicavel(texto, acao) {
    UI.aviso(texto, 'msg', 10000);
    var a = $('avisos').lastElementChild;
    if (!a) return;
    a.classList.add('clicavel');
    a.setAttribute('tabindex', '0');
    a.addEventListener('click', function () { if (a.parentNode) a.parentNode.removeChild(a); acao(); });
    a.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); a.click(); } });
  }

  function bipeMensagem() {
    var ac = est.audio;
    if (!ac) return;
    try {
      if (ac.state === 'suspended') ac.resume();
      var t = ac.currentTime;
      [0, 0.18].forEach(function (d, i) {
        var o = ac.createOscillator(), g = ac.createGain();
        o.type = 'sine';
        o.frequency.value = i ? 1175 : 880;
        g.gain.setValueAtTime(0.0001, t + d);
        g.gain.exponentialRampToValueAtTime(0.25, t + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.16);
        o.connect(g); g.connect(ac.destination);
        o.start(t + d); o.stop(t + d + 0.18);
      });
    } catch (e) { /* ignora */ }
  }

  // Marca como lidas as mensagens que estão sendo vistas (central aberta ou
  // conversa do participante aberta na ficha). O participante vê "Lida por …".
  function marcarLidasVisiveis() {
    if (!est.op || document.visibilityState === 'hidden') return;
    var centralAberta = !$('central').hidden && est.centralAba === 'msgs';
    var fichaDe = !$('ficha').hidden ? est.selecionado : null;
    if (!centralAberta && !fichaDe) return;
    var ids = [];
    naoLidas().forEach(function (m) {
      if ((centralAberta || m.participante_id === fichaDe) && !est.marcandoLidas.has(m.id)) ids.push(m.id);
    });
    if (centralAberta) ids.forEach(function (id) { est.destaqueNovas.add(id); });
    marcarLidas(ids);
  }

  function marcarLidas(ids) {
    ids = ids.filter(function (id) { return !est.marcandoLidas.has(id); });
    if (!ids.length) return;
    ids.forEach(function (id) { est.lidasLocal.add(id); est.marcandoLidas.add(id); });
    atualizarContadorMsgs();
    est.listaSuja = true;
    renderizarLista();
    est.participantes.forEach(atualizarAparenciaMarcador);
    C.rpc('marcar_lidas', { p_ids: ids }).then(function () {
      var agora = new Date().toISOString();
      ids.forEach(function (id) {
        var m = est.mensagens.get(id);
        if (m && !m.lida_em) { m.lida_em = agora; m.lida_por_nome = est.responsavel ? est.responsavel.nome : null; }
      });
      agendarCentral();
      if (est.selecionado) atualizarFicha();
    }).catch(function () {
      // sem conexão: volta a contar como não lida e tenta de novo depois
      ids.forEach(function (id) { est.lidasLocal.delete(id); });
      atualizarContadorMsgs();
    }).then(function () {
      ids.forEach(function (id) { est.marcandoLidas.delete(id); });
    });
  }

  /* ---------- Relatos com localização no mapa ------------------------ */
  function iconeRelato(m) {
    var cat = CATEGORIAS[m.categoria] || CATEGORIAS.MENSAGEM;
    return L.divIcon({
      className: 'mk-relato-wrap',
      html: '<div class="mk-relato cat-' + C.esc(m.categoria || 'MENSAGEM') + '"><span>' + C.esc(cat.letra) + '</span></div>',
      iconSize: [30, 30],
      iconAnchor: [15, 30],
    });
  }

  function atualizarRelato(m) {
    if (!est.camadaPontos) return;
    // No mapa só os relatos e pedidos de ajuda; mensagens comuns ficam na conversa
    // (com "Ver no mapa" quando têm localização), para não poluir o mapa.
    var tem = m.direcao === 'entrada' && m.lat != null && m.lng != null && m.categoria && m.categoria !== 'MENSAGEM';
    var mk = est.relatosMarc.get(m.id);
    if (!tem) {
      if (mk) { est.camadaPontos.removeLayer(mk); est.relatosMarc.delete(m.id); }
      return;
    }
    if (mk) return;
    var cat = CATEGORIAS[m.categoria] || CATEGORIAS.MENSAGEM;
    mk = L.marker([m.lat, m.lng], {
      icon: iconeRelato(m),
      keyboard: true,
      title: cat.rotulo + ' — ' + nomeDoParticipante(m.participante_id, m.remetente_nome) + ' às ' + C.hora(m.criada_em, false),
      alt: cat.rotulo,
      pane: 'pontos',        // participantes ficam por cima
      tipoPonto: 'relato',
    });
    mk.on('click', function () { abrirRelato(m.id); });
    est.relatosMarc.set(m.id, mk);
    if (est.prefsMapa.relatos) est.camadaPontos.addLayer(mk);
  }

  function destacarNoMapa(grupo, mk, lat, lng) {
    if (!est.mapa) return;
    if (telaPequena()) { fecharCentral(); if (!$('ficha').hidden) fecharFicha(); }
    UI.fecharModal();
    function piscar() {
      var el = mk && mk.getElement && mk.getElement();
      if (!el) return;
      el.classList.add('destaque');
      setTimeout(function () { el.classList.remove('destaque'); }, 3500);
    }
    if (mk && grupo && grupo.zoomToShowLayer && est.mapa.hasLayer(grupo)) {
      grupo.zoomToShowLayer(mk, function () { est.mapa.panTo([lat, lng]); setTimeout(piscar, 300); });
    } else {
      est.mapa.setView([lat, lng], Math.max(est.mapa.getZoom(), 17));
      setTimeout(piscar, 300);
    }
  }

  function verRelatoNoMapa(m) {
    if (m.lat == null) return;
    if (!est.prefsMapa.relatos) definirPrefMapa('relatos', true);
    destacarNoMapa(est.camadaPontos, est.relatosMarc.get(m.id), m.lat, m.lng);
  }

  function abrirRelato(id) {
    var m = est.mensagens.get(id);
    if (!m) return;
    var p = est.participantes.get(m.participante_id);
    var cat = CATEGORIAS[m.categoria] || CATEGORIAS.MENSAGEM;
    marcarLidas([m.id]);
    var dl = UI.el('dl', { classe: 'dados' });
    function linha(rot, valor) { dl.appendChild(UI.el('dt', { texto: rot })); dl.appendChild(UI.el('dd', null, [valor])); }
    linha('Enviado por', nomeDoParticipante(m.participante_id, m.remetente_nome) + (p ? ' (' + TIPOS[tipoDe(p.dados)].rotulo.toLowerCase() + ')' : ''));
    linha('Horário', C.hora(m.criada_em) + ' (' + C.idade(m.criada_em) + ')');
    linha('Latitude', C.coord(m.lat));
    linha('Longitude', C.coord(m.lng));
    linha('Precisão', C.precisao(m.precisao));
    if (m.posicao_em) linha('Posição obtida às', C.hora(m.posicao_em));
    linha('Leitura', m.lida_em ? 'Lida por ' + (m.lida_por_nome || 'responsável') + ' às ' + C.hora(m.lida_em, false) : 'Lida agora por você');
    var fechar = UI.abrirModal(UI.el('div', { classe: 'visor-relato' }, [
      UI.el('h2', { id: 'modal-titulo', texto: m.categoria && m.categoria !== 'MENSAGEM' ? 'Relato: ' + cat.rotulo : 'Mensagem com localização' }),
      UI.el('p', { classe: 'relato-texto', texto: m.texto }),
      dl,
      UI.el('div', { classe: 'modal-acoes' }, [
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Ver no mapa', onclick: function () { fechar(); verRelatoNoMapa(m); } }),
        p ? UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Abrir conversa', onclick: function () { fechar(); abrirConversa(m.participante_id); } }) : null,
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
      ]),
    ]));
  }

  /* ---------- Conversa na ficha ------------------------------------ */
  function renderizarConversa(p) {
    var msgs = [];
    est.mensagens.forEach(function (m) { if (m.participante_id === p.id) msgs.push(m); });
    msgs.sort(function (a, b) { return C.paraMs(a.criada_em) - C.paraMs(b.criada_em); });
    var cod = estadoDe(p).cod;
    var assinatura = p.id + '|' + cod + '|' + msgs.map(function (m) {
      return m.id + ':' + (m.entregue_em || '') + (m.confirmada_em || '') + (m.resposta || '') + (jaLida(m) ? 'L' : '') + (m.lida_por_nome || '');
    }).join(',');
    if (assinatura === est.assinaturaConversa) return;
    var primeira = est.assinaturaConversa.split('|')[0] !== p.id;
    est.assinaturaConversa = assinatura;
    var ul = $('ficha-msgs');
    var noFim = ul.scrollHeight - ul.scrollTop - ul.clientHeight < 40;
    ul.innerHTML = '';
    if (!msgs.length) ul.appendChild(UI.el('li', { classe: 'muted vazio', texto: 'Nenhuma mensagem.' }));
    msgs.forEach(function (m) {
      if (m.direcao === 'entrada') {
        var cat = CATEGORIAS[m.categoria] || CATEGORIAS.MENSAGEM;
        var relato = m.categoria && m.categoria !== 'MENSAGEM';
        ul.appendChild(UI.el('li', { classe: 'entrada' + (relato ? ' relato' : '') + (jaLida(m) ? '' : ' nao-lida') }, [
          UI.el('div', { classe: 'msg-topo' }, [
            UI.el('span', { texto: relato ? 'RELATO · ' + cat.rotulo : nomeDoParticipante(m.participante_id, m.remetente_nome) }),
            UI.el('span', { classe: 'muted num', texto: C.hora(m.criada_em) }),
          ]),
          UI.el('div', { classe: 'msg-texto', texto: m.texto }),
          UI.el('div', { classe: 'msg-estado' }, [
            m.lat != null
              ? UI.el('button', { classe: 'btn btn-pequeno btn-link', type: 'button', texto: 'Ver no mapa (' + C.precisao(m.precisao) + ')', onclick: function () { verRelatoNoMapa(m); } })
              : UI.el('span', { classe: 'muted', texto: 'Sem localização' }),
            UI.el('span', { classe: 'muted', texto: m.lida_em ? '· Lida por ' + (m.lida_por_nome || 'responsável') + ' às ' + C.hora(m.lida_em, false) : '· Nova' }),
          ]),
        ]));
        return;
      }
      var t = C.TIPOS_MENSAGEM[m.tipo] || C.TIPOS_MENSAGEM.PERSONALIZADA;
      var st = estadoMensagem(m, p);
      ul.appendChild(UI.el('li', { classe: 'saida' }, [
        UI.el('div', { classe: 'msg-topo' }, [UI.el('span', { texto: t.rotulo }), UI.el('span', { classe: 'muted num', texto: C.hora(m.criada_em) })]),
        UI.el('div', { classe: 'msg-texto', texto: m.texto || t.padrao }),
        UI.el('div', { classe: 'msg-estado' }, [UI.el('span', { classe: 'selo ' + st.cls, texto: st.txt })]),
        UI.el('div', { classe: 'muted msg-autor', texto: 'Por ' + (m.remetente_nome || '—') }),
      ]));
    });
    if (primeira || noFim) ul.scrollTop = ul.scrollHeight;
  }

  function abrirConversa(pid) {
    if (!est.participantes.has(pid)) return;
    if (telaPequena()) { est.centralVoltar = !$('central').hidden; }
    selecionar(pid);
    setTimeout(function () {
      var bloco = $('ficha-conversa');
      if (bloco) bloco.scrollIntoView({ block: 'start', behavior: 'smooth' });
      var ta = $('resposta-texto');
      if (ta && !$('form-resposta').hidden) ta.focus({ preventScroll: true });
    }, 60);
  }

  // Resposta rápida (mensagem livre) sem sair da ficha.
  async function enviarResposta(ev) {
    if (ev) ev.preventDefault();
    var p = est.participantes.get(est.selecionado);
    if (!p) return;
    var ta = $('resposta-texto');
    var texto = ta.value.trim();
    if (!texto) {
      UI.aviso('Escreva a mensagem antes de enviar.', 'erro');
      ta.focus();
      return;
    }
    var btn = $('btn-responder');
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      var m = await C.rpc('enviar_mensagem', { p_participante: p.id, p_tipo: 'PERSONALIZADA', p_texto: texto.slice(0, 500) });
      ta.value = '';
      receberMensagem(m, true);
      marcarLidas(naoLidasDe(p.id).map(function (x) { return x.id; }));
      UI.aviso('Mensagem enviada a ' + p.dados.nome + '.', 'ok');
    } catch (e) {
      UI.aviso('Mensagem não enviada: ' + e.message, 'erro', 8000);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Enviar';
    }
  }

  /* ---------- Central de comunicação (mensagens, relatos e fotos) ----- */
  function abrirCentral(aba) {
    if (!est.op) return;
    if (aba) est.centralAba = aba;
    if (telaPequena() && !$('ficha').hidden) {
      est.centralVoltar = false;
      fecharFicha();
    }
    fecharMenu(false);
    $('central').hidden = false;
    $('btn-mensagens').setAttribute('aria-expanded', 'true');
    document.body.classList.add('central-aberta');
    mostrarAbaCentral(est.centralAba);
  }

  function fecharCentral() {
    var c = $('central');
    if (!c || c.hidden) return;
    c.hidden = true;
    $('btn-mensagens').setAttribute('aria-expanded', 'false');
    document.body.classList.remove('central-aberta');
    est.destaqueNovas = new Set();
  }

  function mostrarAbaCentral(aba) {
    est.centralAba = aba === 'fotos' ? 'fotos' : 'msgs';
    var msgs = est.centralAba === 'msgs';
    $('aba-msgs').classList.toggle('btn-ativo', msgs);
    $('aba-msgs').setAttribute('aria-selected', String(msgs));
    $('aba-fotos').classList.toggle('btn-ativo', !msgs);
    $('aba-fotos').setAttribute('aria-selected', String(!msgs));
    $('painel-msgs').hidden = !msgs;
    $('painel-fotos').hidden = msgs;
    renderizarCentral();
  }

  function agendarCentral() {
    if (est.rafCentral) return;
    est.rafCentral = requestAnimationFrame(function () {
      est.rafCentral = null;
      renderizarCentral();
    });
  }

  function renderizarCentral() {
    $('qtd-fotos').textContent = String(est.fotos.size);
    renderizarFilaFotos();
    if ($('central').hidden || !est.op) return;
    if (est.centralAba === 'msgs') renderizarFeed();
    else renderizarGaleria();
    marcarLidasVisiveis();
  }

  function renderizarFeed() {
    document.querySelectorAll('[data-filtro]').forEach(function (b) {
      b.classList.toggle('btn-ativo', b.getAttribute('data-filtro') === est.centralFiltro);
      b.setAttribute('aria-pressed', String(b.getAttribute('data-filtro') === est.centralFiltro));
    });
    var lista = [];
    est.mensagens.forEach(function (m) {
      if (m.direcao !== 'entrada') return;
      var relato = m.categoria && m.categoria !== 'MENSAGEM';
      if (est.centralFiltro === 'relatos' && !relato) return;
      if (est.centralFiltro === 'mensagens' && relato) return;
      lista.push(m);
    });
    lista.sort(function (a, b) { return C.paraMs(b.criada_em) - C.paraMs(a.criada_em); });
    var ul = $('feed-msgs');
    ul.innerHTML = '';
    $('feed-vazio').hidden = lista.length > 0;
    $('feed-vazio').textContent = est.centralFiltro === 'todas'
      ? 'Nenhuma mensagem dos participantes ainda. Quando alguém escrever ou relatar algo pelo link, aparece aqui.'
      : 'Nada neste filtro.';
    lista.slice(0, 300).forEach(function (m) {
      var p = est.participantes.get(m.participante_id);
      var cat = CATEGORIAS[m.categoria] || CATEGORIAS.MENSAGEM;
      var relato = m.categoria && m.categoria !== 'MENSAGEM';
      var simb = UI.el('span', { classe: 'feed-simbolo' });
      if (p) simb.innerHTML = htmlSimbolo(p);
      var topo = UI.el('div', { classe: 'feed-topo' }, [
        simb,
        UI.el('strong', { texto: nomeDoParticipante(m.participante_id, m.remetente_nome) }),
        relato ? UI.el('span', { classe: 'selo selo-relato', texto: cat.rotulo }) : null,
        UI.el('span', { classe: 'muted num feed-hora', texto: C.hora(m.criada_em, false) }),
      ]);
      var acoes = UI.el('div', { classe: 'feed-acoes' }, [
        m.lat != null ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Ver no mapa', onclick: function () { verRelatoNoMapa(m); } }) : null,
        p ? UI.el('button', { classe: 'btn btn-pequeno btn-escuro', type: 'button', texto: 'Responder', onclick: function () { abrirConversa(m.participante_id); } }) : null,
      ]);
      ul.appendChild(UI.el('li', { classe: 'feed-item' + (relato ? ' relato' : '') + (est.destaqueNovas.has(m.id) || !jaLida(m) ? ' nova' : ''), 'data-id': m.id }, [
        topo,
        UI.el('div', { classe: 'feed-texto', texto: m.texto }),
        UI.el('div', { classe: 'feed-meta', texto:
          (m.lat != null ? 'Com localização (' + C.precisao(m.precisao) + ')' : 'Sem localização') + ' · ' + C.idade(m.criada_em) +
          (m.lida_em ? ' · lida por ' + (m.lida_por_nome || 'responsável') : '') }),
        acoes,
      ]));
    });
  }

  /* ------------------------------------------------------------------ */
  /* Fotografias georreferenciadas                                        */
  /* ------------------------------------------------------------------ */
  async function carregarFotos(silencioso) {
    var opId = est.op.id;
    var lista;
    try {
      lista = await C.consultarTudo(function () {
        return C.cliente.from('fotos').select('*').eq('operacao_id', opId).order('registrada_em', { ascending: true });
      });
    } catch (e) {
      return;   // tenta de novo na próxima conferência (não derruba o restante)
    }
    if (!est.op || est.op.id !== opId) return;
    var ids = new Set();
    lista.forEach(function (f) { ids.add(f.id); adicionarFoto(f, silencioso); });
    Array.from(est.fotos.keys()).forEach(function (id) { if (!ids.has(id)) removerFoto(id); });
  }

  function iconeFoto() {
    return L.divIcon({ className: 'mk-foto-wrap', html: '<div class="mk-foto"><span class="ico-camera"></span></div>', iconSize: [32, 32], iconAnchor: [16, 16] });
  }

  function adicionarFoto(f, silencioso) {
    if (!est.op || f.operacao_id !== est.op.id) return;
    var antiga = est.fotos.get(f.id);
    est.fotos.set(f.id, f);
    if (!antiga) {
      if (f.lat != null && f.lng != null && est.camadaPontos) {
        var mk = L.marker([f.lat, f.lng], {
          icon: iconeFoto(),
          keyboard: true,
          title: 'Foto de ' + nomeDoParticipante(f.participante_id, f.autor_nome) + ' às ' + C.hora(f.capturada_em || f.registrada_em, false),
          alt: 'Foto',
          pane: 'pontos',    // participantes ficam por cima
          tipoPonto: 'foto',
        });
        mk.on('click', function () { abrirFoto(f.id); });
        est.fotosMarc.set(f.id, mk);
        if (est.prefsMapa.fotos) est.camadaPontos.addLayer(mk);
      }
      if (!silencioso && f.participante_id !== est.meuPart) {
        avisoClicavel('Nova foto de ' + nomeDoParticipante(f.participante_id, f.autor_nome) +
          (f.lat != null ? '' : ' (sem localização)') + (f.legenda ? ': ' + resumir(f.legenda, 80) : '') + '. Toque para ver.', function () { abrirFoto(f.id); });
        bipeMensagem();
      }
    }
    agendarCentral();
    if (est.selecionado === f.participante_id) atualizarFicha();
  }

  function removerFoto(id) {
    var mk = est.fotosMarc.get(id);
    if (mk && est.camadaPontos) est.camadaPontos.removeLayer(mk);
    est.fotosMarc.delete(id);
    est.fotos.delete(id);
    agendarCentral();
  }

  function fotosOrdenadas(pid) {
    return Array.from(est.fotos.values())
      .filter(function (f) { return !pid || f.participante_id === pid; })
      .sort(function (a, b) { return C.paraMs(b.registrada_em) - C.paraMs(a.registrada_em); });
  }

  function miniatura(f, lista) {
    var img = UI.el('img', { alt: f.legenda || 'Foto de ' + (f.autor_nome || ''), loading: 'lazy', 'data-caminho': f.caminho, decoding: 'async' });
    var u = window.Fotos.urlEmCache(f.caminho);
    if (u) img.src = u;
    img.addEventListener('error', function () { img.parentNode && img.parentNode.classList.add('falhou'); });
    return UI.el('button', {
      classe: 'miniatura' + (f.lat == null ? ' sem-local' : ''), type: 'button',
      title: 'Foto de ' + (f.autor_nome || '') + ' — ' + C.hora(f.capturada_em || f.registrada_em),
      onclick: function () { abrirFoto(f.id, lista); },
    }, [img, f.lat == null ? UI.el('span', { classe: 'tag-sem-local', texto: 'sem local' }) : null]);
  }

  async function carregarMiniaturas(raiz) {
    var imgs = Array.from(raiz.querySelectorAll('img[data-caminho]:not([src])'));
    if (!imgs.length) return;
    var caminhos = Array.from(new Set(imgs.map(function (i) { return i.getAttribute('data-caminho'); })));
    try {
      var urls = await window.Fotos.urlsAssinadas(caminhos);
      imgs.forEach(function (i) { var u = urls[i.getAttribute('data-caminho')]; if (u) i.src = u; });
    } catch (e) {
      imgs.forEach(function (i) { if (i.parentNode) i.parentNode.classList.add('falhou'); });
    }
  }

  function renderizarGaleria() {
    var fotos = fotosOrdenadas();
    var ids = fotos.map(function (f) { return f.id; });
    var ul = $('galeria');
    var assinatura = ids.join(',');
    $('galeria-vazia').hidden = fotos.length > 0;
    if (ul.getAttribute('data-assinatura') === assinatura) { carregarMiniaturas(ul); return; }
    ul.setAttribute('data-assinatura', assinatura);
    ul.innerHTML = '';
    fotos.forEach(function (f) {
      ul.appendChild(UI.el('li', { classe: 'galeria-item' }, [
        miniatura(f, ids),
        UI.el('div', { classe: 'galeria-info' }, [
          UI.el('strong', { texto: nomeDoParticipante(f.participante_id, f.autor_nome) }),
          UI.el('span', { classe: 'muted', texto: C.hora(f.capturada_em || f.registrada_em, false) + (f.lat == null ? ' · sem localização' : '') }),
          f.legenda ? UI.el('span', { classe: 'galeria-legenda', texto: f.legenda }) : null,
        ]),
      ]));
    });
    carregarMiniaturas(ul);
  }

  function renderizarFotosFicha(p) {
    var fotos = fotosOrdenadas(p.id);
    var bloco = $('ficha-fotos-bloco');
    bloco.hidden = !fotos.length;
    $('ficha-qtd-fotos').textContent = String(fotos.length);
    var ul = $('ficha-fotos');
    var ids = fotos.map(function (f) { return f.id; });
    var assinatura = p.id + ':' + ids.join(',');
    if (ul.getAttribute('data-assinatura') !== assinatura) {
      ul.setAttribute('data-assinatura', assinatura);
      ul.innerHTML = '';
      fotos.forEach(function (f) { ul.appendChild(UI.el('li', null, [miniatura(f, ids)])); });
    }
    if (fotos.length) carregarMiniaturas(ul);
  }

  // Janela da foto: imagem, autor, horários (captura × registro) e coordenadas.
  function abrirFoto(id, lista) {
    var f = est.fotos.get(id);
    if (!f) { UI.aviso('Esta foto não está mais disponível.', 'erro'); return; }
    lista = (lista && lista.length ? lista : fotosOrdenadas().map(function (x) { return x.id; }))
      .filter(function (x) { return est.fotos.has(x); });
    var pos = lista.indexOf(id);
    var p = est.participantes.get(f.participante_id);
    var autor = nomeDoParticipante(f.participante_id, f.autor_nome);
    var tipoAutor = TIPOS[f.autor_tipo === 'militar' ? 'militar' : f.autor_tipo === 'responsavel' ? 'responsavel' : 'civil'];

    var caixa = UI.el('div', { classe: 'visor-img carregando' }, [UI.el('span', { classe: 'visor-status', texto: 'Carregando a foto…' })]);
    var urlAtual = null;
    async function carregar() {
      caixa.className = 'visor-img carregando';
      caixa.innerHTML = '';
      caixa.appendChild(UI.el('span', { classe: 'visor-status', texto: 'Carregando a foto…' }));
      try {
        urlAtual = window.Fotos.urlEmCache(f.caminho) || (await window.Fotos.urlsAssinadas([f.caminho]))[f.caminho];
        if (!urlAtual) throw new Error('arquivo não encontrado');
      } catch (e) {
        mostrarFalha(e.rede ? 'sem conexão' : (e.message || 'erro'));
        return;
      }
      var img = UI.el('img', { alt: f.legenda || 'Foto registrada por ' + autor, id: 'visor-imagem' });
      img.addEventListener('load', function () { caixa.className = 'visor-img'; var st = caixa.querySelector('.visor-status'); if (st) st.remove(); });
      img.addEventListener('error', function () { mostrarFalha('conexão lenta ou link expirado'); });
      img.addEventListener('click', function () { abrirLightbox(urlAtual, img.alt); });
      img.src = urlAtual;
      caixa.appendChild(img);
    }
    function mostrarFalha(motivo) {
      caixa.className = 'visor-img falhou';
      caixa.innerHTML = '';
      caixa.appendChild(UI.el('span', { classe: 'visor-status', texto: 'Não foi possível carregar a imagem (' + motivo + ').' }));
      caixa.appendChild(UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Tentar de novo', onclick: carregar }));
    }

    var dl = UI.el('dl', { classe: 'dados' });
    function linha(rot, valor) { dl.appendChild(UI.el('dt', { texto: rot })); dl.appendChild(UI.el('dd', null, [valor])); }
    var selo = UI.el('span', { classe: 'selo ' + tipoAutor.selo, texto: tipoAutor.rotulo });
    linha('Registrada por', UI.el('span', null, [autor + ' ', selo]));
    linha('Capturada em', f.capturada_em ? C.hora(f.capturada_em) : 'desconhecido');
    var atraso = f.capturada_em ? C.paraMs(f.registrada_em) - C.paraMs(f.capturada_em) : 0;
    linha('Recebida às', C.hora(f.registrada_em) + (atraso > 120000 ? ' (enviada ' + C.idade(f.capturada_em, C.paraMs(f.registrada_em)).replace('há ', '') + ' depois da captura)' : ''));
    if (f.lat != null) {
      linha('Latitude', UI.el('span', { classe: 'mono', texto: C.coord(f.lat) }));
      linha('Longitude', UI.el('span', { classe: 'mono', texto: C.coord(f.lng) }));
      linha('Precisão', C.precisao(f.precisao));
      linha('Origem do local', ORIGEM_FOTO[f.origem_posicao] || f.origem_posicao);
    } else {
      linha('Localização', 'Sem localização (o aparelho não informou) — a foto não aparece no mapa.');
    }
    if (f.legenda) linha('Descrição', f.legenda);
    if (f.largura) linha('Imagem', f.largura + ' × ' + f.altura + ' px' + (f.bytes ? ' · ' + Math.round(f.bytes / 1024) + ' KB' : ''));

    var nav = lista.length > 1 ? UI.el('div', { classe: 'visor-nav' }, [
      UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: '‹ Anterior', disabled: pos <= 0 ? true : null, onclick: function () { abrirFoto(lista[pos - 1], lista); } }),
      UI.el('span', { classe: 'muted num', texto: (pos + 1) + ' de ' + lista.length }),
      UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Próxima ›', disabled: pos >= lista.length - 1 ? true : null, onclick: function () { abrirFoto(lista[pos + 1], lista); } }),
    ]) : null;

    var fechar = UI.abrirModal(UI.el('div', { classe: 'visor-foto' }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Foto de ' + autor }),
      caixa,
      nav,
      dl,
      UI.el('div', { classe: 'modal-acoes' }, [
        UI.el('button', { classe: 'btn', type: 'button', id: 'visor-ampliar', texto: 'Ampliar', onclick: function () { if (urlAtual) abrirLightbox(urlAtual, 'Foto de ' + autor); } }),
        f.lat != null ? UI.el('button', { classe: 'btn', type: 'button', texto: 'Ver no mapa', onclick: function () {
          fechar();
          if (!est.prefsMapa.fotos) definirPrefMapa('fotos', true);
          destacarNoMapa(est.camadaPontos, est.fotosMarc.get(f.id), f.lat, f.lng);
        } }) : null,
        p ? UI.el('button', { classe: 'btn', type: 'button', texto: 'Ficha de ' + p.dados.nome, onclick: function () { fechar(); selecionar(p.id); } }) : null,
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
      ]),
    ]), { aoFechar: fecharLightbox });
    carregar();
  }

  // Imagem em tela cheia. Toque na imagem: tamanho real (com rolagem); fora dela: fecha.
  function abrirLightbox(url, alt) {
    fecharLightbox();
    var img = UI.el('img', { src: url, alt: alt || 'Foto' });
    var btn = UI.el('button', { classe: 'btn lightbox-fechar', type: 'button', texto: 'Fechar', 'aria-label': 'Fechar a imagem ampliada' });
    var caixa = UI.el('div', { classe: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': alt || 'Foto ampliada' }, [img, btn]);
    img.addEventListener('click', function (ev) { ev.stopPropagation(); caixa.classList.toggle('tamanho-real'); });
    caixa.addEventListener('click', fecharLightbox);
    document.addEventListener('keydown', teclaLightbox, true);
    document.body.appendChild(caixa);
    btn.focus();
  }

  function teclaLightbox(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      fecharLightbox();
    }
  }

  function fecharLightbox() {
    var c = document.querySelector('.lightbox');
    document.removeEventListener('keydown', teclaLightbox, true);
    if (c && c.parentNode) {
      c.parentNode.removeChild(c);
      var b = $('visor-ampliar');
      if (b) b.focus();
    }
  }

  /* ---------- Fotos tiradas pelo próprio responsável ----------------- */
  function obterMinhaPosicao() {
    var u = est.compartilhando && est.ultimoAceitoMeu && est.ultimoAceitoMeu.prec != null && est.ultimoAceitoMeu.prec <= 100 ? est.ultimoAceitoMeu : null;
    if (u && Date.now() - u.t < 15000) {
      return Promise.resolve({ ok: true, lat: u.lat, lng: u.lng, prec: u.prec, t: u.t });
    }
    if (!('geolocation' in navigator) || !window.isSecureContext) return Promise.resolve({ ok: false, motivo: 'navegador sem acesso à localização' });
    return new Promise(function (resolve) {
      navigator.geolocation.getCurrentPosition(function (p) {
        var agora = Date.now();
        resolve({ ok: true, lat: p.coords.latitude, lng: p.coords.longitude, prec: p.coords.accuracy,
          t: p.timestamp && Math.abs(p.timestamp - agora) < 864e5 ? p.timestamp : agora });
      }, function (e) {
        // parado, o GPS pode não entregar leitura nova: usa a última de até 2 min (com o horário real dela)
        if (e.code !== 1 && u && Date.now() - u.t < 120000) {
          resolve({ ok: true, lat: u.lat, lng: u.lng, prec: u.prec, t: u.t });
          return;
        }
        resolve({ ok: false, motivo: e.code === 1 ? 'permissão de localização negada' : e.code === 2 ? 'GPS desligado ou indisponível' : 'sem sinal de GPS' });
      }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 });
    });
  }

  function abrirRegistrarFoto() {
    if (!est.op || est.op.status !== 'ativa') return;
    prepararAudio();
    var inCam = UI.el('input', { classe: 'sr-only', type: 'file', accept: 'image/*', capture: 'environment', id: 'painel-foto-camera' });
    var inArq = UI.el('input', { classe: 'sr-only', type: 'file', accept: 'image/*', id: 'painel-foto-arquivo' });
    inCam.addEventListener('change', function (ev) { aoEscolherFotoPainel(ev, true); });
    inArq.addEventListener('change', function (ev) { aoEscolherFotoPainel(ev, false); });
    var fechar = UI.abrirModal(UI.el('div', null, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Registrar foto' }),
      UI.el('p', { classe: 'ajuda', texto: 'A foto fica vinculada a você e a esta operação, com o local do GPS no momento do registro (ou o gravado na própria foto). Sem localização, ela é salva mas não aparece no mapa.' }),
      UI.el('div', { classe: 'fotos-botoes' }, [
        UI.el('label', { classe: 'btn btn-escuro btn-foto' }, [UI.el('span', { classe: 'ico-camera', 'aria-hidden': 'true' }), ' TIRAR FOTO', inCam]),
        UI.el('label', { classe: 'btn btn-foto' }, ['Escolher arquivo', inArq]),
      ]),
      UI.el('div', { classe: 'modal-acoes' }, [UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } })]),
    ]));
  }

  async function aoEscolherFotoPainel(ev, daCamera) {
    var arquivo = ev.target.files && ev.target.files[0];
    UI.fecharModal();
    if (!arquivo || !est.op) return;
    var opId = est.op.id;
    var f = await window.Fotos.lerArquivo(arquivo, daCamera, obterMinhaPosicao);
    if (!f || !est.op || est.op.id !== opId) return;
    window.Fotos.abrirPrevia(f, {
      obterPosicao: obterMinhaPosicao,
      aoSalvar: async function (d) {
        if (!est.op || est.op.id !== opId) throw new Error('A operação foi fechada antes de salvar a foto.');
        est.fotosFila.push(Object.assign(d, { id: C.uuid(), operacao_id: opId, participante_id: null, estado: 'fila' }));
        renderizarFilaFotos();
        enviarFilaFotos();
      },
    });
  }

  async function enviarFilaFotos() {
    if (est.enviandoFotos || !est.fotosFila.length || !est.op) return;
    est.enviandoFotos = true;
    try {
      while (est.fotosFila.length && est.op) {
        var it = est.fotosFila[0];
        if (it.operacao_id !== est.op.id) { est.fotosFila.shift(); continue; }
        if (!est.meuPart) await entrarComoResponsavel();
        if (!est.meuPart) break;   // sem conexão: tenta no próximo ciclo
        it.participante_id = est.meuPart;
        it.estado = 'enviando';
        renderizarFilaFotos();
        try {
          var foto = await window.Fotos.enviar(it);
          est.fotosFila.shift();
          window.Fotos.guardarUrlLocal(foto.caminho, URL.createObjectURL(it.blob));
          adicionarFoto(foto, true);
          UI.aviso(foto.lat != null ? 'Foto registrada no mapa.' : 'Foto registrada sem localização (não aparece no mapa).', 'ok');
        } catch (e) {
          if (e.rede) {
            it.estado = 'fila';
            UI.aviso('Sem conexão: a foto ficou na fila e será enviada automaticamente. Não feche o painel.', 'erro', 8000);
            break;
          }
          if (e.codigo === 'participante_invalido') est.meuPart = null;
          est.fotosFila.shift();
          UI.aviso('A foto não foi salva: ' + e.message, 'erro', 9000);
        }
      }
    } finally {
      est.enviandoFotos = false;
      renderizarFilaFotos();
    }
  }

  function renderizarFilaFotos() {
    var caixa = $('minhas-fotos-fila');
    if (!caixa) return;
    var n = est.fotosFila.length;
    caixa.hidden = !n;
    if (!n) return;
    caixa.innerHTML = '';
    caixa.appendChild(UI.el('span', { texto: n + ' foto(s) sua(s) ' + (est.enviandoFotos ? 'sendo enviada(s)…' : 'aguardando conexão para envio.') + ' ' }));
    if (!est.enviandoFotos) caixa.appendChild(UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Tentar agora', onclick: enviarFilaFotos }));
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
    $('ferramentas').classList.toggle('compartilhando', est.compartilhando);
    var txt = { ok: 'GPS ativo', fraco: 'GPS com sinal fraco', sem_sinal: 'procurando sinal de GPS', negado: 'localização negada', indisponivel: 'GPS indisponível', aguardando: 'aguardando GPS' }[est.gpsMeu] || '';
    b.title = est.compartilhando
      ? 'Sua posição está sendo compartilhada com os outros responsáveis (' + txt + '). Toque para parar.'
      : 'Compartilhar sua posição com os outros responsáveis desta operação';
    $('minha-pos-estado').textContent = est.compartilhando ? 'ligada · ' + txt : 'desligada';
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
      est.ultimoAceitoMeu = { lat: c.latitude, lng: c.longitude, t: t, prec: prec };
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
      if (m.participante_id === est.meuPart && m.direcao !== 'entrada' && !m.entregue_em && !est.entregando.has(m.id)) {
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
      if (est.meuPart && m.participante_id === est.meuPart && m.direcao !== 'entrada' && !m.confirmada_em && !est.confirmadasLocal.has(m.id)) lista.push(m);
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
