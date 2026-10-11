-- =====================================================================
--  RASTREAMENTO SAR — esquema do banco de dados (Supabase / PostgreSQL)
-- ---------------------------------------------------------------------
--  Execute este arquivo INTEIRO no "SQL Editor" do Supabase.
--  Pode ser executado novamente para atualizar funções e políticas.
--
--  Modelo de segurança (resumo):
--   * Militares responsáveis entram com e-mail e senha (Supabase Auth) e
--     só têm acesso ao painel se estiverem cadastrados na tabela
--     "responsaveis" (lista de autorização mantida pelo administrador).
--   * Participantes (civis e militares de campo) recebem uma sessão
--     anônima do Supabase Auth. Eles só conseguem ingressar numa operação
--     apresentando o token secreto do link de convite.
--   * O TIPO (civil/militar) é decidido no servidor a partir do token:
--     o link de civis só permite "civil"; o link de militares permite
--     "militar" ou "civil".
--   * Nenhuma tabela aceita INSERT/UPDATE/DELETE direto do navegador.
--     Toda escrita passa por funções (RPC) que validam permissões e dados.
--   * RLS (Row Level Security) garante que:
--       - o responsável só lê as operações que ele criou;
--       - o participante só lê o próprio cadastro e as próprias mensagens;
--       - nenhum participante lê posições (nem as próprias, nem de outros).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABELAS
-- ---------------------------------------------------------------------

create table if not exists public.responsaveis (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  nome       text not null check (char_length(nome) between 2 and 60),
  criado_em  timestamptz not null default now()
);
-- admin: pode cadastrar e gerenciar responsáveis pelo painel.
-- ativo: false = acesso ao painel suspenso (o cadastro e o histórico continuam).
alter table public.responsaveis add column if not exists admin boolean not null default false;
alter table public.responsaveis add column if not exists ativo boolean not null default true;

-- Se ainda não houver administrador, o primeiro responsável cadastrado vira administrador
-- (vale para bancos que já existiam e para a primeira instalação, pelo gatilho abaixo).
create or replace function public.primeiro_responsavel_admin()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.responsaveis where admin and ativo) then
    new.admin := true;
    new.ativo := true;
  end if;
  return new;
end;
$$;
drop trigger if exists responsaveis_primeiro_admin on public.responsaveis;
create trigger responsaveis_primeiro_admin before insert on public.responsaveis
  for each row execute function public.primeiro_responsavel_admin();
revoke execute on function public.primeiro_responsavel_admin() from public;

update public.responsaveis set admin = true
 where user_id = (select user_id from public.responsaveis where ativo order by criado_em, user_id limit 1)
   and not exists (select 1 from public.responsaveis where admin and ativo);

create table if not exists public.operacoes (
  id                 uuid primary key default gen_random_uuid(),
  codigo             text not null check (char_length(codigo) between 2 and 80),
  responsavel_id     uuid not null references auth.users(id) on delete cascade,
  token_civil        text not null unique,
  token_militar      text not null unique,
  status             text not null default 'ativa' check (status in ('ativa', 'encerrada')),
  retencao_horas     integer not null default 0 check (retencao_horas between 0 and 2160),
  criada_em          timestamptz not null default now(),
  encerrada_em       timestamptz,
  expira_em          timestamptz,
  dados_apagados_em  timestamptz
);
create index if not exists operacoes_responsavel_idx on public.operacoes (responsavel_id, criada_em desc);

create table if not exists public.participantes (
  id                 uuid primary key default gen_random_uuid(),
  operacao_id        uuid not null references public.operacoes(id) on delete cascade,
  user_id            uuid not null references auth.users(id) on delete cascade,
  nome               text not null check (char_length(nome) between 2 and 40),
  tipo               text not null check (tipo in ('civil', 'militar', 'responsavel')),
  removido           boolean not null default false,
  rastreando         boolean not null default false,
  gps_estado         text not null default 'aguardando'
                     check (gps_estado in ('aguardando', 'ok', 'fraco', 'sem_sinal', 'negado', 'indisponivel')),
  ultima_lat         double precision,
  ultima_lng         double precision,
  ultima_precisao    real,
  ultima_posicao_em  timestamptz,
  ultimo_contato_em  timestamptz,
  criado_em          timestamptz not null default now(),
  unique (operacao_id, user_id)
);
-- Dados de identificação (visíveis só aos responsáveis da operação; apagados com ela)
-- e pedido de encerramento feito pelo participante.
alter table public.participantes add column if not exists cpf text;
alter table public.participantes add column if not exists telefone text;
alter table public.participantes add column if not exists saida_solicitada_em timestamptz;
alter table public.participantes add column if not exists saida_motivo text;
alter table public.participantes add column if not exists liberado_em timestamptz;

-- Atualização de bancos criados pela versão anterior: aceita o tipo "responsavel"
-- (presença e posição do responsável no mapa, visível só para os responsáveis).
alter table public.participantes drop constraint if exists participantes_tipo_check;
alter table public.participantes add constraint participantes_tipo_check
  check (tipo in ('civil', 'militar', 'responsavel'));
create index if not exists participantes_operacao_idx on public.participantes (operacao_id);
create index if not exists participantes_user_idx on public.participantes (user_id);

create table if not exists public.posicoes (
  id               bigint generated always as identity primary key,
  operacao_id      uuid not null references public.operacoes(id) on delete cascade,
  participante_id  uuid not null references public.participantes(id) on delete cascade,
  client_id        uuid not null,          -- gerado no celular; evita pontos duplicados
  lat              double precision not null check (lat between -90 and 90),
  lng              double precision not null check (lng between -180 and 180),
  precisao         real check (precisao >= 0),
  registrado_em    timestamptz not null,   -- horário em que o GPS obteve a posição
  recebido_em      timestamptz not null default now(),
  unique (participante_id, client_id)
);
create index if not exists posicoes_operacao_idx on public.posicoes (operacao_id, id);
create index if not exists posicoes_participante_idx on public.posicoes (participante_id, registrado_em desc);

create table if not exists public.mensagens (
  id               uuid primary key default gen_random_uuid(),
  operacao_id      uuid not null references public.operacoes(id) on delete cascade,
  participante_id  uuid not null references public.participantes(id) on delete cascade,
  remetente_id     uuid not null references auth.users(id) on delete cascade,
  remetente_nome   text not null,
  tipo             text not null check (tipo in ('RETORNE', 'ATENCAO', 'MUDE_ROTA', 'PARE', 'CONFIRME', 'PERSONALIZADA')),
  texto            text not null default '' check (char_length(texto) <= 500),
  criada_em        timestamptz not null default now(),
  entregue_em      timestamptz,   -- o aparelho do participante recebeu
  confirmada_em    timestamptz,   -- o participante tocou em confirmar
  resposta         text check (resposta in ('CIENTE', 'ESTOU_BEM', 'PRECISO_AJUDA'))
);
create index if not exists mensagens_participante_idx on public.mensagens (participante_id, criada_em desc);

-- Mensagens nos dois sentidos:
--   direcao 'saida'   = do responsável para o participante (comandos e mensagens livres)
--   direcao 'entrada' = do participante para os responsáveis (mensagens e relatos de campo)
alter table public.mensagens add column if not exists direcao text not null default 'saida';
alter table public.mensagens add column if not exists categoria text;
alter table public.mensagens add column if not exists lat double precision;
alter table public.mensagens add column if not exists lng double precision;
alter table public.mensagens add column if not exists precisao real;
alter table public.mensagens add column if not exists posicao_em timestamptz;
alter table public.mensagens add column if not exists lida_em timestamptz;
alter table public.mensagens add column if not exists lida_por_nome text;
alter table public.mensagens add column if not exists client_id uuid;
alter table public.mensagens drop constraint if exists mensagens_direcao_check;
alter table public.mensagens add constraint mensagens_direcao_check check (direcao in ('saida', 'entrada'));
alter table public.mensagens drop constraint if exists mensagens_categoria_check;
alter table public.mensagens add constraint mensagens_categoria_check
  check (categoria is null or categoria in ('MENSAGEM', 'OBJETO', 'VESTIGIO', 'PISTA', 'OBSTACULO', 'OUTRO', 'AJUDA'));
alter table public.mensagens drop constraint if exists mensagens_tipo_check;
alter table public.mensagens add constraint mensagens_tipo_check
  check (tipo in ('RETORNE', 'ATENCAO', 'MUDE_ROTA', 'PARE', 'CONFIRME', 'PERSONALIZADA', 'PARTICIPANTE'));
alter table public.mensagens drop constraint if exists mensagens_texto_check;
alter table public.mensagens add constraint mensagens_texto_check check (char_length(texto) <= 1000);
create unique index if not exists mensagens_cliente_unico on public.mensagens (participante_id, client_id) where client_id is not null;
create index if not exists mensagens_entrada_idx on public.mensagens (operacao_id, direcao, lida_em);

-- Fotografias georreferenciadas. O arquivo fica no Storage (bucket privado "fotos"),
-- no caminho <operacao_id>/<participante_id>/<client_id>.jpg. A foto é um registro
-- de uma posição: não altera a trilha.
create table if not exists public.fotos (
  id               uuid primary key default gen_random_uuid(),
  operacao_id      uuid not null references public.operacoes(id) on delete cascade,
  participante_id  uuid not null references public.participantes(id) on delete cascade,
  autor_nome       text not null,
  autor_tipo       text not null,
  client_id        uuid not null,
  caminho          text not null unique,
  lat              double precision check (lat between -90 and 90),
  lng              double precision check (lng between -180 and 180),
  precisao         real check (precisao >= 0),
  posicao_em       timestamptz,
  origem_posicao   text not null check (origem_posicao in ('gps', 'exif', 'nenhuma')),
  capturada_em     timestamptz,
  registrada_em    timestamptz not null default now(),
  legenda          text not null default '' check (char_length(legenda) <= 300),
  bytes            integer,
  largura          integer,
  altura           integer,
  unique (participante_id, client_id),
  check ((lat is null) = (lng is null))
);
create index if not exists fotos_operacao_idx on public.fotos (operacao_id, registrada_em);

-- Arquivos do Storage que precisam ser apagados (fotos de operações excluídas ou
-- com retenção vencida). O painel apaga na hora; o que falhar é apagado pela
-- limpeza diária. Assim nenhum arquivo fica esquecido.
create table if not exists public.arquivos_pendentes (
  caminho       text primary key,
  bucket        text not null default 'fotos',
  operacao_id   uuid,
  excluido_por  uuid,
  criado_em     timestamptz not null default now(),
  tentativas    integer not null default 0,
  ultimo_erro   text
);
create index if not exists mensagens_operacao_idx on public.mensagens (operacao_id, criada_em);

-- Responsáveis adicionais de cada operação (além de quem a criou).
-- Todos veem o mesmo painel e podem enviar orientações; precisam continuar
-- cadastrados em "responsaveis" para ter acesso.
create table if not exists public.operacao_responsaveis (
  operacao_id     uuid not null references public.operacoes(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  adicionado_por  uuid references auth.users(id) on delete set null,
  criado_em       timestamptz not null default now(),
  primary key (operacao_id, user_id)
);
create index if not exists operacao_responsaveis_user_idx on public.operacao_responsaveis (user_id);

-- ---------------------------------------------------------------------
-- 2. FUNÇÕES AUXILIARES DE AUTORIZAÇÃO
-- ---------------------------------------------------------------------

create or replace function public.eh_responsavel()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.responsaveis where user_id = auth.uid() and ativo);
$$;

create or replace function public.eh_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.responsaveis where user_id = auth.uid() and ativo and admin);
$$;

create or replace function public.dono_operacao(p_operacao uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  -- Criador ou responsável adicionado à operação, e ainda autorizado em "responsaveis".
  select public.eh_responsavel() and exists (
    select 1
      from public.operacoes o
     where o.id = p_operacao
       and (o.responsavel_id = auth.uid()
            or exists (select 1 from public.operacao_responsaveis m
                        where m.operacao_id = o.id and m.user_id = auth.uid()))
  );
$$;

create or replace function public.eh_criador(p_operacao uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.eh_responsavel() and exists (
    select 1 from public.operacoes where id = p_operacao and responsavel_id = auth.uid()
  );
$$;

create or replace function public.eh_meu_participante(p_participante uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.participantes
     where id = p_participante and user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------
-- 3. ROW LEVEL SECURITY (somente leitura pelo navegador)
-- ---------------------------------------------------------------------

alter table public.responsaveis  enable row level security;
alter table public.operacoes     enable row level security;
alter table public.participantes enable row level security;
alter table public.posicoes      enable row level security;
alter table public.mensagens     enable row level security;
alter table public.operacao_responsaveis enable row level security;
alter table public.fotos enable row level security;
alter table public.arquivos_pendentes enable row level security;   -- sem políticas: ninguém lê pelo navegador

drop policy if exists responsaveis_ler_proprio on public.responsaveis;
create policy responsaveis_ler_proprio on public.responsaveis
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists operacoes_ler_dono on public.operacoes;
create policy operacoes_ler_dono on public.operacoes
  for select to authenticated
  using (public.dono_operacao(id));

drop policy if exists participantes_ler on public.participantes;
create policy participantes_ler on public.participantes
  for select to authenticated
  using (user_id = auth.uid() or public.dono_operacao(operacao_id));

drop policy if exists posicoes_ler_dono on public.posicoes;
create policy posicoes_ler_dono on public.posicoes
  for select to authenticated
  using (public.dono_operacao(operacao_id));

drop policy if exists mensagens_ler on public.mensagens;
create policy mensagens_ler on public.mensagens
  for select to authenticated
  using (public.dono_operacao(operacao_id) or public.eh_meu_participante(participante_id));

drop policy if exists fotos_ler on public.fotos;
create policy fotos_ler on public.fotos
  for select to authenticated
  using (public.dono_operacao(operacao_id) or public.eh_meu_participante(participante_id));

drop policy if exists operacao_responsaveis_ler on public.operacao_responsaveis;
create policy operacao_responsaveis_ler on public.operacao_responsaveis
  for select to authenticated
  using (public.dono_operacao(operacao_id));

-- Defesa em profundidade: o navegador nunca escreve direto nas tabelas.
revoke all on public.responsaveis, public.operacoes, public.participantes, public.posicoes, public.mensagens, public.operacao_responsaveis, public.fotos, public.arquivos_pendentes from anon;
revoke insert, update, delete, truncate on public.responsaveis, public.operacoes, public.participantes, public.posicoes, public.mensagens, public.operacao_responsaveis, public.fotos from authenticated;
revoke all on public.arquivos_pendentes from authenticated;
grant select on public.responsaveis, public.operacoes, public.participantes, public.posicoes, public.mensagens, public.operacao_responsaveis, public.fotos to authenticated;

-- ---------------------------------------------------------------------
-- 4. FUNÇÕES (RPC) — RESPONSÁVEL MILITAR
-- ---------------------------------------------------------------------

create or replace function public.gerar_token()
returns text
language sql volatile
as $$
  -- 2 UUIDs aleatórios = 244 bits de entropia
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
$$;

create or replace function public.criar_operacao(p_codigo text, p_retencao_horas integer default 0)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_codigo text := btrim(regexp_replace(coalesce(p_codigo, ''), '\s+', ' ', 'g'));
  v_op public.operacoes%rowtype;
begin
  if not public.eh_responsavel() then
    raise exception 'sem_permissao';
  end if;
  if char_length(v_codigo) < 2 or char_length(v_codigo) > 80 then
    raise exception 'codigo_invalido';
  end if;
  if p_retencao_horas is null or p_retencao_horas not in (0, 24, 72, 168, 720) then
    raise exception 'retencao_invalida';
  end if;

  insert into public.operacoes (codigo, responsavel_id, token_civil, token_militar, retencao_horas)
  values (v_codigo, auth.uid(), public.gerar_token(), public.gerar_token(), p_retencao_horas)
  returning * into v_op;

  return row_to_json(v_op);
end;
$$;

create or replace function public.encerrar_operacao(p_operacao uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
begin
  if not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;

  update public.operacoes
     set status = 'encerrada',
         encerrada_em = now(),
         expira_em = now() + make_interval(hours => retencao_horas)
   where id = p_operacao and status = 'ativa'
  returning * into v_op;

  if not found then
    select * into v_op from public.operacoes where id = p_operacao;
    return row_to_json(v_op);
  end if;

  update public.participantes set rastreando = false where operacao_id = p_operacao;

  if v_op.retencao_horas = 0 then
    delete from public.participantes where operacao_id = p_operacao;  -- apaga posições e mensagens em cascata
    update public.operacoes set dados_apagados_em = now() where id = p_operacao returning * into v_op;
  end if;

  return row_to_json(v_op);
end;
$$;

create or replace function public.apagar_dados_operacao(p_operacao uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
begin
  if not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  if v_op.status <> 'encerrada' then
    raise exception 'operacao_ativa';
  end if;

  delete from public.participantes where operacao_id = p_operacao;
  update public.operacoes set dados_apagados_em = now(), expira_em = coalesce(least(expira_em, now()), now())
   where id = p_operacao returning * into v_op;

  return row_to_json(v_op);
end;
$$;

create or replace function public.remover_participante(p_participante uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_op uuid;
begin
  select operacao_id into v_op from public.participantes where id = p_participante and tipo <> 'responsavel';
  if v_op is null or not public.dono_operacao(v_op) then
    raise exception 'sem_permissao';
  end if;
  update public.participantes set removido = true, rastreando = false where id = p_participante;
end;
$$;

create or replace function public.enviar_mensagem(p_participante uuid, p_tipo text, p_texto text default '')
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
  v_nome text;
  v_texto text := btrim(coalesce(p_texto, ''));
  v_msg public.mensagens%rowtype;
  v_recentes integer;
begin
  select * into v_part from public.participantes where id = p_participante;
  if not found or not public.dono_operacao(v_part.operacao_id) or v_part.user_id = auth.uid() then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_part.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if v_part.removido then
    raise exception 'participante_removido';
  end if;
  if p_tipo is null or p_tipo not in ('RETORNE', 'ATENCAO', 'MUDE_ROTA', 'PARE', 'CONFIRME', 'PERSONALIZADA') then
    raise exception 'tipo_invalido';
  end if;
  if char_length(v_texto) > 500 then
    raise exception 'texto_longo';
  end if;
  if p_tipo = 'PERSONALIZADA' and v_texto = '' then
    raise exception 'texto_obrigatorio';
  end if;

  -- proteção contra envio em massa acidental
  select count(*) into v_recentes from public.mensagens
   where operacao_id = v_part.operacao_id and direcao = 'saida' and criada_em > now() - interval '1 minute';
  if v_recentes >= 60 then
    raise exception 'muitas_mensagens';
  end if;

  select nome into v_nome from public.responsaveis where user_id = auth.uid();

  insert into public.mensagens (operacao_id, participante_id, remetente_id, remetente_nome, tipo, texto)
  values (v_part.operacao_id, v_part.id, auth.uid(), v_nome, p_tipo, v_texto)
  returning * into v_msg;

  return row_to_json(v_msg);
end;
$$;

-- ---------------------------------------------------------------------
-- 4a. ADMINISTRAÇÃO DOS RESPONSÁVEIS (tela "Responsáveis" do painel)
--     A criação do login (e-mail e senha) é feita pela função de servidor
--     /api/responsaveis, que usa a chave secreta; o resto é feito aqui.
-- ---------------------------------------------------------------------

create or replace function public.admin_listar_responsaveis()
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v json;
begin
  if not public.eh_admin() then
    raise exception 'sem_permissao';
  end if;
  select coalesce(json_agg(x order by x.ativo desc, x.nome), '[]'::json) into v
    from (
      select r.user_id, r.nome, u.email, r.admin, r.ativo, r.criado_em,
             u.last_sign_in_at as ultimo_acesso,
             r.user_id = auth.uid() as eu
        from public.responsaveis r
        join auth.users u on u.id = r.user_id
    ) x;
  return v;
end;
$$;

-- Altera nome, administrador e ativo. Protege contra ficar sem administrador.
create or replace function public.admin_alterar_responsavel(p_user uuid, p_nome text default null,
                                                            p_admin boolean default null, p_ativo boolean default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := nullif(btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g')), '');
begin
  if not public.eh_admin() then
    raise exception 'sem_permissao';
  end if;
  if not exists (select 1 from public.responsaveis where user_id = p_user) then
    raise exception 'responsavel_nao_encontrado';
  end if;
  if p_user = auth.uid() and (p_admin = false or p_ativo = false) then
    raise exception 'nao_pode_alterar_a_si';
  end if;
  if v_nome is not null and (char_length(v_nome) < 2 or char_length(v_nome) > 60) then
    raise exception 'nome_invalido';
  end if;
  update public.responsaveis
     set nome = coalesce(v_nome, nome),
         admin = coalesce(p_admin, admin),
         ativo = coalesce(p_ativo, ativo)
   where user_id = p_user;
  if not exists (select 1 from public.responsaveis where admin and ativo) then
    raise exception 'ultimo_admin';
  end if;
  return public.admin_listar_responsaveis();
end;
$$;

-- Usadas SOMENTE pela função de servidor (chave secreta), nunca pelo navegador.
create or replace function public.servidor_usuario_por_email(p_email text)
returns json
language sql stable security definer set search_path = public
as $$
  select json_build_object('user_id', u.id, 'responsavel', r.user_id is not null)
    from auth.users u
    left join public.responsaveis r on r.user_id = u.id
   where lower(u.email) = lower(btrim(coalesce(p_email, '')))
   limit 1;
$$;

create or replace function public.servidor_salvar_responsavel(p_user uuid, p_nome text, p_admin boolean default false)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g'));
begin
  if char_length(v_nome) < 2 or char_length(v_nome) > 60 then
    raise exception 'nome_invalido';
  end if;
  insert into public.responsaveis (user_id, nome, admin, ativo)
  values (p_user, v_nome, coalesce(p_admin, false), true)
  on conflict (user_id) do update set nome = excluded.nome, admin = excluded.admin, ativo = true;
end;
$$;

create or replace function public.servidor_eh_responsavel(p_user uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.responsaveis where user_id = p_user);
$$;

-- ---------------------------------------------------------------------
-- 4b. EQUIPE DE RESPONSÁVEIS E PRESENÇA DO COMANDO NO MAPA
-- ---------------------------------------------------------------------

-- Lista os responsáveis da operação (criador primeiro).
create or replace function public.listar_responsaveis(p_operacao uuid)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_lista json;
begin
  if not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select coalesce(json_agg(x order by x.criador desc, x.nome), '[]'::json) into v_lista
    from (
      select o.responsavel_id as user_id, r.nome, u.email, true as criador
        from public.operacoes o
        join public.responsaveis r on r.user_id = o.responsavel_id
        join auth.users u on u.id = o.responsavel_id
       where o.id = p_operacao
      union all
      select m.user_id, r.nome, u.email, false
        from public.operacao_responsaveis m
        join public.operacoes o on o.id = m.operacao_id
        join public.responsaveis r on r.user_id = m.user_id
        join auth.users u on u.id = m.user_id
       where m.operacao_id = p_operacao and m.user_id <> o.responsavel_id
    ) x;
  return v_lista;
end;
$$;

-- Qualquer responsável da operação pode adicionar outro responsável cadastrado, pelo e-mail.
create or replace function public.adicionar_responsavel(p_operacao uuid, p_email text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid;
begin
  if not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select u.id into v_uid
    from auth.users u
    join public.responsaveis r on r.user_id = u.id and r.ativo
   where lower(u.email) = lower(btrim(coalesce(p_email, '')))
   limit 1;
  if v_uid is null then
    raise exception 'responsavel_nao_encontrado';
  end if;
  if not exists (select 1 from public.operacoes where id = p_operacao and responsavel_id = v_uid) then
    insert into public.operacao_responsaveis (operacao_id, user_id, adicionado_por)
    values (p_operacao, v_uid, auth.uid())
    on conflict do nothing;
  end if;
  return public.listar_responsaveis(p_operacao);
end;
$$;

-- Só quem criou a operação remove responsáveis (e não pode remover a si mesmo).
create or replace function public.remover_responsavel(p_operacao uuid, p_user uuid)
returns json
language plpgsql security definer set search_path = public
as $$
begin
  if not public.eh_criador(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  if p_user = auth.uid() then
    raise exception 'sem_permissao';
  end if;
  delete from public.operacao_responsaveis where operacao_id = p_operacao and user_id = p_user;
  delete from public.participantes where operacao_id = p_operacao and user_id = p_user and tipo = 'responsavel';
  return public.listar_responsaveis(p_operacao);
end;
$$;

-- Registra o responsável no mapa da operação (presença). A posição só é
-- enviada quando ele liga "Minha posição" (usa enviar_posicoes/sinal_vida).
-- Civis e militares de campo nunca veem estes registros.
create or replace function public.entrar_como_responsavel(p_operacao uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_status text;
  v_nome text;
  v_part public.participantes%rowtype;
begin
  if not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = p_operacao;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  select left(nome, 40) into v_nome from public.responsaveis where user_id = auth.uid();

  insert into public.participantes (operacao_id, user_id, nome, tipo, ultimo_contato_em)
  values (p_operacao, auth.uid(), v_nome, 'responsavel', now())
  on conflict (operacao_id, user_id) do update
     set nome = excluded.nome, tipo = 'responsavel', removido = false, ultimo_contato_em = now()
  returning * into v_part;

  return row_to_json(v_part);
end;
$$;

-- ---------------------------------------------------------------------
-- 4c. VALIDAÇÃO DE CPF E TELEFONE
-- ---------------------------------------------------------------------

-- Devolve só os 11 dígitos do CPF se ele for válido (dígitos verificadores), ou nulo.
create or replace function public.cpf_normalizado(p_cpf text)
returns text
language plpgsql immutable
as $$
declare
  d text := regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g');
  soma integer;
  dv integer;
  i integer;
begin
  if char_length(d) <> 11 or d ~ '^(\d)\1{10}$' then
    return null;
  end if;
  for k in 1..2 loop
    soma := 0;
    for i in 1..(8 + k) loop
      soma := soma + substr(d, i, 1)::integer * (10 + k - i);
    end loop;
    dv := (soma * 10) % 11;
    if dv = 10 then dv := 0; end if;
    if dv <> substr(d, 9 + k, 1)::integer then
      return null;
    end if;
  end loop;
  return d;
end;
$$;

-- Celular brasileiro: DDD + número (10 ou 11 dígitos), aceitando +55 na frente.
create or replace function public.telefone_normalizado(p_tel text)
returns text
language sql immutable
as $$
  select case
    when d ~ '^55[1-9][0-9]9?[0-9]{8}$' and char_length(d) in (12, 13) then substr(d, 3)
    when d ~ '^[1-9][0-9]9?[0-9]{8}$' and char_length(d) in (10, 11) then d
    else null end
  from (select regexp_replace(coalesce(p_tel, ''), '\D', '', 'g') as d) x;
$$;

-- ---------------------------------------------------------------------
-- 4d. ENCERRAMENTO DA PARTICIPAÇÃO: o participante pede, o responsável libera
-- ---------------------------------------------------------------------

-- O participante não interrompe o rastreamento sozinho: ele pede ao responsável.
create or replace function public.solicitar_saida(p_participante uuid, p_motivo text default '')
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found or v_part.tipo = 'responsavel' then
    raise exception 'participante_invalido';
  end if;
  if v_part.removido then
    raise exception 'participante_removido';
  end if;
  select status into v_status from public.operacoes where id = v_part.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  update public.participantes
     set saida_solicitada_em = coalesce(saida_solicitada_em, now()),
         saida_motivo = left(btrim(coalesce(p_motivo, '')), 200),
         ultimo_contato_em = now()
   where id = v_part.id
  returning * into v_part;
  return json_build_object('saida_solicitada_em', v_part.saida_solicitada_em);
end;
$$;

-- O responsável libera a saída: o celular para de enviar e mostra "participação encerrada".
create or replace function public.liberar_participante(p_participante uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_op uuid;
begin
  select operacao_id into v_op from public.participantes where id = p_participante and tipo <> 'responsavel';
  if v_op is null or not public.dono_operacao(v_op) then
    raise exception 'sem_permissao';
  end if;
  update public.participantes
     set liberado_em = coalesce(liberado_em, now()), removido = true, rastreando = false
   where id = p_participante;
end;
$$;

-- O responsável pede para o participante continuar (desfaz o pedido de saída).
create or replace function public.recusar_saida(p_participante uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_op uuid;
begin
  select operacao_id into v_op from public.participantes where id = p_participante and tipo <> 'responsavel';
  if v_op is null or not public.dono_operacao(v_op) then
    raise exception 'sem_permissao';
  end if;
  update public.participantes set saida_solicitada_em = null, saida_motivo = null where id = p_participante;
end;
$$;

-- ---------------------------------------------------------------------
-- 4e. MENSAGENS E RELATOS ENVIADOS PELOS PARTICIPANTES
-- ---------------------------------------------------------------------

-- O participante escreve aos responsáveis (mensagem livre ou relato de campo:
-- objeto, vestígio, possível pista, obstáculo, outro) ou pedido de ajuda, com localização opcional.
-- client_id torna o reenvio (após falta de internet) seguro: não duplica.
create or replace function public.participante_enviar_mensagem(
  p_participante uuid, p_categoria text, p_texto text,
  p_lat double precision default null, p_lng double precision default null,
  p_precisao real default null, p_posicao_em timestamptz default null, p_client_id uuid default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
  v_texto text := btrim(coalesce(p_texto, ''));
  v_cat text := coalesce(p_categoria, 'MENSAGEM');
  v_msg public.mensagens%rowtype;
  v_recentes integer;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found or v_part.tipo = 'responsavel' then
    raise exception 'participante_invalido';
  end if;
  if v_part.liberado_em is not null then
    raise exception 'participante_liberado';
  end if;
  if v_part.removido then
    raise exception 'participante_removido';
  end if;
  select status into v_status from public.operacoes where id = v_part.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  -- AJUDA = botão "Preciso de ajuda" da página do participante (alarme no painel)
  if v_cat not in ('MENSAGEM', 'OBJETO', 'VESTIGIO', 'PISTA', 'OBSTACULO', 'OUTRO', 'AJUDA') then
    raise exception 'tipo_invalido';
  end if;
  if v_texto = '' then
    raise exception 'texto_obrigatorio';
  end if;
  if char_length(v_texto) > 1000 then
    raise exception 'texto_longo';
  end if;
  -- Localização: só a que o aparelho informou; nunca é inventada.
  if (p_lat is null) <> (p_lng is null)
     or (p_lat is not null and (p_lat not between -90 and 90 or p_lng not between -180 and 180 or (p_lat = 0 and p_lng = 0))) then
    raise exception 'posicao_invalida';
  end if;

  if p_client_id is not null then
    select * into v_msg from public.mensagens where participante_id = v_part.id and client_id = p_client_id;
    if found then
      return row_to_json(v_msg);   -- reenvio: já estava gravada
    end if;
  end if;

  select count(*) into v_recentes from public.mensagens
   where participante_id = v_part.id and direcao = 'entrada' and criada_em > now() - interval '1 minute';
  if v_recentes >= 20 then
    raise exception 'muitas_mensagens';
  end if;

  insert into public.mensagens (operacao_id, participante_id, remetente_id, remetente_nome, tipo, texto,
                                direcao, categoria, lat, lng, precisao, posicao_em, client_id, entregue_em)
  values (v_part.operacao_id, v_part.id, auth.uid(), v_part.nome, 'PARTICIPANTE', v_texto,
          'entrada', v_cat, p_lat, p_lng,
          case when p_precisao between 0 and 100000 then p_precisao end,
          case when p_lat is not null then least(coalesce(p_posicao_em, now()), now()) end,
          p_client_id, now())
  returning * into v_msg;

  update public.participantes set ultimo_contato_em = now() where id = v_part.id;
  return row_to_json(v_msg);
end;
$$;

-- Os responsáveis marcam como lidas as mensagens recebidas (o participante vê "lida por …").
create or replace function public.marcar_lidas(p_ids uuid[])
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_nome text;
  v_qtd integer;
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;
  if cardinality(p_ids) > 500 then
    raise exception 'lote_invalido';
  end if;
  select nome into v_nome from public.responsaveis where user_id = auth.uid() and ativo;
  if v_nome is null then
    raise exception 'sem_permissao';
  end if;
  update public.mensagens m
     set lida_em = now(), lida_por_nome = v_nome
   where m.id = any (p_ids)
     and m.direcao = 'entrada'
     and m.lida_em is null
     and public.dono_operacao(m.operacao_id);
  get diagnostics v_qtd = row_count;
  return v_qtd;
end;
$$;

-- ---------------------------------------------------------------------
-- 4f. FOTOGRAFIAS GEORREFERENCIADAS
-- ---------------------------------------------------------------------

-- Caminho válido: <operacao_id>/<participante_id>/<client_id>.jpg  → {operacao, participante, client}
create or replace function public.caminho_foto_partes(p_nome text)
returns uuid[]
language plpgsql immutable
as $$
begin
  if coalesce(p_nome, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$' then
    return null;
  end if;
  return array[split_part(p_nome, '/', 1)::uuid, split_part(p_nome, '/', 2)::uuid,
               replace(split_part(p_nome, '/', 3), '.jpg', '')::uuid];
end;
$$;

-- Regras do Storage (bucket "fotos"):
--   enviar: só o próprio participante, na pasta dele, com a operação ativa;
--   ver: responsáveis da operação ou o próprio autor;
--   apagar: só arquivos cujo registro já foi excluído (fila arquivos_pendentes).
create or replace function public.pode_enviar_foto(p_nome text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v uuid[] := public.caminho_foto_partes(p_nome);
begin
  if v is null then
    return false;
  end if;
  return exists (
    select 1 from public.participantes p
      join public.operacoes o on o.id = p.operacao_id
     where p.id = v[2] and p.operacao_id = v[1] and p.user_id = auth.uid()
       and not p.removido and p.liberado_em is null and o.status = 'ativa');
end;
$$;

create or replace function public.pode_ver_foto(p_nome text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v uuid[] := public.caminho_foto_partes(p_nome);
begin
  if v is null then
    return false;
  end if;
  return public.dono_operacao(v[1])
      or exists (select 1 from public.participantes where id = v[2] and operacao_id = v[1] and user_id = auth.uid())
      -- quem excluiu a operação precisa "ver" o arquivo para conseguir apagá-lo do Storage
      or exists (select 1 from public.arquivos_pendentes a where a.caminho = p_nome and a.excluido_por = auth.uid());
end;
$$;

create or replace function public.pode_apagar_foto(p_nome text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
begin
  return exists (
    select 1 from public.arquivos_pendentes a
     where a.caminho = p_nome and a.bucket = 'fotos'
       and (a.excluido_por = auth.uid() or (a.operacao_id is not null and public.dono_operacao(a.operacao_id))));
end;
$$;

-- Depois de enviar o arquivo ao Storage, o aparelho registra a foto.
create or replace function public.registrar_foto(
  p_participante uuid, p_client_id uuid, p_origem text,
  p_lat double precision default null, p_lng double precision default null, p_precisao real default null,
  p_posicao_em timestamptz default null, p_capturada_em timestamptz default null, p_legenda text default '',
  p_bytes integer default null, p_largura integer default null, p_altura integer default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
  v_caminho text;
  v_foto public.fotos%rowtype;
  v_captura timestamptz := p_capturada_em;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found then
    raise exception 'participante_invalido';
  end if;
  if v_part.liberado_em is not null then
    raise exception 'participante_liberado';
  end if;
  if v_part.removido then
    raise exception 'participante_removido';
  end if;
  select status into v_status from public.operacoes where id = v_part.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if p_client_id is null then
    raise exception 'foto_invalida';
  end if;

  select * into v_foto from public.fotos where participante_id = v_part.id and client_id = p_client_id;
  if found then
    return row_to_json(v_foto);   -- reenvio: já estava registrada
  end if;

  v_caminho := v_part.operacao_id || '/' || v_part.id || '/' || p_client_id || '.jpg';
  if not exists (select 1 from storage.objects where bucket_id = 'fotos' and name = v_caminho) then
    raise exception 'foto_nao_enviada';
  end if;

  if p_origem is null or p_origem not in ('gps', 'exif', 'nenhuma') then
    raise exception 'foto_invalida';
  end if;
  if p_origem = 'nenhuma' and (p_lat is not null or p_lng is not null) then
    raise exception 'posicao_invalida';
  end if;
  if p_origem <> 'nenhuma' and (p_lat is null or p_lng is null or p_lat not between -90 and 90
       or p_lng not between -180 and 180 or (p_lat = 0 and p_lng = 0)) then
    raise exception 'posicao_invalida';
  end if;
  if v_captura is not null and (v_captura > now() + interval '2 minutes' or v_captura < '2000-01-01') then
    v_captura := null;
  end if;

  insert into public.fotos (operacao_id, participante_id, autor_nome, autor_tipo, client_id, caminho,
                            lat, lng, precisao, posicao_em, origem_posicao, capturada_em, legenda,
                            bytes, largura, altura)
  values (v_part.operacao_id, v_part.id, v_part.nome, v_part.tipo, p_client_id, v_caminho,
          p_lat, p_lng, case when p_precisao between 0 and 100000 then p_precisao end,
          case when p_lat is not null then least(coalesce(p_posicao_em, now()), now()) end,
          p_origem, v_captura, left(btrim(coalesce(p_legenda, '')), 300),
          case when p_bytes between 0 and 20000000 then p_bytes end,
          case when p_largura between 1 and 20000 then p_largura end,
          case when p_altura between 1 and 20000 then p_altura end)
  returning * into v_foto;

  update public.participantes set ultimo_contato_em = now() where id = v_part.id;
  return row_to_json(v_foto);
end;
$$;

-- Toda foto excluída (por exclusão da operação, retenção vencida etc.) entra na
-- fila de arquivos a apagar do Storage.
create or replace function public.fila_apagar_arquivo()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.arquivos_pendentes (caminho, bucket, operacao_id, excluido_por)
  values (old.caminho, 'fotos', old.operacao_id, auth.uid())
  on conflict (caminho) do nothing;
  return old;
end;
$$;
drop trigger if exists fotos_apagar_arquivo on public.fotos;
create trigger fotos_apagar_arquivo after delete on public.fotos
  for each row execute function public.fila_apagar_arquivo();

-- Arquivos que este responsável deve apagar do Storage (após excluir dados).
create or replace function public.meus_arquivos_pendentes()
returns json
language sql stable security definer set search_path = public
as $$
  select coalesce(json_agg(caminho), '[]'::json)
    from (select caminho from public.arquivos_pendentes
           where excluido_por = auth.uid() order by criado_em limit 1000) x;
$$;

-- Tira da fila os arquivos que de fato já não existem no Storage.
create or replace function public.confirmar_arquivos_removidos(p_caminhos text[])
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_qtd integer;
begin
  delete from public.arquivos_pendentes a
   where a.caminho = any (coalesce(p_caminhos, '{}'))
     and a.excluido_por = auth.uid()
     and not exists (select 1 from storage.objects o where o.bucket_id = a.bucket and o.name = a.caminho);
  get diagnostics v_qtd = row_count;
  return v_qtd;
end;
$$;

-- Usadas só pela limpeza diária (chave secreta).
create or replace function public.servidor_arquivos_pendentes(p_limite integer default 500)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v json;
begin
  -- primeiro, tira da fila o que já não existe
  delete from public.arquivos_pendentes a
   where not exists (select 1 from storage.objects o where o.bucket_id = a.bucket and o.name = a.caminho);
  with x as (
    update public.arquivos_pendentes set tentativas = tentativas + 1
     where caminho in (select caminho from public.arquivos_pendentes order by criado_em limit greatest(1, least(p_limite, 1000)))
    returning caminho, bucket
  )
  select coalesce(json_agg(json_build_object('caminho', caminho, 'bucket', bucket)), '[]'::json) into v from x;
  return v;
end;
$$;

create or replace function public.servidor_arquivos_conferir(p_erro text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_removidos integer;
  v_restantes integer;
begin
  delete from public.arquivos_pendentes a
   where not exists (select 1 from storage.objects o where o.bucket_id = a.bucket and o.name = a.caminho);
  get diagnostics v_removidos = row_count;
  if p_erro is not null then
    update public.arquivos_pendentes set ultimo_erro = left(p_erro, 300);
  end if;
  select count(*) into v_restantes from public.arquivos_pendentes;
  return json_build_object('removidos_da_fila', v_removidos, 'restantes', v_restantes);
end;
$$;

-- ---------------------------------------------------------------------
-- 4g. EXCLUSÃO DEFINITIVA DE UMA OPERAÇÃO
-- ---------------------------------------------------------------------
-- Quem pode: quem criou a operação, ou um administrador que faça parte dela.
-- Tudo acontece numa transação: participantes, posições, mensagens, relatos,
-- fotos (registros), equipe e tokens dos links são apagados juntos. Os arquivos
-- das fotos entram na fila arquivos_pendentes e são apagados do Storage pelo
-- painel logo em seguida (ou pela limpeza diária, se algo falhar).
create or replace function public.excluir_operacao(p_operacao uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_codigo text;
  v_fotos integer;
  v_participantes integer;
begin
  if not (public.eh_criador(p_operacao) or (public.eh_admin() and public.dono_operacao(p_operacao))) then
    raise exception 'sem_permissao';
  end if;
  select codigo into v_codigo from public.operacoes where id = p_operacao for update;
  if v_codigo is null then
    raise exception 'sem_permissao';
  end if;
  select count(*) into v_fotos from public.fotos where operacao_id = p_operacao;
  select count(*) into v_participantes from public.participantes where operacao_id = p_operacao and tipo <> 'responsavel';

  delete from public.operacoes where id = p_operacao;   -- apaga em cascata tudo o que é da operação

  return json_build_object('operacao', v_codigo, 'fotos', v_fotos, 'participantes', v_participantes);
end;
$$;

-- ---------------------------------------------------------------------
-- 5. FUNÇÕES (RPC) — PARTICIPANTE (civil ou militar de campo)
-- ---------------------------------------------------------------------

-- Informações mínimas para a tela inicial (antes do ingresso).
create or replace function public.info_operacao(p_token text)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_op public.operacoes%rowtype;
  v_tipo text;
begin
  if p_token is null or char_length(p_token) <> 64 then
    return null;
  end if;
  select * into v_op from public.operacoes where token_civil = p_token;
  if found then
    v_tipo := 'civil';
  else
    select * into v_op from public.operacoes where token_militar = p_token;
    if not found then
      return null;
    end if;
    v_tipo := 'militar';
  end if;
  return json_build_object(
    'operacao', v_op.codigo,
    'ativa', v_op.status = 'ativa',
    'tipos_permitidos', case when v_tipo = 'militar' then json_build_array('militar', 'civil') else json_build_array('civil') end
  );
end;
$$;

-- Versão anterior (sem CPF e telefone) é substituída.
drop function if exists public.ingressar(text, text, text);

create or replace function public.ingressar(p_token text, p_nome text, p_tipo text default 'civil',
                                            p_cpf text default null, p_telefone text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_op public.operacoes%rowtype;
  v_link text;
  v_tipo text;
  v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g'));
  v_part public.participantes%rowtype;
  v_total integer;
  v_cpf text := public.cpf_normalizado(p_cpf);
  v_tel text := public.telefone_normalizado(p_telefone);
begin
  if v_uid is null then
    raise exception 'nao_autenticado';
  end if;
  if p_token is null or char_length(p_token) <> 64 then
    raise exception 'link_invalido';
  end if;

  select * into v_op from public.operacoes where token_civil = p_token;
  if found then
    v_link := 'civil';
  else
    select * into v_op from public.operacoes where token_militar = p_token;
    if not found then
      raise exception 'link_invalido';
    end if;
    v_link := 'militar';
  end if;

  if v_op.status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if char_length(v_nome) < 2 or char_length(v_nome) > 40 then
    raise exception 'nome_invalido';
  end if;

  -- O tipo é decidido pelo servidor: o link de civis nunca concede "militar".
  if v_link = 'militar' and p_tipo = 'militar' then
    v_tipo := 'militar';
  else
    v_tipo := 'civil';
  end if;

  -- CPF e celular: obrigatórios para civis; opcionais para militares (se informados, válidos).
  if coalesce(btrim(p_cpf), '') <> '' and v_cpf is null then
    raise exception 'cpf_invalido';
  end if;
  if coalesce(btrim(p_telefone), '') <> '' and v_tel is null then
    raise exception 'telefone_invalido';
  end if;
  if v_tipo = 'civil' and v_cpf is null then
    raise exception 'cpf_invalido';
  end if;
  if v_tipo = 'civil' and v_tel is null then
    raise exception 'telefone_invalido';
  end if;

  select * into v_part from public.participantes where operacao_id = v_op.id and user_id = v_uid;
  if found then
    if v_part.liberado_em is not null then
      raise exception 'participante_liberado';
    end if;
    if v_part.removido or v_part.tipo = 'responsavel' then
      raise exception 'participante_removido';
    end if;
    update public.participantes
       set nome = v_nome, tipo = v_tipo,
           cpf = coalesce(v_cpf, cpf), telefone = coalesce(v_tel, telefone)
     where id = v_part.id returning * into v_part;
  else
    select count(*) into v_total from public.participantes where operacao_id = v_op.id;
    if v_total >= 300 then
      raise exception 'limite_participantes';
    end if;
    insert into public.participantes (operacao_id, user_id, nome, tipo, cpf, telefone)
    values (v_op.id, v_uid, v_nome, v_tipo, v_cpf, v_tel)
    returning * into v_part;
  end if;

  return json_build_object(
    'participante_id', v_part.id,
    'nome', v_part.nome,
    'tipo', v_part.tipo,
    'operacao', v_op.codigo,
    'operacao_id', v_op.id,
    'saida_solicitada_em', v_part.saida_solicitada_em
  );
end;
$$;

-- Recebe um lote de posições. Formato de cada ponto:
--   {"id": "<uuid gerado no celular>", "lat": -15.79, "lng": -47.88, "prec": 8.5, "t": <epoch ms>}
-- Pontos inválidos são descartados; pontos repetidos (mesmo id) são ignorados.
create or replace function public.enviar_posicoes(p_participante uuid, p_pontos jsonb, p_gps text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_op public.operacoes%rowtype;
  v_inseridos integer := 0;
  v_ult record;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found then
    raise exception 'participante_invalido';
  end if;
  if v_part.liberado_em is not null then
    raise exception 'participante_liberado';
  end if;
  if v_part.removido then
    raise exception 'participante_removido';
  end if;
  select * into v_op from public.operacoes where id = v_part.operacao_id;
  if v_op.status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if p_pontos is null or jsonb_typeof(p_pontos) <> 'array' or jsonb_array_length(p_pontos) > 500 then
    raise exception 'lote_invalido';
  end if;

  -- Cada conversão é protegida por CASE: o PostgreSQL não garante a ordem
  -- entre WHERE e SELECT, e um único ponto malformado não pode derrubar o lote.
  with numericos as (
    select case when jsonb_typeof(e) = 'object'
                 and coalesce(e ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then (e ->> 'id')::uuid end as client_id,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'lat') = 'number' then (e -> 'lat')::numeric end as lat,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'lng') = 'number' then (e -> 'lng')::numeric end as lng,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'prec') = 'number' then (e -> 'prec')::numeric end as prec,
           case when jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 't') = 'number' then (e -> 't')::numeric end as t
      from jsonb_array_elements(p_pontos) as e
  ), validos as (
    select client_id,
           case when lat between -90 and 90 then lat::double precision end as lat,
           case when lng between -180 and 180 then lng::double precision end as lng,
           case when prec between 0 and 100000 then prec::real end as prec,
           case when t between 946684800000 and 4102444800000            -- entre 2000 e 2100
                then to_timestamp((t / 1000)::double precision) end as registrado_em
      from numericos
  ), dentro_do_periodo as (
    select * from validos
     where client_id is not null
       and lat is not null and lng is not null
       and not (lat = 0 and lng = 0)
       and registrado_em between v_op.criada_em - interval '10 minutes' and now() + interval '2 minutes'
  ), inseridos as (
    insert into public.posicoes (operacao_id, participante_id, client_id, lat, lng, precisao, registrado_em)
    select v_op.id, v_part.id, client_id, lat, lng, prec, registrado_em from dentro_do_periodo
    on conflict (participante_id, client_id) do nothing
    returning 1
  )
  select count(*) into v_inseridos from inseridos;

  select lat, lng, precisao, registrado_em into v_ult
    from public.posicoes
   where participante_id = v_part.id
   order by registrado_em desc
   limit 1;

  update public.participantes
     set ultimo_contato_em = now(),
         rastreando = true,
         gps_estado = case when p_gps in ('ok', 'fraco', 'sem_sinal', 'negado', 'indisponivel') then p_gps
                           when v_inseridos > 0 then 'ok'
                           else gps_estado end,
         ultima_lat = coalesce(v_ult.lat, ultima_lat),
         ultima_lng = coalesce(v_ult.lng, ultima_lng),
         ultima_precisao = case when v_ult.registrado_em is not null then v_ult.precisao else ultima_precisao end,
         ultima_posicao_em = coalesce(v_ult.registrado_em, ultima_posicao_em)
   where id = v_part.id;

  return json_build_object('status', 'ativa', 'recebidos', jsonb_array_length(p_pontos), 'inseridos', v_inseridos);
end;
$$;

-- Sinal de vida periódico: mantém o estado de conexão/GPS e informa se a operação continua ativa.
create or replace function public.sinal_vida(p_participante uuid, p_rastreando boolean, p_gps text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
begin
  select * into v_part from public.participantes where id = p_participante and user_id = auth.uid();
  if not found then
    return json_build_object('status', 'inexistente');
  end if;
  if v_part.liberado_em is not null then
    return json_build_object('status', 'liberado');
  end if;
  if v_part.removido then
    return json_build_object('status', 'removido');
  end if;
  select status into v_status from public.operacoes where id = v_part.operacao_id;
  if v_status <> 'ativa' then
    return json_build_object('status', 'encerrada');
  end if;

  update public.participantes
     set ultimo_contato_em = now(),
         rastreando = coalesce(p_rastreando, rastreando),
         gps_estado = case when p_gps in ('aguardando', 'ok', 'fraco', 'sem_sinal', 'negado', 'indisponivel') then p_gps
                           else gps_estado end
   where id = v_part.id;

  return json_build_object('status', 'ativa', 'agora', now(), 'saida_solicitada_em', v_part.saida_solicitada_em);
end;
$$;

create or replace function public.marcar_entregues(p_ids uuid[])
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_qtd integer;
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;
  if cardinality(p_ids) > 200 then
    raise exception 'lote_invalido';
  end if;
  update public.mensagens m
     set entregue_em = now()
    from public.participantes p
   where m.id = any (p_ids)
     and m.participante_id = p.id
     and p.user_id = auth.uid()
     and m.direcao = 'saida'
     and m.entregue_em is null;
  get diagnostics v_qtd = row_count;
  return v_qtd;
end;
$$;

create or replace function public.confirmar_mensagem(p_mensagem uuid, p_resposta text default 'CIENTE')
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_resp text := case when p_resposta in ('CIENTE', 'ESTOU_BEM', 'PRECISO_AJUDA') then p_resposta else 'CIENTE' end;
  v_msg public.mensagens%rowtype;
begin
  update public.mensagens m
     set confirmada_em = coalesce(m.confirmada_em, now()),
         entregue_em   = coalesce(m.entregue_em, now()),
         resposta      = coalesce(m.resposta, v_resp)
    from public.participantes p
   where m.id = p_mensagem
     and m.participante_id = p.id
     and p.user_id = auth.uid()
     and m.direcao = 'saida'
  returning m.* into v_msg;
  if not found then
    raise exception 'sem_permissao';
  end if;
  return row_to_json(v_msg);
end;
$$;

-- Hora do servidor (para sincronizar relógios e calcular "há X segundos").
create or replace function public.agora()
returns timestamptz
language sql stable
as $$ select now(); $$;

-- ---------------------------------------------------------------------
-- 6. LIMPEZA AUTOMÁTICA (retenção) — chamada só pelo servidor
-- ---------------------------------------------------------------------
create or replace function public.purgar_expiradas()
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_encerradas integer := 0;
  v_apagadas integer := 0;
  v_anonimos integer := 0;
begin
  -- Salvaguarda: operações esquecidas abertas por mais de 30 dias são encerradas.
  with x as (
    update public.operacoes
       set status = 'encerrada', encerrada_em = now(), expira_em = now() + make_interval(hours => retencao_horas)
     where status = 'ativa' and criada_em < now() - interval '30 days'
    returning id
  )
  select count(*) into v_encerradas from x;

  -- Apaga participantes, posições e mensagens de operações com retenção vencida.
  with alvo as (
    update public.operacoes
       set dados_apagados_em = now()
     where status = 'encerrada' and dados_apagados_em is null and expira_em <= now()
    returning id
  ), del as (
    delete from public.participantes where operacao_id in (select id from alvo) returning 1
  )
  select (select count(*) from alvo) into v_apagadas from (select count(*) from del) d;

  -- Remove contas anônimas antigas que não participam mais de nenhuma operação.
  begin
    with velhos as (
      delete from auth.users u
       where u.is_anonymous
         and u.created_at < now() - interval '7 days'
         and not exists (select 1 from public.participantes p where p.user_id = u.id)
      returning 1
    )
    select count(*) into v_anonimos from velhos;
  exception when others then
    v_anonimos := -1;   -- sem permissão no esquema auth: ignore
  end;

  return json_build_object('operacoes_encerradas', v_encerradas, 'operacoes_apagadas', v_apagadas, 'contas_anonimas_removidas', v_anonimos);
end;
$$;

-- ---------------------------------------------------------------------
-- 7. PERMISSÕES DE EXECUÇÃO
-- ---------------------------------------------------------------------
revoke execute on function
  public.participante_enviar_mensagem(uuid, text, text, double precision, double precision, real, timestamptz, uuid),
  public.marcar_lidas(uuid[]), public.caminho_foto_partes(text), public.pode_enviar_foto(text), public.pode_ver_foto(text),
  public.pode_apagar_foto(text),
  public.registrar_foto(uuid, uuid, text, double precision, double precision, real, timestamptz, timestamptz, text, integer, integer, integer),
  public.meus_arquivos_pendentes(), public.confirmar_arquivos_removidos(text[]), public.excluir_operacao(uuid),
  public.servidor_arquivos_pendentes(integer), public.servidor_arquivos_conferir(text), public.fila_apagar_arquivo(),
  public.eh_admin(), public.admin_listar_responsaveis(), public.admin_alterar_responsavel(uuid, text, boolean, boolean),
  public.servidor_usuario_por_email(text), public.servidor_salvar_responsavel(uuid, text, boolean),
  public.servidor_eh_responsavel(uuid),
  public.eh_responsavel(), public.dono_operacao(uuid), public.eh_meu_participante(uuid), public.gerar_token(),
  public.criar_operacao(text, integer), public.encerrar_operacao(uuid), public.apagar_dados_operacao(uuid),
  public.remover_participante(uuid), public.enviar_mensagem(uuid, text, text), public.info_operacao(text),
  public.ingressar(text, text, text, text, text), public.enviar_posicoes(uuid, jsonb, text), public.sinal_vida(uuid, boolean, text),
  public.marcar_entregues(uuid[]), public.confirmar_mensagem(uuid, text), public.agora(), public.purgar_expiradas(),
  public.solicitar_saida(uuid, text), public.liberar_participante(uuid), public.recusar_saida(uuid),
  public.eh_criador(uuid), public.listar_responsaveis(uuid), public.adicionar_responsavel(uuid, text),
  public.remover_responsavel(uuid, uuid), public.entrar_como_responsavel(uuid)
from public, anon;

grant execute on function
  public.participante_enviar_mensagem(uuid, text, text, double precision, double precision, real, timestamptz, uuid),
  public.marcar_lidas(uuid[]), public.caminho_foto_partes(text), public.pode_enviar_foto(text), public.pode_ver_foto(text),
  public.pode_apagar_foto(text),
  public.registrar_foto(uuid, uuid, text, double precision, double precision, real, timestamptz, timestamptz, text, integer, integer, integer),
  public.meus_arquivos_pendentes(), public.confirmar_arquivos_removidos(text[]), public.excluir_operacao(uuid),
  public.eh_admin(), public.admin_listar_responsaveis(), public.admin_alterar_responsavel(uuid, text, boolean, boolean),
  public.eh_responsavel(), public.dono_operacao(uuid), public.eh_meu_participante(uuid),
  public.criar_operacao(text, integer), public.encerrar_operacao(uuid), public.apagar_dados_operacao(uuid),
  public.remover_participante(uuid), public.enviar_mensagem(uuid, text, text), public.info_operacao(text),
  public.ingressar(text, text, text, text, text), public.enviar_posicoes(uuid, jsonb, text), public.sinal_vida(uuid, boolean, text),
  public.marcar_entregues(uuid[]), public.confirmar_mensagem(uuid, text), public.agora(),
  public.solicitar_saida(uuid, text), public.liberar_participante(uuid), public.recusar_saida(uuid),
  public.eh_criador(uuid), public.listar_responsaveis(uuid), public.adicionar_responsavel(uuid, text),
  public.remover_responsavel(uuid, uuid), public.entrar_como_responsavel(uuid)
to authenticated;

-- A tela inicial do participante mostra o nome da operação antes do login anônimo.
grant execute on function public.info_operacao(text) to anon;

-- Só o servidor (chave secreta, função /api/limpeza) executa a limpeza.
revoke execute on function public.purgar_expiradas() from authenticated;
grant execute on function public.purgar_expiradas() to service_role;

-- Funções do servidor (cadastro de login pelo painel): só a chave secreta executa.
revoke execute on function public.servidor_usuario_por_email(text), public.servidor_salvar_responsavel(uuid, text, boolean),
  public.servidor_eh_responsavel(uuid) from authenticated;
grant execute on function public.servidor_usuario_por_email(text), public.servidor_salvar_responsavel(uuid, text, boolean),
  public.servidor_eh_responsavel(uuid) to service_role;
revoke execute on function public.servidor_arquivos_pendentes(integer), public.servidor_arquivos_conferir(text) from authenticated;
grant execute on function public.servidor_arquivos_pendentes(integer), public.servidor_arquivos_conferir(text) to service_role;

-- ---------------------------------------------------------------------
-- 8. TEMPO REAL (Supabase Realtime — postgres_changes respeita o RLS)
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['participantes', 'posicoes', 'mensagens', 'fotos'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then
        null;  -- já estava publicada
      end;
    end loop;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 9. STORAGE: bucket PRIVADO "fotos" e suas regras de acesso
--    (imagens só por links assinados e temporários; nunca públicas)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos', 'fotos', false, 10485760, array['image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists gbs_fotos_enviar on storage.objects;
create policy gbs_fotos_enviar on storage.objects
  for insert to authenticated
  with check (bucket_id = 'fotos' and public.pode_enviar_foto(name));

drop policy if exists gbs_fotos_ver on storage.objects;
create policy gbs_fotos_ver on storage.objects
  for select to authenticated
  using (bucket_id = 'fotos' and public.pode_ver_foto(name));

drop policy if exists gbs_fotos_apagar on storage.objects;
create policy gbs_fotos_apagar on storage.objects
  for delete to authenticated
  using (bucket_id = 'fotos' and public.pode_apagar_foto(name));

-- =====================================================================
-- DEPOIS DE EXECUTAR ESTE ARQUIVO (somente na PRIMEIRA instalação):
--   O primeiro responsável é criado pelo Supabase; ele vira ADMINISTRADOR e
--   cadastra os demais pela tela "Responsáveis" do painel.
--   1. Crie o usuário em Authentication > Users > Add user (marque Auto Confirm).
--   2. Autorize-o (troque o e-mail e o nome):
--
--      insert into public.responsaveis (user_id, nome)
--      select id, 'Sgt BM Fulano' from auth.users where email = 'fulano@cbm.exemplo.gov.br';
-- =====================================================================
