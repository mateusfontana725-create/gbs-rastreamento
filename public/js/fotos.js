/* =====================================================================
 * fotos.js — registro fotográfico georreferenciado (compartilhado)
 * Usado pela página do participante e pelo painel dos responsáveis:
 *   - leitura da data e do GPS gravados na foto (EXIF), para fotos da galeria
 *   - redução da imagem (máx. 1600 px, JPEG) para enviar em conexão ruim
 *   - prévia com confirmação/cancelamento antes de salvar
 *   - envio ao Storage privado e registro no banco
 * Nunca inventa coordenadas: sem GPS, a foto é salva "sem localização".
 * ===================================================================== */
(function () {
  'use strict';

  var C = window.Comunicacao;
  var UI = window.UI;

  var LIMITE_ORIGINAL = 40 * 1024 * 1024;   // arquivos maiores nem são abertos
  var TEMPO_ENVIO_MS = 90000;
  // Acima desta incerteza a posição não serve para marcar a foto no mapa
  // (ex.: localização aproximada pela rede, sem GPS): a foto vai sem localização.
  var PRECISAO_MAXIMA_M = 500;

  function posicaoUtil(p) {
    if (!p || !p.ok) return p || { ok: false, motivo: 'GPS indisponível' };
    if (p.prec != null && p.prec > PRECISAO_MAXIMA_M) {
      return { ok: false, motivo: 'precisão insuficiente: ' + C.precisao(p.prec) + ', o limite é ± ' + PRECISAO_MAXIMA_M + ' m' };
    }
    return p;
  }

  // Lê a data/hora original e o GPS gravados na foto (EXIF), quando existirem.
  function lerExif(buf) {
    try {
      var v = new DataView(buf);
      if (v.getUint16(0) !== 0xFFD8) return {};
      var off = 2;
      while (off + 10 < v.byteLength) {
        var marca = v.getUint16(off);
        if ((marca & 0xFF00) !== 0xFF00) break;
        var tam = v.getUint16(off + 2);
        if (marca === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) return lerTiff(v, off + 10);
        off += 2 + tam;
      }
    } catch (e) { /* imagem sem EXIF legível */ }
    return {};
  }

  function lerTiff(v, ini) {
    var le = v.getUint16(ini) === 0x4949;
    function u16(o) { return v.getUint16(ini + o, le); }
    function u32(o) { return v.getUint32(ini + o, le); }
    function ifd(o) {
      var n = u16(o), tags = {};
      for (var i = 0; i < n; i++) { var e = o + 2 + i * 12; tags[u16(e)] = { cnt: u32(e + 4), val: e + 8 }; }
      return tags;
    }
    function texto(t) {
      var o = t.cnt > 4 ? u32(t.val) : t.val, s2 = '';
      for (var i = 0; i < t.cnt - 1; i++) s2 += String.fromCharCode(v.getUint8(ini + o + i));
      return s2;
    }
    function racionais(t) {
      var o = u32(t.val), r = [];
      for (var i = 0; i < t.cnt; i++) { var a = u32(o + i * 8), b = u32(o + i * 8 + 4); r.push(b ? a / b : 0); }
      return r;
    }
    var res = {};
    try {
      var i0 = ifd(u32(4));
      if (i0[0x8769]) {
        var ex = ifd(u32(i0[0x8769].val));
        var dt = ex[0x9003] || ex[0x9004];
        var m = dt && /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(texto(dt));
        if (m) res.data = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      }
      if (i0[0x8825]) {
        var g = ifd(u32(i0[0x8825].val));
        if (g[2] && g[4]) {
          var la = racionais(g[2]), lo = racionais(g[4]);
          var lat = la[0] + la[1] / 60 + la[2] / 3600, lng = lo[0] + lo[1] / 60 + lo[2] / 3600;
          if (g[1] && String.fromCharCode(v.getUint8(ini + g[1].val)) === 'S') lat = -lat;
          if (g[3] && String.fromCharCode(v.getUint8(ini + g[3].val)) === 'W') lng = -lng;
          if (isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)) {
            res.lat = lat;
            res.lng = lng;
          }
        }
      }
    } catch (e) { /* EXIF incompleto */ }
    return res;
  }

  // Reduz a foto (no máximo 1600 px, JPEG) para enviar rápido em conexão ruim.
  // O novo arquivo não leva os metadados originais da câmera.
  async function prepararImagem(arquivo) {
    var fonte, urlTemp = null;
    try {
      fonte = await createImageBitmap(arquivo, { imageOrientation: 'from-image' });
    } catch (e) {
      urlTemp = URL.createObjectURL(arquivo);
      fonte = await new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = reject;
        img.src = urlTemp;
      });
    }
    try {
      var w = fonte.width || fonte.naturalWidth, h = fonte.height || fonte.naturalHeight;
      var esc = Math.min(1, 1600 / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * esc)), ch = Math.max(1, Math.round(h * esc));
      var cv = document.createElement('canvas');
      cv.width = cw;
      cv.height = ch;
      cv.getContext('2d').drawImage(fonte, 0, 0, cw, ch);
      var blob = await new Promise(function (r) { cv.toBlob(r, 'image/jpeg', 0.82); });
      if (blob && blob.size > 1500000) blob = await new Promise(function (r) { cv.toBlob(r, 'image/jpeg', 0.6); });
      if (!blob) throw new Error('falha ao processar');
      return { blob: blob, largura: cw, altura: ch };
    } finally {
      if (urlTemp) URL.revokeObjectURL(urlTemp);
      if (fonte && fonte.close) try { fonte.close(); } catch (e) { /* ignora */ }
    }
  }

  // Abre o arquivo escolhido (câmera ou galeria) e devolve os dados para a prévia.
  // obterPosicao(): Promise<{ok, lat, lng, prec, t} | {ok:false, motivo}>
  async function lerArquivo(arquivo, daCamera, obterPosicao) {
    if (!arquivo) return null;
    if (arquivo.type && !/^image\//.test(arquivo.type)) {
      UI.aviso('Escolha um arquivo de imagem.', 'erro');
      return null;
    }
    if (arquivo.size > LIMITE_ORIGINAL) {
      UI.aviso('Imagem muito grande (' + Math.round(arquivo.size / 1048576) + ' MB). Escolha outra foto.', 'erro', 7000);
      return null;
    }
    var instante = Date.now();
    var posicao = daCamera ? obterPosicao() : null;   // a foto acabou de ser tirada: GPS de agora
    var exif = {};
    if (!daCamera) {
      try { exif = lerExif(await arquivo.slice(0, 262144).arrayBuffer()); } catch (e) { exif = {}; }
    }
    UI.aviso('Preparando a foto…');
    var img;
    try {
      img = await prepararImagem(arquivo);
    } catch (e) {
      UI.aviso('Não foi possível abrir esta imagem (formato não suportado neste aparelho).', 'erro', 7000);
      return null;
    }
    return {
      blob: img.blob, largura: img.largura, altura: img.altura, daCamera: daCamera,
      capturada: daCamera ? instante : (exif.data ? exif.data.getTime() : (arquivo.lastModified || null)),
      capturaExata: daCamera || Boolean(exif.data),
      posicao: posicao ? await posicao : null,
      exif: exif,
    };
  }

  // Prévia: a pessoa confere a foto e confirma ou cancela antes de salvar.
  // opcoes.obterPosicao: como em lerArquivo
  // opcoes.aoSalvar({origem, lat, lng, prec, posicao_em, capturada, legenda, blob, largura, altura, bytes})
  // opcoes.simples: textos curtos, sem coordenadas nem dados técnicos (página do participante).
  function abrirPrevia(f, opcoes) {
    var simples = Boolean(opcoes.simples);
    var url = URL.createObjectURL(f.blob);
    var origem = 'nenhuma';
    var posEscolhida = null;
    var infoLocal = UI.el('div', { classe: 'previa-local' });
    var escolhas = null;
    var legenda = UI.el('input', { classe: 'campo', id: 'foto-legenda', maxlength: '300', placeholder: 'Ex.: mochila azul ao lado da trilha' });
    if (opcoes.legenda) legenda.value = opcoes.legenda;
    var rotuloSalvar = simples ? 'ENVIAR FOTO' : 'SALVAR FOTO';
    var btnSalvar = UI.el('button', { classe: 'btn btn-ok', type: 'button', id: 'foto-salvar', texto: rotuloSalvar });

    function mostrarLocalCamera(p) {
      p = posicaoUtil(p);
      infoLocal.innerHTML = '';
      if (p && p.ok && simples) {
        origem = 'gps';
        posEscolhida = p;
        infoLocal.appendChild(UI.el('p', { classe: 'ok-txt', texto: '📍 O local da foto vai junto.' }));
        if (p.prec > 100) infoLocal.appendChild(UI.el('p', { classe: 'nota', texto: 'O sinal de GPS está fraco: o local pode não ser exato.' }));
      } else if (p && p.ok) {
        origem = 'gps';
        posEscolhida = p;
        var idade = p.t && Date.now() - p.t > 20000 ? ' · obtida ' + C.idade(p.t) : '';
        infoLocal.appendChild(UI.el('p', { classe: 'ok-txt', texto: 'Localização do GPS: ' + C.coord(p.lat) + ', ' + C.coord(p.lng) + ' (' + C.precisao(p.prec) + idade + ')' }));
        if (p.prec > 100) infoLocal.appendChild(UI.el('p', { classe: 'nota', texto: 'Precisão baixa (' + C.precisao(p.prec) + '). Se possível, vá a um local aberto e tire a foto de novo.' }));
      } else {
        origem = 'nenhuma';
        posEscolhida = null;
        infoLocal.appendChild(UI.el('p', { classe: 'nota', texto: simples
          ? 'Sem sinal de GPS agora: a foto vai sem o local.'
          : 'Não foi possível obter a localização (' + ((p && p.motivo) || 'GPS indisponível') + '). A foto será salva SEM localização e não aparecerá no mapa.' }));
        infoLocal.appendChild(UI.el('button', {
          classe: 'btn btn-pequeno', type: 'button', texto: 'Tentar localizar de novo',
          onclick: async function () { this.disabled = true; mostrarLocalCamera(await opcoes.obterPosicao()); },
        }));
      }
    }

    if (f.daCamera) {
      mostrarLocalCamera(f.posicao);
    } else {
      // Foto da galeria: a posição atual pode não ser onde ela foi tirada. A pessoa escolhe.
      var temExif = f.exif && f.exif.lat != null;
      var ops = [];
      if (simples) {
        if (temExif) ops.push(['exif', 'No lugar gravado na própria foto']);
        ops.push(['atual', 'Aqui, onde estou agora']);
        ops.push(['nenhuma', 'Não sei']);
      } else {
        if (temExif) ops.push(['exif', 'Local gravado na foto (' + C.coord(f.exif.lat) + ', ' + C.coord(f.exif.lng) + ')']);
        ops.push(['atual', 'Minha posição atual (a foto foi tirada aqui)']);
        ops.push(['nenhuma', 'Sem localização (não aparece no mapa)']);
      }
      escolhas = UI.el('div', { classe: 'previa-opcoes', role: 'radiogroup', 'aria-label': 'Local da foto' }, ops.map(function (o, i) {
        return UI.el('label', { classe: 'linha-opcao' }, [
          UI.el('input', { type: 'radio', name: 'foto-origem', value: o[0], checked: i === 0 ? true : null }), ' ' + o[1],
        ]);
      }));
      infoLocal.appendChild(UI.el('p', { classe: 'ajuda', texto: 'Onde esta foto foi tirada?' }));
      infoLocal.appendChild(escolhas);
    }

    var fechar = UI.abrirModal(UI.el('div', { classe: 'previa-foto' }, [
      UI.el('h2', { id: 'modal-titulo', texto: simples ? 'A foto ficou boa?' : 'Conferir a foto' }),
      UI.el('img', { src: url, alt: 'Prévia da foto', classe: 'previa-img' }),
      simples ? null : UI.el('p', { classe: 'ajuda', texto: (f.capturada ? (f.capturaExata ? 'Capturada em ' : 'Data do arquivo: ') + C.hora(f.capturada) : 'Data de captura desconhecida') + ' · ' + Math.round(f.blob.size / 1024) + ' KB' }),
      infoLocal,
      UI.el('div', { classe: 'grupo' }, [UI.el('label', { classe: 'rotulo', for: 'foto-legenda', texto: simples ? 'O que é? (se quiser)' : 'Descrição (opcional)' }), legenda]),
      UI.el('div', { classe: 'modal-acoes' }, [
        UI.el('button', { classe: 'btn', type: 'button', texto: 'Cancelar', onclick: function () { fechar(); } }),
        btnSalvar,
      ]),
    ]), { fecharNoFundo: false, aoFechar: function () { URL.revokeObjectURL(url); } });

    btnSalvar.addEventListener('click', async function () {
      btnSalvar.disabled = true;
      if (!f.daCamera) {
        var esc = escolhas.querySelector('input:checked');
        origem = esc ? esc.value : 'nenhuma';
        posEscolhida = null;
        if (origem === 'exif') {
          posEscolhida = { ok: true, lat: f.exif.lat, lng: f.exif.lng, prec: null, t: f.capturada };
        } else if (origem === 'atual') {
          btnSalvar.textContent = 'LOCALIZANDO…';
          var p = posicaoUtil(await opcoes.obterPosicao());
          if (!p.ok) {
            UI.aviso(simples ? 'Sem sinal de GPS agora. Escolha "Não sei" ou tente de novo.'
              : 'Não foi possível obter sua localização (' + p.motivo + '). Escolha "Sem localização" ou tente de novo.', 'erro', 8000);
            btnSalvar.disabled = false;
            btnSalvar.textContent = rotuloSalvar;
            return;
          }
          posEscolhida = p;
          origem = 'gps';
        }
      }
      var dados = {
        blob: f.blob,
        origem: posEscolhida ? origem : 'nenhuma',
        lat: posEscolhida ? Math.round(posEscolhida.lat * 1e7) / 1e7 : null,
        lng: posEscolhida ? Math.round(posEscolhida.lng * 1e7) / 1e7 : null,
        prec: posEscolhida && posEscolhida.prec != null ? Math.round(posEscolhida.prec * 10) / 10 : null,
        posicao_em: posEscolhida && posEscolhida.t ? posEscolhida.t : null,
        capturada: f.capturada || null,
        legenda: legenda.value.trim().slice(0, 300),
        largura: f.largura, altura: f.altura, bytes: f.blob.size,
      };
      fechar(true);
      try { await opcoes.aoSalvar(dados); } catch (e) { UI.aviso(e.message || 'Falha ao salvar a foto.', 'erro', 8000); }
    });
  }

  // Envia o arquivo ao Storage privado e registra a foto no banco.
  // it: {id, operacao_id, participante_id, blob, origem, lat, lng, prec, posicao_em, capturada, legenda, bytes, largura, altura}
  // Erros: e.rede = true quando vale tentar de novo depois (sem conexão / lenta demais).
  async function enviar(it) {
    var caminho = it.operacao_id + '/' + it.participante_id + '/' + it.id + '.jpg';
    var dados = await it.blob.arrayBuffer();
    var up;
    try {
      up = await Promise.race([
        C.cliente.storage.from('fotos').upload(caminho, dados, { contentType: 'image/jpeg', upsert: false }),
        new Promise(function (_, rej) {
          setTimeout(function () { var e = new Error('Conexão lenta demais: o envio da foto passou de 90 s.'); e.rede = true; rej(e); }, TEMPO_ENVIO_MS);
        }),
      ]);
    } catch (e) {
      if (e.rede) throw e;
      throw C.criarErro(e);
    }
    if (up.error) {
      var msg = String(up.error.message || up.error.error || '');
      var st = Number(up.error.statusCode || up.error.status || 0);
      if (!/exist|duplicate/i.test(msg) && st !== 409) {   // já enviado antes: segue para o registro
        var err;
        if (/row-level security|unauthorized|403/i.test(msg) || st === 403) err = C.criarErro({ message: 'operacao_encerrada' });
        else if (/size|large|413/i.test(msg) || st === 413) err = new Error('A foto é grande demais para o servidor (limite de 10 MB).');
        else if (/fetch|network|timeout|Failed/i.test(msg) || !st) { err = new Error('Sem conexão para enviar a foto.'); err.rede = true; }
        else err = new Error('O servidor recusou a foto (' + (msg || st) + ').');
        throw err;
      }
    }
    return C.rpc('registrar_foto', {
      p_participante: it.participante_id, p_client_id: it.id, p_origem: it.origem,
      p_lat: it.lat, p_lng: it.lng, p_precisao: it.prec,
      p_posicao_em: it.posicao_em ? new Date(it.posicao_em).toISOString() : null,
      p_capturada_em: it.capturada ? new Date(it.capturada).toISOString() : null,
      p_legenda: it.legenda || '', p_bytes: it.bytes, p_largura: it.largura, p_altura: it.altura,
    }, 30000);
  }

  // Links temporários (1 h) para ver fotos do bucket privado. Guardados em memória.
  var cacheUrls = new Map();   // caminho → {url, exp}
  async function urlsAssinadas(caminhos) {
    var agora = Date.now();
    var faltam = caminhos.filter(function (c) { var x = cacheUrls.get(c); return !x || x.exp < agora + 120000; });
    for (var i = 0; i < faltam.length; i += 100) {
      var r = await C.cliente.storage.from('fotos').createSignedUrls(faltam.slice(i, i + 100), 3600);
      if (r.error) throw C.criarErro(r.error);
      (r.data || []).forEach(function (d) { if (d.signedUrl && d.path) cacheUrls.set(d.path, { url: d.signedUrl, exp: agora + 3600 * 1000 }); });
    }
    var res = {};
    caminhos.forEach(function (c) { var x = cacheUrls.get(c); if (x) res[c] = x.url; });
    return res;
  }
  function guardarUrlLocal(caminho, url) { cacheUrls.set(caminho, { url: url, exp: Infinity }); }
  function urlEmCache(caminho) { var x = cacheUrls.get(caminho); return x && x.exp > Date.now() + 60000 ? x.url : null; }

  window.Fotos = {
    lerExif: lerExif,
    prepararImagem: prepararImagem,
    lerArquivo: lerArquivo,
    abrirPrevia: abrirPrevia,
    enviar: enviar,
    urlsAssinadas: urlsAssinadas,
    guardarUrlLocal: guardarUrlLocal,
    urlEmCache: urlEmCache,
  };
})();
