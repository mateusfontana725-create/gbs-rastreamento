// POST /api/responsaveis  →  cadastro de responsáveis pelo painel (somente administradores).
//
// Ações (corpo JSON):
//   { "acao": "criar", "nome": "...", "email": "...", "senha": "...", "admin": false }
//   { "acao": "senha", "user_id": "<uuid>", "senha": "..." }      (redefinir senha)
//
// Segurança:
//   1. Quem chama envia o próprio token de login (Authorization: Bearer <token>).
//   2. A função pergunta ao banco, COM ESSE TOKEN, se a pessoa é administradora ativa.
//   3. Só então usa a chave SECRETA (que fica só no servidor) para criar o login
//      ou trocar a senha. A chave secreta nunca vai para o navegador.
//   Ativar/desativar e dar/tirar administrador são feitos direto no banco pelo
//   painel (funções admin_*), sem passar por aqui.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function lerCorpo(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); }
  }
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 20000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function cabecalhosServico(chave) {
  const h = { 'Content-Type': 'application/json', apikey: chave };
  // Chaves antigas (JWT "service_role") também vão no Authorization; as novas (sb_secret_) só no apikey.
  if (!chave.startsWith('sb_')) h.Authorization = `Bearer ${chave}`;
  return h;
}

async function rpcServico(url, chave, nome, args) {
  const r = await fetch(`${url}/rest/v1/rpc/${nome}`, {
    method: 'POST',
    headers: cabecalhosServico(chave),
    body: JSON.stringify(args || {}),
  });
  const texto = await r.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch (e) { dados = texto; }
  return { ok: r.ok, status: r.status, dados };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ erro: 'metodo_nao_permitido' });

  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const chavePublica = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  const chaveSecreta = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !chavePublica || !chaveSecreta) {
    return res.status(500).json({ erro: 'variaveis_de_ambiente_ausentes' });
  }

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ erro: 'nao_autenticado' });

  try {
    // 1. Quem está chamando é administrador ativo? (pergunta feita com o login da própria pessoa)
    const v = await fetch(`${url}/rest/v1/rpc/eh_admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: chavePublica, Authorization: `Bearer ${token}` },
      body: '{}',
    });
    if (v.status === 401) return res.status(401).json({ erro: 'nao_autenticado' });
    if (!v.ok || (await v.json()) !== true) return res.status(403).json({ erro: 'sem_permissao' });

    const corpo = await lerCorpo(req);
    const acao = corpo.acao;

    // 2a. Cadastrar novo responsável
    if (acao === 'criar') {
      const nome = String(corpo.nome || '').replace(/\s+/g, ' ').trim();
      const email = String(corpo.email || '').trim().toLowerCase();
      const senha = String(corpo.senha || '');
      const admin = corpo.admin === true;
      if (nome.length < 2 || nome.length > 60) return res.status(400).json({ erro: 'nome_invalido' });
      if (!EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ erro: 'email_invalido' });
      if (senha.length < 8 || senha.length > 72) return res.status(400).json({ erro: 'senha_fraca' });

      let userId = null;
      let jaExistia = false;
      const c = await fetch(`${url}/auth/v1/admin/users`, {
        method: 'POST',
        headers: cabecalhosServico(chaveSecreta),
        body: JSON.stringify({ email, password: senha, email_confirm: true, user_metadata: { nome } }),
      });
      const cj = await c.json().catch(() => ({}));
      if (c.ok && cj && cj.id) {
        userId = cj.id;
      } else if (/already|exists|registered/i.test(JSON.stringify(cj))) {
        // O e-mail já tem login no Supabase: apenas autoriza no painel (a senha atual é mantida).
        const u = await rpcServico(url, chaveSecreta, 'servidor_usuario_por_email', { p_email: email });
        if (!u.ok || !u.dados || !u.dados.user_id) return res.status(502).json({ erro: 'falha_supabase' });
        if (u.dados.responsavel) return res.status(409).json({ erro: 'ja_cadastrado' });
        userId = u.dados.user_id;
        jaExistia = true;
      } else if (/password/i.test(JSON.stringify(cj))) {
        return res.status(400).json({ erro: 'senha_fraca' });
      } else {
        return res.status(502).json({ erro: 'falha_supabase', detalhe: String(cj.msg || cj.message || c.status).slice(0, 200) });
      }

      const s = await rpcServico(url, chaveSecreta, 'servidor_salvar_responsavel', { p_user: userId, p_nome: nome, p_admin: admin });
      if (!s.ok) return res.status(502).json({ erro: 'falha_supabase', detalhe: JSON.stringify(s.dados).slice(0, 200) });
      return res.status(200).json({ ok: true, user_id: userId, ja_existia: jaExistia });
    }

    // 2b. Redefinir a senha de um responsável
    if (acao === 'senha') {
      const userId = String(corpo.user_id || '');
      const senha = String(corpo.senha || '');
      if (!UUID_RE.test(userId)) return res.status(400).json({ erro: 'responsavel_nao_encontrado' });
      if (senha.length < 8 || senha.length > 72) return res.status(400).json({ erro: 'senha_fraca' });
      const e = await rpcServico(url, chaveSecreta, 'servidor_eh_responsavel', { p_user: userId });
      if (!e.ok || e.dados !== true) return res.status(404).json({ erro: 'responsavel_nao_encontrado' });
      const p = await fetch(`${url}/auth/v1/admin/users/${userId}`, {
        method: 'PUT',
        headers: cabecalhosServico(chaveSecreta),
        body: JSON.stringify({ password: senha }),
      });
      if (!p.ok) {
        const pj = await p.json().catch(() => ({}));
        if (/password/i.test(JSON.stringify(pj))) return res.status(400).json({ erro: 'senha_fraca' });
        return res.status(502).json({ erro: 'falha_supabase' });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ erro: 'acao_invalida' });
  } catch (e) {
    return res.status(502).json({ erro: 'falha_rede', detalhe: String(e && e.message).slice(0, 200) });
  }
};
