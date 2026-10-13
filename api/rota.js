// POST /api/rota  →  rota por ruas, caminhos e trilhas reais (não em linha reta).
//
// Serviço de roteamento: openrouteservice (HeiGIT), dados do OpenStreetMap, com
// altitude (SRTM) e informações extras (inclinação, tipo de via, dificuldade da
// trilha). A chave fica SÓ no servidor (variável ORS_API_KEY); o navegador nunca a vê.
// Para usar uma instalação própria do openrouteservice, defina ORS_URL.
//
// Corpo JSON:
//   { "origem": [lat, lng], "destino": [lat, lng], "modo": "a_pe" | "trilha" | "carro",
//     "participante_id": "<uuid>" (quando é o celular do participante) }
//
// Segurança: quem chama envia o próprio token de login (Authorization: Bearer).
//   - participante: o banco confere, com o token dele, que o participante é dele
//     e está ativo numa operação ativa (função meu_destino);
//   - responsável: o banco confere que é responsável ativo (função eh_responsavel).
// Coordenadas da rota não são gravadas em lugar nenhum por esta função.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERFIS = { a_pe: 'foot-walking', trilha: 'foot-hiking', carro: 'driving-car' };
const DIST_MAX_KM = { a_pe: 60, trilha: 60, carro: 500 };
const LIMITE_POR_MIN = 20;          // pedidos por usuário por minuto (por instância do servidor)
const contagem = new Map();

// Tipos de via do openrouteservice (extra "waytype").
const TIPO_VIA = { 0: 'desconhecido', 1: 'rodovia', 2: 'estrada', 3: 'rua', 4: 'caminho', 5: 'estrada de terra', 6: 'ciclovia',
  7: 'calçada/passagem', 8: 'escadas', 9: 'balsa', 10: 'em obras' };
// Dificuldade de trilha (extra "traildifficulty", escala SAC nos perfis a pé).
const DIFICULDADE = { 0: null, 1: 'trilha fácil (T1)', 2: 'trilha de montanha (T2)', 3: 'trilha de montanha exigente (T3)',
  4: 'trilha alpina (T4)', 5: 'trilha alpina exigente (T5)', 6: 'trilha alpina difícil (T6)' };

function lerCorpo(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); }
  }
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 5000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function coordValida(c) {
  return Array.isArray(c) && c.length === 2 && c.every((v) => typeof v === 'number' && isFinite(v)) &&
    Math.abs(c[0]) <= 90 && Math.abs(c[1]) <= 180 && !(c[0] === 0 && c[1] === 0);
}

function distM(a, b) {
  const R = 6371000, k = Math.PI / 180;
  const dLat = (b[0] - a[0]) * k, dLng = (b[1] - a[1]) * k;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * k) * Math.cos(b[0] * k) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function limitar(chave) {
  const agora = Date.now();
  const lista = (contagem.get(chave) || []).filter((t) => agora - t < 60000);
  lista.push(agora);
  contagem.set(chave, lista);
  if (contagem.size > 5000) contagem.clear();
  return lista.length <= LIMITE_POR_MIN;
}

async function rpcUsuario(url, chavePublica, token, nome, args) {
  const r = await fetch(`${url}/rest/v1/rpc/${nome}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: chavePublica, Authorization: `Bearer ${token}` },
    body: JSON.stringify(args || {}),
  });
  const texto = await r.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch (e) { dados = texto; }
  return { ok: r.ok, status: r.status, dados };
}

// Soma os trechos de um "extra" do openrouteservice: [[de, ate, valor], …] → distância por valor.
function somarExtra(extra, cumul) {
  const out = {};
  if (!extra || !Array.isArray(extra.values)) return out;
  extra.values.forEach(([de, ate, v]) => {
    const d = (cumul[Math.min(ate, cumul.length - 1)] || 0) - (cumul[Math.min(de, cumul.length - 1)] || 0);
    out[v] = (out[v] || 0) + Math.max(0, d);
  });
  return out;
}

async function pedirRota(base, chave, perfil, corpo) {
  const r = await fetch(`${base}/v2/directions/${perfil}/geojson`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/geo+json, application/json', Authorization: chave },
    body: JSON.stringify(corpo),
  });
  const texto = await r.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch (e) { dados = null; }
  return { status: r.status, dados };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ erro: 'metodo_nao_permitido' });

  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const chavePublica = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  const chaveOrs = (process.env.ORS_API_KEY || '').trim();
  const baseOrs = (process.env.ORS_URL || 'https://api.openrouteservice.org').trim().replace(/\/+$/, '');
  if (!url || !chavePublica) return res.status(500).json({ erro: 'variaveis_de_ambiente_ausentes' });
  if (!chaveOrs) {
    return res.status(503).json({ erro: 'rota_nao_configurada',
      mensagem: 'O serviço de rotas não está configurado no servidor (falta ORS_API_KEY na Vercel).' });
  }

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ erro: 'nao_autenticado' });

  const corpo = await lerCorpo(req);
  const modo = PERFIS[corpo.modo] ? corpo.modo : 'a_pe';
  const origem = corpo.origem, destino = corpo.destino;
  if (!coordValida(origem) || !coordValida(destino)) return res.status(400).json({ erro: 'posicao_invalida' });
  const reta = distM(origem, destino);
  if (reta > DIST_MAX_KM[modo] * 1000) {
    return res.status(400).json({ erro: 'distancia_grande', mensagem: 'Destino longe demais para calcular a rota neste modo.' });
  }

  try {
    // 1. Quem chama pode pedir rota?
    let autorizado = false;
    if (corpo.participante_id) {
      if (!UUID_RE.test(String(corpo.participante_id))) return res.status(400).json({ erro: 'dados_invalidos' });
      let v = await rpcUsuario(url, chavePublica, token, 'meu_destino', { p_participante: corpo.participante_id });
      if (!v.ok && v.dados && v.dados.code === 'PGRST202') {   // banco sem a migração 004
        v = await rpcUsuario(url, chavePublica, token, 'mapa_do_participante', { p_participante: corpo.participante_id });
      }
      if (v.status === 401) return res.status(401).json({ erro: 'nao_autenticado' });
      autorizado = v.ok;
    } else {
      const v = await rpcUsuario(url, chavePublica, token, 'eh_responsavel', {});
      if (v.status === 401) return res.status(401).json({ erro: 'nao_autenticado' });
      autorizado = v.ok && v.dados === true;
    }
    if (!autorizado) return res.status(403).json({ erro: 'sem_permissao' });
    let quem = token.slice(-24);
    try { quem = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub || quem; } catch (e) { /* usa o fim do token */ }
    if (!limitar(quem)) return res.status(429).json({ erro: 'muitas_rotas', mensagem: 'Muitos cálculos de rota em pouco tempo. Aguarde um minuto.' });

    // 2. Pede a rota. Evita vaus (travessia de rio sem ponte) e balsas; se não houver
    //    rota assim, tenta de novo permitindo — e avisa.
    const perfil = PERFIS[modo];
    const pedido = {
      coordinates: [[origem[1], origem[0]], [destino[1], destino[0]]],
      elevation: true,
      instructions: true,
      instructions_format: 'text',
      language: 'pt',
      units: 'm',
      geometry_simplify: false,
      radiuses: [5000, 5000],   // procura a via/caminho mapeado mais próximo até 5 km (o trecho fora é informado)
      extra_info: modo === 'carro' ? ['steepness', 'waytype', 'surface'] : ['steepness', 'waytype', 'surface', 'traildifficulty'],
      options: { avoid_features: ['fords', 'ferries'] },
    };
    let r = await pedirRota(baseOrs, chaveOrs, perfil, pedido);
    let permitiuVau = false;
    if (r.status !== 200 && r.status !== 401 && r.status !== 403 && r.status !== 429) {
      const p2 = Object.assign({}, pedido, { options: {} });
      const r2 = await pedirRota(baseOrs, chaveOrs, perfil, p2);
      if (r2.status === 200) { r = r2; permitiuVau = true; }
    }
    if (r.status === 429) return res.status(503).json({ erro: 'cota_rotas', mensagem: 'Limite do serviço de rotas atingido. Tente em alguns minutos.' });
    if (r.status === 401 || r.status === 403) return res.status(503).json({ erro: 'rota_nao_configurada', mensagem: 'Chave do serviço de rotas inválida (ORS_API_KEY).' });
    const f = r.dados && Array.isArray(r.dados.features) ? r.dados.features[0] : null;
    if (r.status !== 200 || !f) {
      const msg = r.dados && r.dados.error ? (r.dados.error.message || r.dados.error) : null;
      return res.status(422).json({ erro: 'sem_rota', mensagem: 'Não há rota por caminhos mapeados até este destino.' + (msg ? ' (' + String(msg).slice(0, 160) + ')' : '') });
    }

    // 3. Monta a resposta (lat, lng, altitude) e os resumos do terreno.
    const coords = (f.geometry && f.geometry.coordinates || []).map((c) => [c[1], c[0], c[2] == null ? null : Math.round(c[2])]);
    if (coords.length < 2) return res.status(422).json({ erro: 'sem_rota', mensagem: 'Rota vazia.' });
    const cumul = [0];
    for (let i = 1; i < coords.length; i++) cumul.push(cumul[i - 1] + distM(coords[i - 1], coords[i]));
    const pr = f.properties || {};
    const sum = pr.summary || {};
    const ex = pr.extras || {};
    const passos = [];
    (pr.segments || []).forEach((sg) => (sg.steps || []).forEach((st) => passos.push({
      instrucao: st.instruction || '', distancia_m: Math.round(st.distance || 0), duracao_s: Math.round(st.duration || 0),
      tipo: st.type, nome: st.name && st.name !== '-' ? st.name : '', de: (st.way_points || [0])[0], ate: (st.way_points || [0, 0])[1],
    })));
    const inclin = somarExtra(ex.steepness, cumul);
    const vias = somarExtra(ex.waytypes || ex.waytype, cumul);
    const dific = somarExtra(ex.traildifficulty, cumul);
    const total = cumul[cumul.length - 1] || 1;
    const ingreme = Object.keys(inclin).filter((k) => Math.abs(Number(k)) >= 4).reduce((a, k) => a + inclin[k], 0);
    const trechosIngremes = ((ex.steepness && ex.steepness.values) || []).filter((v) => Math.abs(v[2]) >= 4).map((v) => [v[0], v[1], v[2]]);
    const viasTxt = Object.keys(vias).sort((a, b) => vias[b] - vias[a]).map((k) => ({ tipo: TIPO_VIA[k] || 'outro', distancia_m: Math.round(vias[k]) }));
    const maxDif = Object.keys(dific).map(Number).filter((k) => k > 0 && dific[k] > 0).sort((a, b) => b - a)[0];
    const foraInicio = Math.round(distM(origem, coords[0]));
    const foraFim = Math.round(distM(coords[coords.length - 1], destino));
    const avisos = [];
    if (foraInicio > 30) avisos.push(`Você está a ${foraInicio} m do caminho mapeado mais próximo: esse trecho inicial não tem caminho conhecido.`);
    if (foraFim > 30) avisos.push(`O destino fica a ${foraFim} m do caminho mapeado mais próximo: o trecho final não tem caminho conhecido.`);
    if (ingreme > 0) avisos.push(`${Math.round(ingreme)} m (${Math.round(100 * ingreme / total)}%) do trajeto têm inclinação de 10% ou mais (marcados no mapa).`);
    if (maxDif && maxDif >= 2) avisos.push(`Inclui ${DIFICULDADE[maxDif]}.`);
    if (permitiuVau) avisos.push('Não foi possível evitar travessia de rio (vau) ou balsa: confira antes de seguir.');

    return res.status(200).json({
      provedor: baseOrs.indexOf('api.openrouteservice.org') !== -1 ? 'openrouteservice' : 'openrouteservice (instalação própria)',
      modo,
      perfil,
      distancia_m: Math.round(sum.distance != null ? sum.distance : total),
      duracao_s: Math.round(sum.duration || 0),
      subida_m: pr.ascent != null ? Math.round(pr.ascent) : null,
      descida_m: pr.descent != null ? Math.round(pr.descent) : null,
      linha_reta_m: Math.round(reta),
      geometria: coords,
      passos,
      trechos_ingremes: trechosIngremes,
      vias: viasTxt,
      fora_inicio_m: foraInicio,
      fora_fim_m: foraFim,
      avisos,
      limites: 'Rota calculada sobre ruas, caminhos e trilhas do OpenStreetMap, com altitude de modelo de terreno (~30–90 m). ' +
        'Não avalia segurança: mata fechada, rios cheios, áreas alagadas, deslizamentos e caminhos não mapeados não são conhecidos. ' +
        'Siga as orientações dos bombeiros.',
      calculada_em: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(502).json({ erro: 'rota_indisponivel', mensagem: 'Serviço de rotas indisponível agora. Use a direção em linha reta e tente de novo.' });
  }
};
