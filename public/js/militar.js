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
    precisaoTrilhaM: 150,        // pontos com precisão pior são só "posição aproximada" (fora da linha da trilha)
    pollingOkMs: 20000,          // conferência periódica com tempo real funcionando
    pollingFalhaMs: 8000,        // conferência periódica quando o tempo real cai
  };

  var PALETA = {
    militar: ['#1d4ed8', '#0e7490', '#4338ca', '#0369a1', '#1e40af', '#155e75', '#3730a3', '#2563eb'],
    // Trilhas civis em ROXO (não se confundem com a vegetação); um tom diferente para cada civil.
    civil: ['#A020F0', '#D946EF', '#7C3AED', '#C026D3', '#9D4EDD', '#E040FB', '#6D28D9', '#F0ABFC'],
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

  // "Minha posição": o filtro das leituras está em gps.js (o mesmo da página do participante).
  var CFG_GPS = { sinalVidaMs: 15000, envioRapidoMs: 1000, envioPeMs: 1500, reiniciarMs: 90000 };

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
    ultimoAceitoMeu: null,      // última leitura válida do meu GPS { lat, lng, prec, t }
    filtroMeu: new window.GPS.Filtro(),
    minhaPosEstado: 'desligada', // desligada | iniciando | ativa | sem_sinal | bloqueada | indisponivel
    iniciandoMinhaPos: false,
    meuWatchEm: 0,
    permissaoMinha: 'desconhecido',
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
    prefsMapa: Object.assign({ camada: 'osm', fotos: true, relatos: true, nomes: true, legenda: true, setores: true, pontos: true }, C.local.ler(CHAVE_PREFS_MAPA, {}) || {}),
    lateralOculta: Boolean(C.local.ler(CHAVE_LATERAL, false)),
    centralAba: 'msgs',
    // setores, pontos de interesse e destinos
    setores: new Map(),         // id → { d: dados, camada }
    pontosInt: new Map(),       // id → { d: dados, marcador }
    destinos: new Map(),        // participante_id → destino ativo
    rotasFicha: new Map(),      // destino:modo → { rota, origem, em, calculando, erro }
    camadaRotaFicha: null,
    rotaFichaChave: null,
    camadaSetores: null,
    camadaPontosInt: null,
    linhaDestino: null,
    marcaDestino: null,
    desenho: null,              // modo de desenho em andamento
    timerAreas: null,
    visao3d: null,
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
      if (item && !item.disabled && !item.classList.contains('menu-select')) fecharMenu(false);
    }, true);
    document.addEventListener('pointerdown', function (ev) {
      if (!$('menu-ferramentas').hidden && !$('ferramentas').contains(ev.target)) fecharMenu(false);
    });
    $('btn-registrar-foto').addEventListener('click', function () { abrirRegistrarFoto(); });
    // Áreas e pontos
    $('menu-setor-raio').addEventListener('click', function () { iniciarDesenho('raio'); });
    $('menu-setor-poligono').addEventListener('click', function () { iniciarDesenho('poligono'); });
    $('menu-ponto').addEventListener('click', function () { iniciarDesenho('ponto'); });
    $('menu-destino').addEventListener('click', function () { escolherDestino([]); });
    $('menu-areas').addEventListener('click', abrirAreas);
    $('areas-fechar').addEventListener('click', fecharAreas);
    $('areas-novo-raio').addEventListener('click', function () { iniciarDesenho('raio'); });
    $('areas-novo-poligono').addEventListener('click', function () { iniciarDesenho('poligono'); });
    $('areas-novo-ponto').addEventListener('click', function () { iniciarDesenho('ponto'); });
    $('opt-setores').addEventListener('click', function () { definirPrefMapa('setores', !est.prefsMapa.setores); });
    $('opt-pontos').addEventListener('click', function () { definirPrefMapa('pontos', !est.prefsMapa.pontos); });
    $('menu-3d').addEventListener('click', abrirRelevo3D);
    $('visao-3d-fechar').addEventListener('click', fecharRelevo3D);
    $('visao-3d-atualizar').addEventListener('click', function () { adicionarDados3D(); UI.aviso('Posições atualizadas no 3D.', 'ok'); });
    $('ficha-enviar-destino').addEventListener('click', function () { if (est.selecionado) escolherDestino([est.selecionado]); });
    $('menu-central').addEventListener('click', function () { abrirCentral('msgs'); });
    $('btn-excluir-op').addEventListener('click', function () { excluirOperacao(est.op); });
    document.querySelectorAll('[data-camada]').forEach(function (b) {
      b.addEventListener('click', function () { trocarCamada(b.getAttribute('data-camada')); });
    });
    $('opt-fotos').addEventListener('click', function () { definirPrefMapa('fotos', !est.prefsMapa.fotos); });
    $('opt-relatos').addEventListener('click', function () { definirPrefMapa('relatos', !est.prefsMapa.relatos); });
    $('opt-nomes').addEventListener('click', function () { definirPrefMapa('nomes', !est.prefsMapa.nomes); });
    $('opt-coord').addEventListener('change', function () { definirPrefMapa('coord', this.value); if (est.selecionado) atualizarFicha(); });
    $('ficha-estatisticas').addEventListener('click', function () { if (window.Ferramentas && est.selecionado) window.Ferramentas.abrirEstatisticas(est.selecionado); });
    $('ficha-exportar').addEventListener('click', function () { if (window.Ferramentas && est.selecionado) window.Ferramentas.abrirExportar(est.selecionado); });
    $('opt-trilhas').addEventListener('click', function () { definirTodasTrilhas(!todasTrilhasVisiveis()); });
    $('menu-enquadrar').addEventListener('click', enquadrarTodos);
    $('menu-diag-gps').addEventListener('click', function () { fecharMenu(false); abrirDiagnosticoGps(); });
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
      if (document.visibilityState === 'visible' && est.op && est.op.status === 'ativa') verificarPermissaoMinha();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' || document.querySelector('.modal-fundo') || document.querySelector('.lightbox')) return;
      if (est.desenho) cancelarDesenho();
      else if (!$('visao-3d').hidden) fecharRelevo3D();
      else if (!$('menu-ferramentas').hidden) fecharMenu(true);
      else if (!$('painel-areas').hidden) fecharAreas();
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
        vigiarMeuGps();
        enviarMinhaFila();
        enviarFilaFotos();
      }, CFG_GPS.sinalVidaMs);
      // A localização do responsável liga sozinha ao abrir (ou criar) a operação,
      // respeitando a permissão do navegador e a escolha de desligar nesta operação.
      iniciarMinhaPosicaoAuto();
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
    est.filtroMeu.reiniciar();
    est.minhaPosEstado = 'desligada';
    est.enviouMinhaAlguma = false;
    est.entregando = new Set();
    est.alertaAtual = null;
    if ($('alerta-cmd')) $('alerta-cmd').hidden = true;
    fecharMenu(false);
    fecharCentral();
    fecharLightbox();
    cancelarDesenho();
    fecharAreas();
    fecharRelevo3D();
    clearTimeout(est.timerAreas);
    est.setores = new Map();
    est.pontosInt = new Map();
    est.destinos = new Map();
    est.camadaSetores = est.camadaPontosInt = est.linhaDestino = est.marcaDestino = null;
    est.rotasFicha = new Map();
    est.camadaRotaFicha = null;
    est.rotaFichaChave = null;
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
    $('lista-removidos').innerHTML = '';
    $('feed-msgs').innerHTML = '';
    $('galeria').innerHTML = '';
    atualizarContadorMsgs();
  }

  function limparDadosDoMapa() {
    est.participantes.forEach(function (p) {
      if (p.marcador) p.marcador.remove();
      if (p.trilha) p.trilha.remove();
      if (p.halo) p.halo.remove();
      if (p.lacunas) p.lacunas.remove();
    });
    limparAreasDoMapa();
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
    $('lista-removidos').innerHTML = '';
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
    $('menu-zona-perigo').hidden = $('btn-encerrar').hidden && $('btn-excluir-op').hidden;
    $('menu-destino').hidden = op.status !== 'ativa';
    ['menu-setor-raio', 'menu-setor-poligono', 'menu-ponto'].forEach(function (id) { $(id).hidden = Boolean(op.dados_apagados_em); });
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
      maxNativeZoom: 17,   // o servidor vai até 17; acima disso os ladrilhos são ampliados (zoom continua funcionando)
      maxZoom: 19,
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
          '<div><span class="simbolo simbolo-civil"><span>C</span></span> Civil (verde) — trilha <b style="color:#d8a6ff">roxa</b> tracejada</div>' +
          '<div><span class="simbolo simbolo-responsavel"><span>R</span></span> Responsável (ciano) — trilha pontilhada</div>' +
          '<div><span class="antigo"><span class="simbolo simbolo-civil" style="background:#6b7280">C</span></span> Última posição antiga (+2 min)</div>' +
          '<div><span class="mk-foto mk-foto-legenda"><span class="ico-camera"></span></span> Foto registrada no local</div>' +
          '<div><span class="mk-relato mk-relato-legenda"><span>P</span></span> Relato do participante</div>' +
          '<div><span class="mk-poi mk-poi-legenda poi-ENCONTRO"><span>E</span></span> Ponto de interesse (letra = categoria)</div>' +
          '<div><span class="setor-legenda"></span> Setor de busca (tracejado = pendente)</div>' +
          '<div><span class="lg-linha-rota"></span> Rota até o destino (por caminhos)</div>' +
          '<div><span class="lg-lacuna"></span> Trecho sem posições registradas</div>' +
          '</details>';
        L.DomEvent.disableClickPropagation(div);
        return div;
      },
    });
    est.legenda = new Legenda();
    est.legenda.addTo(mapa);   // sempre no mapa; abre e fecha tocando em "Legenda"

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

    // Setores ficam ABAIXO das trilhas e dos marcadores (não escondem nada).
    mapa.createPane('setores').style.zIndex = 350;
    est.camadaSetores = L.layerGroup();
    est.camadaPontosInt = L.layerGroup();
    if (est.prefsMapa.setores) est.camadaSetores.addTo(mapa);
    if (est.prefsMapa.pontos) est.camadaPontosInt.addTo(mapa);
    mapa.on('click', aoClicarNoMapa);
    // toque longo / botão direito: coordenadas e altitude do ponto (como no AlpineQuest)
    mapa.on('contextmenu', function (e) { if (!est.desenho && window.Ferramentas) window.Ferramentas.infoPonto(e.latlng); });

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
      if (chave === 'setores' && est.camadaSetores) { if (valor) est.camadaSetores.addTo(est.mapa); else est.camadaSetores.remove(); }
      if (chave === 'pontos' && est.camadaPontosInt) { if (valor) est.camadaPontosInt.addTo(est.mapa); else est.camadaPontosInt.remove(); }
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
    $('opt-setores').setAttribute('aria-pressed', String(Boolean(est.prefsMapa.setores)));
    $('opt-pontos').setAttribute('aria-pressed', String(Boolean(est.prefsMapa.pontos)));
    $('opt-nomes').setAttribute('aria-pressed', String(Boolean(est.prefsMapa.nomes)));
    $('opt-coord').value = est.prefsMapa.coord || 'dec';
    $('opt-trilhas').setAttribute('aria-pressed', String(todasTrilhasVisiveis()));
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
        return C.cliente.from('posicoes').select('id,participante_id,lat,lng,precisao,registrado_em,recebido_em')
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
      await carregarAreas();
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
        return C.cliente.from('posicoes').select('id,participante_id,lat,lng,precisao,registrado_em,recebido_em')
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
      await carregarAreas();
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'setores', filter: filtro }, agendarAreas)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pontos_interesse', filter: filtro }, agendarAreas)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'destinos', filter: filtro }, agendarAreas)
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
    $('lista-removidos').innerHTML = '';
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

  // Reincluído e o celular ainda não voltou a enviar a localização.
  function aguardandoRetorno(p) {
    var d = p.dados;
    if (!d.reincluido_em || d.removido || d.rastreando) return false;
    var r = C.paraMs(d.reincluido_em);
    return !d.ultima_posicao_em || C.paraMs(d.ultima_posicao_em) < r;
  }

  // Estado de conexão do participante (nunca trata posição antiga como atual).
  function estadoDe(p) {
    var d = p.dados;
    var agora = C.agora();
    var por = d.removido_por_nome ? ' por ' + d.removido_por_nome : '';
    if (d.liberado_em) return { cod: 'removido', rot: 'Saída liberada às ' + C.hora(d.liberado_em, false) + por };
    if (d.removido) return { cod: 'removido', rot: 'Removido' + (d.removido_em ? ' às ' + C.hora(d.removido_em, false) : '') + por };
    if (est.op && est.op.status !== 'ativa') return { cod: 'encerrado', rot: 'Operação encerrada' };
    if (aguardandoRetorno(p)) return { cod: 'aguardando', rot: 'Reincluído às ' + C.hora(d.reincluido_em, false) + ' · aguardando o celular voltar' };
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
      p.marcador.on('click', function () {
        if (est.desenho) { aoClicarNoMapa({ latlng: p.marcador.getLatLng() }); return; }
        selecionar(p.id);
      });
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
    // t = capturado pelo GPS; rec = chegou ao servidor; exib = mostrado neste painel
    var pt = { id: row.id, t: C.paraMs(row.registrado_em), lat: row.lat, lng: row.lng, prec: row.precisao,
      rec: C.paraMs(row.recebido_em), exib: C.agora() };
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
    // alarmes de proximidade (saiu do setor / entrou em área de risco)
    if (window.Ferramentas && pt.t > C.agora() - 180000 && (pt.prec == null || pt.prec <= LIM.precisaoTrilhaM)) window.Ferramentas.aoNovoPonto(p, pt);
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

  // Trilha em ordem cronológica (p.pontos já é mantido ordenado por horário).
  // Não liga pontos imprecisos, separados por longa pausa ou por salto
  // impossível, nem desenha o vaivém de quem está parado (gps.js). Os pontos
  // guardados não mudam: o histórico completo continua na ficha.
  function trilhaDe(p) {
    return window.GPS.trilha(p.pontos, { precisaoTrilhaM: LIM.precisaoTrilhaM });
  }

  function pesoTrilha(p) { return est.selecionado === p.id ? 6 : 4; }

  function desenharTrilha(p) {
    if (!est.mapa) return;
    var tr = p.trilhaVisivel ? trilhaDe(p) : { segmentos: [], lacunas: [] };
    var segs = tr.segmentos;
    desenharLacunas(p, tr.lacunas);
    if (!segs.length) {   // oculta ou sem pontos: nada a desenhar
      if (p.trilha) p.trilha.remove();
      if (p.halo) p.halo.remove();
      return;
    }
    var tipo = tipoDe(p.dados);
    // Civis: contorno claro por baixo para a linha roxa aparecer sobre mata, satélite e topográfico.
    if (tipo === 'civil') {
      if (!p.halo) {
        p.halo = L.polyline(segs, { color: '#ffffff', weight: pesoTrilha(p) + 4, opacity: 0.55, interactive: false, lineJoin: 'round', className: 'trilha-halo' });
      } else {
        p.halo.setLatLngs(segs);
      }
      if (!est.mapa.hasLayer(p.halo)) p.halo.addTo(est.mapa);
    }
    if (!p.trilha) {
      p.trilha = L.polyline(segs, {
        color: p.cor,
        weight: pesoTrilha(p),
        opacity: tipo === 'civil' ? 0.95 : 0.85,
        dashArray: TIPOS[tipo].trilha,
        interactive: false,
        lineJoin: 'round',
        className: 'trilha trilha-' + tipo,
      });
    } else {
      p.trilha.setLatLngs(segs);
    }
    if (!est.mapa.hasLayer(p.trilha)) p.trilha.addTo(est.mapa);
  }

  // Lacuna: período sem posições registradas em que a pessoa se deslocou. É
  // desenhada como uma linha cinza fina pontilhada (não é percurso registrado).
  function desenharLacunas(p, lacunas) {
    if (!lacunas.length) { if (p.lacunas) { p.lacunas.remove(); p.lacunas = null; } return; }
    if (!p.lacunas) p.lacunas = L.layerGroup().addTo(est.mapa);
    var assinatura = lacunas.map(function (l) { return l.t0 + '-' + l.t1; }).join('|');
    if (p.lacunas._assinatura === assinatura) return;
    p.lacunas._assinatura = assinatura;
    p.lacunas.clearLayers();
    lacunas.forEach(function (l) {
      var min = Math.max(1, Math.round((l.t1 - l.t0) / 60000));
      L.polyline([l.de, l.ate], { color: '#9ca3af', weight: 2, opacity: 0.8, dashArray: '2 7', interactive: true, className: 'trilha-lacuna' })
        .bindTooltip('Sem posições registradas de ' + C.hora(l.t0, false) + ' a ' + C.hora(l.t1, false) + ' (' + min + ' min)' +
          (l.impossivel ? ' — salto incoerente' : '') + '. O percurso real nesse trecho é desconhecido.', { sticky: true })
        .addTo(p.lacunas);
    });
  }

  // A trilha de quem está com a ficha aberta fica mais grossa (fácil de seguir entre várias).
  function estilizarTrilhas() {
    est.participantes.forEach(function (p) {
      if (p.trilha) p.trilha.setStyle({ weight: pesoTrilha(p) });
      if (p.halo) p.halo.setStyle({ weight: pesoTrilha(p) + 4 });
      if (p.trilha && est.selecionado === p.id) p.trilha.bringToFront();
    });
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
    var bRei = UI.el('button', { classe: 'btn btn-pequeno btn-ok btn-reincluir', type: 'button', hidden: true, 'aria-label': 'Reincluir ' + p.dados.nome + ' na operação', texto: 'Reincluir' });
    bLoc.addEventListener('click', function (ev) { ev.stopPropagation(); centralizar(p.id); });
    bTri.addEventListener('click', function (ev) { ev.stopPropagation(); alternarTrilha(p.id); });
    bRei.addEventListener('click', function (ev) { ev.stopPropagation(); reincluirParticipante(p.id); });
    acoes.appendChild(bRei);
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
    p.liPartes = { simbolo: simbolo, nome: nome, estado: estado, bTri: bTri, bLoc: bLoc, bRei: bRei };
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
      (aguardandoRetorno(p) ? '<span class="selo selo-responsavel">Reincluído</span>' : '') +
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
    var podeReincluir = podeReincluirP(p);
    if (partes.bRei.hidden === podeReincluir) partes.bRei.hidden = !podeReincluir;
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

  // Duas listas: quem está na operação e quem está fora (removido ou com saída
  // liberada), que pode ser reincluído. O cadastro e a trilha dos dois continuam.
  function renderizarLista() {
    est.listaSuja = false;
    var lista = Array.from(est.participantes.values()).sort(ordemLista);
    var ativos = lista.filter(function (p) { return !p.dados.removido; });
    var fora = lista.filter(function (p) { return p.dados.removido; });
    [[$('lista-part'), ativos], [$('lista-removidos'), fora]].forEach(function (par) {
      var ul = par[0];
      par[1].forEach(function (p, i) {
        atualizarItemLista(p);
        if (ul.children[i] !== p.li) ul.insertBefore(p.li, ul.children[i] || null);
      });
      while (ul.children.length > par[1].length) ul.removeChild(ul.lastChild);
    });
    $('lista-vazia').hidden = lista.length > 0;
    $('qtd-part').textContent = String(ativos.length);
    $('qtd-removidos').textContent = String(fora.length);
    $('grupo-removidos').hidden = fora.length === 0;

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
    estilizarTrilhas();
    desenharLinhaDestino();
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
    estilizarTrilhas();
    desenharLinhaDestino();
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
    var destino = est.destinos.get(p.id);
    var caixaDest = $('ficha-destino');
    caixaDest.hidden = !destino;
    if (destino) {
      caixaDest.innerHTML = '';
      caixaDest.appendChild(document.createTextNode('🧭 Navegando até: '));
      caixaDest.appendChild(UI.el('strong', { texto: destino.nome }));
      caixaDest.appendChild(document.createTextNode(' · enviado às ' + C.hora(destino.criado_em, false) + ' por ' + destino.enviado_por_nome + ' · '));
      caixaDest.appendChild(destino.recebido_em
        ? UI.el('span', { classe: 'destino-recebido', texto: '✓ recebido no celular às ' + C.hora(destino.recebido_em, false) + ' ' })
        : UI.el('span', { classe: 'destino-aguardando', texto: 'aguardando o celular receber ' }));
      caixaDest.appendChild(UI.el('button', { classe: 'btn btn-pequeno btn-link', type: 'button', texto: 'Encerrar', onclick: function () { encerrarDestinoPainel(destino); } }));
      caixaDest.appendChild(UI.el('span', { classe: 'ficha-rota', id: 'ficha-rota', hidden: true }));
    }
    $('ficha-enviar-destino').hidden = tipoDe(d) === 'responsavel' || d.removido || est.op.status !== 'ativa';
    desenharLinhaDestino();
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
      ['Coordenadas', pos ? '<span class="mono">' + C.esc(window.Coords.formatar(pos.lat, pos.lng, est.prefsMapa.coord || 'dec')) + '</span>' : '—'],
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
        C.coord(pt.lng) + '</td><td class="num">' + C.esc(C.precisao(pt.prec)) + '</td><td class="num">' + textoAtraso(pt) + '</td></tr>';
    }).join('');
    $('ficha-hist').innerHTML = linhasHist || '<tr><td colspan="5" class="muted">Sem posições registradas.</td></tr>';

    $('ficha-remover').hidden = d.removido || est.op.status !== 'ativa' || ehResp;
    atualizarSituacaoFicha(p);
  }

  function podeReincluirP(p) {
    return Boolean(p.dados.removido && est.op && est.op.status === 'ativa' && tipoDe(p.dados) !== 'responsavel');
  }

  // Bloco no topo da ficha: fora da operação (com o botão Reincluir) ou reincluído aguardando o celular.
  function atualizarSituacaoFicha(p) {
    var d = p.dados;
    var caixa = $('ficha-situacao');
    var assinatura = [d.removido, d.liberado_em, d.removido_em, d.reincluido_em, d.rastreando, aguardandoRetorno(p), est.op.status].join('|');
    if (caixa._assinatura === assinatura) return;
    caixa._assinatura = assinatura;
    caixa.innerHTML = '';
    caixa.className = 'ficha-bloco ficha-situacao';
    if (d.removido) {
      caixa.classList.add('fora');
      caixa.appendChild(UI.el('p', null, [UI.el('strong', { texto: estadoDe(p).rot + '.' }),
        ' O cadastro, a trilha e as mensagens continuam guardados.']));
      if (podeReincluirP(p)) {
        caixa.appendChild(UI.el('button', { classe: 'btn btn-ok', type: 'button', id: 'ficha-reincluir', texto: 'Reincluir na operação',
          onclick: function () { reincluirParticipante(p.id); } }));
      }
      caixa.hidden = false;
    } else if (aguardandoRetorno(p)) {
      caixa.classList.add('aguardando');
      caixa.appendChild(UI.el('p', null, [UI.el('strong', { texto: 'Reincluído às ' + C.hora(d.reincluido_em, false) + (d.reincluido_por_nome ? ' por ' + d.reincluido_por_nome : '') + '.' }),
        ' Aguardando o celular voltar: a página dele mostra "Os bombeiros chamaram você de volta". Se ele fechou a página, deve abrir o mesmo link no mesmo celular.']));
      caixa.hidden = false;
    } else {
      caixa.hidden = true;
    }
  }

  async function reincluirParticipante(id) {
    var p = est.participantes.get(id);
    if (!p || !podeReincluirP(p)) return;
    var r = await UI.confirmar({
      titulo: 'Reincluir ' + p.dados.nome + ' na operação?',
      texto: 'Ele volta para a lista de participantes com o mesmo cadastro e a mesma trilha (nada é duplicado). ' +
        'O celular dele mostra o aviso para voltar à busca e, com um toque, volta a enviar a localização e a receber mensagens.',
      ok: 'Reincluir',
    });
    if (!r) return;
    try {
      var row = await C.rpc('reincluir_participante', { p_participante: id });
      if (row) upsertParticipante(row);
      renderizarLista();
      atualizarMarcador(p);
      if (est.selecionado === id) atualizarFicha();
      UI.aviso(p.dados.nome + ' foi reincluído. Aguardando o celular dele voltar.', 'ok', 7000);
    } catch (e) {
      UI.aviso(e.message, 'erro');
    }
  }

  // Atraso entre a captura pelo GPS e a chegada ao servidor (diagnóstico de campo).
  function textoAtraso(pt) {
    if (!pt.rec || !pt.t) return '—';
    var s = Math.max(0, Math.round((pt.rec - pt.t) / 1000));
    return s < 60 ? s + ' s' : Math.round(s / 60) + ' min';
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
      texto: 'O participante deixa de enviar a localização e de receber mensagens. O cadastro e a trilha já registrada continuam guardados, e você pode reincluí-lo depois pela lista "Fora da operação".',
      ok: 'Remover',
      perigo: true,
    });
    if (!r) return;
    try {
      await C.rpc('remover_participante', { p_participante: p.id });
      p.dados.removido = true;
      p.dados.rastreando = false;
      p.dados.removido_em = p.dados.removido_em || new Date().toISOString();
      est.destinos.delete(p.id);
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
        est.op && !est.op.dados_apagados_em ? UI.el('button', { classe: 'btn', type: 'button', id: 'relato-ponto', texto: 'Registrar como ponto de interesse', onclick: function () { fechar(); pontoDoRelato(m); } }) : null,
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
    fecharAreas();
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
    if (u) u = { lat: u.lat, lng: u.lng, prec: u.prec, t: u.recebidaEm || u.t };
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

  function abrirRegistrarFoto(aoEnviar) {
    if (!est.op || est.op.status !== 'ativa') return;
    if (typeof aoEnviar !== 'function') aoEnviar = null;
    prepararAudio();
    var inCam = UI.el('input', { classe: 'sr-only', type: 'file', accept: 'image/*', capture: 'environment', id: 'painel-foto-camera' });
    var inArq = UI.el('input', { classe: 'sr-only', type: 'file', accept: 'image/*', id: 'painel-foto-arquivo' });
    inCam.addEventListener('change', function (ev) { aoEscolherFotoPainel(ev, true, aoEnviar); });
    inArq.addEventListener('change', function (ev) { aoEscolherFotoPainel(ev, false, aoEnviar); });
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

  async function aoEscolherFotoPainel(ev, daCamera, aoEnviar) {
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
        est.fotosFila.push(Object.assign(d, { id: C.uuid(), operacao_id: opId, participante_id: null, estado: 'fila', aoEnviar: aoEnviar || null }));
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
          if (it.aoEnviar) { try { it.aoEnviar(foto); } catch (e2) { /* ignora */ } }
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
  /* Setores de busca, pontos de interesse e destinos                     */
  /* ------------------------------------------------------------------ */
  var CORES_SETOR = ['#3b82f6', '#f59e0b', '#14b8a6', '#ec4899', '#84cc16', '#0ea5e9', '#f43f5e', '#eab308'];
  var STATUS_SETOR = {
    pendente: { rotulo: 'Pendente', selo: 'selo-neutro' },
    andamento: { rotulo: 'Em andamento', selo: 'selo-alerta' },
    concluido: { rotulo: 'Concluído', selo: 'selo-ok' },
  };
  var RAIO_ALERTA_PADRAO = 100;   // m — área de risco sem raio definido
  var CAT_PONTO = {
    ULTIMA_LOCALIZACAO: { rotulo: 'Última localização conhecida', letra: 'U' },
    POSSIVEL_LOCALIZACAO: { rotulo: 'Possível localização da vítima', letra: '?' },
    VESTIGIO: { rotulo: 'Vestígio ou objeto encontrado', letra: 'V' },
    RISCO: { rotulo: 'Área de risco / perigo', letra: '!' },
    ENCONTRO: { rotulo: 'Ponto de encontro', letra: 'E' },
    VITIMA_ENCONTRADA: { rotulo: 'Vítima encontrada', letra: '+' },
    OUTRO: { rotulo: 'Outro ponto', letra: '•' },
  };
  var FAIXA_COBERTURA_M = 25;   // meia-largura de varredura considerada em volta de cada rastro
  var URL_DEM = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png';

  /* ---------- Carga e tempo real ------------------------------------ */
  async function carregarAreas() {
    if (!est.op) return;
    var opId = est.op.id;
    try {
      var r = await Promise.all([
        C.consultar(C.cliente.from('setores').select('*').eq('operacao_id', opId).order('criado_em', { ascending: true })),
        C.consultar(C.cliente.from('pontos_interesse').select('*').eq('operacao_id', opId).order('criado_em', { ascending: true })),
        C.consultar(C.cliente.from('destinos').select('*').eq('operacao_id', opId).is('encerrado_em', null)),
      ]);
      if (!est.op || est.op.id !== opId) return;
      aplicarSetores(r[0] || [], true);
      aplicarPontos(r[1] || [], true);
      aplicarDestinos(r[2] || []);
      est.erroAreas = false;
    } catch (e) {
      // banco sem a migração 003 ou sem conexão: o resto do painel segue funcionando
      if (!est.erroAreas) console.warn('Setores/pontos indisponíveis:', e.message);
      est.erroAreas = true;
    }
  }

  function agendarAreas() {
    clearTimeout(est.timerAreas);
    est.timerAreas = setTimeout(carregarAreas, 400);
  }

  function aplicarSetores(lista, completa) {
    var vistos = new Set();
    lista.forEach(function (d) {
      vistos.add(d.id);
      var s = est.setores.get(d.id);
      if (!s) { s = { d: d, camada: null }; est.setores.set(d.id, s); }
      else s.d = d;
      desenharSetor(s);
    });
    if (completa) {
      est.setores.forEach(function (s, id) {
        if (!vistos.has(id)) { if (s.camada) s.camada.remove(); est.setores.delete(id); }
      });
    }
    renderizarAreas();
  }

  function aplicarPontos(lista, completa) {
    var vistos = new Set();
    lista.forEach(function (d) {
      vistos.add(d.id);
      var p = est.pontosInt.get(d.id);
      if (!p) { p = { d: d, marcador: null }; est.pontosInt.set(d.id, p); }
      else p.d = d;
      desenharPontoInt(p);
    });
    if (completa) {
      est.pontosInt.forEach(function (p, id) {
        if (!vistos.has(id)) { if (p.marcador) p.marcador.remove(); if (p.circulo) p.circulo.remove(); est.pontosInt.delete(id); }
      });
    }
    renderizarAreas();
  }

  function aplicarDestinos(lista) {
    est.destinos = new Map();
    lista.forEach(function (d) { if (!d.encerrado_em) est.destinos.set(d.participante_id, d); });
    if (est.selecionado) atualizarFicha();
  }

  function limparAreasDoMapa() {
    est.setores.forEach(function (s) { if (s.camada) s.camada.remove(); });
    est.pontosInt.forEach(function (p) { if (p.marcador) p.marcador.remove(); });
    if (est.linhaDestino) { est.linhaDestino.remove(); est.linhaDestino = null; }
    if (est.marcaDestino) { est.marcaDestino.remove(); est.marcaDestino = null; }
    est.setores = new Map();
    est.pontosInt = new Map();
    est.destinos = new Map();
    renderizarAreas();
  }

  /* ---------- Geometria --------------------------------------------- */
  // Projeção local em metros (equiretangular), boa para áreas de busca (até dezenas de km).
  function projetor(lat0, lng0) {
    var R = 6371008.8, k = Math.PI / 180, cos0 = Math.cos(lat0 * k);
    return {
      xy: function (lat, lng) { return [(lng - lng0) * k * R * cos0, (lat - lat0) * k * R]; },
      ll: function (x, y) { return [lat0 + y / (k * R), lng0 + x / (k * R * cos0)]; },
    };
  }

  function verticesSetor(d) {
    if (d.forma === 'poligono') return d.pontos || [];
    var pr = projetor(d.centro_lat, d.centro_lng), v = [];
    for (var i = 0; i < 64; i++) {
      var a = (i / 64) * 2 * Math.PI;
      v.push(pr.ll(Math.cos(a) * d.raio_m, Math.sin(a) * d.raio_m));
    }
    return v;
  }

  function centroSetor(d) {
    if (d.forma === 'circulo') return [d.centro_lat, d.centro_lng];
    var la = 0, ln = 0;
    d.pontos.forEach(function (p) { la += p[0]; ln += p[1]; });
    return [la / d.pontos.length, ln / d.pontos.length];
  }

  function areaSetorM2(d) {
    if (d.forma === 'circulo') return Math.PI * d.raio_m * d.raio_m;
    var c = centroSetor(d), pr = projetor(c[0], c[1]);
    var pts = d.pontos.map(function (p) { return pr.xy(p[0], p[1]); }), a = 0;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
    return Math.abs(a / 2);
  }

  function formatarArea(m2) {
    if (m2 < 10000) return Math.round(m2).toLocaleString('pt-BR') + ' m²';
    if (m2 < 1e6) return Math.round(m2).toLocaleString('pt-BR') + ' m² (' + (m2 / 10000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' ha)';
    return (m2 / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' km² (' + Math.round(m2 / 10000).toLocaleString('pt-BR') + ' ha)';
  }

  function dentroDoPoligono(x, y, pts) {
    var dentro = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      if (((pts[i][1] > y) !== (pts[j][1] > y)) && (x < (pts[j][0] - pts[i][0]) * (y - pts[i][1]) / (pts[j][1] - pts[i][1]) + pts[i][0])) dentro = !dentro;
    }
    return dentro;
  }

  function distSegmento(px, py, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    var t = l2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0;
    var qx = a[0] + t * dx - px, qy = a[1] + t * dy - py;
    return Math.sqrt(qx * qx + qy * qy);
  }

  // Estimativa de quanto do setor ficou perto de algum rastro GPS (faixa de ±25 m).
  // É uma estimativa: não prova que a área foi vasculhada.
  function coberturaSetor(d) {
    var c = centroSetor(d), pr = projetor(c[0], c[1]);
    var poli = verticesSetor(d).map(function (p) { return pr.xy(p[0], p[1]); });
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    poli.forEach(function (p) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); });
    var area = areaSetorM2(d);
    var passo = Math.max(4, Math.sqrt(area / 4000));
    var f = FAIXA_COBERTURA_M;
    var segs = [];
    est.participantes.forEach(function (p) {
      trilhaDe(p).segmentos.forEach(function (seg) {
        var ant = null;
        seg.forEach(function (ll) {
          var q = pr.xy(ll[0], ll[1]);
          var a = ant || q;
          if (Math.max(a[0], q[0]) >= minX - f && Math.min(a[0], q[0]) <= maxX + f &&
              Math.max(a[1], q[1]) >= minY - f && Math.min(a[1], q[1]) <= maxY + f) segs.push([a, q]);
          ant = q;
        });
      });
    });
    var total = 0, cobertos = 0;
    for (var x = minX + passo / 2; x < maxX; x += passo) {
      for (var y = minY + passo / 2; y < maxY; y += passo) {
        if (!dentroDoPoligono(x, y, poli)) continue;
        total++;
        for (var i = 0; i < segs.length; i++) {
          if (distSegmento(x, y, segs[i][0], segs[i][1]) <= f) { cobertos++; break; }
        }
      }
    }
    return { pct: total ? Math.round((cobertos / total) * 100) : 0, comRastros: segs.length > 0 };
  }

  /* ---------- Desenho dos setores ----------------------------------- */
  function estiloSetor(d) {
    return {
      pane: 'setores',
      color: d.cor,
      weight: 2.5,
      opacity: 0.95,
      fillColor: d.cor,
      fillOpacity: d.status === 'concluido' ? 0.06 : d.status === 'andamento' ? 0.16 : 0.11,
      dashArray: d.status === 'pendente' ? '8 6' : null,
      className: 'setor setor-' + d.status,
    };
  }

  function textoRotuloSetor(d) {
    return d.nome + ' · ' + STATUS_SETOR[d.status].rotulo;
  }

  function desenharSetor(s) {
    if (!est.mapa || !est.camadaSetores) return;
    var d = s.d;
    if (s.camada) { s.camada.remove(); s.camada = null; }
    if (est.desenho && est.desenho.tipo === 'ajuste' && est.desenho.id === d.id) return;   // sendo ajustado
    var camada = d.forma === 'circulo'
      ? L.circle([d.centro_lat, d.centro_lng], Object.assign({ radius: d.raio_m }, estiloSetor(d)))
      : L.polygon(d.pontos, estiloSetor(d));
    camada.bindTooltip(C.esc(textoRotuloSetor(d)), { permanent: true, direction: 'center', className: 'rotulo-setor', opacity: 1 });
    camada.on('click', function (ev) {
      if (est.desenho) return;   // durante o desenho o clique é do mapa
      L.DomEvent.stopPropagation(ev);
      abrirSetor(d.id);
    });
    camada.addTo(est.camadaSetores);
    s.camada = camada;
  }

  /* ---------- Pontos de interesse ----------------------------------- */
  function iconePontoInt(d) {
    var cat = CAT_PONTO[d.categoria] || CAT_PONTO.OUTRO;
    return L.divIcon({
      className: 'mk-poi-wrap',
      html: '<div class="mk-poi poi-' + C.esc(d.categoria) + '"><span>' + C.esc(cat.letra) + '</span></div>' +
        '<div class="mk-poi-rotulo">' + C.esc(d.titulo) + '</div>',
      iconSize: [0, 0],
    });
  }

  function desenharPontoInt(p) {
    if (!est.mapa || !est.camadaPontosInt) return;
    var d = p.d;
    if (p.marcador) { p.marcador.remove(); p.marcador = null; }
    if (p.circulo) { p.circulo.remove(); p.circulo = null; }
    var cat = CAT_PONTO[d.categoria] || CAT_PONTO.OUTRO;
    // Área de risco: círculo do alarme de proximidade (quem entra é avisado).
    if (d.categoria === 'RISCO') {
      p.circulo = L.circle([d.lat, d.lng], { radius: d.raio_m || RAIO_ALERTA_PADRAO, color: '#ef4444', weight: 2, dashArray: '6 6',
        fillColor: '#ef4444', fillOpacity: 0.08, interactive: false, className: 'circulo-risco' }).addTo(est.camadaPontosInt);
    }
    var mk = L.marker([d.lat, d.lng], { icon: iconePontoInt(d), keyboard: true, title: cat.rotulo + ': ' + d.titulo, alt: d.titulo, zIndexOffset: -50 });
    mk.on('click', function () {
      if (est.desenho) { aoClicarNoMapa({ latlng: mk.getLatLng() }); return; }
      abrirPontoInt(d.id);
    });
    mk.addTo(est.camadaPontosInt);
    p.marcador = mk;
  }

  /* ---------- Modo de desenho (tocar no mapa) ------------------------ */
  function mostrarBarraDesenho(texto, extra, botoes) {
    $('barra-desenho-texto').textContent = texto;
    var ex = $('barra-desenho-extra');
    ex.innerHTML = '';
    if (extra) ex.appendChild(extra);
    var bt = $('barra-desenho-botoes');
    bt.innerHTML = '';
    (botoes || []).forEach(function (b) { if (b) bt.appendChild(b); });
    $('barra-desenho').hidden = false;
  }

  function iniciarDesenho(tipo, opcoes) {
    if (!est.mapa || !est.op) return;
    cancelarDesenho();
    fecharMenu(false);
    if (telaPequena()) { fecharAreas(); fecharCentral(); if (!$('ficha').hidden) fecharFicha(); }
    est.desenho = Object.assign({ tipo: tipo, camadaTemp: L.layerGroup().addTo(est.mapa), pontos: [] }, opcoes || {});
    $('mapa').classList.add('modo-desenho');
    var cancelar = UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'desenho-cancelar', texto: 'Cancelar', onclick: cancelarDesenho });
    if (tipo === 'raio') {
      mostrarBarraDesenho('Toque no mapa no CENTRO do setor.', null, [cancelar]);
    } else if (tipo === 'poligono') {
      atualizarBarraPoligono();
    } else if (tipo === 'ponto') {
      mostrarBarraDesenho('Toque no mapa onde fica o ponto.', null, [
        UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Usar minha posição', onclick: usarMinhaPosicaoNoDesenho }), cancelar]);
    } else if (tipo === 'destino') {
      mostrarBarraDesenho('Toque no mapa no DESTINO.', null, [cancelar]);
    }
  }

  function atualizarBarraPoligono() {
    var n = est.desenho.pontos.length;
    mostrarBarraDesenho(n < 3 ? 'Toque nos cantos da área (' + n + ' de no mínimo 3).' : n + ' cantos. Toque em mais pontos ou em Concluir.', null, [
      UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Desfazer', disabled: n ? null : true, onclick: function () { est.desenho.pontos.pop(); redesenharTemp(); atualizarBarraPoligono(); } }),
      UI.el('button', { classe: 'btn btn-pequeno btn-ok', type: 'button', id: 'desenho-concluir', texto: 'Concluir', disabled: n >= 3 ? null : true, onclick: concluirPoligono }),
      UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'desenho-cancelar', texto: 'Cancelar', onclick: cancelarDesenho }),
    ]);
  }

  function redesenharTemp() {
    var dz = est.desenho;
    dz.camadaTemp.clearLayers();
    if (dz.tipo === 'poligono') {
      var cor = '#facc15';
      if (dz.pontos.length >= 3) L.polygon(dz.pontos, { color: cor, weight: 2, fillOpacity: 0.12, dashArray: '6 4', interactive: false }).addTo(dz.camadaTemp);
      else if (dz.pontos.length === 2) L.polyline(dz.pontos, { color: cor, weight: 2, dashArray: '6 4', interactive: false }).addTo(dz.camadaTemp);
      dz.pontos.forEach(function (p) { L.circleMarker(p, { radius: 5, color: '#000', weight: 1.5, fillColor: cor, fillOpacity: 1, interactive: false }).addTo(dz.camadaTemp); });
    }
  }

  function aoClicarNoMapa(e) {
    var dz = est.desenho;
    if (!dz || !e || !e.latlng) return;
    var ll = [Math.round(e.latlng.lat * 1e7) / 1e7, Math.round(e.latlng.lng * 1e7) / 1e7];
    if (dz.tipo === 'raio') {
      dz.centro = ll;
      $('barra-desenho').hidden = true;
      abrirFormSetor({ forma: 'circulo', centro_lat: ll[0], centro_lng: ll[1], raio_m: 200 });
    } else if (dz.tipo === 'poligono') {
      dz.pontos.push(ll);
      redesenharTemp();
      atualizarBarraPoligono();
    } else if (dz.tipo === 'ponto') {
      $('barra-desenho').hidden = true;
      abrirFormPontoInt({ lat: ll[0], lng: ll[1] });
    } else if (dz.tipo === 'destino') {
      var pre = dz.participantes;
      cancelarDesenho();
      abrirEnviarDestino({ nome: 'Ponto marcado no mapa', lat: ll[0], lng: ll[1], participantes: pre });
    } else if (dz.tipo === 'externo' && dz.aoClicar) {
      dz.aoClicar(ll);
    }
  }

  // Modo de desenho usado pelas ferramentas (medir etc.): mesma barra e mesma
  // regra de toques no mapa (inclusive sobre marcadores).
  function iniciarDesenhoExterno(o) {
    if (!est.mapa) return null;
    cancelarDesenho();
    fecharMenu(false);
    if (telaPequena()) { fecharAreas(); fecharCentral(); if (!$('ficha').hidden) fecharFicha(); }
    est.desenho = { tipo: 'externo', camadaTemp: L.layerGroup().addTo(est.mapa), aoClicar: o.aoClicar, aoCancelar: o.aoCancelar };
    $('mapa').classList.add('modo-desenho');
    var dz = est.desenho;
    return {
      camada: dz.camadaTemp,
      barra: function (texto, extra, botoes) { if (est.desenho === dz) mostrarBarraDesenho(texto, extra, botoes); },
      encerrar: function () { if (est.desenho === dz) cancelarDesenho(); },
      ativo: function () { return est.desenho === dz; },
    };
  }

  async function usarMinhaPosicaoNoDesenho() {
    var p = await obterMinhaPosicao();
    if (!p.ok) { UI.aviso('Sem a sua localização agora (' + p.motivo + '). Toque no mapa.', 'erro', 7000); return; }
    aoClicarNoMapa({ latlng: { lat: p.lat, lng: p.lng } });
  }

  function concluirPoligono() {
    var dz = est.desenho;
    if (!dz || dz.pontos.length < 3) return;
    $('barra-desenho').hidden = true;
    abrirFormSetor({ forma: 'poligono', pontos: dz.pontos.slice() });
  }

  function cancelarDesenho() {
    var dz = est.desenho;
    if (!dz) return;
    est.desenho = null;
    if (dz.camadaTemp) dz.camadaTemp.remove();
    if (dz.aoCancelar) dz.aoCancelar();
    $('barra-desenho').hidden = true;
    $('mapa').classList.remove('modo-desenho');
  }

  /* ---------- Setores: formulário, detalhes, limites, exclusão ------- */
  function opcoesParticipantes(selecionado, incluirVazio) {
    var sel = UI.el('select', { classe: 'campo', id: 'setor-participante' });
    if (incluirVazio) sel.appendChild(UI.el('option', { value: '', texto: '— ninguém (só a equipe abaixo) —' }));
    Array.from(est.participantes.values())
      .filter(function (p) { return !p.dados.removido || p.id === selecionado; })
      .sort(function (a, b) { return a.dados.nome.localeCompare(b.dados.nome, 'pt-BR'); })
      .forEach(function (p) {
        sel.appendChild(UI.el('option', { value: p.id, selected: p.id === selecionado ? true : null, texto: nomeExibido(p) + ' (' + TIPOS[tipoDe(p.dados)].rotulo.toLowerCase() + ')' }));
      });
    return sel;
  }

  function corLivre() {
    var usadas = new Set(Array.from(est.setores.values()).map(function (s) { return s.d.cor.toLowerCase(); }));
    for (var i = 0; i < CORES_SETOR.length; i++) if (!usadas.has(CORES_SETOR[i].toLowerCase())) return CORES_SETOR[i];
    return CORES_SETOR[est.setores.size % CORES_SETOR.length];
  }

  // s: setor existente (edição) ou base de um novo (forma + geometria)
  function abrirFormSetor(s) {
    var novo = !s.id;
    var d = Object.assign({ nome: 'Setor ' + (est.setores.size + 1), cor: corLivre(), status: 'pendente', equipe: '', observacoes: '', participante_id: null }, s);
    var dz = est.desenho;
    var previa = null;
    function desenharPrevia(raio) {
      if (!dz || d.forma !== 'circulo') return;
      if (previa) previa.remove();
      previa = L.circle([d.centro_lat, d.centro_lng], { radius: raio, color: '#facc15', weight: 2, dashArray: '6 4', fillOpacity: 0.12, interactive: false }).addTo(dz.camadaTemp);
    }
    var nome = UI.el('input', { classe: 'campo', id: 'setor-nome', maxlength: '60', value: d.nome });
    var raio = d.forma === 'circulo' ? UI.el('input', { classe: 'campo', id: 'setor-raio', type: 'number', min: '5', max: '50000', step: '10', inputmode: 'numeric', value: String(Math.round(d.raio_m)) }) : null;
    var area = UI.el('p', { classe: 'ajuda', id: 'setor-area' });
    function atualizarArea() {
      var r = raio ? Number(raio.value) : null;
      var dd = Object.assign({}, d, raio ? { raio_m: r } : {});
      area.textContent = 'Área aproximada: ' + (raio && !(r >= 5 && r <= 50000) ? '—' : formatarArea(areaSetorM2(dd)));
      if (raio && r >= 5 && r <= 50000) desenharPrevia(r);
    }
    if (raio) raio.addEventListener('input', atualizarArea);
    var cores = UI.el('div', { classe: 'cores-setor', role: 'radiogroup', 'aria-label': 'Cor do setor' }, CORES_SETOR.map(function (c) {
      return UI.el('label', { classe: 'cor-opcao', title: c }, [
        UI.el('input', { type: 'radio', name: 'setor-cor', value: c, checked: c.toLowerCase() === d.cor.toLowerCase() ? true : null }),
        UI.el('span', { style: 'background:' + c }),
      ]);
    }));
    var part = opcoesParticipantes(d.participante_id, true);
    var equipe = UI.el('input', { classe: 'campo', id: 'setor-equipe', maxlength: '60', value: d.equipe || '', placeholder: 'Ex.: Equipe Alfa' });
    var status = UI.el('select', { classe: 'campo', id: 'setor-status' }, Object.keys(STATUS_SETOR).map(function (k) {
      return UI.el('option', { value: k, selected: k === d.status ? true : null, texto: STATUS_SETOR[k].rotulo });
    }));
    var obs = UI.el('textarea', { classe: 'campo', id: 'setor-obs', maxlength: '500', rows: '2' });
    obs.value = d.observacoes || '';
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btnSalvar = UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'setor-salvar', texto: novo ? 'Criar setor' : 'Salvar' });
    var salvo = false;
    var form = UI.el('form', { classe: 'form-setor', novalidate: true }, [
      UI.el('h2', { id: 'modal-titulo', texto: novo ? 'Novo setor de busca' : 'Editar setor' }),
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'setor-nome', texto: 'Nome, número ou código' }), nome]),
      raio ? UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'setor-raio', texto: 'Raio (metros)' }), raio]) : null,
      area,
      UI.el('div', { classe: 'grupo' }, [UI.el('span', { classe: 'rotulo', texto: 'Cor' }), cores]),
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'setor-participante', texto: 'Responsável pelo setor' }), part]),
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'setor-equipe', texto: 'Equipe (opcional)' }), equipe]),
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'setor-status', texto: 'Situação' }), status]),
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'setor-obs', texto: 'Observações (opcional)' }), obs]),
      erro,
      UI.el('div', { classe: 'modal-acoes' }, [UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btnSalvar]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      var dados = {
        nome: nome.value.replace(/\s+/g, ' ').trim(),
        cor: (form.querySelector('input[name="setor-cor"]:checked') || {}).value || d.cor,
        participante_id: part.value || null,
        equipe: equipe.value.trim(),
        status: status.value,
        observacoes: obs.value.trim(),
      };
      if (!dados.nome) { erro.textContent = 'Informe o nome do setor.'; erro.hidden = false; return; }
      if (novo || raio) {
        dados.forma = d.forma;
        if (d.forma === 'circulo') {
          var r = Number(raio.value);
          if (!(r >= 5 && r <= 50000)) { erro.textContent = 'O raio deve ficar entre 5 m e 50 km.'; erro.hidden = false; return; }
          Object.assign(dados, { centro_lat: d.centro_lat, centro_lng: d.centro_lng, raio_m: r });
        } else {
          dados.pontos = d.pontos;
        }
      }
      btnSalvar.disabled = true;
      try {
        var res = await C.rpc('salvar_setor', { p_operacao: est.op.id, p_id: d.id || null, p_dados: dados });
        salvo = true;
        fechar(true);
        cancelarDesenho();
        aplicarSetores([res]);
        UI.aviso(novo ? 'Setor "' + res.nome + '" criado.' : 'Setor salvo.', 'ok');
      } catch (e) {
        erro.textContent = 'Não foi possível salvar: ' + e.message;
        erro.hidden = false;
        btnSalvar.disabled = false;
      }
    });
    var fechar = UI.abrirModal(form, { fecharNoFundo: false, aoFechar: function () { if (!salvo && novo) cancelarDesenho(); } });
    atualizarArea();
  }

  function nomeResponsavelSetor(d) {
    var p = d.participante_id && est.participantes.get(d.participante_id);
    var partes = [];
    if (p) partes.push(nomeExibido(p));
    if (d.equipe) partes.push(d.equipe);
    return partes.join(' · ') || 'Ninguém atribuído';
  }

  function verSetorNoMapa(d) {
    if (!est.mapa) return;
    if (!est.prefsMapa.setores) definirPrefMapa('setores', true);
    if (telaPequena()) { fecharAreas(); }
    UI.fecharModal();
    est.mapa.fitBounds(L.latLngBounds(verticesSetor(d)), { padding: [40, 40], maxZoom: 17 });
  }

  function abrirSetor(id) {
    var s = est.setores.get(id);
    if (!s) return;
    var d = s.d;
    var dl = UI.el('dl', { classe: 'dados' });
    function linha(rot, valor) { dl.appendChild(UI.el('dt', { texto: rot })); dl.appendChild(UI.el('dd', null, [valor])); }
    linha('Forma', d.forma === 'circulo' ? 'Círculo — raio de ' + Math.round(d.raio_m).toLocaleString('pt-BR') + ' m' : 'Área desenhada — ' + d.pontos.length + ' cantos');
    linha('Área aproximada', formatarArea(areaSetorM2(d)));
    linha('Responsável', nomeResponsavelSetor(d));
    linha('Criado', C.hora(d.criado_em) + ' por ' + d.criado_por_nome);
    if (d.atualizado_por_nome && d.atualizado_em !== d.criado_em) linha('Alterado', C.hora(d.atualizado_em) + ' por ' + d.atualizado_por_nome);
    if (d.observacoes) linha('Observações', d.observacoes);
    var cob = coberturaSetor(d);
    var caixaCob = UI.el('div', { classe: 'nota nota-cobertura' }, [
      UI.el('strong', { texto: 'Percorrido (estimativa pelos rastros GPS): ' + cob.pct + '%' }),
      UI.el('div', { texto: cob.comRastros
        ? 'Parte da área que ficou a até ' + FAIXA_COBERTURA_M + ' m de algum rastro. Não prova que o setor foi vasculhado: só a equipe confirma, marcando "Concluído".'
        : 'Nenhum rastro GPS passou por este setor ainda.' }),
    ]);
    var podeEditar = !est.op.dados_apagados_em;
    var botoesStatus = UI.el('div', { classe: 'status-setor', role: 'group', 'aria-label': 'Situação do setor' }, Object.keys(STATUS_SETOR).map(function (k) {
      return UI.el('button', {
        classe: 'btn btn-pequeno status-' + k + (d.status === k ? ' btn-ativo' : ''), type: 'button', 'data-status': k,
        'aria-pressed': String(d.status === k), disabled: podeEditar ? null : true, texto: STATUS_SETOR[k].rotulo,
        onclick: async function () {
          if (k === d.status) return;
          try {
            var res = await C.rpc('salvar_setor', { p_operacao: est.op.id, p_id: d.id, p_dados: { status: k } });
            aplicarSetores([res]);
            UI.aviso('Setor "' + res.nome + '": ' + STATUS_SETOR[k].rotulo + '.', 'ok');
            abrirSetor(id);
          } catch (e) { UI.aviso(e.message, 'erro'); }
        },
      });
    }));
    var fechar = UI.abrirModal(UI.el('div', { classe: 'detalhe-setor' }, [
      UI.el('h2', { id: 'modal-titulo' }, [UI.el('span', { classe: 'chip-cor', style: 'background:' + d.cor }), ' ' + d.nome]),
      botoesStatus,
      caixaCob,
      dl,
      UI.el('div', { classe: 'modal-acoes acoes-detalhe' }, [
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Ver no mapa', onclick: function () { fechar(); verSetorNoMapa(d); } }),
        podeEditar ? UI.el('button', { classe: 'btn', type: 'button', texto: 'Editar', onclick: function () { fechar(); abrirFormSetor(d); } }) : null,
        podeEditar ? UI.el('button', { classe: 'btn', type: 'button', id: 'setor-ajustar', texto: 'Ajustar limites', onclick: function () { fechar(); ajustarLimites(d.id); } }) : null,
        podeEditar && est.op.status === 'ativa' ? UI.el('button', { classe: 'btn', type: 'button', texto: '🧭 Enviar o centro como destino', onclick: function () {
          var c = centroSetor(d);
          fechar();
          abrirEnviarDestino({ nome: 'Setor ' + d.nome, lat: c[0], lng: c[1], participantes: d.participante_id ? [d.participante_id] : [] });
        } }) : null,
        UI.el('button', { classe: 'btn btn-perigo', type: 'button', id: 'setor-excluir', texto: 'Excluir', onclick: function () { fechar(); excluirSetor(d); } }),
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
      ]),
    ]));
  }

  async function excluirSetor(d) {
    var r = await UI.confirmar({
      titulo: 'Excluir o setor "' + d.nome + '"?',
      texto: 'O setor some do mapa de todos os responsáveis (e do celular de quem estava atribuído). As trilhas GPS não são afetadas.',
      ok: 'Excluir setor',
      perigo: true,
    });
    if (!r) return;
    try {
      await C.rpc('excluir_setor', { p_id: d.id });
      var s = est.setores.get(d.id);
      if (s && s.camada) s.camada.remove();
      est.setores.delete(d.id);
      renderizarAreas();
      UI.aviso('Setor excluído.', 'ok');
    } catch (e) {
      UI.aviso(e.codigo === 'sem_permissao' ? 'Só quem criou o setor, quem criou a operação ou um administrador pode excluí-lo.' : e.message, 'erro', 7000);
    }
  }

  // Ajuste dos limites direto no mapa: arrastar cantos (polígono) ou centro/raio (círculo).
  function ajustarLimites(id) {
    var s = est.setores.get(id);
    if (!s || !est.mapa) return;
    cancelarDesenho();
    var d = s.d;
    if (telaPequena()) { fecharAreas(); }
    est.desenho = { tipo: 'ajuste', id: id, camadaTemp: L.layerGroup().addTo(est.mapa), aoCancelar: function () { desenharSetor(s); } };
    var dz = est.desenho;
    if (s.camada) { s.camada.remove(); s.camada = null; }
    var cor = d.cor;
    var botoes = [
      UI.el('button', { classe: 'btn btn-pequeno btn-ok', type: 'button', id: 'ajuste-salvar', texto: 'Salvar limites', onclick: salvarAjuste }),
      UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Cancelar', onclick: cancelarDesenho }),
    ];
    function iconeVertice(classe) { return L.divIcon({ className: 'vertice-wrap', html: '<div class="' + classe + '"></div>', iconSize: [0, 0] }); }
    if (d.forma === 'poligono') {
      var pts = d.pontos.map(function (p) { return p.slice(); });
      var redesenhar = function () {
        dz.camadaTemp.clearLayers();
        L.polygon(pts, { color: cor, weight: 2.5, fillColor: cor, fillOpacity: 0.12, dashArray: '6 4', interactive: false }).addTo(dz.camadaTemp);
        pts.forEach(function (p, i) {
          var v = L.marker(p, { icon: iconeVertice('vertice'), draggable: true, zIndexOffset: 3000, title: 'Arraste para mover; toque para remover' }).addTo(dz.camadaTemp);
          v.on('drag', function (e) { pts[i] = [e.latlng.lat, e.latlng.lng]; poli.setLatLngs(pts); });
          v.on('dragend', redesenhar);
          v.on('click', function () {
            if (pts.length <= 3) { UI.aviso('A área precisa de pelo menos 3 cantos.', 'erro'); return; }
            pts.splice(i, 1);
            redesenhar();
          });
          var j = (i + 1) % pts.length;
          var meio = [(p[0] + pts[j][0]) / 2, (p[1] + pts[j][1]) / 2];
          L.marker(meio, { icon: iconeVertice('vertice-meio'), zIndexOffset: 2900, title: 'Toque para criar um canto aqui' })
            .on('click', function () { pts.splice(j === 0 ? pts.length : j, 0, meio); redesenhar(); })
            .addTo(dz.camadaTemp);
        });
        var poli = dz.camadaTemp.getLayers()[0];
      };
      redesenhar();
      dz.obter = function () { return { forma: 'poligono', pontos: pts.map(function (p) { return [Math.round(p[0] * 1e7) / 1e7, Math.round(p[1] * 1e7) / 1e7]; }) }; };
      mostrarBarraDesenho('Arraste os cantos · toque em ◇ para criar um canto · toque num canto para removê-lo.', null, botoes);
    } else {
      var centro = [d.centro_lat, d.centro_lng];
      var raioIn = UI.el('input', { classe: 'campo campo-raio', type: 'number', min: '5', max: '50000', step: '10', id: 'ajuste-raio', 'aria-label': 'Raio em metros', value: String(Math.round(d.raio_m)) });
      var circ = L.circle(centro, { radius: d.raio_m, color: cor, weight: 2.5, fillColor: cor, fillOpacity: 0.12, dashArray: '6 4', interactive: false }).addTo(dz.camadaTemp);
      var vc = L.marker(centro, { icon: iconeVertice('vertice'), draggable: true, zIndexOffset: 3000, title: 'Arraste para mover o centro' }).addTo(dz.camadaTemp);
      vc.on('drag', function (e) { centro = [e.latlng.lat, e.latlng.lng]; circ.setLatLng(centro); });
      raioIn.addEventListener('input', function () { var r = Number(raioIn.value); if (r >= 5 && r <= 50000) circ.setRadius(r); });
      dz.obter = function () {
        var r = Number(raioIn.value);
        if (!(r >= 5 && r <= 50000)) return null;
        return { forma: 'circulo', centro_lat: Math.round(centro[0] * 1e7) / 1e7, centro_lng: Math.round(centro[1] * 1e7) / 1e7, raio_m: r };
      };
      mostrarBarraDesenho('Arraste o centro e ajuste o raio (m):', raioIn, botoes);
    }
    est.mapa.fitBounds(L.latLngBounds(verticesSetor(d)), { padding: [60, 60], maxZoom: 17 });
    $('mapa').classList.add('modo-desenho');

    async function salvarAjuste() {
      var dados = dz.obter();
      if (!dados) { UI.aviso('O raio deve ficar entre 5 m e 50 km.', 'erro'); return; }
      try {
        var res = await C.rpc('salvar_setor', { p_operacao: est.op.id, p_id: id, p_dados: dados });
        dz.aoCancelar = null;
        cancelarDesenho();
        aplicarSetores([res]);
        UI.aviso('Limites do setor "' + res.nome + '" salvos.', 'ok');
      } catch (e) {
        UI.aviso('Não foi possível salvar: ' + e.message, 'erro', 7000);
      }
    }
  }

  /* ---------- Pontos de interesse: formulário e detalhes ------------- */
  function abrirFormPontoInt(base) {
    var novo = !base.id;
    var d = Object.assign({ categoria: 'OUTRO', titulo: '', descricao: '' }, base);
    var grade = UI.el('div', { classe: 'cat-pontos', role: 'radiogroup', 'aria-label': 'Categoria' }, Object.keys(CAT_PONTO).map(function (k) {
      return UI.el('label', { classe: 'cat-ponto' }, [
        UI.el('input', { type: 'radio', name: 'ponto-cat', value: k, checked: k === d.categoria ? true : null }),
        UI.el('span', { classe: 'mk-poi poi-' + k }, [UI.el('span', { texto: CAT_PONTO[k].letra })]),
        UI.el('span', { classe: 'cat-ponto-txt', texto: CAT_PONTO[k].rotulo }),
      ]);
    }));
    var titulo = UI.el('input', { classe: 'campo', id: 'ponto-titulo', maxlength: '80', value: d.titulo, placeholder: 'Ex.: Última vez vista na trilha da cachoeira' });
    var desc = UI.el('textarea', { classe: 'campo', id: 'ponto-desc', maxlength: '1000', rows: '3' });
    desc.value = d.descricao || '';
    var lat = UI.el('input', { classe: 'campo mono', id: 'ponto-lat', type: 'number', step: 'any', inputmode: 'decimal', value: String(d.lat) });
    var lng = UI.el('input', { classe: 'campo mono', id: 'ponto-lng', type: 'number', step: 'any', inputmode: 'decimal', value: String(d.lng) });
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'ponto-salvar', texto: novo ? 'Marcar ponto' : 'Salvar' });
    // coordenada digitada em qualquer formato (UTM, MGRS, GMS, decimal) preenche latitude/longitude
    var coordTxt = UI.el('input', { classe: 'campo mono', id: 'ponto-coord', placeholder: 'Ex.: 23K 707870 7515797 ou 22°27\'05"S 42°58\'48"O' });
    var coordInfo = UI.el('small', { classe: 'muted', id: 'ponto-coord-info' });
    coordTxt.addEventListener('input', function () {
      var c = window.Coords.interpretar(coordTxt.value);
      if (c) { lat.value = String(Math.round(c.lat * 1e7) / 1e7); lng.value = String(Math.round(c.lng * 1e7) / 1e7); coordInfo.textContent = '✓ ' + window.Coords.formatar(c.lat, c.lng, 'dec'); }
      else coordInfo.textContent = coordTxt.value.trim() ? 'Formato não reconhecido' : '';
    });
    var raio = UI.el('input', { classe: 'campo', id: 'ponto-raio', type: 'number', min: '10', max: '5000', step: '10', inputmode: 'numeric',
      value: d.raio_m ? String(Math.round(d.raio_m)) : String(RAIO_ALERTA_PADRAO) });
    var grupoRaio = UI.el('div', { classe: 'grupo', hidden: d.categoria !== 'RISCO' }, [
      UI.el('label', { classe: 'rotulo', for: 'ponto-raio', texto: 'Raio do alarme de proximidade (m)' }), raio,
      UI.el('small', { classe: 'muted', texto: 'Quem entrar neste círculo recebe um alerta no celular e o painel é avisado.' })]);
    grade.addEventListener('change', function () {
      grupoRaio.hidden = (grade.querySelector('input:checked') || {}).value !== 'RISCO';
    });
    grade.addEventListener('change', function () {
      var k = (grade.querySelector('input:checked') || {}).value;
      if (k && (!titulo.value.trim() || Object.keys(CAT_PONTO).some(function (c) { return CAT_PONTO[c].rotulo === titulo.value.trim(); }))) titulo.value = CAT_PONTO[k].rotulo;
    });
    if (!d.titulo) titulo.value = CAT_PONTO[d.categoria].rotulo;
    var salvo = false;
    var form = UI.el('form', { classe: 'form-ponto', novalidate: true }, [
      UI.el('h2', { id: 'modal-titulo', texto: novo ? 'Marcar ponto de interesse' : 'Editar ponto' }),
      d.relatado_por_nome ? UI.el('p', { classe: 'ajuda', texto: 'A partir do relato de ' + d.relatado_por_nome + '.' }) : null,
      UI.el('div', { classe: 'grupo' }, [UI.el('span', { classe: 'rotulo', texto: 'Categoria' }), grade]),
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'ponto-titulo', texto: 'Nome ou título' }), titulo]),
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'ponto-desc', texto: 'Descrição ou observações (opcional)' }), desc]),
      grupoRaio,
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'ponto-coord', texto: 'Coordenada em qualquer formato (opcional)' }), coordTxt, coordInfo]),
      UI.el('div', { classe: 'grupo-duplo' }, [
        UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'ponto-lat', texto: 'Latitude' }), lat]),
        UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'ponto-lng', texto: 'Longitude' }), lng]),
      ]),
      erro,
      UI.el('div', { classe: 'modal-acoes' }, [UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btn]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true;
      var dados = {
        categoria: (grade.querySelector('input:checked') || {}).value,
        titulo: titulo.value.replace(/\s+/g, ' ').trim(),
        descricao: desc.value.trim(),
        lat: Number(lat.value),
        lng: Number(lng.value),
      };
      if (!dados.categoria) { erro.textContent = 'Escolha a categoria.'; erro.hidden = false; return; }
      if (!dados.titulo) { erro.textContent = 'Informe o nome do ponto.'; erro.hidden = false; return; }
      if (!isFinite(dados.lat) || !isFinite(dados.lng) || Math.abs(dados.lat) > 90 || Math.abs(dados.lng) > 180 || (dados.lat === 0 && dados.lng === 0)) {
        erro.textContent = 'Coordenadas inválidas.'; erro.hidden = false; return;
      }
      if (novo && d.mensagem_id) dados.mensagem_id = d.mensagem_id;
      if (dados.categoria === 'RISCO') {
        var r = Number(raio.value);
        if (!isFinite(r) || r < 10 || r > 5000) { erro.textContent = 'Raio do alarme: de 10 m a 5.000 m.'; erro.hidden = false; return; }
        dados.raio_m = Math.round(r);
      }
      btn.disabled = true;
      try {
        var res = await C.rpc('salvar_ponto', { p_operacao: est.op.id, p_id: d.id || null, p_dados: dados });
        salvo = true;
        fechar(true);
        cancelarDesenho();
        aplicarPontos([res]);
        if (!est.prefsMapa.pontos) definirPrefMapa('pontos', true);
        UI.aviso(novo ? 'Ponto "' + res.titulo + '" marcado.' : 'Ponto salvo.', 'ok');
      } catch (e) {
        erro.textContent = 'Não foi possível salvar: ' + e.message;
        erro.hidden = false;
        btn.disabled = false;
      }
    });
    var fechar = UI.abrirModal(form, { fecharNoFundo: false, aoFechar: function () { if (!salvo) cancelarDesenho(); } });
  }

  // Coordenadas no formato escolhido (Ferramentas › Formato das coordenadas), com os
  // outros formatos logo abaixo e botão de copiar — para passar por rádio ou telefone.
  function blocoCoordenadas(lat, lng) {
    var fmt = est.prefsMapa.coord || 'dec';
    var principal = window.Coords.formatar(lat, lng, fmt);
    var outros = Object.keys(window.Coords.FORMATOS).filter(function (f) { return f !== fmt; })
      .map(function (f) { return UI.el('div', { classe: 'mono muted coord-outro', texto: window.Coords.formatar(lat, lng, f) }); });
    return UI.el('div', { classe: 'bloco-coord' }, [
      UI.el('span', { classe: 'mono coord-principal', texto: principal }), ' ',
      UI.el('button', { classe: 'btn btn-pequeno btn-link', type: 'button', texto: 'Copiar', onclick: function () { copiarTexto(principal); } }),
    ].concat(outros));
  }

  function copiarTexto(t) {
    var ok = function () { UI.aviso('Copiado: ' + t, 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(ok, function () { UI.aviso(t, 'ok', 9000); });
    else UI.aviso(t, 'ok', 9000);
  }

  function verPontoNoMapa(d) {
    if (!est.mapa) return;
    if (!est.prefsMapa.pontos) definirPrefMapa('pontos', true);
    if (telaPequena()) fecharAreas();
    UI.fecharModal();
    est.mapa.setView([d.lat, d.lng], Math.max(est.mapa.getZoom(), 17));
    var p = est.pontosInt.get(d.id);
    var el = p && p.marcador && p.marcador.getElement();
    if (el) { el.classList.add('destaque'); setTimeout(function () { el.classList.remove('destaque'); }, 3500); }
  }

  function abrirPontoInt(id) {
    var p = est.pontosInt.get(id);
    if (!p) return;
    var d = p.d;
    var cat = CAT_PONTO[d.categoria] || CAT_PONTO.OUTRO;
    var dl = UI.el('dl', { classe: 'dados' });
    function linha(rot, valor) { dl.appendChild(UI.el('dt', { texto: rot })); var dd = UI.el('dd', null, [valor]); dl.appendChild(dd); return dd; }
    linha('Categoria', cat.rotulo);
    if (d.descricao) linha('Descrição', d.descricao);
    linha('Coordenadas', blocoCoordenadas(d.lat, d.lng));
    if (d.categoria === 'RISCO') linha('Alarme de proximidade', 'raio de ' + Math.round(d.raio_m || RAIO_ALERTA_PADRAO) + ' m');
    var alt = linha('Altitude', UI.el('span', { classe: 'muted', texto: 'consultando o modelo de terreno…' }));
    linha('Registrado', C.hora(d.criado_em) + ' por ' + d.criado_por_nome);
    if (d.relatado_por_nome) linha('Relatado por', d.relatado_por_nome + ' (participante)');
    if (d.atualizado_por_nome && d.atualizado_em !== d.criado_em) linha('Alterado', C.hora(d.atualizado_em) + ' por ' + d.atualizado_por_nome);
    var foto = d.foto_id && est.fotos.get(d.foto_id);
    var blocoFoto = foto ? UI.el('div', { classe: 'ponto-foto' }, [miniatura(foto, [foto.id])]) : null;
    var ativa = est.op.status === 'ativa';
    var editavel = !est.op.dados_apagados_em;
    var fechar = UI.abrirModal(UI.el('div', { classe: 'detalhe-ponto' }, [
      UI.el('h2', { id: 'modal-titulo' }, [UI.el('span', { classe: 'mk-poi poi-' + d.categoria }, [UI.el('span', { texto: cat.letra })]), ' ' + d.titulo]),
      dl,
      blocoFoto,
      UI.el('div', { classe: 'modal-acoes acoes-detalhe' }, [
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Ver no mapa', onclick: function () { fechar(); verPontoNoMapa(d); } }),
        ativa ? UI.el('button', { classe: 'btn', type: 'button', id: 'ponto-destino', texto: '🧭 Enviar como destino', onclick: function () { fechar(); abrirEnviarDestino({ nome: d.titulo, lat: d.lat, lng: d.lng, ponto_id: d.id }); } }) : null,
        editavel ? UI.el('button', { classe: 'btn', type: 'button', texto: 'Editar', onclick: function () { fechar(); abrirFormPontoInt(d); } }) : null,
        ativa ? UI.el('button', { classe: 'btn', type: 'button', texto: foto ? 'Trocar foto' : 'Anexar foto', onclick: function () { fechar(); anexarFotoPonto(d); } }) : null,
        window.Ferramentas ? UI.el('button', { classe: 'btn', type: 'button', id: 'ponto-aneis', texto: window.Ferramentas.temAneis(d.id) ? '◎ Tirar anéis de distância' : '◎ Anéis de distância',
          onclick: function () { fechar(); window.Ferramentas.alternarAneis({ id: d.id, lat: d.lat, lng: d.lng, nome: d.titulo }); } }) : null,
        UI.el('button', { classe: 'btn btn-perigo', type: 'button', id: 'ponto-excluir', texto: 'Excluir', onclick: function () { fechar(); excluirPontoInt(d); } }),
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
      ]),
    ]));
    altitudeEm(d.lat, d.lng).then(function (m) {
      alt.textContent = m == null ? 'indisponível (sem conexão com o modelo de terreno)' : '≈ ' + Math.round(m).toLocaleString('pt-BR') + ' m (modelo de terreno, aproximado)';
    });
  }

  function anexarFotoPonto(d) {
    abrirRegistrarFoto(async function (foto) {
      try {
        var res = await C.rpc('salvar_ponto', { p_operacao: est.op.id, p_id: d.id, p_dados: { foto_id: foto.id } });
        aplicarPontos([res]);
        UI.aviso('Foto anexada ao ponto "' + res.titulo + '".', 'ok');
      } catch (e) {
        UI.aviso('A foto foi salva, mas não foi anexada ao ponto: ' + e.message, 'erro', 8000);
      }
    });
  }

  async function excluirPontoInt(d) {
    var r = await UI.confirmar({
      titulo: 'Excluir o ponto "' + d.titulo + '"?',
      texto: 'O ponto some do mapa de todos os responsáveis. Uma foto anexada continua na galeria.',
      ok: 'Excluir ponto',
      perigo: true,
    });
    if (!r) return;
    try {
      await C.rpc('excluir_ponto', { p_id: d.id });
      var p = est.pontosInt.get(d.id);
      if (p && p.marcador) p.marcador.remove();
      if (p && p.circulo) p.circulo.remove();
      est.pontosInt.delete(d.id);
      renderizarAreas();
      UI.aviso('Ponto excluído.', 'ok');
    } catch (e) {
      UI.aviso(e.codigo === 'sem_permissao' ? 'Só quem marcou o ponto, quem criou a operação ou um administrador pode excluí-lo.' : e.message, 'erro', 7000);
    }
  }

  // Relato de um participante vira ponto de interesse (fica registrado quem relatou).
  function pontoDoRelato(m) {
    var mapa = { PISTA: 'VESTIGIO', VESTIGIO: 'VESTIGIO', OBJETO: 'VESTIGIO', OBSTACULO: 'RISCO', AJUDA: 'POSSIVEL_LOCALIZACAO' };
    abrirFormPontoInt({
      categoria: mapa[m.categoria] || 'OUTRO',
      titulo: resumir(m.texto, 80),
      descricao: m.texto,
      lat: m.lat, lng: m.lng,
      mensagem_id: m.id,
      relatado_por_nome: nomeDoParticipante(m.participante_id, m.remetente_nome),
    });
  }

  /* ---------- Destino (navegação do participante) -------------------- */
  function participantesNavegaveis() {
    return Array.from(est.participantes.values())
      .filter(function (p) { return !p.dados.removido && tipoDe(p.dados) !== 'responsavel'; })
      .sort(function (a, b) { return a.dados.nome.localeCompare(b.dados.nome, 'pt-BR'); });
  }

  // alvo: { nome, lat, lng, ponto_id?, participantes?: [ids pré-marcados] }
  function abrirEnviarDestino(alvo) {
    if (!est.op || est.op.status !== 'ativa') return;
    var lista = participantesNavegaveis();
    var pre = new Set(alvo.participantes || []);
    var nome = UI.el('input', { classe: 'campo', id: 'destino-nome', maxlength: '80', value: alvo.nome || 'Destino' });
    var caixas = UI.el('div', { classe: 'lista-destino' }, lista.length ? lista.map(function (p) {
      var atual = est.destinos.get(p.id);
      return UI.el('label', { classe: 'linha-opcao' }, [
        UI.el('input', { type: 'checkbox', value: p.id, checked: pre.has(p.id) ? true : null }),
        ' ' + p.dados.nome + ' (' + TIPOS[tipoDe(p.dados)].rotulo.toLowerCase() + ')',
        atual ? UI.el('small', { classe: 'muted', texto: ' — hoje indo para: ' + atual.nome }) : null,
      ]);
    }) : [UI.el('p', { classe: 'muted', texto: 'Nenhum participante ativo nesta operação.' })]);
    var erro = UI.el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var btn = UI.el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'destino-enviar', texto: 'Enviar destino' });
    var modos = UI.el('div', { classe: 'opcoes-modo', role: 'radiogroup', 'aria-label': 'Como o participante vai até lá' },
      Object.keys(window.Rotas.MODOS).map(function (k, i) {
        var m = window.Rotas.MODOS[k];
        return UI.el('label', { classe: 'opcao-modo' }, [
          UI.el('input', { type: 'radio', name: 'destino-modo', value: k, checked: i === 0 ? true : null }),
          UI.el('span', null, [UI.el('strong', { texto: m.icone + ' ' + m.rotulo }), UI.el('small', { texto: m.descricao })]),
        ]);
      }));
    var form = UI.el('form', { novalidate: true }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Enviar destino' }),
      UI.el('p', { classe: 'ajuda', texto: 'O celular de cada participante escolhido mostra o destino no mapa, a distância em linha reta e a direção. Coordenadas: ' + C.coord(alvo.lat) + ', ' + C.coord(alvo.lng) + '.' }),
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'destino-nome', texto: 'Nome do destino (o participante vê este nome)' }), nome]),
      UI.el('div', { classe: 'grupo' }, [UI.el('span', { classe: 'rotulo', texto: 'Rota até lá (o celular calcula por ruas, caminhos e trilhas)' }), modos]),
      UI.el('div', { classe: 'grupo' }, [
        UI.el('div', { classe: 'linha-rotulo' }, [UI.el('span', { classe: 'rotulo', texto: 'Para quem' }),
          lista.length ? UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Marcar todos', onclick: function () { caixas.querySelectorAll('input').forEach(function (c) { c.checked = true; }); } }) : null]),
        caixas,
      ]),
      erro,
      UI.el('div', { classe: 'modal-acoes' }, [UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }), btn]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var ids = Array.from(caixas.querySelectorAll('input:checked')).map(function (c) { return c.value; });
      var modoSel = (form.querySelector('input[name="destino-modo"]:checked') || {}).value || 'a_pe';
      var n = nome.value.replace(/\s+/g, ' ').trim();
      if (!n) { erro.textContent = 'Informe o nome do destino.'; erro.hidden = false; return; }
      if (!ids.length) { erro.textContent = 'Escolha pelo menos um participante.'; erro.hidden = false; return; }
      btn.disabled = true;
      var ok = 0, falhas = [];
      for (var i = 0; i < ids.length; i++) {
        try {
          var args = { p_participante: ids[i], p_nome: n, p_lat: alvo.lat, p_lng: alvo.lng, p_ponto: alvo.ponto_id || null, p_modo: modoSel };
          var d;
          try {
            d = await C.rpc('definir_destino', args);
          } catch (e1) {
            if (e1.codigo !== 'funcao_ausente') throw e1;
            delete args.p_modo;   // banco sem a migração 005: envia sem o modo
            d = await C.rpc('definir_destino', args);
          }
          est.destinos.set(d.participante_id, d);
          ok++;
        } catch (e) {
          var p = est.participantes.get(ids[i]);
          falhas.push((p ? p.dados.nome : '?') + ': ' + e.message);
        }
      }
      fechar(true);
      if (ok) UI.aviso('Destino "' + n + '" enviado a ' + ok + ' participante(s). Eles veem a distância e a direção no celular.', 'ok', 7000);
      if (falhas.length) UI.aviso('Não enviado para ' + falhas.join('; '), 'erro', 10000);
      if (est.selecionado) atualizarFicha();
    });
    var fechar = UI.abrirModal(form);
  }

  // Escolher o destino: um ponto de interesse ou um local tocado no mapa.
  function escolherDestino(participantes) {
    var pontos = Array.from(est.pontosInt.values()).map(function (p) { return p.d; });
    var fechar = UI.abrirModal(UI.el('div', null, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Enviar destino' }),
      UI.el('p', { classe: 'ajuda', texto: 'Escolha um ponto de interesse ou toque no mapa.' }),
      UI.el('button', { classe: 'btn btn-escuro', type: 'button', id: 'destino-no-mapa', texto: 'Escolher no mapa', onclick: function () {
        fechar(); iniciarDesenho('destino', { participantes: participantes || [] });
      } }),
      pontos.length ? UI.el('ul', { classe: 'lista-areas lista-escolha' }, pontos.map(function (d) {
        var cat = CAT_PONTO[d.categoria] || CAT_PONTO.OUTRO;
        return UI.el('li', null, [UI.el('button', { classe: 'item-area', type: 'button', onclick: function () {
          fechar(); abrirEnviarDestino({ nome: d.titulo, lat: d.lat, lng: d.lng, ponto_id: d.id, participantes: participantes });
        } }, [UI.el('span', { classe: 'mk-poi poi-' + d.categoria }, [UI.el('span', { texto: cat.letra })]),
          UI.el('span', { classe: 'item-area-txt' }, [UI.el('strong', { texto: d.titulo }), UI.el('small', { classe: 'muted', texto: cat.rotulo })])])]);
      })) : UI.el('p', { classe: 'muted', texto: 'Nenhum ponto de interesse marcado ainda.' }),
      UI.el('div', { classe: 'modal-acoes' }, [UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } })]),
    ]));
  }

  async function encerrarDestinoPainel(d) {
    var r = await UI.confirmar({ titulo: 'Encerrar a navegação?', texto: 'O participante deixa de ver o destino "' + d.nome + '".', ok: 'Encerrar navegação' });
    if (!r) return;
    try {
      await C.rpc('encerrar_destino', { p_destino: d.id });
      est.destinos.delete(d.participante_id);
      if (est.selecionado) atualizarFicha();
      UI.aviso('Navegação encerrada.', 'ok');
    } catch (e) { UI.aviso(e.message, 'erro'); }
  }

  // Na ficha aberta: linha tracejada do participante até o destino dele.
  function desenharLinhaDestino() {
    if (est.linhaDestino) { est.linhaDestino.remove(); est.linhaDestino = null; }
    if (est.marcaDestino) { est.marcaDestino.remove(); est.marcaDestino = null; }
    var d0 = est.mapa && est.selecionado && !$('ficha').hidden ? est.destinos.get(est.selecionado) : null;
    if (!d0) limparRotaFicha();
    if (!est.mapa || !est.selecionado || $('ficha').hidden) return;
    var d = est.destinos.get(est.selecionado);
    if (!d) return;
    est.marcaDestino = L.marker([d.lat, d.lng], {
      icon: L.divIcon({ className: 'mk-destino-wrap', html: '<div class="mk-destino">🧭</div>', iconSize: [0, 0] }),
      interactive: false, keyboard: false, zIndexOffset: 400,
    }).addTo(est.mapa);
    var p = est.participantes.get(est.selecionado);
    var pos = p && posicaoAtual(p);
    if (pos) est.linhaDestino = L.polyline([[pos.lat, pos.lng], [d.lat, d.lng]], { color: '#facc15', weight: 2, dashArray: '4 8', opacity: 0.6, interactive: false }).addTo(est.mapa);
    if (pos) rotaDaFicha(est.selecionado, d, pos);
  }

  /* ---------- Rota por caminhos reais (ficha) ------------------------- */
  // A ficha mostra a rota calculada da posição do participante até o destino dele
  // (mesmo serviço e mesmo modo que o celular dele usa). Recalcula se ele andar
  // mais de 100 m ou a cada 5 min.
  function rotaDaFicha(pid, d, pos) {
    var modo = d.modo || 'a_pe';
    var chave = d.id + ':' + modo;
    var c = est.rotasFicha.get(chave);
    var longe = c && c.origem && window.GPS.distancia(c.origem[0], c.origem[1], pos.lat, pos.lng) > 100;
    var velha = c && Date.now() - c.em > 5 * 60000;
    if (!c || ((longe || velha) && !c.calculando && Date.now() - c.em > 30000)) {
      c = { calculando: true, em: Date.now(), origem: [pos.lat, pos.lng], rota: c ? c.rota : null, erro: null };
      est.rotasFicha.set(chave, c);
      window.Rotas.calcular({ origem: [pos.lat, pos.lng], destino: [d.lat, d.lng], modo: modo }).then(function (r) {
        c.calculando = false;
        c.em = Date.now();
        if (r.ok) { c.rota = r.rota; c.erro = null; } else { c.erro = r.mensagem; }
        if (est.selecionado === pid && !$('ficha').hidden) { est.rotaFichaChave = null; desenharRotaFicha(chave, c); atualizarResumoRotaFicha(c); }
      });
    }
    desenharRotaFicha(chave, c);
    atualizarResumoRotaFicha(c);
  }

  function desenharRotaFicha(chave, c) {
    if (!est.mapa) return;
    if (!est.camadaRotaFicha) est.camadaRotaFicha = L.layerGroup().addTo(est.mapa);
    var marca = chave + ':' + (c.rota ? c.rota.calculada_em : '');
    if (est.rotaFichaChave === marca) return;
    est.rotaFichaChave = marca;
    est.camadaRotaFicha.clearLayers();
    if (c.rota) window.Rotas.desenhar(est.camadaRotaFicha, c.rota, { peso: 4 });
  }

  function atualizarResumoRotaFicha(c) {
    var el = $('ficha-rota');
    if (!el) return;
    var txt = c.rota ? window.Rotas.resumo(c.rota) + (c.calculando ? ' (atualizando…)' : '') +
      (c.rota.avisos && c.rota.avisos.length ? ' · ' + c.rota.avisos.join(' ') : '')
      : c.calculando ? 'Calculando a rota por caminhos…' : 'Rota por caminhos indisponível: ' + (c.erro || '') ;
    if (el.textContent !== txt) el.textContent = txt;
    el.hidden = false;
  }

  function limparRotaFicha() {
    if (est.camadaRotaFicha) est.camadaRotaFicha.clearLayers();
    est.rotaFichaChave = null;
    var el = $('ficha-rota');
    if (el) el.hidden = true;
  }

  /* ---------- Lista de setores e pontos ------------------------------ */
  function abrirAreas() {
    if (!est.op) return;
    fecharCentral();
    if (telaPequena() && !$('ficha').hidden) fecharFicha();
    fecharMenu(false);
    $('painel-areas').hidden = false;
    document.body.classList.add('areas-aberta');
    renderizarAreas();
  }

  function fecharAreas() {
    var c = $('painel-areas');
    if (!c || c.hidden) return;
    c.hidden = true;
    document.body.classList.remove('areas-aberta');
  }

  function renderizarAreas() {
    var ulS = $('lista-setores'), ulP = $('lista-pontos-int');
    if (!ulS) return;
    $('qtd-setores').textContent = String(est.setores.size);
    $('qtd-pontos-int').textContent = String(est.pontosInt.size);
    if ($('painel-areas').hidden) return;
    var editavel = est.op && !est.op.dados_apagados_em;
    ['areas-novo-raio', 'areas-novo-poligono', 'areas-novo-ponto'].forEach(function (i) { $(i).hidden = !editavel; });
    ulS.innerHTML = '';
    $('setores-vazio').hidden = est.setores.size > 0;
    est.setores.forEach(function (s) {
      var d = s.d;
      ulS.appendChild(UI.el('li', null, [UI.el('button', { classe: 'item-area', type: 'button', 'data-setor': d.id, onclick: function () { abrirSetor(d.id); } }, [
        UI.el('span', { classe: 'chip-cor', style: 'background:' + d.cor }),
        UI.el('span', { classe: 'item-area-txt' }, [
          UI.el('strong', { texto: d.nome }),
          UI.el('small', { classe: 'muted', texto: nomeResponsavelSetor(d) + ' · ' + formatarArea(areaSetorM2(d)) }),
        ]),
        UI.el('span', { classe: 'selo ' + STATUS_SETOR[d.status].selo, texto: STATUS_SETOR[d.status].rotulo }),
      ])]));
    });
    ulP.innerHTML = '';
    $('pontos-int-vazio').hidden = est.pontosInt.size > 0;
    est.pontosInt.forEach(function (p) {
      var d = p.d;
      var cat = CAT_PONTO[d.categoria] || CAT_PONTO.OUTRO;
      ulP.appendChild(UI.el('li', null, [UI.el('button', { classe: 'item-area', type: 'button', 'data-ponto': d.id, onclick: function () { abrirPontoInt(d.id); } }, [
        UI.el('span', { classe: 'mk-poi poi-' + d.categoria }, [UI.el('span', { texto: cat.letra })]),
        UI.el('span', { classe: 'item-area-txt' }, [
          UI.el('strong', { texto: d.titulo }),
          UI.el('small', { classe: 'muted', texto: cat.rotulo + ' · ' + C.hora(d.criado_em, false) + ' · ' + d.criado_por_nome }),
        ]),
      ])]));
    });
  }

  /* ---------- Altitude pelo modelo digital de terreno ---------------- */
  // Ladrilhos "Terrarium" (Terrain Tiles / AWS Open Data): altura = R*256 + G + B/256 − 32768.
  var cacheDem = new Map();
  function ladrilhoDem(z, x, y) {
    var chave = z + '/' + x + '/' + y;
    if (cacheDem.has(chave)) return cacheDem.get(chave);
    var p = new Promise(function (resolve) {
      var img = new Image();
      var t = setTimeout(function () { resolve(null); }, 10000);
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        clearTimeout(t);
        try {
          var cv = document.createElement('canvas');
          cv.width = cv.height = 256;
          var cx = cv.getContext('2d');
          cx.drawImage(img, 0, 0);
          resolve(cx.getImageData(0, 0, 256, 256).data);
        } catch (e) { resolve(null); }
      };
      img.onerror = function () { clearTimeout(t); resolve(null); };
      img.src = URL_DEM.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    });
    p.then(function (v) { if (!v) cacheDem.delete(chave); });
    cacheDem.set(chave, p);
    return p;
  }

  async function altitudeEm(lat, lng) {
    var z = 13, n = Math.pow(2, z);
    var x = (lng + 180) / 360 * n;
    var r = lat * Math.PI / 180;
    var y = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
    var tx = Math.floor(x), ty = Math.floor(y);
    var px = Math.min(255, Math.floor((x - tx) * 256)), py = Math.min(255, Math.floor((y - ty) * 256));
    var dados = await ladrilhoDem(z, tx, ty);
    if (!dados) return null;
    var i = (py * 256 + px) * 4;
    return dados[i] * 256 + dados[i + 1] + dados[i + 2] / 256 - 32768;
  }

  /* ---------- Relevo em 3D (MapLibre GL, carregado só quando aberto) -- */
  var MAPLIBRE = {
    js: 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
    jsSri: 'sha384-SYKAG6cglRMN0RVvhNeBY0r3FYKNOJtznwA0v7B5Vp9tr31xAHsZC0DqkQ/pZDmj',
    css: 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
    cssSri: 'sha384-MinO0mNliZ3vwppuPOUnGa+iq619pfMhLVUXfC4LHwSCvF9H+6P/KO4Q7qBOYV5V',
  };
  var carregandoMapLibre = null;
  function carregarMapLibre() {
    if (window.maplibregl) return Promise.resolve();
    if (carregandoMapLibre) return carregandoMapLibre;
    carregandoMapLibre = new Promise(function (resolve, reject) {
      var css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = MAPLIBRE.css; css.integrity = MAPLIBRE.cssSri; css.crossOrigin = 'anonymous';
      document.head.appendChild(css);
      var sc = document.createElement('script');
      sc.src = MAPLIBRE.js; sc.integrity = MAPLIBRE.jsSri; sc.crossOrigin = 'anonymous';
      sc.onload = function () { resolve(); };
      sc.onerror = function () { carregandoMapLibre = null; reject(new Error('não foi possível carregar a biblioteca 3D')); };
      document.head.appendChild(sc);
    });
    return carregandoMapLibre;
  }

  function suportaWebGL() {
    try {
      var c = document.createElement('canvas');
      return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
    } catch (e) { return false; }
  }

  var BASES_3D = {
    osm: { tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], maxzoom: 19, attribution: '© OpenStreetMap' },
    topo: { tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'], maxzoom: 17, attribution: '© OpenStreetMap, SRTM | © OpenTopoMap (CC-BY-SA)' },
    satelite: { tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], maxzoom: 19, attribution: 'Imagens © Esri, Maxar, Earthstar Geographics' },
  };

  async function abrirRelevo3D() {
    if (!est.mapa) return;
    fecharMenu(false);
    cancelarDesenho();
    var caixa = $('visao-3d');
    caixa.hidden = false;
    document.body.classList.add('visao-3d-aberta');
    var nota = $('visao-3d-nota');
    nota.textContent = 'Carregando o relevo em 3D…';
    if (!suportaWebGL()) {
      nota.textContent = 'Este aparelho ou navegador não tem suporte a gráficos 3D (WebGL). Use o mapa "Topográfico (curvas de nível)" no menu Ferramentas.';
      return;
    }
    try {
      await carregarMapLibre();
    } catch (e) {
      nota.textContent = 'Não foi possível abrir o 3D: ' + e.message + '. Verifique a internet. O mapa normal continua funcionando.';
      return;
    }
    if (caixa.hidden) return;
    var base = BASES_3D[est.camadaAtual] || BASES_3D.osm;
    var c = est.mapa.getCenter();
    var mapa3d = new window.maplibregl.Map({
      container: 'visao-3d-mapa',
      style: {
        version: 8,
        sources: {
          base: { type: 'raster', tiles: base.tiles, tileSize: 256, maxzoom: base.maxzoom, attribution: base.attribution },
          dem: { type: 'raster-dem', tiles: [URL_DEM], encoding: 'terrarium', tileSize: 256, maxzoom: 15, attribution: 'Elevação: Terrain Tiles (Mapzen/AWS) — SRTM e outras fontes' },
        },
        layers: [
          { id: 'base', type: 'raster', source: 'base' },
          { id: 'sombreamento', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.45 } },
        ],
        terrain: { source: 'dem', exaggeration: 1.5 },
      },
      center: [c.lng, c.lat],
      zoom: Math.max(2, est.mapa.getZoom() - 1),
      pitch: 60,
      maxPitch: 80,
      attributionControl: { compact: true },
    });
    mapa3d.addControl(new window.maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    est.visao3d = { mapa: mapa3d, marcadores: [], popup: null };
    mapa3d.on('load', function () {
      if (!est.visao3d || est.visao3d.mapa !== mapa3d) return;
      adicionarDados3D();
      nota.textContent = 'Relevo 3D real a partir do modelo digital de terreno (Terrain Tiles/AWS — SRTM e outras fontes, resolução de cerca de 30 m), com exagero vertical de 1,5×. ' +
        'Arraste com dois dedos (ou com o botão direito) para girar e inclinar; toque no terreno para ver a altitude. Mostra as posições do momento em que foi aberto: toque em "Atualizar posições".';
    });
    mapa3d.on('error', function (ev) {
      if (ev && ev.sourceId === 'dem' && !est.visao3d.avisouDem) {
        est.visao3d.avisouDem = true;
        UI.aviso('Parte do relevo não carregou (sem conexão com o modelo de terreno).', 'erro', 7000);
      }
    });
    mapa3d.on('click', async function (e) {
      var m = await altitudeEm(e.lngLat.lat, e.lngLat.lng);
      if (!est.visao3d || est.visao3d.mapa !== mapa3d) return;
      if (est.visao3d.popup) est.visao3d.popup.remove();
      est.visao3d.popup = new window.maplibregl.Popup({ closeButton: true, className: 'popup-3d' })
        .setLngLat(e.lngLat)
        .setText((m == null ? 'Altitude indisponível' : 'Altitude ≈ ' + Math.round(m).toLocaleString('pt-BR') + ' m') + ' · ' + C.coord(e.lngLat.lat) + ', ' + C.coord(e.lngLat.lng))
        .addTo(mapa3d);
    });
  }

  // Setores, trilhas, participantes e pontos sobre o relevo (retrato do momento).
  function adicionarDados3D() {
    var v = est.visao3d;
    if (!v) return;
    var m = v.mapa;
    var setores = { type: 'FeatureCollection', features: [] };
    est.setores.forEach(function (s) {
      var anel = verticesSetor(s.d).map(function (p) { return [p[1], p[0]]; });
      anel.push(anel[0]);
      setores.features.push({ type: 'Feature', properties: { cor: s.d.cor }, geometry: { type: 'Polygon', coordinates: [anel] } });
    });
    var trilhas = { type: 'FeatureCollection', features: [] };
    est.participantes.forEach(function (p) {
      if (!p.trilhaVisivel) return;
      trilhaDe(p).segmentos.forEach(function (seg) {
        if (seg.length < 2) return;
        trilhas.features.push({ type: 'Feature', properties: { cor: p.cor }, geometry: { type: 'LineString', coordinates: seg.map(function (q) { return [q[1], q[0]]; }) } });
      });
    });
    if (m.getSource('setores')) {
      m.getSource('setores').setData(setores);
      m.getSource('trilhas').setData(trilhas);
    } else {
      m.addSource('setores', { type: 'geojson', data: setores });
      m.addLayer({ id: 'setores-fundo', type: 'fill', source: 'setores', paint: { 'fill-color': ['get', 'cor'], 'fill-opacity': 0.18 } });
      m.addLayer({ id: 'setores-borda', type: 'line', source: 'setores', paint: { 'line-color': ['get', 'cor'], 'line-width': 2.5 } });
      m.addSource('trilhas', { type: 'geojson', data: trilhas });
      m.addLayer({ id: 'trilhas-halo', type: 'line', source: 'trilhas', paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.5 } });
      m.addLayer({ id: 'trilhas', type: 'line', source: 'trilhas', paint: { 'line-color': ['get', 'cor'], 'line-width': 3.5 } });
    }
    v.marcadores.forEach(function (mk) { mk.remove(); });
    v.marcadores = [];
    est.participantes.forEach(function (p) {
      var pos = posicaoAtual(p);
      if (!pos || p.dados.removido) return;
      var el = document.createElement('div');
      el.className = 'mk3d' + (posicaoAntiga(p) ? ' antigo' : '');
      el.innerHTML = htmlSimbolo(p);
      el.title = nomeExibido(p) + ' — posição ' + C.idade(pos.t);
      v.marcadores.push(new window.maplibregl.Marker({ element: el }).setLngLat([pos.lng, pos.lat]).addTo(m));
    });
    est.pontosInt.forEach(function (pi) {
      var d = pi.d, cat = CAT_PONTO[d.categoria] || CAT_PONTO.OUTRO;
      var el = document.createElement('div');
      el.className = 'mk3d mk3d-poi';
      el.innerHTML = '<div class="mk-poi poi-' + C.esc(d.categoria) + '"><span>' + C.esc(cat.letra) + '</span></div>';
      el.title = cat.rotulo + ': ' + d.titulo;
      v.marcadores.push(new window.maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([d.lng, d.lat]).addTo(m));
    });
  }

  function fecharRelevo3D() {
    var caixa = $('visao-3d');
    if (!caixa || caixa.hidden) return;
    caixa.hidden = true;
    document.body.classList.remove('visao-3d-aberta');
    if (est.visao3d) {
      try { est.visao3d.mapa.remove(); } catch (e) { /* ignora */ }
      est.visao3d = null;
    }
    $('visao-3d-mapa').innerHTML = '';
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

  var TEXTO_MINHA_POS = {
    desligada: 'desligada',
    iniciando: 'ligando…',
    ativa: 'ligada',
    sem_sinal: 'ligada · procurando sinal',
    bloqueada: 'bloqueada no navegador',
    indisponivel: 'indisponível',
    outro_aparelho: 'desligada · outro aparelho seu já compartilha',
  };

  // O botão só aparece como "ligado" com a permissão concedida E coordenadas chegando.
  function atualizarBotaoMinhaPos() {
    var b = $('btn-minha-pos');
    if (!b) return;
    var e = est.minhaPosEstado;
    var ativa = e === 'ativa';
    b.setAttribute('aria-pressed', String(est.compartilhando || est.iniciandoMinhaPos));
    b.classList.toggle('ligado', ativa);
    b.classList.toggle('parcial', e === 'sem_sinal' || e === 'iniciando');
    b.classList.toggle('bloqueado', e === 'bloqueada' || e === 'indisponivel');
    $('ferramentas').classList.toggle('compartilhando', ativa);
    var txt = TEXTO_MINHA_POS[e] || e;
    if (ativa && est.gpsMeu === 'fraco') txt = 'ligada · sinal fraco';
    $('minha-pos-estado').textContent = txt;
    b.title = e === 'bloqueada' ? 'A localização está bloqueada para este site no navegador. Toque para ver como liberar.'
      : est.compartilhando ? 'Sua posição está sendo compartilhada com a equipe da operação. Toque para desligar.'
        : 'Ligar o compartilhamento da sua posição';
  }

  function chaveMinhaPosOff() { return 'gbs-minha-pos-off:' + (est.op ? est.op.id : ''); }
  function chaveMinhaPosAqui() { return 'gbs-minha-pos-aqui:' + (est.op ? est.op.id : ''); }

  // O mesmo responsável com o painel aberto em dois aparelhos (ex.: computador do
  // posto de comando e celular): só um compartilha, para a trilha não "pular"
  // entre os dois. Se outro aparelho dele já está enviando, este não liga sozinho.
  function outroAparelhoCompartilhando() {
    var p = est.meuPart && est.participantes.get(est.meuPart);
    if (!p) return false;
    var d = p.dados;
    var recente = d.ultima_posicao_em && C.agora() - C.paraMs(d.ultima_posicao_em) < 120000;
    var aqui = Date.now() - Number(C.local.ler(chaveMinhaPosAqui(), 0) || 0) < 180000;
    return Boolean(d.rastreando && recente && !aqui);
  }

  // Ao abrir (ou criar) uma operação ativa: liga sozinha, se o responsável não
  // desligou nesta operação e se o navegador não bloqueou a localização.
  async function iniciarMinhaPosicaoAuto() {
    if (!est.op || est.op.status !== 'ativa') return;
    if (!('geolocation' in navigator) || !window.isSecureContext) {
      est.minhaPosEstado = 'indisponivel';
      atualizarBotaoMinhaPos();
      return;
    }
    await verificarPermissaoMinha();
    if (C.local.ler(chaveMinhaPosOff(), false)) {
      est.minhaPosEstado = 'desligada';
      atualizarBotaoMinhaPos();
      return;
    }
    if (est.permissaoMinha === 'denied') {
      est.minhaPosEstado = 'bloqueada';
      atualizarBotaoMinhaPos();
      return;
    }
    if (!est.meuPart) await entrarComoResponsavel();
    if (outroAparelhoCompartilhando()) {
      est.minhaPosEstado = 'outro_aparelho';
      atualizarBotaoMinhaPos();
      return;
    }
    ligarMinhaPosicao(true);
  }

  // Permissions API: acompanha mudanças (ex.: o responsável liberou nas configurações).
  async function verificarPermissaoMinha() {
    var r = await window.GPS.consultarPermissao();
    est.permissaoMinha = r.estado;
    if (r.status && !est.statusPermissaoMinha) {
      est.statusPermissaoMinha = r.status;
      r.status.onchange = function () {
        est.permissaoMinha = r.status.state;
        if (!est.op || est.op.status !== 'ativa') return;
        if (est.permissaoMinha === 'granted' && est.minhaPosEstado === 'bloqueada' && !C.local.ler(chaveMinhaPosOff(), false)) {
          ligarMinhaPosicao(true);
        } else if (est.permissaoMinha === 'denied' && est.compartilhando) {
          pararMinhaPosicao(true);
          est.minhaPosEstado = 'bloqueada';
          atualizarBotaoMinhaPos();
        }
      };
    }
    if (est.permissaoMinha === 'granted' && est.minhaPosEstado === 'bloqueada' && est.op && est.op.status === 'ativa' &&
        !C.local.ler(chaveMinhaPosOff(), false)) {
      ligarMinhaPosicao(true);
    }
  }

  async function alternarMinhaPosicao() {
    if (est.compartilhando || est.iniciandoMinhaPos) {
      C.local.gravar(chaveMinhaPosOff(), true);   // escolha respeitada nesta operação
      pararMinhaPosicao(false);
      UI.aviso('Sua posição deixou de ser compartilhada.');
      return;
    }
    if (!est.op || est.op.status !== 'ativa') return;
    if (!('geolocation' in navigator) || !window.isSecureContext) {
      UI.aviso('Este navegador não oferece localização (é preciso abrir o painel por https://).', 'erro', 7000);
      return;
    }
    C.local.apagar(chaveMinhaPosOff());
    await verificarPermissaoMinha();
    if (est.permissaoMinha === 'denied') { mostrarComoLiberarMinha(); return; }
    ligarMinhaPosicao(false);
  }

  function mostrarComoLiberarMinha() {
    var inst = window.GPS.instrucoesLocalizacao('navegador');
    var fechar = UI.abrirModal(UI.el('div', null, [
      UI.el('h2', { id: 'modal-titulo', texto: inst.titulo }),
      UI.el('ol', { classe: 'perm-passos' }, inst.passos.map(function (t) { return UI.el('li', { texto: t }); })),
      UI.el('div', { classe: 'modal-acoes' }, [
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Verificar de novo', onclick: function () { fechar(); C.local.apagar(chaveMinhaPosOff()); ligarMinhaPosicao(false); } }),
      ]),
    ]));
  }

  // Liga a coleta: um único observador do GPS, nunca duplicado.
  async function ligarMinhaPosicao(automatico) {
    if (est.compartilhando || est.iniciandoMinhaPos || !est.op || est.op.status !== 'ativa') return;
    var opId = est.op.id;
    est.iniciandoMinhaPos = true;
    est.minhaPosEstado = 'iniciando';
    atualizarBotaoMinhaPos();
    prepararAudio();
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
      if (!est.op || est.op.id !== opId || est.op.status !== 'ativa') return;   // trocou de operação nesse meio-tempo
      if (C.local.ler(chaveMinhaPosOff(), false)) return;                     // desligou enquanto esperava
      if (!teste.ok && teste.codigo === 1) {
        est.minhaPosEstado = 'bloqueada';
        est.permissaoMinha = 'denied';
        if (!automatico) mostrarComoLiberarMinha();
        else UI.aviso('Sua localização está bloqueada neste navegador. Veja em Ferramentas › Minha posição.', 'erro', 8000);
        return;
      }
      est.compartilhando = true;
      est.filtroMeu.reiniciar();
      est.ultimoAceitoMeu = null;
      if (teste.ok) {
        processarMinhaPosicao(teste.pos);
        if (est.minhaPosEstado === 'iniciando') est.minhaPosEstado = 'sem_sinal';   // leitura descartada (antiga/inválida)
      } else {
        est.gpsMeu = teste.codigo === 2 ? 'indisponivel' : 'sem_sinal';
        est.minhaPosEstado = 'sem_sinal';
      }
      iniciarMeuWatch();
      pedirTelaLigada();
      enviarMeuSinal();
      UI.aviso(est.minhaPosEstado === 'ativa'
        ? 'Sua posição está sendo compartilhada com a equipe' + (automatico ? ' (ligada automaticamente — desligue em Ferramentas)' : '') + '. Mantenha o painel aberto.'
        : 'Compartilhamento ligado, mas ainda sem sinal de GPS.', est.minhaPosEstado === 'ativa' ? 'ok' : 'erro', 7000);
    } catch (e) {
      est.minhaPosEstado = 'desligada';
      UI.aviso(e.message, 'erro');
    } finally {
      est.iniciandoMinhaPos = false;
      atualizarBotaoMinhaPos();
    }
  }

  function iniciarMeuWatch() {
    if (est.watchId != null) return;
    est.meuWatchEm = Date.now();
    est.watchId = navigator.geolocation.watchPosition(processarMinhaPosicao, erroMeuGps, {
      enableHighAccuracy: true, maximumAge: 0, timeout: 30000,
    });
  }

  // Sem leituras por 90 s com o painel visível: reinicia o observador (sempre um só).
  function vigiarMeuGps() {
    if (!est.compartilhando || document.visibilityState !== 'visible' || est.gpsMeu === 'negado') return;
    var ultima = est.ultimoAceitoMeu ? est.ultimoAceitoMeu.recebidaEm || 0 : 0;
    if (Date.now() - Math.max(ultima, est.meuWatchEm) < CFG_GPS.reiniciarMs) return;
    if (est.watchId != null) { navigator.geolocation.clearWatch(est.watchId); est.watchId = null; }
    iniciarMeuWatch();
  }

  function processarMinhaPosicao(pos) {
    if (!est.compartilhando) return;
    var r = est.filtroMeu.processar(pos);
    if (r.atual) {
      var a = r.atual;
      est.ultimoAceitoMeu = { lat: a.lat, lng: a.lng, prec: a.prec, t: a.t, recebidaEm: a.recebidaEm };
      est.gpsMeu = a.prec != null && a.prec > 50 ? 'fraco' : 'ok';
      est.minhaPosEstado = 'ativa';
    }
    if (r.pontos.length) {
      r.pontos.forEach(function (p) { est.filaMinha.push({ id: C.uuid(), lat: p.lat, lng: p.lng, prec: p.prec, t: p.t }); });
      if (est.filaMinha.length > 2000) est.filaMinha.splice(0, est.filaMinha.length - 2000);
      // envio logo em seguida (o primeiro na hora; ~1 s em veículo; ~1,5 s a pé), sem adiar o que já está marcado
      if (!est.timerMinhaFila) {
        est.timerMinhaFila = setTimeout(function () { est.timerMinhaFila = null; enviarMinhaFila(); },
          !est.enviouMinhaAlguma ? 300 : r.rapido ? CFG_GPS.envioRapidoMs : CFG_GPS.envioPeMs);
      }
    }
    atualizarBotaoMinhaPos();
  }

  // Parado no mesmo lugar, o navegador pode não avisar novas leituras; então
  // pedimos uma leitura nova para a posição não ficar marcada como antiga.
  function lerPosicaoSeParado() {
    if (!est.compartilhando || !est.ultimoAceitoMeu) return;
    if (Date.now() - est.ultimoAceitoMeu.recebidaEm < 45000) return;
    navigator.geolocation.getCurrentPosition(processarMinhaPosicao, function () {}, {
      enableHighAccuracy: true, maximumAge: 0, timeout: 20000,
    });
  }

  function erroMeuGps(err) {
    if (err.code === 1) {
      est.gpsMeu = 'negado';
      est.minhaPosEstado = 'bloqueada';
    } else if (err.code === 2) {
      est.gpsMeu = 'indisponivel';
      est.minhaPosEstado = 'sem_sinal';
    } else if (!est.ultimoAceitoMeu || Date.now() - est.ultimoAceitoMeu.recebidaEm > 60000) {
      est.gpsMeu = 'sem_sinal';
      est.minhaPosEstado = 'sem_sinal';
    }
    est.filtroMeu.registrar(null, false, err.code === 1 ? 'negado' : err.code === 2 ? 'indisponivel' : 'sem_sinal');
    atualizarBotaoMinhaPos();
  }

  async function enviarMinhaFila() {
    if (est.enviandoMinha || !est.meuPart || !est.filaMinha.length) return;
    est.enviandoMinha = true;
    var lote = est.filaMinha.slice(0, 200);
    try {
      var desvio = C.agora() - Date.now();   // relógio do aparelho errado: converte para a hora do servidor
      var envio = Math.abs(desvio) < 30000 ? lote : lote.map(function (x) { return Object.assign({}, x, { t: Math.round(x.t + desvio) }); });
      var resp = await C.rpc('enviar_posicoes', { p_participante: est.meuPart, p_pontos: envio, p_gps: est.compartilhando ? est.gpsMeu : null }, 20000);
      if (resp && resp.inseridos < lote.length) est.filtroMeu.registrar(null, false, 'servidor_recusou');
      est.enviouMinhaAlguma = true;
      C.local.gravar(chaveMinhaPosAqui(), Date.now());   // este aparelho é o que compartilha
      var enviados = new Set(lote.map(function (x) { return x.id; }));
      est.filaMinha = est.filaMinha.filter(function (x) { return !enviados.has(x.id); });
      if (est.filaMinha.length) setTimeout(enviarMinhaFila, 300);
    } catch (e) {
      if (e.codigo === 'operacao_encerrada' || e.codigo === 'participante_invalido' || e.codigo === 'lote_invalido') {
        est.filaMinha = [];
        if (e.codigo === 'participante_invalido') est.meuPart = null;
      } else if (!est.timerMinhaFila) {
        est.timerMinhaFila = setTimeout(function () { est.timerMinhaFila = null; enviarMinhaFila(); }, 5000);
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
    clearTimeout(est.timerMinhaFila);
    est.timerMinhaFila = null;
    est.minhaPosEstado = 'desligada';
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

  // Diagnóstico das leituras do GPS deste aparelho (não é enviado a ninguém).
  function abrirDiagnosticoGps() {
    var f = est.filtroMeu;
    var caixa = UI.el('div', { classe: 'diag-tabela' });
    var info = UI.el('p', { classe: 'ajuda' });
    function render() {
      caixa.innerHTML = window.GPS.tabelaDiagnostico(f, 80);
      info.textContent = 'Minha posição: ' + (TEXTO_MINHA_POS[est.minhaPosEstado] || est.minhaPosEstado) + ' · permissão do navegador: ' +
        est.permissaoMinha + ' · na fila: ' + est.filaMinha.length + ' · ' +
        (f.resumo().map(function (x) { return x.texto + ': ' + x.qtd; }).join(' · ') || 'sem leituras ainda');
    }
    render();
    var timer = setInterval(render, 2000);
    var fechar = UI.abrirModal(UI.el('div', { classe: 'modal-diag' }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Diagnóstico do GPS (este aparelho)' }),
      UI.el('p', { classe: 'ajuda', texto: 'Mostra cada leitura do GPS e se ela entrou na trilha ou foi descartada, com o motivo. Fica só neste aparelho. ' +
        'Para ver o de um participante, peça que ele abra o link com "&diag=1" no fim.' }),
      info,
      caixa,
      UI.el('div', { classe: 'modal-acoes' }, [UI.el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]),
    ]), { aoFechar: function () { clearInterval(timer); } });
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

  /* ------------------------------------------------------------------ */
  /* Interface para as ferramentas de mapa (ferramentas.js)               */
  /* ------------------------------------------------------------------ */
  window.Painel = {
    mapa: function () { return est.mapa; },
    op: function () { return est.op; },
    usuario: function () { return est.usuario; },
    selecionado: function () { return est.selecionado; },
    participantes: function () { return Array.from(est.participantes.values()); },
    participante: function (id) { return est.participantes.get(id) || null; },
    nome: function (p) { return nomeExibido(p); },
    tipo: function (p) { return tipoDe(p.dados); },
    trilha: function (p) { return window.GPS.trilha(p.pontos, { precisaoTrilhaM: LIM.precisaoTrilhaM, objetos: true }); },
    posicao: function (p) { return posicaoAtual(p); },
    pontosInteresse: function () { return Array.from(est.pontosInt.values()).map(function (x) { return x.d; }); },
    setores: function () { return Array.from(est.setores.values()).map(function (x) { return x.d; }); },
    categorias: CAT_PONTO,
    raioAlertaPadrao: RAIO_ALERTA_PADRAO,
    formatoCoord: function () { return est.prefsMapa.coord || 'dec'; },
    minhaPosicao: function () { return obterMinhaPosicao(); },
    altitudeEm: altitudeEm,
    alarme: function () { alarme(); },
    iniciarDesenho: iniciarDesenhoExterno,
    marcarPonto: function (lat, lng, extra) { abrirFormPontoInt(Object.assign({ lat: lat, lng: lng }, extra || {})); },
    enviarDestino: function (lat, lng, nome) { abrirEnviarDestino({ nome: nome || 'Ponto marcado no mapa', lat: lat, lng: lng }); },
    criarSetor: function (pontos, nome) { abrirFormSetor(Object.assign({ forma: 'poligono', pontos: pontos }, nome ? { nome: nome.slice(0, 60) } : {})); },
    salvarPonto: function (dados) { return C.rpc('salvar_ponto', { p_operacao: est.op.id, p_id: null, p_dados: dados }).then(function (r) { aplicarPontos([r]); return r; }); },
    blocoCoordenadas: blocoCoordenadas,
    copiar: copiarTexto,
    fecharMenu: function () { fecharMenu(false); },
  };

  iniciar();
})();
