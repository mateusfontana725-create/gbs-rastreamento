/* =====================================================================
 * comunicacao.js — camada compartilhada entre o painel militar e a
 * página do participante: cliente Supabase, chamadas ao servidor,
 * tradução de erros, relógio do servidor e utilidades de formatação.
 * ===================================================================== */
(function () {
  'use strict';

  var cfg = window.APP_CONFIG || {};
  var pagina = document.documentElement.getAttribute('data-pagina') || 'app';
  var configurado = Boolean(cfg.supabaseUrl && cfg.supabaseKey && window.supabase && window.supabase.createClient);

  var cliente = null;
  if (configurado) {
    cliente = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        // Sessões separadas: abrir o painel e a página do participante no
        // mesmo navegador não mistura as identidades.
        storageKey: 'sar-sessao-' + pagina,
      },
      realtime: { params: { eventsPerSecond: 30 } },
    });
  }

  /* ---------- Erros ---------------------------------------------------- */
  var ERROS = {
    nao_autenticado: 'Sessão expirada. Recarregue a página.',
    link_invalido: 'Link de operação inválido ou incompleto. Peça um novo link ao responsável.',
    operacao_encerrada: 'Esta operação foi encerrada pelo responsável.',
    nome_invalido: 'Informe um nome ou indicativo com 2 a 40 caracteres.',
    participante_removido: 'Você foi removido desta operação pelo responsável.',
    participante_invalido: 'Sua participação não foi encontrada. Entre novamente pelo link.',
    limite_participantes: 'A operação atingiu o limite de participantes.',
    sem_permissao: 'Você não tem permissão para esta ação.',
    tipo_invalido: 'Tipo de mensagem inválido.',
    texto_obrigatorio: 'Escreva o texto da mensagem.',
    texto_longo: 'Mensagem muito longa (máximo de 500 caracteres).',
    codigo_invalido: 'Informe um nome ou código da operação com 2 a 80 caracteres.',
    retencao_invalida: 'Política de retenção inválida.',
    lote_invalido: 'Dados inválidos enviados ao servidor.',
    operacao_ativa: 'Encerre a operação antes de apagar os dados.',
    muitas_mensagens: 'Muitas mensagens enviadas no último minuto. Aguarde um pouco.',
    cpf_invalido: 'CPF inválido. Confira os 11 números.',
    telefone_invalido: 'Celular inválido. Informe o DDD e o número.',
    participante_liberado: 'Sua saída desta operação já foi liberada pelo responsável.',
    nao_pode_alterar_a_si: 'Você não pode desativar nem tirar o próprio acesso de administrador. Peça a outro administrador.',
    ultimo_admin: 'É preciso manter pelo menos um administrador ativo.',
    area_invalida: 'Área inválida: confira o raio (5 m a 50 km) ou desenhe pelo menos 3 pontos.',
    dados_invalidos: 'Dados inválidos. Confira os campos e tente de novo.',
    posicao_invalida: 'Coordenadas inválidas.',
    setor_nao_encontrado: 'Este setor não existe mais (pode ter sido excluído por outro responsável).',
    ponto_nao_encontrado: 'Este ponto não existe mais (pode ter sido excluído por outro responsável).',
    participante_ativo: 'Este participante já está ativo na operação.',
    funcao_ausente: 'O servidor ainda não foi atualizado (falta executar a migração mais recente do banco no Supabase). Avise o responsável técnico.',
    responsavel_nao_encontrado: 'Nenhum responsável cadastrado com esse e-mail. Peça ao administrador para autorizá-lo primeiro.',
    'Invalid login credentials': 'E-mail ou senha incorretos.',
    'Email not confirmed': 'E-mail ainda não confirmado no Supabase.',
    'Anonymous sign-ins are disabled': 'O ingresso de participantes está desativado no servidor (login anônimo). Avise o responsável.',
  };

  function textoDoErro(err) {
    if (!err) return '';
    return String(err.message || err.error_description || err.msg || err.details || err);
  }

  function ehErroDeRede(err) {
    var t = textoDoErro(err);
    return /Failed to fetch|NetworkError|Network request failed|Load failed|fetch failed|ERR_INTERNET|timeout|AbortError/i.test(t) ||
      (err && (err.status === 0 || err.code === 'rede'));
  }

  function codigoDoErro(err) {
    var t = textoDoErro(err);
    // PostgREST: função inexistente no banco (migração não aplicada ou cache de esquema desatualizado)
    if (err && (err.code === 'PGRST202' || /Could not find the function/i.test(t))) return 'funcao_ausente';
    for (var k in ERROS) {
      if (t.indexOf(k) !== -1) return k;
    }
    if (ehErroDeRede(err)) return 'rede';
    return 'desconhecido';
  }

  function traduzirErro(err) {
    var cod = codigoDoErro(err);
    if (ERROS[cod]) return ERROS[cod];
    if (cod === 'rede') return 'Sem conexão com o servidor. Verifique a internet.';
    return 'Erro inesperado: ' + textoDoErro(err);
  }

  function criarErro(err) {
    var e = new Error(traduzirErro(err));
    e.codigo = codigoDoErro(err);
    e.rede = e.codigo === 'rede';
    e.original = err;
    return e;
  }

  /* ---------- Chamadas ao servidor -------------------------------------- */
  function comTempoLimite(promessa, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        var e = new Error('timeout');
        e.code = 'rede';
        reject(e);
      }, ms || 15000);
      promessa.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  async function rpc(nome, args, ms) {
    if (!cliente) throw criarErro({ message: 'Aplicativo não configurado.' });
    var r;
    try {
      r = await comTempoLimite(cliente.rpc(nome, args || {}), ms || 15000);
    } catch (e) {
      throw criarErro(e);
    }
    if (r.error) throw criarErro(r.error);
    return r.data;
  }

  // Executa uma consulta do supabase-js e devolve os dados (ou lança erro traduzido).
  async function consultar(construtor, ms) {
    var r;
    try {
      r = await comTempoLimite(Promise.resolve(construtor), ms || 20000);
    } catch (e) {
      throw criarErro(e);
    }
    if (r.error) throw criarErro(r.error);
    return r.data;
  }

  // Busca todas as linhas, em páginas de 1000 (limite padrão do Supabase).
  async function consultarTudo(fabrica, tamanho) {
    tamanho = tamanho || 1000;
    var todas = [];
    for (var inicio = 0; ; inicio += tamanho) {
      var pagina = await consultar(fabrica().range(inicio, inicio + tamanho - 1));
      todas = todas.concat(pagina || []);
      if (!pagina || pagina.length < tamanho) break;
      if (inicio > 500000) break; // salvaguarda
    }
    return todas;
  }

  /* ---------- Relógio do servidor --------------------------------------- */
  // Diferença entre o relógio do servidor e o do aparelho. Evita que um
  // celular com hora errada mostre "há 3 horas" para uma posição recente.
  var desvioRelogio = 0;
  async function sincronizarRelogio() {
    try {
      var t0 = Date.now();
      var agoraServidor = await rpc('agora', {}, 8000);
      var t1 = Date.now();
      var ms = Date.parse(agoraServidor);
      if (!isNaN(ms)) desvioRelogio = ms - (t0 + t1) / 2;
    } catch (e) { /* mantém o último valor */ }
    return desvioRelogio;
  }
  function agora() { return Date.now() + desvioRelogio; }

  /* ---------- Formatação ------------------------------------------------ */
  function paraMs(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    var ms = Date.parse(v);
    return isNaN(ms) ? null : ms;
  }

  function hora(v, comSegundos) {
    var ms = paraMs(v);
    if (ms == null) return '—';
    var d = new Date(ms);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    var txt = p(d.getHours()) + ':' + p(d.getMinutes());
    if (comSegundos !== false) txt += ':' + p(d.getSeconds());
    var hoje = new Date();
    if (d.toDateString() !== hoje.toDateString()) txt = p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + txt;
    return txt;
  }

  function idade(v, referencia) {
    var ms = paraMs(v);
    if (ms == null) return 'nunca';
    var s = Math.max(0, Math.round(((referencia || agora()) - ms) / 1000));
    if (s < 5) return 'agora';
    if (s < 60) return 'há ' + s + ' s';
    var m = Math.floor(s / 60);
    if (m < 60) return 'há ' + m + ' min';
    var h = Math.floor(m / 60);
    if (h < 48) return 'há ' + h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
    return 'há ' + Math.floor(h / 24) + ' dias';
  }

  function coord(v) { return v == null ? '—' : Number(v).toFixed(6); }

  function precisao(v) {
    if (v == null) return '—';
    return '± ' + (v < 10 ? Number(v).toFixed(1) : Math.round(v)) + ' m';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  // Distância em metros (fórmula de haversine).
  function distancia(lat1, lng1, lat2, lng2) {
    var R = 6371000, rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /* ---------- Armazenamento local seguro --------------------------------- */
  var local = {
    ler: function (chave, padrao) {
      try {
        var v = localStorage.getItem(chave);
        return v == null ? padrao : JSON.parse(v);
      } catch (e) { return padrao; }
    },
    gravar: function (chave, valor) {
      try { localStorage.setItem(chave, JSON.stringify(valor)); return true; } catch (e) { return false; }
    },
    apagar: function (chave) {
      try { localStorage.removeItem(chave); } catch (e) { /* ignora */ }
    },
  };

  /* ---------- Mensagens (comandos) ---------------------------------------- */
  var TIPOS_MENSAGEM = {
    RETORNE: { rotulo: 'RETORNE', titulo: 'RETORNE', padrao: 'Retorne ao ponto de apoio ou ao local indicado.', critico: true, classe: 'cmd-retorne' },
    ATENCAO: { rotulo: 'ATENÇÃO / CUIDADO', titulo: 'ATENÇÃO — CUIDADO', padrao: 'Condição de risco na sua área. Redobre a atenção.', critico: true, classe: 'cmd-atencao' },
    MUDE_ROTA: { rotulo: 'MUDE A ROTA', titulo: 'MUDE A ROTA', padrao: 'Mude a direção conforme orientação do responsável.', critico: true, classe: 'cmd-rota' },
    PARE: { rotulo: 'PARE', titulo: 'PARE', padrao: 'Interrompa o deslocamento e aguarde instruções.', critico: true, classe: 'cmd-pare' },
    CONFIRME: { rotulo: 'CONFIRME', titulo: 'CONFIRME SUA SITUAÇÃO', padrao: 'Confirme o recebimento e informe sua situação.', critico: false, classe: 'cmd-confirme' },
    PERSONALIZADA: { rotulo: 'MENSAGEM PERSONALIZADA', titulo: 'MENSAGEM', padrao: '', critico: false, classe: 'cmd-livre' },
  };

  var RESPOSTAS = {
    CIENTE: 'Ciente',
    ESTOU_BEM: 'Estou bem',
    PRECISO_AJUDA: 'PRECISO DE AJUDA',
  };

  window.Comunicacao = {
    configurado: configurado,
    cliente: cliente,
    rpc: rpc,
    consultar: consultar,
    consultarTudo: consultarTudo,
    traduzirErro: traduzirErro,
    criarErro: criarErro,
    ehErroDeRede: ehErroDeRede,
    sincronizarRelogio: sincronizarRelogio,
    agora: agora,
    paraMs: paraMs,
    hora: hora,
    idade: idade,
    coord: coord,
    precisao: precisao,
    esc: esc,
    uuid: uuid,
    distancia: distancia,
    local: local,
    TIPOS_MENSAGEM: TIPOS_MENSAGEM,
    RESPOSTAS: RESPOSTAS,
  };
})();
