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
  var CHAVE_MSGS = 'gbs-civil-mensagens-pendentes';
  var CHAVE_VISTO = 'gbs-civil-conversa-vista';
  var EQUIPE_ATUAL_S = 120;          // posição de bombeiro com até 2 min = atual

  // Coleta x envio: o GPS é lido continuamente (watchPosition, eventos reais do
  // aparelho); o filtro (gps.js) decide quais leituras entram na trilha; os
  // pontos aceitos vão para uma fila local (sobrevive a falta de internet) e são
  // enviados logo: ~1 s em veículo, ~1,5 s a pé (vários pontos por envio).
  var CFG = {
    envioRapidoMs: 1000,         // em veículo: envia 1 s depois do ponto
    envioPeMs: 1500,             // a pé/parado: envia 1,5 s depois (junta os pontos desse intervalo)
    sinalVidaMs: 15000,          // "estou conectado" a cada 15 s
    semGpsMs: 60000,             // sem leitura por 60 s = "sem sinal"
    reiniciarGpsMs: 90000,       // sem leitura por 90 s com a tela aberta: reinicia a leitura do GPS
    reinclusaoMs: 20000,         // removido: verifica a cada 20 s se foi chamado de volta
    destinoMs: 15000,            // recuperação do destino (além do tempo real)
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
    msgPendentes: [],        // mensagens escritas aqui que ainda não chegaram ao servidor
    fotosLocais: new Map(),  // fotos na fila do aparelho (id → item)
    minhasFotos: [],         // fotos já registradas (servidor)
    urlsFotos: new Map(),    // caminho → link temporário
    enviandoFotos: false,
    alertaAtual: null,
    alertadas: new Set(),
    audio: null,
    swReg: null,
    finalizado: false,
    // mapa
    mapa: null,
    meuMarcador: null,
    meuCirculo: null,
    equipe: new Map(),        // id → marcador
    timerEquipe: null,
    jaEnquadrou: false,
    seguindo: true,
    conversaVistaAte: 0,
    // setores, pontos e navegação
    camadaExtras: null,
    destino: null,            // { id, nome, lat, lng, criado_em }
    marcaDestino: null,
    linhaDestino: null,
    rumo: null,               // direção para onde o celular aponta (bússola), em graus
    rumoEm: 0,
    ouvindoBussola: false,
    rafNav: null,
    destinoConfirmado: null,  // id do destino cuja chegada já foi confirmada ao servidor
    // rota por caminhos reais (rotas.js → /api/rota)
    modoNav: 'a_pe',
    rota: null,               // rota calculada (com destId e modo)
    rotaErro: null,
    rotaErroEm: 0,
    rotaCalcEm: 0,
    rotaCalculando: false,
    rotaForaCont: 0,
    camadaRota: null,
    falhasDestino: 0,
    destinoSemTempoReal: false,
    // GPS
    filtro: new window.GPS.Filtro(),
    permissao: 'desconhecido',  // granted | denied | prompt | desconhecido
    statusPermissao: null,
    watchIniciadoEm: 0,
    envioAgendadoPara: 0,
    timerReinclusao: null,
    motivoFim: null,
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
      return mostrarErro('O aplicativo não está configurado no servidor (variáveis do Supabase ausentes). Avise os bombeiros.');
    }
    if (!window.isSecureContext) {
      return mostrarErro('Esta página precisa ser aberta por um endereço seguro (https://).');
    }
    if (!('geolocation' in navigator)) {
      return mostrarErro('Este navegador não oferece acesso à localização. Use o Google Chrome atualizado.');
    }
    estado.token = lerToken();
    if (!estado.token) {
      return mostrarErro('Link incompleto. Abra o link completo enviado pelos bombeiros ou leia o QR Code novamente.');
    }

    try {
      estado.info = await C.rpc('info_operacao', { p_token: estado.token });
    } catch (e) {
      return mostrarErro(e.rede ? 'Sem conexão com a internet. Conecte-se e toque em TENTAR NOVAMENTE.' : e.message);
    }
    if (!estado.info) {
      return mostrarErro('Link de operação inválido. Peça um novo link aos bombeiros.');
    }
    if (!estado.info.ativa) {
      return finalizar('encerrada');
    }

    // Tela inicial
    $('ini-operacao').textContent = estado.info.operacao;
    var permiteMilitar = (estado.info.tipos_permitidos || []).indexOf('militar') !== -1;
    $('ini-tipo-escolha').hidden = !permiteMilitar;

    var salvo = C.local.ler(CHAVE_PART, null);
    if (salvo && salvo.token === estado.token) {
      $('ini-nome').value = salvo.nome || '';
      $('ini-cpf').value = mascararCpf(salvo.cpf || '');
      $('ini-tel').value = mascararTelefone(salvo.telefone || '');
      if (permiteMilitar && salvo.tipo) {
        var r = document.querySelector('input[name="tipo"][value="' + salvo.tipo + '"]');
        if (r) r.checked = true;
      }
      if (salvo.ativo) $('btn-iniciar').textContent = 'CONTINUAR';
      var fila = C.local.ler(CHAVE_FILA, null);
      if (fila && fila.participante_id === salvo.participante_id && Array.isArray(fila.pontos)) {
        estado.fila = fila.pontos;
      }
      var conf = C.local.ler(CHAVE_CONF, null);
      if (conf && conf.participante_id === salvo.participante_id && Array.isArray(conf.itens)) {
        estado.confPendentes = conf.itens;
        conf.itens.forEach(function (c) { estado.confirmadasLocal.add(c.id); });
      }
      var pm = C.local.ler(CHAVE_MSGS, null);
      if (pm && pm.participante_id === salvo.participante_id && Array.isArray(pm.itens)) estado.msgPendentes = pm.itens;
    } else {
      C.local.apagar(CHAVE_FILA);
      C.local.apagar(CHAVE_CONF);
      C.local.apagar(CHAVE_MSGS);
    }

    $('form-inicio').addEventListener('submit', aoIniciar);
    $('btn-saida').addEventListener('click', aoSolicitarSaida);
    $('form-msg').addEventListener('submit', aoEnviarMensagem);
    $('btn-encontrei').addEventListener('click', abrirEncontrei);
    $('btn-falar').addEventListener('click', abrirConversa);
    $('conversa-fechar').addEventListener('click', fecharConversa);
    $('btn-onde-estou').addEventListener('click', function () { estado.seguindo = true; centralizarEmMim(true); mostrarMinhasCoordenadas(); });
    $('nav-encerrar').addEventListener('click', encerrarNavegacao);
    $('nav-bussola-ativar').addEventListener('click', pedirBussola);
    document.querySelectorAll('.nav-modos [data-modo]').forEach(function (b) {
      b.addEventListener('click', function () { trocarModoNav(b.getAttribute('data-modo')); });
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !$('painel-conversa').hidden && !document.querySelector('.modal-fundo')) fecharConversa();
    });
    $('foto-camera').addEventListener('change', function (ev) { aoEscolherFoto(ev, true); });
    $('foto-galeria').addEventListener('change', function (ev) { aoEscolherFoto(ev, false); });
    $('ini-cpf').addEventListener('input', function () { this.value = mascararCpf(this.value); });
    $('ini-tel').addEventListener('input', function () { this.value = mascararTelefone(this.value); });
    document.querySelectorAll('input[name="tipo"]').forEach(function (r) { r.addEventListener('change', marcarOpcionais); });
    marcarOpcionais();
    $('opt-tela').addEventListener('change', function () {
      if (this.checked) pedirTelaLigada(); else liberarTelaLigada();
    });
    $('btn-notif').addEventListener('click', ativarNotificacoes);
    $('perm-verificar').addEventListener('click', verificarPermissaoDeNovo);
    $('perm-recarregar').addEventListener('click', function () { location.reload(); });
    $('status-acao').addEventListener('click', mostrarComoResolver);
    $('btn-voltar-busca').addEventListener('click', voltarParaBusca);
    $('btn-diag').addEventListener('click', abrirDiagnostico);
    $('btn-diag').hidden = !/(^|[&#?])diag=1(&|$)/.test(location.hash + '&' + location.search);

    await acompanharPermissao();
    if (estado.permissao === 'denied') mostrarPermissao('navegador');

    // Página recarregada (ou reaberta) por quem já estava na busca: retoma sozinha,
    // sem refazer o cadastro, quando a localização já está permitida.
    if (salvo && salvo.token === estado.token && salvo.participante_id && (salvo.ativo || salvo.removido)) {
      if (await retomarParticipacao(salvo)) return;
    }
    mostrarTela('inicio');
  }

  // Consulta a situação de quem já participava (sem criar sessão nova).
  async function retomarParticipacao(salvo) {
    var sessao = null;
    try { sessao = (await C.cliente.auth.getSession()).data.session; } catch (e) { /* sem sessão */ }
    if (!sessao) return false;
    var r;
    try {
      r = await C.rpc('sinal_vida', { p_participante: salvo.participante_id, p_rastreando: null, p_gps: null }, 12000);
    } catch (e) {
      return false;   // sem internet: mostra a tela inicial com CONTINUAR
    }
    estado.part = { participante_id: salvo.participante_id, nome: salvo.nome, tipo: salvo.tipo, operacao: estado.info.operacao };
    estado.cpf = salvo.cpf;
    estado.telefone = salvo.telefone;
    if (!r || r.status !== 'ativa') {
      finalizar(r && ['removido', 'liberado', 'inexistente'].indexOf(r.status) !== -1 ? r.status : 'encerrada');
      return true;
    }
    if (salvo.ativo && estado.permissao === 'granted') {
      mostrarTela('inicio');
      await entrarNaBusca({ nome: salvo.nome, tipo: salvo.tipo, cpf: salvo.cpf, tel: salvo.telefone });
      return true;
    }
    estado.part = null;
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Permissão de localização                                             */
  /* ------------------------------------------------------------------ */
  // Acompanha a permissão do navegador (Permissions API, quando existe): se a
  // pessoa liberar a localização nas configurações, a página percebe sozinha.
  async function acompanharPermissao() {
    var r = await window.GPS.consultarPermissao();
    estado.permissao = r.estado;
    if (r.status && !estado.statusPermissao) {
      estado.statusPermissao = r.status;
      r.status.onchange = function () {
        estado.permissao = r.status.state;
        aoMudarPermissao();
      };
    }
  }

  function aoMudarPermissao() {
    if (estado.permissao === 'granted') {
      if (!$('tela-inicio').hidden && !$('ini-permissao').hidden) {
        $('ini-permissao').hidden = true;
        UI.aviso('Localização liberada.', 'ok');
        if (estado.tentouEntrar) $('form-inicio').requestSubmit();
      } else if (estado.rastreando && (estado.gps === 'negado' || estado.gps === 'indisponivel')) {
        religarGps();
      }
    } else if (estado.permissao === 'denied' && estado.rastreando) {
      estado.gps = 'negado';
      atualizarUI();
    }
  }

  // problema: 'navegador' | 'sistema' | 'sinal'
  function mostrarPermissao(problema) {
    var inst = window.GPS.instrucoesLocalizacao(problema);
    $('perm-titulo').textContent = inst.titulo;
    $('perm-texto').textContent = problema === 'navegador'
      ? 'Sem a localização os bombeiros não conseguem ver onde você está. Para liberar:'
      : problema === 'sistema' ? 'O navegador pode usar a localização, mas ela está desligada no celular. Para ligar:'
        : 'Para melhorar o sinal:';
    var ol = $('perm-passos');
    ol.innerHTML = '';
    inst.passos.forEach(function (p) { ol.appendChild(UI.el('li', { texto: p })); });
    $('perm-recarregar').hidden = !(problema === 'navegador' && window.GPS.ambiente().so === 'ios');
    $('ini-permissao').hidden = false;
    $('ini-permissao').scrollIntoView({ block: 'start' });
  }

  async function verificarPermissaoDeNovo() {
    await acompanharPermissao();
    var btn = $('perm-verificar');
    btn.disabled = true;
    btn.textContent = 'VERIFICANDO…';
    var teste = await obterPosicaoInicial();
    btn.disabled = false;
    btn.textContent = 'VERIFICAR DE NOVO';
    if (teste.ok || teste.codigo === 3) {
      $('ini-permissao').hidden = true;
      if (estado.tentouEntrar) $('form-inicio').requestSubmit();
      else UI.aviso(teste.ok ? 'Localização funcionando. Toque em COMEÇAR.' : 'Localização permitida. Toque em COMEÇAR.', 'ok', 6000);
      return;
    }
    mostrarPermissao(teste.codigo === 2 ? 'sistema' : 'navegador');
    UI.aviso(teste.codigo === 2 ? 'A localização do celular ainda está desligada.' : 'A localização ainda está bloqueada para este site.', 'erro', 6000);
  }

  // Durante a busca: explica como liberar/ligar e tenta de novo.
  function mostrarComoResolver() {
    var problema = estado.gps === 'negado' ? 'navegador' : estado.gps === 'indisponivel' ? 'sistema' : 'sinal';
    var inst = window.GPS.instrucoesLocalizacao(problema);
    var ol = UI.el('ol', { classe: 'perm-passos' }, inst.passos.map(function (p) { return UI.el('li', { texto: p }); }));
    var fechar = UI.abrirModal(UI.el('div', null, [
      UI.el('h2', { id: 'modal-titulo', texto: inst.titulo }),
      ol,
      UI.el('div', { classe: 'modal-acoes' }, [
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } }),
        UI.el('button', { classe: 'btn btn-escuro', type: 'button', texto: 'Verificar de novo', onclick: function () { fechar(); religarGps(true); } }),
      ]),
    ]));
  }

  /* ------------------------------------------------------------------ */
  /* CPF e celular                                                        */
  /* ------------------------------------------------------------------ */
  function digitos(v) { return String(v || '').replace(/\D/g, ''); }

  function mascararCpf(v) {
    var d = digitos(v).slice(0, 11);
    return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1-$2');
  }

  function mascararTelefone(v) {
    var d = digitos(v);
    if (d.length > 11 && d.indexOf('55') === 0) d = d.slice(2);
    d = d.slice(0, 11);
    if (d.length <= 2) return d.length ? '(' + d : '';
    if (d.length <= 6) return '(' + d.slice(0, 2) + ') ' + d.slice(2);
    if (d.length <= 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
    return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
  }

  function cpfValido(v) {
    var d = digitos(v);
    if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
    for (var k = 9; k <= 10; k++) {
      var soma = 0;
      for (var i = 0; i < k; i++) soma += Number(d[i]) * (k + 1 - i);
      if (((soma * 10) % 11) % 10 !== Number(d[k])) return false;
    }
    return true;
  }

  function telefoneValido(v) {
    var d = digitos(v);
    if (d.length > 11 && d.indexOf('55') === 0) d = d.slice(2);
    return /^[1-9][0-9]9?[0-9]{8}$/.test(d) && (d.length === 10 || d.length === 11);
  }

  function tipoEscolhido() {
    var marcado = document.querySelector('input[name="tipo"]:checked');
    return !$('ini-tipo-escolha').hidden && marcado ? marcado.value : 'civil';
  }

  // CPF e celular: obrigatórios para civis, opcionais para militares.
  function marcarOpcionais() {
    var opcional = tipoEscolhido() === 'militar';
    document.querySelectorAll('[data-opcional]').forEach(function (e) { e.hidden = !opcional; });
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
    var tipo = tipoEscolhido();
    var cpf = digitos($('ini-cpf').value);
    var tel = digitos($('ini-tel').value);
    var obrigatorio = tipo === 'civil';
    if ((obrigatorio || cpf) && !cpfValido(cpf)) {
      erroInicio('CPF inválido. Confira os 11 números.');
      $('ini-cpf').focus();
      return;
    }
    if ((obrigatorio || tel) && !telefoneValido(tel)) {
      erroInicio('Celular inválido. Informe o DDD e o número, por exemplo (21) 99876-5432.');
      $('ini-tel').focus();
      return;
    }
    await entrarNaBusca({ nome: nome, tipo: tipo, cpf: cpf, tel: tel });
  }

  // Pede a localização pelo mecanismo oficial do navegador, entra na operação
  // (ou volta para o mesmo registro) e começa a enviar. O rastreamento só é
  // mostrado como ativo depois que a permissão é concedida.
  async function entrarNaBusca(dados) {
    if (estado.entrando) return;
    estado.entrando = true;
    estado.tentouEntrar = true;
    var btn = $('btn-iniciar');
    var textoOriginal = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'OBTENDO LOCALIZAÇÃO…';
    prepararAudio();

    try {
      // 1. Permissão e teste do GPS
      var teste = await obterPosicaoInicial();
      await acompanharPermissao();
      if (!teste.ok && teste.codigo === 1) {
        erroInicio('');
        mostrarPermissao('navegador');
        return;
      }
      $('ini-permissao').hidden = true;

      // 2. Sessão anônima e ingresso (o mesmo aparelho volta para o mesmo registro)
      btn.textContent = 'CONECTANDO…';
      await garantirSessao();
      var part = await C.rpc('ingressar', {
        p_token: estado.token, p_nome: dados.nome, p_tipo: dados.tipo,
        p_cpf: dados.cpf || null, p_telefone: dados.tel || null,
      });
      estado.cpf = dados.cpf;
      estado.telefone = dados.tel;
      estado.saidaSolicitadaEm = part.saida_solicitada_em || null;

      if (estado.part && estado.part.participante_id !== part.participante_id) estado.fila = [];
      var salvo = C.local.ler(CHAVE_PART, null);
      if (salvo && salvo.participante_id !== part.participante_id) {
        estado.fila = [];
        estado.confPendentes = [];
        estado.confirmadasLocal.clear();
      }
      estado.part = part;
      estado.finalizado = false;
      salvarParticipacao(true);

      mostrarTela('rastreio');
      registrarServiceWorker();
      if (!teste.ok) estado.gps = teste.codigo === 2 ? 'indisponivel' : 'sem_sinal';
      comecarRastreamento(teste.ok ? teste.pos : null);
      if (!teste.ok && teste.codigo === 2) {
        UI.aviso('A localização do celular está desligada. Toque em "Como resolver".', 'erro', 8000);
      } else if (!teste.ok) {
        UI.aviso('Ainda sem sinal de GPS. Se possível, vá para um local aberto. O rastreamento continua tentando.', 'erro', 7000);
      }
    } catch (e) {
      if (e.codigo === 'operacao_encerrada' || e.codigo === 'participante_removido' || e.codigo === 'participante_liberado') {
        if (!estado.part && salvoAtivo()) {
          var s = C.local.ler(CHAVE_PART, null);
          estado.part = { participante_id: s.participante_id, nome: s.nome, tipo: s.tipo, operacao: estado.info.operacao };
        }
        finalizar({ operacao_encerrada: 'encerrada', participante_removido: 'removido', participante_liberado: 'liberado' }[e.codigo]);
        return;
      }
      erroInicio(e.rede ? 'Sem conexão com a internet. Verifique os dados móveis ou o Wi-Fi e tente novamente.' : e.message);
    } finally {
      estado.entrando = false;
      btn.disabled = false;
      btn.textContent = textoOriginal;
    }
  }

  function salvoAtivo() {
    var s = C.local.ler(CHAVE_PART, null);
    return Boolean(s && s.token === estado.token && s.participante_id);
  }

  function salvarParticipacao(ativo, removido) {
    if (!estado.part) return;
    C.local.gravar(CHAVE_PART, {
      token: estado.token,
      participante_id: estado.part.participante_id,
      nome: estado.part.nome,
      tipo: estado.part.tipo,
      cpf: estado.cpf || '',
      telefone: estado.telefone || '',
      ativo: Boolean(ativo),
      removido: Boolean(removido),
    });
  }

  function comecarRastreamento(posInicial) {
    C.sincronizarRelogio();
    estado.rastreando = true;
    estado.ultimoTique = Date.now();
    estado.filtro.reiniciar();
    salvarParticipacao(true);
    if (posInicial) processarPosicao(posInicial);
    iniciarWatch();
    pedirTelaLigada();
    conectarMensagens();

    if (!estado.timerSinal) estado.timerSinal = setInterval(enviarSinal, CFG.sinalVidaMs);
    var visto = C.local.ler(CHAVE_VISTO, null);
    estado.conversaVistaAte = visto && visto.participante_id === estado.part.participante_id ? visto.t : 0;
    iniciarMapa();
    carregarEquipe();
    carregarDestino();
    if (!estado.timerEquipe) {
      estado.timerEquipe = setInterval(function () { carregarEquipe(); carregarDestino(); }, CFG.destinoMs);
    }
    carregarFilaFotos().then(processarFilaFotos);
    carregarMinhasFotos();
    renderizarHistorico();
    if (!estado.timerUI) estado.timerUI = setInterval(tique, 2000);
    enviarSinal();
    agendarEnvio(0);
    atualizarNotifBotao();
    atualizarUI();
  }

  // Um único observador do GPS por vez (nunca duplicado).
  function iniciarWatch() {
    if (estado.watchId != null) return;
    estado.watchIniciadoEm = Date.now();
    estado.watchId = navigator.geolocation.watchPosition(processarPosicao, erroGps, {
      enableHighAccuracy: true,   // usa o GPS (não só Wi-Fi/antenas)
      maximumAge: 0,              // nunca aceitar posição guardada em cache
      timeout: 30000,             // sem leitura em 30 s: avisa "procurando sinal" e continua tentando
    });
  }

  function pararWatch() {
    if (estado.watchId != null) {
      navigator.geolocation.clearWatch(estado.watchId);
      estado.watchId = null;
    }
  }

  // Reinicia a leitura do GPS (depois de liberar a permissão, ligar a localização
  // ou quando o navegador para de entregar leituras).
  function religarGps(avisar) {
    if (!estado.rastreando) return;
    pararWatch();
    navigator.geolocation.getCurrentPosition(function (pos) {
      processarPosicao(pos);
      if (avisar) UI.aviso('Localização funcionando.', 'ok');
    }, function (err) {
      erroGps(err);
      if (avisar) UI.aviso(err.code === 1 ? 'A localização continua bloqueada para este site.' : err.code === 2 ? 'A localização do celular continua desligada.' : 'Ainda sem sinal de GPS.', 'erro', 6000);
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    iniciarWatch();
  }

  /* ------------------------------------------------------------------ */
  /* GPS                                                                  */
  /* ------------------------------------------------------------------ */
  // Toda leitura passa pelo filtro (gps.js). "atual" é o que a tela mostra como
  // posição agora; "ponto" é o que entra na trilha e vai para os bombeiros.
  function processarPosicao(pos) {
    if (!estado.rastreando) return;
    var r = estado.filtro.processar(pos);
    if (r.atual) {
      var a = r.atual;
      estado.ultimaLeitura = { lat: a.lat, lng: a.lng, prec: a.prec, recebidaEm: a.recebidaEm, t: a.t };
      estado.gps = a.prec != null && a.prec > 50 ? 'fraco' : 'ok';
      atualizarMeuMarcador();
      agendarNavegacao();
      if (a.prec == null || a.prec <= 150) verificarRisco(a);
    }
    if (r.pontos.length) {
      estado.ultimoAceito = r.ponto;
      r.pontos.forEach(function (p) {
        estado.fila.push({ id: C.uuid(), lat: p.lat, lng: p.lng, prec: p.prec, t: p.t });
      });
      if (estado.fila.length > CFG.filaMaxima) estado.fila.splice(0, estado.fila.length - CFG.filaMaxima);
      salvarFila();
      // 1º ponto vai na hora; depois, logo em seguida (mais rápido em veículo).
      agendarEnvio(!estado.ultimoEnviadoT ? 300 : r.rapido ? CFG.envioRapidoMs : CFG.envioPeMs);
    }
    if (window.GBS_DEBUG_GPS) console.debug('[GPS]', r.motivo, r.atual ? Math.round(r.atual.prec || 0) + ' m' : '');
    atualizarUI();
  }

  function erroGps(err) {
    if (err.code === 1) estado.gps = 'negado';
    else if (err.code === 2) estado.gps = 'indisponivel';
    else if (!estado.ultimaLeitura || Date.now() - estado.ultimaLeitura.recebidaEm > CFG.semGpsMs) estado.gps = 'sem_sinal';
    // timeout (3) com leitura recente: falha temporária, mantém o estado
    estado.filtro.registrar(null, false, err.code === 1 ? 'negado' : err.code === 2 ? 'indisponivel' : 'sem_sinal');
    atualizarUI();
  }

  // Celular com o relógio errado: o servidor recusaria pontos "do futuro" ou de
  // antes da operação. O horário de cada ponto é convertido para o do servidor.
  function paraHoraDoServidor(lote) {
    var desvio = C.agora() - Date.now();
    if (Math.abs(desvio) < 30000) return lote;
    return lote.map(function (p) { return Object.assign({}, p, { t: Math.round(p.t + desvio) }); });
  }

  function salvarFila() {
    if (!estado.part) return;
    C.local.gravar(CHAVE_FILA, { participante_id: estado.part.participante_id, pontos: estado.fila });
  }

  /* ------------------------------------------------------------------ */
  /* Envio ao servidor                                                    */
  /* ------------------------------------------------------------------ */
  // Agenda o envio da fila. Um pedido mais cedo antecipa; um mais tarde não adia
  // o que já estava marcado (senão, andando, o envio nunca aconteceria).
  function agendarEnvio(ms) {
    var alvo = Date.now() + ms;
    if (estado.envioAgendadoPara && estado.envioAgendadoPara <= alvo) return;
    clearTimeout(estado.timerEnvio);
    estado.envioAgendadoPara = alvo;
    estado.timerEnvio = setTimeout(function () { estado.envioAgendadoPara = 0; enviarFila(); }, ms);
  }

  async function enviarFila() {
    if (estado.enviando || !estado.part || estado.finalizado || !estado.fila.length) return;
    estado.enviando = true;
    var lote = estado.fila.slice(0, CFG.loteMaximo);
    try {
      var resp = await C.rpc('enviar_posicoes', {
        p_participante: estado.part.participante_id,
        p_pontos: paraHoraDoServidor(lote),
        p_gps: estado.rastreando ? estado.gps : null,
      }, 20000);
      if (resp && resp.inseridos < lote.length) estado.filtro.registrar(null, false, 'servidor_recusou');
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
      if (estado.fila.length && !estado.envioAgendadoPara && !estado.finalizado) agendarEnvio(CFG.envioPeMs);
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
        finalizar(r && ['removido', 'inexistente', 'liberado'].indexOf(r.status) !== -1 ? r.status : 'encerrada');
        return;
      }
      if (estado.saidaSolicitadaEm && !r.saida_solicitada_em) {
        UI.aviso('Os bombeiros pediram para você continuar na busca.', 'erro', 9000);
        chamarAtencao();
      }
      estado.saidaSolicitadaEm = r.saida_solicitada_em || null;
      marcarSucesso();
      if (estado.fila.length) agendarEnvio(0);
      await buscarMensagens();
      await reenviarConfirmacoes();
      await reenviarMensagens();
      processarFilaFotos();
    } catch (e) {
      if (!tratarErroFatal(e)) marcarFalha(e);
    }
    atualizarUI();
  }

  function tratarErroFatal(e) {
    if (e.codigo === 'operacao_encerrada') { finalizar('encerrada'); return true; }
    if (e.codigo === 'participante_removido') { finalizar('removido'); return true; }
    if (e.codigo === 'participante_liberado') { finalizar('liberado'); return true; }
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
      // Destino enviado pelos bombeiros: chega na hora (o RLS só entrega o destino
      // deste participante). A consulta confirma o estado atual no servidor.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'destinos', filter: 'participante_id=eq.' + pid },
        function () { carregarDestino(); carregarEquipe(); })
      .subscribe(function (status) {
        estado.statusTempoReal = status;
        // Conectou ou reconectou: recupera o que pode ter chegado enquanto estava fora.
        if (status === 'SUBSCRIBED') { buscarMensagens(); carregarDestino(); }
      });
  }

  async function buscarMensagens() {
    if (!estado.part) return;
    try {
      var dados = await C.consultar(
        C.cliente.from('mensagens').select('*')
          .eq('participante_id', estado.part.participante_id)
          .order('criada_em', { ascending: false })
          .limit(80)
      );
      receberMensagens(dados || []);
    } catch (e) { /* tenta de novo no próximo sinal de vida */ }
  }

  function receberMensagens(lista) {
    var paraEntregar = [];
    var houveNova = false;
    var mudouPendentes = false;
    lista.forEach(function (m) {
      var antiga = estado.mensagens.get(m.id);
      estado.mensagens.set(m.id, m);
      if (m.direcao === 'entrada') {
        // algo que eu enviei: tira da fila local, se ainda estiver lá
        var antes = estado.msgPendentes.length;
        estado.msgPendentes = estado.msgPendentes.filter(function (x) { return x.client_id !== m.client_id; });
        if (estado.msgPendentes.length !== antes) mudouPendentes = true;
        return;
      }
      if (!m.entregue_em) paraEntregar.push(m.id);
      if (!antiga && !m.confirmada_em && !estado.confirmadasLocal.has(m.id) && !estado.alertadas.has(m.id)) {
        houveNova = true;
        estado.alertadas.add(m.id);
      }
    });
    if (paraEntregar.length) {
      C.rpc('marcar_entregues', { p_ids: paraEntregar }).catch(function () { /* nova tentativa depois */ });
    }
    if (mudouPendentes) salvarMsgPendentes();
    if (houveNova) chamarAtencao();
    renderizarHistorico();
    mostrarProximoAlerta();
  }

  function pendentesDeConfirmacao() {
    var lista = [];
    estado.mensagens.forEach(function (m) {
      if (m.direcao !== 'entrada' && !m.confirmada_em && !estado.confirmadasLocal.has(m.id)) lista.push(m);
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
      $('alerta-fila').textContent = pend.length > 1 ? 'Mais ' + (pend.length - 1) + ' mensagem(ns) dos bombeiros' : '';
      return;
    }
    estado.alertaAtual = m.id;
    var tipo = C.TIPOS_MENSAGEM[m.tipo] || C.TIPOS_MENSAGEM.PERSONALIZADA;
    caixa.className = 'alerta-msg alerta-' + tipo.classe;
    $('alerta-tit').textContent = tipo.titulo;
    $('alerta-texto').textContent = m.texto || tipo.padrao;
    $('alerta-meta').textContent = 'Bombeiros · às ' + C.hora(m.criada_em, false);
    var botoes = $('alerta-botoes');
    botoes.innerHTML = '';
    if (m.tipo === 'CONFIRME') {
      botoes.appendChild(UI.el('button', { classe: 'btn btn-ok btn-gigante', type: 'button', texto: 'ESTOU BEM', onclick: function () { confirmarMensagem(m.id, 'ESTOU_BEM'); } }));
      botoes.appendChild(UI.el('button', { classe: 'btn btn-primario btn-gigante', type: 'button', texto: 'PRECISO DE AJUDA', onclick: function () { confirmarMensagem(m.id, 'PRECISO_AJUDA'); } }));
    } else {
      botoes.appendChild(UI.el('button', { classe: 'btn btn-escuro btn-gigante', type: 'button', texto: 'ENTENDI', onclick: function () { confirmarMensagem(m.id, 'CIENTE'); } }));
    }
    $('alerta-fila').textContent = pend.length > 1 ? 'Mais ' + (pend.length - 1) + ' mensagem(ns) dos bombeiros' : '';
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
    if (ok) UI.aviso(resposta === 'PRECISO_AJUDA' ? 'Pedido de ajuda enviado aos bombeiros.' : 'Resposta enviada.', 'ok');
    else UI.aviso('Sem internet: a resposta vai ser enviada quando o sinal voltar.', 'erro', 7000);
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

  var CATEGORIAS = {
    MENSAGEM: 'Mensagem', PISTA: 'Possível pista', VESTIGIO: 'Vestígio',
    OBJETO: 'Objeto', OBSTACULO: 'Obstáculo', OUTRO: 'Outra coisa', AJUDA: 'Pedido de ajuda',
  };

  // Conversa: o que os bombeiros enviaram (à esquerda) e o que eu enviei (à direita).
  // Só o essencial: quem, o texto e a hora.
  function renderizarHistorico() {
    var ul = $('hist-msgs');
    var itens = Array.from(estado.mensagens.values()).map(function (m) { return { m: m, t: C.paraMs(m.criada_em) }; });
    estado.msgPendentes.forEach(function (x) { itens.push({ local: x, t: x.criada_local }); });
    itens.sort(function (a, b) { return a.t - b.t; });
    $('hist-vazio').hidden = itens.length > 0;
    var noFim = ul.scrollHeight - ul.scrollTop - ul.clientHeight < 40;
    ul.innerHTML = '';
    itens.forEach(function (it) {
      if (it.local) { ul.appendChild(bolhaMinha(it.local, null)); return; }
      var m = it.m;
      if (m.direcao === 'entrada') { ul.appendChild(bolhaMinha(null, m)); return; }
      var tipo = C.TIPOS_MENSAGEM[m.tipo] || C.TIPOS_MENSAGEM.PERSONALIZADA;
      var respondida = m.confirmada_em || estado.confirmadasLocal.has(m.id);
      var li = UI.el('li', { classe: 'bolha bolha-equipe' + (respondida ? '' : ' pendente') }, [
        UI.el('div', { classe: 'bolha-topo', texto: 'Bombeiros' + (m.tipo !== 'PERSONALIZADA' ? ' · ' + tipo.titulo : '') }),
        UI.el('div', { classe: 'bolha-texto', texto: m.texto || tipo.padrao }),
        UI.el('div', { classe: 'bolha-meta', texto: C.hora(m.criada_em, false) }),
      ]);
      if (!respondida) {
        li.appendChild(UI.el('button', {
          classe: 'btn btn-pequeno btn-escuro', type: 'button', texto: 'Responder',
          onclick: function () { estado.alertaAtual = null; mostrarProximoAlerta(); },
        }));
      }
      ul.appendChild(li);
    });
    if (noFim || itens.length < 4) ul.scrollTop = ul.scrollHeight;
    atualizarContadorConversa();
  }

  function bolhaMinha(local, m) {
    var d = m || local;
    var cat = d.categoria || 'MENSAGEM';
    var meta = m ? C.hora(m.criada_em, false) : (local.erro ? 'Não enviada' : 'Esperando internet…');
    var li = UI.el('li', { classe: 'bolha bolha-minha' + (m ? '' : ' na-fila') + (cat !== 'MENSAGEM' ? ' relato' : '') + (cat === 'AJUDA' ? ' sos' : '') }, [
      cat !== 'MENSAGEM' ? UI.el('div', { classe: 'bolha-topo', texto: CATEGORIAS[cat] || cat }) : null,
      UI.el('div', { classe: 'bolha-texto', texto: d.texto }),
      UI.el('div', { classe: 'bolha-meta', texto: meta }),
    ]);
    if (local && local.erro) {
      li.appendChild(UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Apagar',
        onclick: function () { estado.msgPendentes = estado.msgPendentes.filter(function (x) { return x !== local; }); salvarMsgPendentes(); renderizarHistorico(); } }));
    }
    return li;
  }

  /* ------------------------------------------------------------------ */
  /* Conversa: abre só quando o participante pede                         */
  /* ------------------------------------------------------------------ */
  function abrirConversa() {
    $('painel-conversa').hidden = false;
    $('btn-falar').setAttribute('aria-expanded', 'true');
    document.body.classList.add('conversa-aberta');
    marcarConversaVista();
    renderizarHistorico();
    var ul = $('hist-msgs');
    ul.scrollTop = ul.scrollHeight;
    setTimeout(function () { $('msg-texto').focus({ preventScroll: true }); }, 50);
  }

  function fecharConversa() {
    if ($('painel-conversa').hidden) return;
    $('painel-conversa').hidden = true;
    $('btn-falar').setAttribute('aria-expanded', 'false');
    document.body.classList.remove('conversa-aberta');
    $('btn-falar').focus();
  }

  function marcarConversaVista() {
    estado.conversaVistaAte = Date.now();
    if (estado.part) C.local.gravar(CHAVE_VISTO, { participante_id: estado.part.participante_id, t: estado.conversaVistaAte });
    atualizarContadorConversa();
  }

  // Número no botão: mensagens dos bombeiros que chegaram depois da última vez que a conversa foi aberta.
  function atualizarContadorConversa() {
    if (!$('painel-conversa').hidden && estado.part) {
      estado.conversaVistaAte = Date.now();
      C.local.gravar(CHAVE_VISTO, { participante_id: estado.part.participante_id, t: estado.conversaVistaAte });
    }
    var n = 0;
    estado.mensagens.forEach(function (m) {
      if (m.direcao !== 'entrada' && C.paraMs(m.criada_em) > estado.conversaVistaAte) n++;
    });
    var c = $('falar-contador');
    c.textContent = String(n);
    c.hidden = !n;
    $('btn-falar').classList.toggle('tem-novas', n > 0);
  }

  /* ------------------------------------------------------------------ */
  /* Mapa: a minha posição e a dos bombeiros                              */
  /* ------------------------------------------------------------------ */
  function iniciarMapa() {
    if (estado.mapa) { setTimeout(function () { estado.mapa.invalidateSize(); }, 50); return; }
    if (!window.L) { document.querySelector('.mapa-civil-caixa').hidden = true; return; }
    var mapa = L.map('mapa-civil', { zoomControl: true, attributionControl: true }).setView([-15.79, -47.88], 4);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(mapa);
    // Se a pessoa arrastar o mapa, ele para de seguir a posição (até tocar em "Onde estou").
    mapa.on('dragstart', function () { estado.seguindo = false; });
    estado.mapa = mapa;
    setTimeout(function () { mapa.invalidateSize(); }, 80);
    atualizarMeuMarcador();
  }

  function atualizarMeuMarcador() {
    var l = estado.ultimaLeitura;
    if (!estado.mapa || !l) return;
    var ll = [l.lat, l.lng];
    if (!estado.meuMarcador) {
      estado.meuCirculo = L.circle(ll, { radius: l.prec || 0, color: '#3b82f6', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(estado.mapa);
      estado.meuMarcador = L.marker(ll, {
        icon: L.divIcon({ className: 'mk-eu-wrap', html: '<div class="mk-eu"></div><div class="mk-eu-rotulo">Você</div>', iconSize: [0, 0] }),
        keyboard: false, zIndexOffset: 1000, title: 'Você está aqui',
      }).addTo(estado.mapa);
      estado.meuMarcador.on('click', mostrarMinhasCoordenadas);
      estado.mapa.setView(ll, 16);
    } else {
      estado.meuMarcador.setLatLng(ll);
      estado.meuCirculo.setLatLng(ll);
      estado.meuCirculo.setRadius(l.prec || 0);
      if (estado.seguindo && !estado.mapa.getBounds().pad(-0.2).contains(ll)) estado.mapa.panTo(ll);
    }
  }

  // Minhas coordenadas (para passar por telefone ou rádio aos bombeiros).
  function mostrarMinhasCoordenadas() {
    var l = estado.ultimaLeitura;
    if (!estado.mapa || !l || !window.Coords) return;
    var utm = window.Coords.formatar(l.lat, l.lng, 'utm');
    var dec = window.Coords.formatar(l.lat, l.lng, 'dec');
    var caixa = UI.el('div', { classe: 'minhas-coord' }, [
      UI.el('strong', { texto: 'Suas coordenadas' }),
      UI.el('span', { classe: 'mono', texto: dec }),
      UI.el('span', { classe: 'mono muted', texto: 'UTM ' + utm }),
      UI.el('span', { classe: 'muted', texto: 'Precisão: ' + C.precisao(l.prec) }),
      UI.el('button', { classe: 'btn btn-pequeno', type: 'button', id: 'copiar-coord', texto: 'Copiar', onclick: function () {
        var t = dec + ' (UTM ' + utm + ')';
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { UI.aviso('Coordenadas copiadas.', 'ok'); }, function () { UI.aviso(t, 'ok', 9000); });
        else UI.aviso(t, 'ok', 9000);
      } }),
    ]);
    L.popup({ className: 'popup-info-ponto', maxWidth: 280, offset: [0, -8] }).setLatLng([l.lat, l.lng]).setContent(caixa).openOn(estado.mapa);
  }

  function centralizarEmMim(aviso) {
    var l = estado.ultimaLeitura;
    if (!estado.mapa) return;
    if (!l) { if (aviso) UI.aviso('Ainda procurando o seu sinal de GPS.', 'erro'); return; }
    estado.mapa.setView([l.lat, l.lng], Math.max(estado.mapa.getZoom(), 16));
  }

  function textoIdade(s) {
    if (s < 60) return 'agora há pouco';
    var m = Math.round(s / 60);
    return 'há ' + m + ' min';
  }

  // O que o mapa do participante pode mostrar (mapa_do_participante): militares e
  // responsáveis (sem nomes), os setores atribuídos a ele, pontos de encontro e de
  // risco, e o destino enviado pelos bombeiros. A idade das posições vem do servidor.
  async function carregarEquipe() {
    if (!estado.part || estado.finalizado || !estado.mapa) return;
    var dados;
    try {
      dados = await C.rpc('mapa_do_participante', { p_participante: estado.part.participante_id }, 12000);
    } catch (e) {
      tratarErroFatal(e);
      return;
    }
    if (!estado.mapa || !dados) return;
    desenharEquipe(dados.equipe || []);
    desenharExtras(dados.setores || [], dados.pontos || []);
    if (estado.destinoSemFuncao) definirDestino(dados.destino || null);   // servidor sem a migração 004
  }

  // Destino ativo: não depende do mapa (funciona mesmo se o mapa não carregar).
  // Chamado ao entrar, pelo tempo real, ao reconectar, ao voltar para a página
  // e a cada 15 s. Nunca falha em silêncio: avisa se não conseguir verificar.
  async function carregarDestino() {
    if (!estado.part || estado.finalizado || estado.buscandoDestino) return;
    estado.buscandoDestino = true;
    try {
      var d;
      if (estado.destinoSemFuncao) {
        var m = await C.rpc('mapa_do_participante', { p_participante: estado.part.participante_id }, 12000);
        d = m ? m.destino : null;
      } else {
        d = await C.rpc('meu_destino', { p_participante: estado.part.participante_id }, 12000);
      }
      estado.falhasDestino = 0;
      mostrarAvisoDestino('');
      definirDestino(d || null);
      if (d && d.id && estado.destinoConfirmado !== d.id && !estado.destinoSemFuncao) confirmarDestino(d.id);
    } catch (e) {
      if (tratarErroFatal(e)) return;
      if (e.codigo === 'funcao_ausente' && !estado.destinoSemFuncao) {
        // Servidor ainda sem a migração 004: usa a consulta da migração 003.
        estado.destinoSemFuncao = true;
        estado.buscandoDestino = false;
        return carregarDestino();
      }
      estado.falhasDestino++;
      if (!e.rede && estado.falhasDestino >= 2) {
        mostrarAvisoDestino('Não foi possível verificar se os bombeiros mandaram um destino (' + e.message + '). Tentando de novo…');
      }
    } finally {
      estado.buscandoDestino = false;
    }
  }

  async function confirmarDestino(id) {
    try {
      await C.rpc('confirmar_destino', { p_destino: id }, 12000);
      estado.destinoConfirmado = id;
    } catch (e) { /* tenta de novo na próxima verificação */ }
  }

  function mostrarAvisoDestino(texto) {
    var p = $('aviso-destino');
    if (p.textContent !== texto) p.textContent = texto;
    p.hidden = !texto;
  }

  function desenharEquipe(lista) {
    var vistos = new Set();
    (lista || []).forEach(function (b) {
      if (b.lat == null || b.lng == null) return;
      vistos.add(b.id);
      var resp = b.tipo === 'responsavel';
      var antigo = b.idade_s > EQUIPE_ATUAL_S;
      var nome = resp ? 'Responsável' : 'Bombeiro';
      var html = '<div class="mk mk-equipe ' + (resp ? 'responsavel' : 'militar') + (antigo ? ' antigo' : '') + '">' +
        '<div class="simbolo simbolo-' + (resp ? 'responsavel' : 'militar') + '"><span>' + (resp ? 'R' : 'M') + '</span></div>' +
        (antigo ? '<div class="mk-rotulo">' + textoIdade(b.idade_s) + '</div>' : '') + '</div>';
      var texto = nome + ' — ' + (antigo ? 'última posição conhecida ' + textoIdade(b.idade_s) + ' (pode não estar mais aí)' : 'posição atual');
      var mk = estado.equipe.get(b.id);
      if (!mk) {
        mk = L.marker([b.lat, b.lng], { icon: L.divIcon({ className: 'mk-wrap', html: html, iconSize: [0, 0] }), title: texto, keyboard: false, zIndexOffset: resp ? 200 : 100 });
        mk.bindPopup(texto);
        mk.addTo(estado.mapa);
        mk._gbsHtml = html;
        estado.equipe.set(b.id, mk);
      } else {
        mk.setLatLng([b.lat, b.lng]);
        if (mk._gbsHtml !== html) { mk.setIcon(L.divIcon({ className: 'mk-wrap', html: html, iconSize: [0, 0] })); mk._gbsHtml = html; }
        mk.setPopupContent(texto);
        if (mk.getElement()) mk.getElement().title = texto;
      }
    });
    estado.equipe.forEach(function (mk, id) {
      if (!vistos.has(id)) { mk.remove(); estado.equipe.delete(id); }
    });
    var nota = $('mapa-nota');
    nota.hidden = vistos.size > 0;
    nota.textContent = 'Nenhum bombeiro com localização no mapa agora.';
    // Na primeira vez, mostra você e a equipe juntos.
    if (!estado.jaEnquadrou && vistos.size && estado.ultimaLeitura) {
      estado.jaEnquadrou = true;
      var pts = [[estado.ultimaLeitura.lat, estado.ultimaLeitura.lng]];
      estado.equipe.forEach(function (mk) { var p = mk.getLatLng(); pts.push([p.lat, p.lng]); });
      estado.mapa.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 16 });
      estado.seguindo = false;
    }
  }

  var LETRA_PONTO = { ENCONTRO: 'E', RISCO: '!' };
  var RAIO_ALERTA_PADRAO = 100;   // m — área de risco sem raio definido pelos bombeiros

  // Alarme de proximidade: entrou numa área de risco marcada pelos bombeiros.
  function verificarRisco(l) {
    var caixa = $('alerta-risco');
    var dentro = null;
    (estado.pontosRisco || []).forEach(function (pt) {
      if (!dentro && C.distancia(l.lat, l.lng, pt.lat, pt.lng) <= (pt.raio_m || RAIO_ALERTA_PADRAO)) dentro = pt;
    });
    if (dentro) {
      caixa.textContent = '⚠ Você está numa ÁREA DE RISCO: ' + dentro.titulo + '. Tenha muito cuidado e siga as orientações dos bombeiros.';
      caixa.hidden = false;
      if (estado.riscoAtual !== dentro.id) {
        estado.riscoAtual = dentro.id;
        try { if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500]); } catch (e) { /* ignora */ }
        bipe();
        try { caixa.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ignora */ }
      }
    } else if (estado.riscoAtual) {
      estado.riscoAtual = null;
      caixa.hidden = true;
      UI.aviso('Você saiu da área de risco.', 'ok');
    }
  }
  var NOME_PONTO = { ENCONTRO: 'Ponto de encontro', RISCO: 'Área de risco — cuidado' };

  // Setores atribuídos a mim (contorno) e pontos de encontro / risco.
  function desenharExtras(setores, pontos) {
    if (!estado.camadaExtras) estado.camadaExtras = L.layerGroup().addTo(estado.mapa);
    var assinatura = JSON.stringify([setores, pontos]);
    if (estado.camadaExtras._assinatura === assinatura) return;
    estado.camadaExtras._assinatura = assinatura;
    estado.camadaExtras.clearLayers();
    setores.forEach(function (st) {
      var estilo = { color: st.cor, weight: 3, fillColor: st.cor, fillOpacity: 0.1, dashArray: st.status === 'concluido' ? null : '8 6', interactive: false };
      var camada = st.forma === 'circulo' ? L.circle([st.centro_lat, st.centro_lng], Object.assign({ radius: st.raio_m }, estilo)) : L.polygon(st.pontos || [], estilo);
      camada.bindTooltip('Seu setor: ' + C.esc(st.nome), { permanent: true, direction: 'center', className: 'rotulo-setor' });
      camada.addTo(estado.camadaExtras);
    });
    estado.pontosRisco = pontos.filter(function (pt) { return pt.categoria === 'RISCO'; });
    estado.pontosRisco.forEach(function (pt) {
      L.circle([pt.lat, pt.lng], { radius: pt.raio_m || RAIO_ALERTA_PADRAO, color: '#ef4444', weight: 2, dashArray: '6 6', fillColor: '#ef4444', fillOpacity: 0.1, interactive: false, className: 'circulo-risco' }).addTo(estado.camadaExtras);
    });
    pontos.forEach(function (pt) {
      L.marker([pt.lat, pt.lng], {
        icon: L.divIcon({ className: 'mk-poi-wrap', html: '<div class="mk-poi poi-' + C.esc(pt.categoria) + '"><span>' + (LETRA_PONTO[pt.categoria] || '•') + '</span></div><div class="mk-poi-rotulo">' + C.esc(pt.titulo) + '</div>', iconSize: [0, 0] }),
        title: (NOME_PONTO[pt.categoria] || 'Ponto') + ': ' + pt.titulo, keyboard: false,
      }).bindPopup((NOME_PONTO[pt.categoria] || 'Ponto') + ': ' + C.esc(pt.titulo)).addTo(estado.camadaExtras);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Navegação até o destino enviado pelos bombeiros                      */
  /* ------------------------------------------------------------------ */
  var DIRECOES = ['Norte', 'Nordeste', 'Leste', 'Sudeste', 'Sul', 'Sudoeste', 'Oeste', 'Noroeste'];

  function definirDestino(d) {
    var antes = estado.destino;
    if (!d) {
      if (antes) {
        estado.destino = null;
        estado.rota = null;
        desenharRotaCivil();
        atualizarDestinoNoMapa();
        $('navegacao').hidden = true;
        $('lg-destino').hidden = true;
        if (!estado.encerrandoNav) UI.aviso('Os bombeiros encerraram a navegação até "' + antes.nome + '".', 'ok', 7000);
      }
      return;
    }
    var novo = !antes || antes.id !== d.id;
    estado.destino = d;
    if (novo) {
      // modo escolhido pelos bombeiros (a pessoa pode trocar na tela)
      estado.modoNav = window.Rotas.MODOS[d.modo] ? d.modo : 'a_pe';
      estado.rota = null;
      estado.rotaErro = null;
      estado.rotaErroEm = 0;
      estado.rotaEnquadrada = false;
      atualizarBotoesModo();
      desenharRotaCivil();
      renderizarRotaInfo();
    }
    $('navegacao').hidden = false;
    $('lg-destino').hidden = false;
    $('nav-nome').textContent = d.nome;
    $('nav-coord').textContent = C.coord(d.lat) + ', ' + C.coord(d.lng);
    $('nav-rota').href = window.Rotas.linkGoogle([d.lat, d.lng], estado.modoNav);
    if (novo) {
      ligarBussola();
      try { if (navigator.vibrate) navigator.vibrate([300, 120, 300]); } catch (e) { /* ignora */ }
      bipe();
      UI.aviso('Os bombeiros enviaram um destino: ' + d.nome + '.', 'ok', 8000);
      if (!$('painel-conversa').hidden) fecharConversa();
      try { $('navegacao').scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* ignora */ }
      if (estado.mapa) {
        var pts = [[d.lat, d.lng]];
        if (estado.ultimaLeitura) pts.push([estado.ultimaLeitura.lat, estado.ultimaLeitura.lng]);
        estado.mapa.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 17 });
        estado.seguindo = false;
      }
    }
    atualizarDestinoNoMapa();
    agendarNavegacao();
    if (novo) calcularRota('novo');
  }

  /* ---------- Rota por caminhos reais -------------------------------- */
  function trocarModoNav(modo) {
    if (!window.Rotas.MODOS[modo] || modo === estado.modoNav) return;
    estado.modoNav = modo;
    estado.rota = null;
    estado.rotaErroEm = 0;
    atualizarBotoesModo();
    desenharRotaCivil();
    if (estado.destino) $('nav-rota').href = window.Rotas.linkGoogle([estado.destino.lat, estado.destino.lng], modo);
    calcularRota('modo');
  }

  function atualizarBotoesModo() {
    document.querySelectorAll('.nav-modos [data-modo]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-modo') === estado.modoNav));
    });
  }

  // Calcula (ou recalcula) a rota da posição atual até o destino.
  //   motivo: 'novo' (destino novo), 'modo' (trocou a pé/trilha/carro), 'gps' (primeira
  //   posição), 'desvio' (saiu da rota), 'tentar' (nova tentativa depois de erro)
  async function calcularRota(motivo) {
    var d = estado.destino, l = estado.ultimaLeitura;
    if (!d || estado.finalizado || estado.rotaCalculando) return;
    if (!l) { estado.rotaErro = null; renderizarRotaInfo('Aguardando o GPS para calcular a rota…'); return; }
    if (navigator.onLine === false) { estado.rotaErro = 'Sem internet: a rota será calculada quando o sinal voltar.'; renderizarRotaInfo(); return; }
    var modo = estado.modoNav, destId = d.id;
    estado.rotaCalculando = true;
    renderizarRotaInfo(motivo === 'desvio' ? 'Você saiu da rota — recalculando…' : 'Calculando a rota…');
    var r = await window.Rotas.calcular({ origem: [l.lat, l.lng], destino: [d.lat, d.lng], modo: modo, participante_id: estado.part && estado.part.participante_id });
    estado.rotaCalculando = false;
    if (!estado.destino || estado.destino.id !== destId || estado.modoNav !== modo) {
      if (estado.destino) calcularRota('modo');   // mudou enquanto calculava
      return;
    }
    estado.rotaCalcEm = Date.now();
    estado.rotaForaCont = 0;
    if (!r.ok) {
      estado.rota = null;
      estado.rotaErro = r.mensagem;
      // erros que não se resolvem tentando de novo logo: espera 10 min
      estado.rotaErroEm = Date.now() + (['rota_nao_configurada', 'sem_permissao', 'distancia_grande', 'sem_rota'].indexOf(r.erro) !== -1 ? 9 * 60000 : 0);
      desenharRotaCivil();
      renderizarRotaInfo();
      agendarNavegacao();
      return;
    }
    estado.rota = r.rota;
    estado.rota.destId = destId;
    estado.rotaErro = null;
    desenharRotaCivil();
    renderizarRotaInfo();
    if (motivo === 'desvio') UI.aviso('Rota recalculada a partir de onde você está.', 'ok');
    if (estado.mapa && !estado.rotaEnquadrada) {
      estado.rotaEnquadrada = true;
      var pts = r.rota.geometria.map(function (c) { return [c[0], c[1]]; });
      pts.push([d.lat, d.lng], [l.lat, l.lng]);
      estado.mapa.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 17 });
      estado.seguindo = false;
    }
    agendarNavegacao();
  }

  function desenharRotaCivil() {
    if (!estado.mapa) return;
    if (!estado.camadaRota) estado.camadaRota = L.layerGroup().addTo(estado.mapa);
    if (!estado.rota) { estado.camadaRota.clearLayers(); $('lg-rota').hidden = true; return; }
    window.Rotas.desenhar(estado.camadaRota, estado.rota, { peso: 5 });
    $('lg-rota').hidden = false;
  }

  function renderizarRotaInfo(textoEstado) {
    var rota = estado.rota;
    var res = $('nav-rota-resumo');
    var ul = $('nav-avisos-rota');
    var ol = $('nav-passos');
    ul.innerHTML = '';
    ol.innerHTML = '';
    $('nav-passos-caixa').hidden = true;
    $('nav-rota-info').classList.toggle('erro', Boolean(!rota && estado.rotaErro));
    if (!rota) {
      res.textContent = textoEstado || (estado.rotaErro ? 'Rota por caminhos indisponível: ' + estado.rotaErro + ' Use a direção em linha reta (seta) ou o app de mapas.' : 'Calculando a rota…');
      $('nav-proxima').hidden = true;
      return;
    }
    res.textContent = textoEstado || window.Rotas.resumo(rota);
    (rota.avisos || []).forEach(function (a) { ul.appendChild(UI.el('li', { texto: a })); });
    ul.appendChild(UI.el('li', { classe: 'nav-limites', texto: rota.limites }));
    (rota.passos || []).forEach(function (p) {
      ol.appendChild(UI.el('li', { texto: p.instrucao + (p.distancia_m ? ' — ' + window.Rotas.formatarDistancia(p.distancia_m) : '') }));
    });
    $('nav-passos-caixa').hidden = !(rota.passos || []).length;
  }

  function atualizarDestinoNoMapa() {
    if (!estado.mapa) return;
    var d = estado.destino;
    if (!d) {
      if (estado.marcaDestino) { estado.marcaDestino.remove(); estado.marcaDestino = null; }
      if (estado.linhaDestino) { estado.linhaDestino.remove(); estado.linhaDestino = null; }
      return;
    }
    if (!estado.marcaDestino) {
      estado.marcaDestino = L.marker([d.lat, d.lng], {
        icon: L.divIcon({ className: 'mk-destino-wrap', html: '<div class="mk-destino">🧭</div>', iconSize: [0, 0] }),
        keyboard: false, zIndexOffset: 900, title: 'Destino: ' + d.nome,
      }).addTo(estado.mapa);
    } else {
      estado.marcaDestino.setLatLng([d.lat, d.lng]);
    }
    var l = estado.ultimaLeitura;
    if (l) {
      var pts = [[l.lat, l.lng], [d.lat, d.lng]];
      if (!estado.linhaDestino) estado.linhaDestino = L.polyline(pts, { color: '#facc15', weight: 3, dashArray: '2 8', lineCap: 'round', interactive: false }).addTo(estado.mapa);
      else estado.linhaDestino.setLatLngs(pts);
      // com rota calculada, a linha reta vira só referência de direção (mais fina)
      var comRota = Boolean(estado.rota);
      if (estado.linhaDestino._comRota !== comRota) {
        estado.linhaDestino._comRota = comRota;
        estado.linhaDestino.setStyle(comRota ? { weight: 2, opacity: 0.6, dashArray: '1 9' } : { weight: 3, opacity: 1, dashArray: '2 8' });
      }
    }
  }

  function rumoEntre(lat1, lng1, lat2, lng2) {
    var k = Math.PI / 180;
    var y = Math.sin((lng2 - lng1) * k) * Math.cos(lat2 * k);
    var x = Math.cos(lat1 * k) * Math.sin(lat2 * k) - Math.sin(lat1 * k) * Math.cos(lat2 * k) * Math.cos((lng2 - lng1) * k);
    return (Math.atan2(y, x) / k + 360) % 360;
  }

  function formatarDistancia(m) {
    if (m < 1000) return Math.round(m) + ' m';
    return (m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: m < 10000 ? 1 : 0 }) + ' km';
  }

  function agendarNavegacao() {
    if (!estado.destino || estado.rafNav) return;
    estado.rafNav = requestAnimationFrame(function () { estado.rafNav = null; atualizarNavegacao(); });
  }

  // Distância e direção em LINHA RETA, recalculadas a cada leitura do GPS.
  function atualizarNavegacao() {
    var d = estado.destino;
    if (!d) return;
    atualizarDestinoNoMapa();
    var l = estado.ultimaLeitura;
    var semGps = !l || Date.now() - l.recebidaEm > 60000 || estado.gps === 'negado' || estado.gps === 'indisponivel';
    var caixa = $('navegacao');
    var aviso = $('nav-aviso');
    if (semGps) {
      caixa.className = 'navegacao sem-gps';
      $('nav-dist').textContent = 'Sem GPS';
      $('nav-dir').textContent = 'Não dá para calcular a distância e a direção agora.';
      aviso.textContent = 'Ligue a localização do celular ou vá para um lugar aberto. As coordenadas do destino estão abaixo.';
      $('nav-seta').style.transform = 'rotate(0deg)';
      $('nav-bussola').classList.add('inativa');
      return;
    }
    $('nav-bussola').classList.remove('inativa');
    var dist = C.distancia(l.lat, l.lng, d.lat, d.lng);
    var rumoReta = rumoEntre(l.lat, l.lng, d.lat, d.lng);
    var chegou = dist <= Math.max(15, l.prec || 0);
    var fraco = l.prec != null && l.prec > 50;
    caixa.className = 'navegacao' + (chegou ? ' chegou' : '') + (fraco ? ' gps-fraco' : '');
    // Com rota: distância que falta PELA ROTA e seta apontando para a rota à frente.
    var rota = estado.rota && estado.rota.destId === d.id ? estado.rota : null;
    var prog = rota ? window.Rotas.progresso(rota, l.lat, l.lng) : null;
    var naRota = prog && prog.distanciaDaRota <= Math.max(60, (l.prec || 0) * 1.5);
    var rumo = naRota ? rumoEntre(l.lat, l.lng, prog.alvo[0], prog.alvo[1]) : rumoReta;
    if (prog && !chegou) {
      // saiu da rota (3 leituras seguidas): recalcula, no máximo 1 vez a cada 30 s
      if (prog.distanciaDaRota > Math.max(50, 2 * (l.prec || 0))) estado.rotaForaCont++; else estado.rotaForaCont = 0;
      if (estado.rotaForaCont >= 3 && Date.now() - estado.rotaCalcEm > 30000) calcularRota('desvio');
      var px = $('nav-proxima');
      px.hidden = false;
      px.textContent = naRota
        ? (prog.proximo ? 'Em ' + formatarDistancia(prog.distManobra) + ': ' + prog.proximo.instrucao : 'Siga pela rota até o destino.')
        : 'Você está a ' + formatarDistancia(prog.distanciaDaRota) + ' da rota azul. Volte para ela ou aguarde o recálculo.';
    } else if (!rota && !estado.rotaCalculando && Date.now() - estado.rotaErroEm > 60000 && navigator.onLine !== false) {
      calcularRota(estado.rotaErro ? 'tentar' : 'gps');
    }
    $('nav-dist').textContent = chegou ? 'Você chegou' : formatarDistancia(prog ? prog.restante + (naRota ? 0 : prog.distanciaDaRota) : dist);
    var dir = DIRECOES[Math.round(rumoReta / 45) % 8];
    var bussolaOk = estado.rumo != null && Date.now() - estado.rumoEm < 3000;
    var giro = bussolaOk ? rumo - estado.rumo : rumo;
    $('nav-seta').style.transform = 'rotate(' + Math.round(giro) + 'deg)';
    $('nav-norte').style.transform = 'rotate(' + Math.round(bussolaOk ? -estado.rumo : 0) + 'deg) translateY(-34px)';
    $('nav-bussola').classList.toggle('com-bussola', bussolaOk);
    $('nav-dir').textContent = chegou ? 'O destino está a menos de ' + Math.round(Math.max(15, l.prec || 0)) + ' m.'
      : (prog ? 'pela rota · em linha reta ' + formatarDistancia(dist) + ' para o ' + dir : 'em linha reta · para o ' + dir + ' (' + Math.round(rumoReta) + '°)') +
        (bussolaOk ? ' · siga a seta' : ' · a seta aponta em relação ao Norte (N)');
    aviso.textContent = (fraco ? 'Sinal de GPS fraco (' + C.precisao(l.prec) + '): distância e direção aproximadas. ' : '') +
      (prog ? 'A rota segue caminhos mapeados; confira o terreno e siga as orientações dos bombeiros.'
        : 'Linha reta não é caminho: confira o terreno, evite riscos e siga as orientações dos bombeiros.');
  }

  // Bússola: Android (deviceorientationabsolute) ou iPhone (webkitCompassHeading, com permissão).
  function aoGirar(ev) {
    var r = null;
    if (typeof ev.webkitCompassHeading === 'number' && !isNaN(ev.webkitCompassHeading)) r = ev.webkitCompassHeading;
    else if (ev.absolute && typeof ev.alpha === 'number') r = 360 - ev.alpha;
    if (r == null) return;
    var ang = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0);
    estado.rumo = (r + ang + 360) % 360;
    estado.rumoEm = Date.now();
    agendarNavegacao();
  }

  function ligarBussola() {
    if (estado.ouvindoBussola) return;
    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
      $('nav-bussola-ativar').hidden = false;   // iPhone: precisa de um toque para pedir permissão
      return;
    }
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', aoGirar);
      estado.ouvindoBussola = true;
    } else if ('ondeviceorientation' in window) {
      window.addEventListener('deviceorientation', aoGirar);
      estado.ouvindoBussola = true;
    }
  }

  function pedirBussola() {
    DeviceOrientationEvent.requestPermission().then(function (r) {
      if (r === 'granted') {
        window.addEventListener('deviceorientation', aoGirar);
        estado.ouvindoBussola = true;
        $('nav-bussola-ativar').hidden = true;
      } else {
        UI.aviso('Sem permissão para a bússola: a seta vai apontar em relação ao Norte.', 'erro', 7000);
      }
    }).catch(function () { UI.aviso('Bússola indisponível neste celular.', 'erro'); });
  }

  async function encerrarNavegacao() {
    var d = estado.destino;
    if (!d) return;
    var r = await UI.confirmar({ titulo: 'Encerrar a navegação?', texto: 'O destino "' + d.nome + '" some da sua tela. Os bombeiros podem enviar outro.', ok: 'Encerrar', cancelar: 'Voltar' });
    if (!r) return;
    try {
      await C.rpc('encerrar_destino', { p_destino: d.id });
      estado.encerrandoNav = true;
      definirDestino(null);
      estado.encerrandoNav = false;
      UI.aviso('Navegação encerrada.', 'ok');
    } catch (e) {
      if (!tratarErroFatal(e)) UI.aviso(e.rede ? 'Sem internet: tente de novo.' : e.message, 'erro');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Envio de mensagens e relatos à equipe                                */
  /* ------------------------------------------------------------------ */
  // Posição atual para mensagens e fotos: usa a leitura recente do rastreamento
  // ou pede uma nova ao GPS. Se não conseguir, devolve ok:false (nunca inventa).
  function obterPosicaoAgora() {
    var l = estado.ultimaLeitura;
    var recente = l && l.prec != null && l.prec <= 100 ? l : null;
    if (recente && Date.now() - recente.recebidaEm < 15000) {
      return Promise.resolve({ ok: true, lat: recente.lat, lng: recente.lng, prec: recente.prec, t: recente.recebidaEm });
    }
    if (!('geolocation' in navigator)) return Promise.resolve({ ok: false, motivo: 'aparelho sem GPS' });
    return new Promise(function (resolve) {
      navigator.geolocation.getCurrentPosition(function (p) {
        var agora = Date.now();
        resolve({ ok: true, lat: p.coords.latitude, lng: p.coords.longitude, prec: p.coords.accuracy,
          t: p.timestamp && Math.abs(p.timestamp - agora) < 864e5 ? p.timestamp : agora });
      }, function (e) {
        // Parado no mesmo lugar o GPS pode não entregar leitura nova: usa a última
        // leitura do rastreamento se for de até 2 min atrás (com o horário real dela).
        if (e.code !== 1 && recente && Date.now() - recente.recebidaEm < 120000) {
          resolve({ ok: true, lat: recente.lat, lng: recente.lng, prec: recente.prec, t: recente.recebidaEm });
          return;
        }
        resolve({ ok: false, motivo: e.code === 1 ? 'permissão de localização negada' : e.code === 2 ? 'GPS desligado ou indisponível' : 'sem sinal de GPS' });
      }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 });
    });
  }

  function salvarMsgPendentes() {
    if (!estado.part) return;
    C.local.gravar(CHAVE_MSGS, { participante_id: estado.part.participante_id, itens: estado.msgPendentes });
  }

  // Posição sem esperar o GPS: a leitura do rastreamento dos últimos 2 min, se houver.
  function posicaoRecente() {
    var l = estado.ultimaLeitura;
    if (l && l.prec != null && l.prec <= 100 && Date.now() - l.recebidaEm < 120000) {
      return { ok: true, lat: l.lat, lng: l.lng, prec: l.prec, t: l.recebidaEm };
    }
    return null;
  }

  // Envia aos bombeiros (mensagem, relato ou pedido de ajuda). A localização vai
  // junto automaticamente quando existir; nunca é inventada.
  async function enviarAosBombeiros(categoria, texto, posicao) {
    var item = { client_id: C.uuid(), categoria: categoria, texto: String(texto).slice(0, 1000), criada_local: Date.now() };
    if (posicao && posicao.ok) {
      item.lat = Math.round(posicao.lat * 1e7) / 1e7;
      item.lng = Math.round(posicao.lng * 1e7) / 1e7;
      item.prec = posicao.prec == null ? null : Math.round(posicao.prec * 10) / 10;
      item.t = posicao.t;
    }
    estado.msgPendentes.push(item);
    salvarMsgPendentes();
    renderizarHistorico();
    var ok = await enviarMensagemPendente(item);
    return { ok: ok, item: item };
  }

  async function aoEnviarMensagem(ev) {
    ev.preventDefault();
    if (!estado.part || estado.finalizado) return;
    var texto = $('msg-texto').value.trim();
    if (!texto) {
      UI.aviso('Escreva a mensagem antes de enviar.', 'erro');
      $('msg-texto').focus();
      return;
    }
    var btn = $('btn-enviar-msg');
    btn.disabled = true;
    try {
      $('msg-texto').value = '';
      var r = await enviarAosBombeiros('MENSAGEM', texto, posicaoRecente());
      if (r.ok) UI.aviso('Mensagem enviada aos bombeiros.', 'ok');
      else if (!r.item.erro) UI.aviso('Sem internet: a mensagem vai ser enviada quando o sinal voltar.', 'erro', 7000);
    } finally {
      btn.disabled = false;
    }
  }

  // "Encontrei algo": escolhe o que é, escreve (se quiser) e envia com a localização.
  function abrirEncontrei() {
    if (!estado.part || estado.finalizado) return;
    var opcoes = [
      ['PISTA', 'Possível pista', 'pegada, rastro, roupa, sinal de passagem'],
      ['OBJETO', 'Objeto', 'mochila, celular, documento, calçado'],
      ['VESTIGIO', 'Vestígio', 'sangue, fogueira, restos de comida'],
      ['OBSTACULO', 'Obstáculo', 'rio, barranco, mata fechada, trilha bloqueada'],
      ['OUTRO', 'Outra coisa', 'qualquer informação importante'],
    ];
    var grade = UI.el('div', { classe: 'encontrei-opcoes' });
    var fechar = UI.abrirModal(UI.el('div', { classe: 'encontrei' }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'O que você encontrou?' }),
      grade,
      UI.el('div', { classe: 'modal-acoes' }, [UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } })]),
    ]));
    opcoes.forEach(function (o) {
      grade.appendChild(UI.el('button', { classe: 'opcao-encontrei', type: 'button', 'data-cat': o[0], onclick: function () { fechar(); detalharEncontrei(o); } }, [
        UI.el('strong', { texto: o[1] }), UI.el('span', { texto: o[2] }),
      ]));
    });
  }

  function detalharEncontrei(o) {
    var area = UI.el('textarea', { classe: 'campo', id: 'encontrei-texto', rows: '2', maxlength: '1000', placeholder: 'Ex.: mochila azul perto da cerca' });
    var btnEnviar = UI.el('button', { classe: 'btn btn-primario btn-gigante', type: 'button', id: 'encontrei-enviar', texto: 'ENVIAR AOS BOMBEIROS' });
    var inFoto = UI.el('input', { classe: 'sr-only', type: 'file', accept: 'image/*', capture: 'environment', id: 'encontrei-foto' });
    var comFoto = UI.el('label', { classe: 'btn btn-escuro btn-gigante' }, [UI.el('span', { 'aria-hidden': 'true', texto: '📷 ' }), 'ENVIAR E TIRAR FOTO', inFoto]);
    var fechar = UI.abrirModal(UI.el('div', null, [
      UI.el('h2', { id: 'modal-titulo', texto: o[1] }),
      UI.el('p', { classe: 'ajuda', texto: 'Sua localização vai junto. Se quiser, explique em poucas palavras:' }),
      area,
      UI.el('div', { classe: 'encontrei-botoes' }, [btnEnviar, comFoto]),
      UI.el('div', { classe: 'modal-acoes' }, [UI.el('button', { classe: 'btn', type: 'button', texto: 'Voltar', onclick: function () { fechar(); abrirEncontrei(); } })]),
    ]), { fecharNoFundo: false });
    var enviado = false;
    async function enviar() {
      if (enviado) return;
      enviado = true;
      var texto = area.value.trim() || o[1] + ' encontrado(a) aqui';
      var pos = posicaoRecente() || await obterPosicaoAgora();
      if (!pos.ok) UI.aviso('Sem GPS agora: o aviso vai sem a localização.', 'erro', 6000);
      var r = await enviarAosBombeiros(o[0], texto, pos);
      if (r.ok) UI.aviso('Os bombeiros receberam: ' + o[1] + '.', 'ok', 5000);
      else if (!r.item.erro) UI.aviso('Sem internet: o aviso vai ser enviado quando o sinal voltar.', 'erro', 7000);
    }
    btnEnviar.addEventListener('click', function () { fechar(); enviar(); });
    // A foto abre logo em seguida; o aviso é enviado na hora.
    inFoto.addEventListener('change', function (ev) {
      var legenda = area.value.trim() || o[1];
      fechar();
      enviar();
      aoEscolherFoto(ev, true, legenda);
    });
  }

  async function enviarMensagemPendente(item) {
    try {
      var m = await C.rpc('participante_enviar_mensagem', {
        p_participante: estado.part.participante_id,
        p_categoria: item.categoria,
        p_texto: item.texto,
        p_lat: item.lat != null ? item.lat : null,
        p_lng: item.lng != null ? item.lng : null,
        p_precisao: item.prec != null ? item.prec : null,
        p_posicao_em: item.t ? new Date(item.t).toISOString() : null,
        p_client_id: item.client_id,
      });
      marcarSucesso();
      receberMensagens([m]);
      return true;
    } catch (e) {
      if (tratarErroFatal(e)) return false;
      if (!e.rede) {
        item.erro = e.message;
        salvarMsgPendentes();
        renderizarHistorico();
        UI.aviso(e.message, 'erro', 7000);
      }
      return false;
    }
  }

  async function reenviarMensagens() {
    var copia = estado.msgPendentes.filter(function (x) { return !x.erro; });
    for (var i = 0; i < copia.length; i++) {
      if (!(await enviarMensagemPendente(copia[i]))) break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Fotos georreferenciadas                                              */
  /* ------------------------------------------------------------------ */
  // Fila de fotos no aparelho (IndexedDB): sobrevive a falta de internet e a
  // recarregar a página. Sem IndexedDB, a fila fica só na memória.
  var banco = { db: null };
  function abrirBanco() {
    if (banco.db !== null) return Promise.resolve(banco.db);
    return new Promise(function (resolve) {
      try {
        var r = indexedDB.open('gbs-civil', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('fotos', { keyPath: 'id' }); };
        r.onsuccess = function () { banco.db = r.result; resolve(banco.db); };
        r.onerror = function () { banco.db = false; resolve(false); };
      } catch (e) { banco.db = false; resolve(false); }
    });
  }
  async function bancoOp(modo, fn) {
    var db = await abrirBanco();
    if (!db) return null;
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction('fotos', modo);
        var req = fn(tx.objectStore('fotos'));
        tx.oncomplete = function () { resolve(req ? req.result : null); };
        tx.onerror = tx.onabort = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }
  function guardarFotoLocal(item) { estado.fotosLocais.set(item.id, item); return bancoOp('readwrite', function (st) { return st.put(item); }); }
  function apagarFotoLocal(id) {
    var it = estado.fotosLocais.get(id);
    if (it && it.urlPrevia) URL.revokeObjectURL(it.urlPrevia);
    estado.fotosLocais.delete(id);
    return bancoOp('readwrite', function (st) { return st.delete(id); });
  }
  async function carregarFilaFotos() {
    var todos = (await bancoOp('readonly', function (st) { return st.getAll(); })) || [];
    todos.forEach(function (it) {
      if (estado.part && it.participante_id === estado.part.participante_id) {
        if (it.estado === 'enviando') it.estado = 'fila';
        estado.fotosLocais.set(it.id, it);
      } else {
        bancoOp('readwrite', function (st) { return st.delete(it.id); });
      }
    });
    renderizarFotos();
  }

  async function aoEscolherFoto(ev, daCamera, legenda) {
    var arquivo = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!arquivo || !estado.part || estado.finalizado) return;
    var f = await window.Fotos.lerArquivo(arquivo, daCamera, obterPosicaoAgora);
    if (!f || !estado.part || estado.finalizado) return;
    // Prévia: confirma ou cancela antes de salvar (Fotos.abrirPrevia).
    window.Fotos.abrirPrevia(f, {
      simples: true,
      legenda: legenda || '',
      obterPosicao: obterPosicaoAgora,
      aoSalvar: async function (d) {
        var item = Object.assign(d, {
          id: C.uuid(),
          participante_id: estado.part.participante_id,
          operacao_id: estado.part.operacao_id,
          criada_local: Date.now(),
          estado: 'fila',
        });
        await guardarFotoLocal(item);
        renderizarFotos();
        processarFilaFotos();
      },
    });
  }

  async function processarFilaFotos() {
    if (estado.enviandoFotos || !estado.part || estado.finalizado) return;
    var fila = Array.from(estado.fotosLocais.values())
      .filter(function (it) { return it.estado !== 'erro'; })
      .sort(function (a, b) { return a.criada_local - b.criada_local; });
    if (!fila.length) return;
    estado.enviandoFotos = true;
    try {
      for (var i = 0; i < fila.length; i++) {
        var it = fila[i];
        it.estado = 'enviando';
        renderizarFotos();
        try {
          await enviarFoto(it);
          await apagarFotoLocal(it.id);
          UI.aviso('Foto enviada aos bombeiros.', 'ok');
        } catch (e) {
          if (tratarErroFatal(e)) return;
          it.estado = e.rede ? 'fila' : 'erro';
          it.erro = e.rede ? null : e.message;
          await guardarFotoLocal(it);
          renderizarFotos();
          if (e.rede) {
            UI.aviso('Sem internet: a foto ficou guardada e vai ser enviada quando o sinal voltar.', 'erro', 7000);
            break;
          }
          UI.aviso('A foto não foi enviada: ' + e.message, 'erro', 8000);
        }
      }
    } finally {
      estado.enviandoFotos = false;
      renderizarFotos();
    }
  }

  async function enviarFoto(it) {
    var foto = await window.Fotos.enviar(it);
    marcarSucesso();
    estado.minhasFotos = [foto].concat(estado.minhasFotos.filter(function (x) { return x.id !== foto.id; }));
    estado.urlsFotos.set(foto.caminho, { url: URL.createObjectURL(it.blob), exp: Infinity });
  }

  async function carregarMinhasFotos() {
    if (!estado.part) return;
    try {
      var lista = await C.consultar(C.cliente.from('fotos').select('*').eq('participante_id', estado.part.participante_id)
        .order('registrada_em', { ascending: false }).limit(20));
      estado.minhasFotos = lista || [];
      var faltam = estado.minhasFotos.map(function (f) { return f.caminho; }).filter(function (c) { return !estado.urlsFotos.has(c); });
      if (faltam.length) {
        var r = await C.cliente.storage.from('fotos').createSignedUrls(faltam, 3600);
        (r.data || []).forEach(function (d) { if (d.signedUrl) estado.urlsFotos.set(d.path, { url: d.signedUrl }); });
      }
    } catch (e) { /* tenta de novo depois */ }
    renderizarFotos();
  }

  // Suas fotos: miniaturas. Na fila mostra "esperando internet"; se falhar, tentar de novo ou apagar.
  function renderizarFotos() {
    var ul = $('fotos-minhas');
    if (!ul) return;
    ul.innerHTML = '';
    var locais = Array.from(estado.fotosLocais.values()).sort(function (a, b) { return b.criada_local - a.criada_local; });
    locais.forEach(function (it) {
      if (!it.urlPrevia) it.urlPrevia = URL.createObjectURL(it.blob);
      var li = UI.el('li', { classe: 'foto-item ' + (it.estado === 'erro' ? 'erro' : 'fila') }, [
        UI.el('img', { src: it.urlPrevia, alt: it.legenda || 'Foto' }),
        UI.el('span', { classe: 'foto-selo', texto: it.estado === 'enviando' ? 'Enviando…' : it.estado === 'erro' ? 'Não enviada' : 'Esperando internet' }),
      ]);
      if (it.estado === 'erro' || it.estado === 'fila') {
        li.appendChild(UI.el('div', { classe: 'foto-acoes' }, [
          UI.el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Tentar', onclick: function () { it.estado = 'fila'; it.erro = null; processarFilaFotos(); } }),
          UI.el('button', { classe: 'btn btn-pequeno btn-perigo', type: 'button', texto: 'Apagar', onclick: async function () { await apagarFotoLocal(it.id); renderizarFotos(); } }),
        ]));
      }
      ul.appendChild(li);
    });
    estado.minhasFotos.forEach(function (f) {
      var u = estado.urlsFotos.get(f.caminho);
      ul.appendChild(UI.el('li', { classe: 'foto-item enviada' }, [
        u ? UI.el('img', { src: u.url, alt: f.legenda || 'Foto enviada' }) : UI.el('div', { classe: 'foto-sem-previa', texto: 'Foto' }),
        UI.el('span', { classe: 'foto-selo ok', texto: '✓ Enviada' }),
      ]));
    });
    $('fotos-civil').hidden = !ul.children.length;
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
        estado.swReg.showNotification('Bombeiros: ' + (tipo && m.tipo !== 'PERSONALIZADA' ? tipo.titulo : 'nova mensagem'), {
          body: m ? (m.texto || tipo.padrao) : 'Abra a página da busca.',
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
      if (p === 'granted') UI.aviso('Pronto. Mesmo assim, deixe esta tela aberta.', 'ok');
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
    caixa.textContent = 'O celular parou de enviar sua localização por cerca de ' + min + ' min. Deixe esta tela aberta e o celular desbloqueado.';
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
    // Parado, alguns aparelhos só avisam quando há mudança: pede uma leitura nova
    // a cada 45 s para a posição não envelhecer (o filtro decide se entra na trilha).
    if (estado.rastreando && estado.ultimaLeitura && estado.gps !== 'negado' && agora - estado.ultimaLeitura.recebidaEm > 45000 &&
        agora - (estado.leituraPedidaEm || 0) > 45000) {
      estado.leituraPedidaEm = agora;
      navigator.geolocation.getCurrentPosition(processarPosicao, function () { /* o observador trata os erros */ },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    }
    // Alguns aparelhos param de entregar leituras sem avisar: reinicia o observador
    // (sempre um só) se ficar 90 s sem nada com a tela aberta e a permissão concedida.
    var ultima = estado.ultimaLeitura ? estado.ultimaLeitura.recebidaEm : 0;
    if (estado.rastreando && document.visibilityState === 'visible' && estado.permissao !== 'denied' &&
        estado.gps !== 'negado' && agora - Math.max(ultima, estado.watchIniciadoEm) > CFG.reiniciarGpsMs) {
      pararWatch();
      iniciarWatch();
    }
    atualizarUI();
    agendarNavegacao();
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !estado.part) return;
    if (estado.finalizado) { if (estado.timerReinclusao) verificarReinclusao(); return; }
    pedirTelaLigada();
    enviarSinal();
    agendarEnvio(0);
    carregarDestino();
    carregarEquipe();
    acompanharPermissao().then(function () { if (estado.permissao === 'granted' && estado.gps === 'negado') religarGps(); });
  });
  window.addEventListener('online', function () {
    if (estado.part && !estado.finalizado) {
      enviarSinal(); agendarEnvio(0); reenviarMensagens(); processarFilaFotos(); carregarDestino();
      if (estado.destino && !estado.rota) { estado.rotaErroEm = 0; calcularRota('tentar'); }
    }
    atualizarUI();
  });
  window.addEventListener('offline', function () { atualizarUI(); });
  window.addEventListener('beforeunload', function (ev) {
    if (estado.rastreando && !window.GBS_RECARREGANDO) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });

  /* ------------------------------------------------------------------ */
  /* Pedido de encerramento / encerrar                                    */
  /* ------------------------------------------------------------------ */
  // O participante não interrompe o rastreamento: ele pede ao responsável,
  // que libera a saída pelo painel. Até lá, o envio continua normalmente.
  async function aoSolicitarSaida() {
    if (estado.saidaSolicitadaEm) return;
    var r = await UI.confirmar({
      titulo: 'Quer sair da busca?',
      texto: 'Os bombeiros vão receber seu pedido e liberar sua saída. Até lá, deixe esta tela aberta.',
      campo: { rotulo: 'Motivo (se quiser)', valor: '', max: 200 },
      ok: 'Pedir para sair',
      cancelar: 'Voltar',
    });
    if (!r) return;
    var btn = $('btn-saida');
    btn.disabled = true;
    try {
      var resp = await C.rpc('solicitar_saida', { p_participante: estado.part.participante_id, p_motivo: r.texto || '' });
      estado.saidaSolicitadaEm = resp && resp.saida_solicitada_em ? resp.saida_solicitada_em : new Date().toISOString();
      marcarSucesso();
      UI.aviso('Pedido enviado. Aguarde os bombeiros liberarem.', 'ok', 6000);
    } catch (e) {
      if (!tratarErroFatal(e)) UI.aviso(e.rede ? 'Sem internet: não deu para enviar o pedido. Tente de novo.' : e.message, 'erro', 7000);
    } finally {
      btn.disabled = false;
      atualizarUI();
    }
  }

  function pararColeta() {
    estado.rastreando = false;
    pararWatch();
    liberarTelaLigada();
    atualizarUI();
  }

  function finalizar(motivo) {
    estado.finalizado = true;
    pararColeta();
    estado.filtro.reiniciar();
    clearInterval(estado.timerSinal);
    clearInterval(estado.timerUI);
    clearInterval(estado.timerEquipe);
    estado.timerEquipe = null;
    window.removeEventListener('deviceorientationabsolute', aoGirar);
    window.removeEventListener('deviceorientation', aoGirar);
    $('navegacao').hidden = true;
    $('painel-conversa').hidden = true;
    document.body.classList.remove('conversa-aberta');
    clearTimeout(estado.timerEnvio);
    estado.timerSinal = estado.timerUI = null;
    if (estado.canal) {
      try { C.cliente.removeChannel(estado.canal); } catch (e) { /* ignora */ }
      estado.canal = null;
    }
    $('alerta-msg').hidden = true;
    var podeVoltar = (motivo === 'removido' || motivo === 'liberado') && estado.part;
    if (podeVoltar) salvarParticipacao(false, true);   // guarda para uma reinclusão (sem fila nem mensagens)
    else C.local.apagar(CHAVE_PART);
    C.local.apagar(CHAVE_FILA);
    C.local.apagar(CHAVE_CONF);
    C.local.apagar(CHAVE_MSGS);
    C.local.apagar(CHAVE_VISTO);
    var naFila = estado.fotosLocais.size;
    estado.fotosLocais.forEach(function (it, id) { apagarFotoLocal(id); });
    if (naFila) UI.aviso(naFila + ' foto(s) que ainda não tinham sido enviadas foram descartadas.', 'erro', 8000);
    var textos = {
      encerrada: ['Busca encerrada', 'Os bombeiros encerraram esta busca. Obrigado pela sua ajuda!'],
      removido: ['Participação encerrada', 'Os bombeiros encerraram a sua participação nesta busca.'],
      liberado: ['Saída liberada', 'Os bombeiros liberaram a sua saída. Obrigado pela sua ajuda!'],
      inexistente: ['Participação encerrada', 'A operação foi excluída pelos bombeiros. Este link não funciona mais.'],
    };
    var t = textos[motivo] || textos.encerrada;
    estado.motivoFim = motivo;
    estado.fila = [];
    estado.destino = null;
    estado.destinoConfirmado = null;
    $('navegacao').hidden = true;
    $('fim-titulo').textContent = t[0];
    $('fim-texto').textContent = t[1];
    $('fim-voltar').hidden = true;
    $('fim-nota').textContent = podeVoltar
      ? 'Sua localização não está mais sendo compartilhada.'
      : 'Sua localização não está mais sendo compartilhada. Você já pode fechar esta página.';
    $('fim-aguardando').hidden = !podeVoltar;
    clearInterval(estado.timerReinclusao);
    estado.timerReinclusao = podeVoltar ? setInterval(verificarReinclusao, CFG.reinclusaoMs) : null;
    mostrarTela('encerrado');
  }

  /* ------------------------------------------------------------------ */
  /* Reinclusão: os bombeiros chamaram de volta                           */
  /* ------------------------------------------------------------------ */
  // Removido ou com saída liberada: a página verifica (sem enviar localização)
  // se o responsável reincluiu este participante. Se sim, oferece o botão para
  // voltar — o rastreamento só recomeça com o toque da pessoa.
  async function verificarReinclusao() {
    if (!estado.part || !estado.finalizado) return;
    var r;
    try {
      r = await C.rpc('sinal_vida', { p_participante: estado.part.participante_id, p_rastreando: false, p_gps: null }, 12000);
    } catch (e) { return; }
    if (!r) return;
    if (r.status === 'ativa') {
      clearInterval(estado.timerReinclusao);
      estado.timerReinclusao = null;
      $('fim-aguardando').hidden = true;
      $('fim-voltar').hidden = false;
      prepararAudio();
      chamarAtencao();
      $('btn-voltar-busca').focus();
    } else if (r.status === 'encerrada' || r.status === 'inexistente') {
      clearInterval(estado.timerReinclusao);
      estado.timerReinclusao = null;
      C.local.apagar(CHAVE_PART);
      finalizar(r.status);
    }
  }

  async function voltarParaBusca() {
    var s = C.local.ler(CHAVE_PART, null);
    if (!s || s.token !== estado.token) { location.reload(); return; }
    $('fim-voltar').hidden = true;
    $('ini-nome').value = s.nome || '';
    $('ini-cpf').value = mascararCpf(s.cpf || '');
    $('ini-tel').value = mascararTelefone(s.telefone || '');
    $('btn-iniciar').textContent = 'CONTINUAR';
    mostrarTela('inicio');
    await entrarNaBusca({ nome: s.nome, tipo: s.tipo, cpf: s.cpf, tel: s.telefone });
  }

  /* ------------------------------------------------------------------ */
  /* Diagnóstico do GPS (só neste aparelho; abre com ?diag=1 no link)      */
  /* ------------------------------------------------------------------ */
  function abrirDiagnostico() {
    var f = estado.filtro;
    var caixa = UI.el('div', { classe: 'diag-tabela' });
    function render() {
      caixa.innerHTML = window.GPS.tabelaDiagnostico(f, 80);
    }
    render();
    var resumo = f.resumo().map(function (x) { return x.texto + ': ' + x.qtd; }).join(' · ');
    var timer = setInterval(render, 2000);
    var fechar = UI.abrirModal(UI.el('div', { classe: 'modal-diag' }, [
      UI.el('h2', { id: 'modal-titulo', texto: 'Diagnóstico do GPS' }),
      UI.el('p', { classe: 'ajuda', texto: 'Fica só neste aparelho; não é enviado. Permissão: ' + estado.permissao + ' · estado: ' + estado.gps +
        ' · na fila: ' + estado.fila.length + ' ponto(s).' }),
      UI.el('p', { classe: 'ajuda', texto: resumo || 'Sem leituras ainda.' }),
      caixa,
      UI.el('div', { classe: 'modal-acoes' }, [UI.el('button', { classe: 'btn', type: 'button', texto: 'Fechar', onclick: function () { fechar(); } })]),
    ]), { aoFechar: function () { clearInterval(timer); } });
  }

  /* ------------------------------------------------------------------ */
  /* Atualização da interface                                             */
  /* ------------------------------------------------------------------ */
  function atualizarUI() {
    if (!estado.part || estado.finalizado) return;
    $('st-nome').textContent = estado.part.nome + ' · ' + estado.part.operacao;

    var net = estadoInternet();
    var pend = estado.fila.length;
    var cod, titulo, sub;
    if (!estado.rastreando) {
      cod = 'parado'; titulo = 'Localização desligada'; sub = 'Toque em CONTINUAR para voltar a ajudar.';
    } else if (estado.gps === 'negado') {
      cod = 'erro'; titulo = 'A localização está bloqueada';
      sub = 'Os bombeiros NÃO estão vendo onde você está. Toque em "Como resolver".';
    } else if (estado.gps === 'indisponivel') {
      cod = 'erro'; titulo = 'A localização do celular está desligada';
      sub = 'Os bombeiros NÃO estão vendo onde você está. Toque em "Como resolver".';
    } else if (estado.gps !== 'ok' && estado.gps !== 'fraco') {
      cod = 'sem-gps'; titulo = 'Procurando o sinal de GPS…'; sub = 'Se puder, vá para um lugar aberto, longe de paredes e árvores.';
    } else if (net === 'offline' || net === 'falha') {
      cod = 'sem-internet'; titulo = 'Sem internet agora';
      sub = 'Sua localização está sendo guardada e vai ser enviada quando o sinal voltar.' + (pend ? ' (' + pend + ' guardada' + (pend > 1 ? 's' : '') + ')' : '');
    } else if (net === 'conectando' && !estado.ultimoEnviadoT) {
      cod = 'sem-gps'; titulo = 'Conectando com os bombeiros…'; sub = 'Só um instante.';
    } else {
      cod = 'ok'; titulo = 'Os bombeiros estão vendo onde você está'; sub = 'Deixe esta tela aberta.';
    }
    var acao = $('status-acao');
    var precisaAjuda = estado.rastreando && (estado.gps === 'negado' || estado.gps === 'indisponivel' ||
      (estado.gps === 'sem_sinal' && estado.ultimaLeitura == null && Date.now() - estado.watchIniciadoEm > 30000));
    if (acao.hidden === precisaAjuda) acao.hidden = !precisaAjuda;
    var caixa = $('status-civil');
    if (caixa.getAttribute('data-estado') !== cod) caixa.setAttribute('data-estado', cod);
    if ($('status-titulo').textContent !== titulo) $('status-titulo').textContent = titulo;
    if ($('status-sub').textContent !== sub) $('status-sub').textContent = sub;

    // Pedido de saída
    var pendente = Boolean(estado.saidaSolicitadaEm);
    $('saida-pendente').hidden = !pendente;
    if (pendente) $('saida-hora').textContent = C.hora(estado.saidaSolicitadaEm, false);
    $('btn-saida').hidden = pendente;
  }

  iniciar();
})();
