/* =====================================================================
 * interface.js — componentes de interface compartilhados:
 * avisos rápidos (toasts) e caixas de confirmação acessíveis.
 * ===================================================================== */
(function () {
  'use strict';

  function el(tag, attrs, filhos) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'texto') e.textContent = attrs[k];
        else if (k === 'classe') e.className = attrs[k];
        else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
      });
    }
    (filhos || []).forEach(function (f) {
      if (f == null) return;
      e.appendChild(typeof f === 'string' ? document.createTextNode(f) : f);
    });
    return e;
  }

  function aviso(texto, tipo, ms) {
    var raiz = document.getElementById('avisos');
    if (!raiz) return;
    var a = el('div', { classe: 'aviso' + (tipo ? ' aviso-' + tipo : ''), role: tipo === 'erro' ? 'alert' : 'status', texto: texto });
    raiz.appendChild(a);
    while (raiz.children.length > 3) raiz.removeChild(raiz.firstChild);
    setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, ms || (tipo === 'erro' ? 6000 : 3500));
  }

  var modalAtual = null;

  // Abre um modal genérico. "conteudo" é um nó DOM. Devolve função para fechar.
  function abrirModal(conteudo, opcoes) {
    opcoes = opcoes || {};
    fecharModal();
    var anterior = document.activeElement;
    var caixa = el('div', { classe: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-titulo' }, [conteudo]);
    var fundo = el('div', { classe: 'modal-fundo' }, [caixa]);
    fundo.addEventListener('click', function (ev) {
      if (ev.target === fundo && opcoes.fecharNoFundo !== false) fechar(null);
    });
    function tecla(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); fechar(null); }
    }
    document.addEventListener('keydown', tecla);
    document.body.appendChild(fundo);
    var foco = caixa.querySelector('[autofocus]') || caixa.querySelector('textarea, input, button');
    if (foco) setTimeout(function () { foco.focus(); }, 30);

    function fechar(valor) {
      if (!fundo.parentNode) return;
      document.removeEventListener('keydown', tecla);
      fundo.parentNode.removeChild(fundo);
      if (modalAtual && modalAtual.fechar === fechar) modalAtual = null;
      if (anterior && anterior.focus) { try { anterior.focus(); } catch (e) { /* ignora */ } }
      if (opcoes.aoFechar) opcoes.aoFechar(valor);
    }
    modalAtual = { fechar: fechar };
    return fechar;
  }

  function fecharModal() {
    if (modalAtual) modalAtual.fechar(null);
  }

  /*
   * confirmar({ titulo, texto, detalhe, ok, cancelar, perigo, campo: { rotulo, valor, max, obrigatorio } })
   * → Promise que resolve { texto } se confirmado, ou null se cancelado.
   */
  function confirmar(o) {
    return new Promise(function (resolve) {
      var area = null;
      var erro = el('p', { classe: 'erro-form', hidden: true });
      var filhos = [el('h2', { id: 'modal-titulo', texto: o.titulo || 'Confirmar' })];
      if (o.texto) filhos.push(el('p', { texto: o.texto }));
      if (o.detalhe) filhos.push(o.detalhe);
      if (o.campo) {
        area = el('textarea', { classe: 'campo', id: 'modal-campo', maxlength: String(o.campo.max || 500), rows: '3' });
        area.value = o.campo.valor || '';
        filhos.push(el('div', { classe: 'grupo' }, [
          el('label', { classe: 'rotulo', for: 'modal-campo', texto: o.campo.rotulo || 'Texto' }),
          area,
        ]));
      }
      filhos.push(erro);
      var btnOk = el('button', { classe: 'btn ' + (o.perigo ? 'btn-primario' : 'btn-escuro'), type: 'button', texto: o.ok || 'Confirmar' });
      var btnCancelar = el('button', { classe: 'btn', type: 'button', texto: o.cancelar || 'Cancelar', autofocus: !area });
      filhos.push(el('div', { classe: 'modal-acoes' }, [btnCancelar, btnOk]));
      var resolvido = false;
      var fechar = abrirModal(el('div', null, filhos), {
        aoFechar: function (v) { if (!resolvido) { resolvido = true; resolve(v || null); } },
      });
      btnCancelar.addEventListener('click', function () { fechar(null); });
      btnOk.addEventListener('click', function () {
        var texto = area ? area.value.trim() : '';
        if (o.campo && o.campo.obrigatorio && !texto) {
          erro.textContent = 'Preencha o texto.';
          erro.hidden = false;
          area.focus();
          return;
        }
        resolvido = true;
        resolve({ texto: texto });
        fechar({ texto: texto });
      });
    });
  }

  /*
   * Página aberta há muito tempo pode estar rodando uma versão antiga do
   * aplicativo (ex.: a página do participante fica aberta a busca inteira).
   * Compara a versão desta página com /versao.json e, se mudou, oferece
   * atualizar. Recarregar não perde a participação: ela retoma sozinha.
   */
  function verificarVersao() {
    var meta = document.querySelector('meta[name="gbs-versao"]');
    if (!meta || !window.fetch) return;
    var minha = meta.getAttribute('content');
    var avisado = false;
    function conferir() {
      if (avisado || document.visibilityState !== 'visible') return;
      fetch('versao.json?_=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
        if (!j || !j.versao || j.versao === minha || avisado) return;
        avisado = true;
        var faixa = el('div', { classe: 'faixa-versao', role: 'status' }, [
          el('span', { texto: 'Há uma versão nova desta página.' }),
          el('button', { classe: 'btn btn-pequeno btn-escuro', type: 'button', texto: 'Atualizar agora', onclick: function () { window.GBS_RECARREGANDO = true; location.reload(); } }),
        ]);
        document.body.appendChild(faixa);
      }).catch(function () { /* sem internet: tenta depois */ });
    }
    setInterval(conferir, 5 * 60000);
    document.addEventListener('visibilitychange', conferir);
    setTimeout(conferir, 20000);
  }
  verificarVersao();

  window.UI = { el: el, aviso: aviso, abrirModal: abrirModal, fecharModal: fecharModal, confirmar: confirmar };
})();
