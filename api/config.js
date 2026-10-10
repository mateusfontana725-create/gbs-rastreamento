// GET /api/config  →  entrega ao navegador SOMENTE a configuração pública.
//
// A URL do projeto e a chave PUBLICÁVEL (anon/publishable) do Supabase são
// públicas por definição: a proteção dos dados é feita pelas regras de
// segurança (RLS) e pelas funções do banco. A chave SECRETA (service_role)
// nunca sai do servidor — ela é usada apenas em /api/limpeza.
module.exports = (req, res) => {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const chave = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();

  const config = {
    supabaseUrl: url,
    supabaseKey: chave,
    configurado: Boolean(url && chave),
  };

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send('window.APP_CONFIG = ' + JSON.stringify(config) + ';\n');
};
