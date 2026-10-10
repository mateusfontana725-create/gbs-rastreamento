// GET /api/limpeza  →  aplica a política de retenção (apaga dados expirados).
//
// Executada automaticamente 1x por dia pelo Vercel Cron (ver vercel.json).
// O Vercel envia "Authorization: Bearer <CRON_SECRET>"; qualquer outra
// chamada é recusada. A chave secreta do Supabase fica só aqui, no servidor.
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
    return res.status(200).json({ ok: true, resultado: JSON.parse(corpo || 'null') });
  } catch (e) {
    return res.status(502).json({ erro: 'falha_rede', detalhe: String(e && e.message) });
  }
};
