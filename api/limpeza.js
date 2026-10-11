// GET /api/limpeza  →  aplica a política de retenção (apaga dados expirados).
//
// Executada automaticamente 1x por dia pelo Vercel Cron (ver vercel.json).
// O Vercel envia "Authorization: Bearer <CRON_SECRET>"; qualquer outra
// chamada é recusada. A chave secreta do Supabase fica só aqui, no servidor.
async function apagarArquivosPendentes(url, cabecalhos) {
  let erro = null;
  let enviados = 0;
  try {
    const r = await fetch(`${url}/rest/v1/rpc/servidor_arquivos_pendentes`, { method: 'POST', headers: cabecalhos, body: JSON.stringify({ p_limite: 500 }) });
    const lista = r.ok ? await r.json() : [];
    if (!r.ok) erro = 'fila: ' + r.status;
    const porBucket = {};
    (lista || []).forEach((a) => { (porBucket[a.bucket] = porBucket[a.bucket] || []).push(a.caminho); });
    for (const bucket of Object.keys(porBucket)) {
      const caminhos = porBucket[bucket];
      for (let i = 0; i < caminhos.length; i += 100) {
        const d = await fetch(`${url}/storage/v1/object/${encodeURIComponent(bucket)}`, {
          method: 'DELETE', headers: cabecalhos, body: JSON.stringify({ prefixes: caminhos.slice(i, i + 100) }),
        });
        if (!d.ok) erro = 'storage: ' + d.status;
        enviados += Math.min(100, caminhos.length - i);
      }
    }
  } catch (e) {
    erro = String(e && e.message);
  }
  const c = await fetch(`${url}/rest/v1/rpc/servidor_arquivos_conferir`, { method: 'POST', headers: cabecalhos, body: JSON.stringify({ p_erro: erro }) })
    .then((x) => (x.ok ? x.json() : null)).catch(() => null);
  return Object.assign({ solicitados: enviados, erro }, c || {});
}

module.exports = async (req, res) => {
  const segredo = process.env.CRON_SECRET;
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const chaveSecreta = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (!segredo || req.headers.authorization !== `Bearer ${segredo}`) {
    return res.status(401).json({ erro: 'nao_autorizado' });
  }
  if (!url || !chaveSecreta) {
    return res.status(500).json({ erro: 'variaveis_de_ambiente_ausentes' });
  }

  const cabecalhos = { 'Content-Type': 'application/json', apikey: chaveSecreta };
  // Chaves antigas (JWT "service_role") também precisam ir no Authorization.
  // As chaves novas ("sb_secret_...") vão apenas no cabeçalho apikey.
  if (!chaveSecreta.startsWith('sb_')) cabecalhos.Authorization = `Bearer ${chaveSecreta}`;

  try {
    const r = await fetch(`${url}/rest/v1/rpc/purgar_expiradas`, {
      method: 'POST',
      headers: cabecalhos,
      body: '{}',
    });
    const corpo = await r.text();
    if (!r.ok) {
      return res.status(502).json({ erro: 'falha_supabase', status: r.status, detalhe: corpo.slice(0, 300) });
    }
    const resultado = JSON.parse(corpo || 'null');

    // Arquivos de fotos que ficaram na fila (operações excluídas, retenção vencida
    // ou falha ao apagar pelo painel): apaga no Storage e confere.
    resultado.arquivos = await apagarArquivosPendentes(url, cabecalhos);
    return res.status(200).json({ ok: true, resultado });
  } catch (e) {
    return res.status(502).json({ erro: 'falha_rede', detalhe: String(e && e.message) });
  }
};
