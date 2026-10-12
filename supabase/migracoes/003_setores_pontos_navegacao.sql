-- =====================================================================
-- 10. SETORES DE BUSCA, PONTOS DE INTERESSE E NAVEGAÇÃO
--     (migração 003 — pode ser executada sozinha num banco já instalado,
--      ou junto com o schema.sql completo; é idempotente)
--
--  setores           áreas de busca (círculo por raio ou polígono) de uma operação
--  pontos_interesse  locais marcados pelos responsáveis (última localização, risco…)
--  destinos          "navegue até aqui" enviado a um participante (1 ativo por vez)
--
--  Leitura direta: só responsáveis da operação (RLS). Toda gravação passa por
--  funções que conferem a permissão. O participante só recebe, pela função
--  mapa_do_participante, o que é dele: os setores atribuídos a ele, pontos de
--  encontro e áreas de risco, e o destino ativo.
-- =====================================================================

create table if not exists public.setores (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  nome                text not null check (char_length(btrim(nome)) between 1 and 60),
  forma               text not null check (forma in ('circulo', 'poligono')),
  centro_lat          double precision check (centro_lat between -90 and 90),
  centro_lng          double precision check (centro_lng between -180 and 180),
  raio_m              double precision,
  pontos              jsonb,
  cor                 text not null default '#3b82f6' check (cor ~ '^#[0-9a-fA-F]{6}$'),
  status              text not null default 'pendente' check (status in ('pendente', 'andamento', 'concluido')),
  participante_id     uuid references public.participantes(id) on delete set null,
  equipe              text not null default '' check (char_length(equipe) <= 60),
  observacoes         text not null default '' check (char_length(observacoes) <= 500),
  criado_por          uuid references auth.users(id) on delete set null,
  criado_por_nome     text not null,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text,
  constraint setores_forma_ok check (
    (forma = 'circulo' and centro_lat is not null and centro_lng is not null and raio_m between 5 and 50000 and pontos is null)
    or (forma = 'poligono' and pontos is not null and jsonb_typeof(pontos) = 'array' and centro_lat is null and raio_m is null))
);
create index if not exists setores_operacao_idx on public.setores (operacao_id);

create table if not exists public.pontos_interesse (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  categoria           text not null check (categoria in ('ULTIMA_LOCALIZACAO', 'POSSIVEL_LOCALIZACAO', 'VESTIGIO',
                                                         'RISCO', 'ENCONTRO', 'VITIMA_ENCONTRADA', 'OUTRO')),
  titulo              text not null check (char_length(btrim(titulo)) between 1 and 80),
  descricao           text not null default '' check (char_length(descricao) <= 1000),
  lat                 double precision not null check (lat between -90 and 90),
  lng                 double precision not null check (lng between -180 and 180),
  foto_id             uuid references public.fotos(id) on delete set null,
  mensagem_id         uuid references public.mensagens(id) on delete set null,
  relatado_por_nome   text,
  criado_por          uuid references auth.users(id) on delete set null,
  criado_por_nome     text not null,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text
);
create index if not exists pontos_interesse_operacao_idx on public.pontos_interesse (operacao_id);

create table if not exists public.destinos (
  id                  uuid primary key default gen_random_uuid(),
  operacao_id         uuid not null references public.operacoes(id) on delete cascade,
  participante_id     uuid not null references public.participantes(id) on delete cascade,
  nome                text not null check (char_length(btrim(nome)) between 1 and 80),
  lat                 double precision not null check (lat between -90 and 90),
  lng                 double precision not null check (lng between -180 and 180),
  ponto_id            uuid references public.pontos_interesse(id) on delete set null,
  enviado_por         uuid references auth.users(id) on delete set null,
  enviado_por_nome    text not null,
  criado_em           timestamptz not null default now(),
  encerrado_em        timestamptz,
  encerrado_por       text
);
create index if not exists destinos_operacao_idx on public.destinos (operacao_id);
create unique index if not exists destinos_um_ativo on public.destinos (participante_id) where encerrado_em is null;

alter table public.setores enable row level security;
alter table public.pontos_interesse enable row level security;
alter table public.destinos enable row level security;

drop policy if exists setores_ler on public.setores;
create policy setores_ler on public.setores for select to authenticated using (public.dono_operacao(operacao_id));
drop policy if exists pontos_interesse_ler on public.pontos_interesse;
create policy pontos_interesse_ler on public.pontos_interesse for select to authenticated using (public.dono_operacao(operacao_id));
drop policy if exists destinos_ler on public.destinos;
create policy destinos_ler on public.destinos for select to authenticated using (public.dono_operacao(operacao_id));

revoke all on public.setores, public.pontos_interesse, public.destinos from anon;
revoke insert, update, delete, truncate on public.setores, public.pontos_interesse, public.destinos from authenticated;
grant select on public.setores, public.pontos_interesse, public.destinos to authenticated;

-- Quem pode editar/excluir: qualquer responsável da operação edita; excluir é de
-- quem criou o registro, de quem criou a operação ou de um administrador da equipe.
create or replace function public.pode_excluir_registro(p_operacao uuid, p_criado_por uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.dono_operacao(p_operacao)
     and (p_criado_por = auth.uid() or public.eh_criador(p_operacao) or public.eh_admin());
$$;

create or replace function public.nome_responsavel_atual()
returns text
language sql stable security definer set search_path = public
as $$ select nome from public.responsaveis where user_id = auth.uid() and ativo; $$;

-- Confere uma lista de vértices [[lat, lng], …] (3 a 300 pontos).
create or replace function public.vertices_validos(p jsonb)
returns boolean
language plpgsql immutable
as $$
declare
  v jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) < 3 or jsonb_array_length(p) > 300 then
    return false;
  end if;
  for v in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) <> 2
       or jsonb_typeof(v->0) <> 'number' or jsonb_typeof(v->1) <> 'number'
       or (v->>0)::double precision not between -90 and 90
       or (v->>1)::double precision not between -180 and 180 then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- Cria (p_id nulo) ou altera um setor. Na alteração, só os campos enviados mudam.
create or replace function public.salvar_setor(p_operacao uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v_s public.setores%rowtype;
  v_op public.operacoes%rowtype;
  v_part uuid;
begin
  if v_nome_resp is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  if v_op.dados_apagados_em is not null then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);

  if p_id is null then
    v_s.id := gen_random_uuid();
    v_s.operacao_id := p_operacao;
    v_s.criado_por := auth.uid();
    v_s.criado_por_nome := v_nome_resp;
    v_s.criado_em := now();
    v_s.status := 'pendente';
    v_s.cor := '#3b82f6';
    v_s.equipe := '';
    v_s.observacoes := '';
  else
    select * into v_s from public.setores where id = p_id and operacao_id = p_operacao for update;
    if not found then
      raise exception 'setor_nao_encontrado';
    end if;
  end if;

  if p_dados ? 'nome' then v_s.nome := btrim(coalesce(p_dados->>'nome', '')); end if;
  if p_dados ? 'status' then v_s.status := p_dados->>'status'; end if;
  if p_dados ? 'cor' then v_s.cor := p_dados->>'cor'; end if;
  if p_dados ? 'equipe' then v_s.equipe := left(btrim(coalesce(p_dados->>'equipe', '')), 60); end if;
  if p_dados ? 'observacoes' then v_s.observacoes := left(btrim(coalesce(p_dados->>'observacoes', '')), 500); end if;
  if p_dados ? 'participante_id' then
    v_part := nullif(p_dados->>'participante_id', '')::uuid;
    if v_part is not null and not exists (select 1 from public.participantes where id = v_part and operacao_id = p_operacao) then
      raise exception 'participante_invalido';
    end if;
    v_s.participante_id := v_part;
  end if;
  if p_dados ? 'forma' then
    v_s.forma := p_dados->>'forma';
    if v_s.forma = 'circulo' then
      v_s.centro_lat := (p_dados->>'centro_lat')::double precision;
      v_s.centro_lng := (p_dados->>'centro_lng')::double precision;
      v_s.raio_m := (p_dados->>'raio_m')::double precision;
      v_s.pontos := null;
    elsif v_s.forma = 'poligono' then
      if not public.vertices_validos(p_dados->'pontos') then
        raise exception 'area_invalida';
      end if;
      v_s.pontos := p_dados->'pontos';
      v_s.centro_lat := null;
      v_s.centro_lng := null;
      v_s.raio_m := null;
    else
      raise exception 'area_invalida';
    end if;
  end if;

  if v_s.nome is null or char_length(v_s.nome) not between 1 and 60 then
    raise exception 'nome_invalido';
  end if;
  if v_s.status not in ('pendente', 'andamento', 'concluido') or v_s.cor !~ '^#[0-9a-fA-F]{6}$' then
    raise exception 'dados_invalidos';
  end if;
  if v_s.forma is null
     or (v_s.forma = 'circulo' and (v_s.centro_lat is null or v_s.centro_lng is null or v_s.raio_m is null
         or v_s.raio_m not between 5 and 50000 or v_s.centro_lat not between -90 and 90 or v_s.centro_lng not between -180 and 180)) then
    raise exception 'area_invalida';
  end if;

  v_s.atualizado_em := now();
  v_s.atualizado_por_nome := v_nome_resp;
  if p_id is null then
    insert into public.setores select v_s.*;
  else
    update public.setores set nome = v_s.nome, forma = v_s.forma, centro_lat = v_s.centro_lat, centro_lng = v_s.centro_lng,
           raio_m = v_s.raio_m, pontos = v_s.pontos, cor = v_s.cor, status = v_s.status, participante_id = v_s.participante_id,
           equipe = v_s.equipe, observacoes = v_s.observacoes, atualizado_em = v_s.atualizado_em,
           atualizado_por_nome = v_s.atualizado_por_nome
     where id = v_s.id;
  end if;
  return row_to_json(v_s);
end;
$$;

create or replace function public.excluir_setor(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v public.setores%rowtype;
begin
  select * into v from public.setores where id = p_id;
  if not found or not public.pode_excluir_registro(v.operacao_id, v.criado_por) then
    raise exception 'sem_permissao';
  end if;
  delete from public.setores where id = p_id;
end;
$$;

-- Cria ou altera um ponto de interesse.
create or replace function public.salvar_ponto(p_operacao uuid, p_id uuid, p_dados jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v_p public.pontos_interesse%rowtype;
  v_op public.operacoes%rowtype;
  v_ref uuid;
  v_msg public.mensagens%rowtype;
begin
  if v_nome_resp is null or not public.dono_operacao(p_operacao) then
    raise exception 'sem_permissao';
  end if;
  select * into v_op from public.operacoes where id = p_operacao;
  if v_op.dados_apagados_em is not null then
    raise exception 'operacao_encerrada';
  end if;
  p_dados := coalesce(p_dados, '{}'::jsonb);

  if p_id is null then
    v_p.id := gen_random_uuid();
    v_p.operacao_id := p_operacao;
    v_p.criado_por := auth.uid();
    v_p.criado_por_nome := v_nome_resp;
    v_p.criado_em := now();
    v_p.descricao := '';
    -- ponto criado a partir de um relato: guarda quem relatou
    if p_dados ? 'mensagem_id' and nullif(p_dados->>'mensagem_id', '') is not null then
      select * into v_msg from public.mensagens
       where id = (p_dados->>'mensagem_id')::uuid and operacao_id = p_operacao and direcao = 'entrada';
      if not found then
        raise exception 'dados_invalidos';
      end if;
      v_p.mensagem_id := v_msg.id;
      v_p.relatado_por_nome := v_msg.remetente_nome;
    end if;
  else
    select * into v_p from public.pontos_interesse where id = p_id and operacao_id = p_operacao for update;
    if not found then
      raise exception 'ponto_nao_encontrado';
    end if;
  end if;

  if p_dados ? 'categoria' then v_p.categoria := p_dados->>'categoria'; end if;
  if p_dados ? 'titulo' then v_p.titulo := btrim(coalesce(p_dados->>'titulo', '')); end if;
  if p_dados ? 'descricao' then v_p.descricao := left(btrim(coalesce(p_dados->>'descricao', '')), 1000); end if;
  if p_dados ? 'lat' then v_p.lat := (p_dados->>'lat')::double precision; end if;
  if p_dados ? 'lng' then v_p.lng := (p_dados->>'lng')::double precision; end if;
  if p_dados ? 'foto_id' then
    v_ref := nullif(p_dados->>'foto_id', '')::uuid;
    if v_ref is not null and not exists (select 1 from public.fotos where id = v_ref and operacao_id = p_operacao) then
      raise exception 'dados_invalidos';
    end if;
    v_p.foto_id := v_ref;
  end if;

  if v_p.categoria is null or v_p.categoria not in ('ULTIMA_LOCALIZACAO', 'POSSIVEL_LOCALIZACAO', 'VESTIGIO',
                                                      'RISCO', 'ENCONTRO', 'VITIMA_ENCONTRADA', 'OUTRO') then
    raise exception 'dados_invalidos';
  end if;
  if v_p.titulo is null or char_length(v_p.titulo) not between 1 and 80 then
    raise exception 'nome_invalido';
  end if;
  if v_p.lat is null or v_p.lng is null or v_p.lat not between -90 and 90 or v_p.lng not between -180 and 180
     or (v_p.lat = 0 and v_p.lng = 0) then
    raise exception 'posicao_invalida';
  end if;

  v_p.atualizado_em := now();
  v_p.atualizado_por_nome := v_nome_resp;
  if p_id is null then
    insert into public.pontos_interesse select v_p.*;
  else
    update public.pontos_interesse set categoria = v_p.categoria, titulo = v_p.titulo, descricao = v_p.descricao,
           lat = v_p.lat, lng = v_p.lng, foto_id = v_p.foto_id, atualizado_em = v_p.atualizado_em,
           atualizado_por_nome = v_p.atualizado_por_nome
     where id = v_p.id;
  end if;
  return row_to_json(v_p);
end;
$$;

create or replace function public.excluir_ponto(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v public.pontos_interesse%rowtype;
begin
  select * into v from public.pontos_interesse where id = p_id;
  if not found or not public.pode_excluir_registro(v.operacao_id, v.criado_por) then
    raise exception 'sem_permissao';
  end if;
  delete from public.pontos_interesse where id = p_id;
end;
$$;

-- Envia um destino ("navegue até aqui") a um participante. Substitui o anterior.
create or replace function public.definir_destino(p_participante uuid, p_nome text, p_lat double precision,
                                                  p_lng double precision, p_ponto uuid default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_nome_resp text := public.nome_responsavel_atual();
  v_part public.participantes%rowtype;
  v_status text;
  v_d public.destinos%rowtype;
begin
  select * into v_part from public.participantes where id = p_participante;
  if not found or v_nome_resp is null or not public.dono_operacao(v_part.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_part.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if v_part.removido or v_part.liberado_em is not null then
    raise exception 'participante_removido';
  end if;
  if v_part.user_id = auth.uid() then
    raise exception 'nao_pode_alterar_a_si';
  end if;
  if p_nome is null or char_length(btrim(p_nome)) not between 1 and 80 then
    raise exception 'nome_invalido';
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 or (p_lat = 0 and p_lng = 0) then
    raise exception 'posicao_invalida';
  end if;
  if p_ponto is not null and not exists (select 1 from public.pontos_interesse where id = p_ponto and operacao_id = v_part.operacao_id) then
    raise exception 'dados_invalidos';
  end if;

  update public.destinos set encerrado_em = now(), encerrado_por = 'substituído por novo destino'
   where participante_id = v_part.id and encerrado_em is null;
  insert into public.destinos (operacao_id, participante_id, nome, lat, lng, ponto_id, enviado_por, enviado_por_nome)
  values (v_part.operacao_id, v_part.id, btrim(p_nome), p_lat, p_lng, p_ponto, auth.uid(), v_nome_resp)
  returning * into v_d;
  return row_to_json(v_d);
end;
$$;

-- Encerra a navegação: pelo responsável (painel) ou pelo próprio participante.
create or replace function public.encerrar_destino(p_destino uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v public.destinos%rowtype;
  v_quem text;
begin
  select * into v from public.destinos where id = p_destino;
  if not found then
    raise exception 'sem_permissao';
  end if;
  if public.dono_operacao(v.operacao_id) then
    v_quem := coalesce(public.nome_responsavel_atual(), 'responsável');
  elsif exists (select 1 from public.participantes where id = v.participante_id and user_id = auth.uid()) then
    v_quem := 'participante';
  else
    raise exception 'sem_permissao';
  end if;
  update public.destinos set encerrado_em = coalesce(encerrado_em, now()), encerrado_por = coalesce(encerrado_por, v_quem)
   where id = p_destino;
end;
$$;

-- Tudo o que o mapa do participante pode mostrar, numa chamada só:
--   equipe   última posição de militares e responsáveis (sem nomes), como equipe_no_mapa
--   setores  só os setores atribuídos a ESTE participante
--   pontos   só pontos de encontro e áreas de risco (nunca dados sobre a vítima)
--   destino  o destino ativo enviado a ele
create or replace function public.mapa_do_participante(p_participante uuid)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
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
  return json_build_object(
    'equipe', public.equipe_no_mapa(p_participante),
    'setores', coalesce((
      select json_agg(json_build_object('id', s.id, 'nome', s.nome, 'forma', s.forma, 'centro_lat', s.centro_lat,
                                        'centro_lng', s.centro_lng, 'raio_m', s.raio_m, 'pontos', s.pontos,
                                        'cor', s.cor, 'status', s.status) order by s.criado_em)
        from public.setores s where s.operacao_id = v_part.operacao_id and s.participante_id = v_part.id), '[]'::json),
    'pontos', coalesce((
      select json_agg(json_build_object('id', p.id, 'categoria', p.categoria, 'titulo', p.titulo,
                                        'lat', p.lat, 'lng', p.lng) order by p.criado_em)
        from public.pontos_interesse p
       where p.operacao_id = v_part.operacao_id and p.categoria in ('ENCONTRO', 'RISCO')), '[]'::json),
    'destino', (
      select json_build_object('id', d.id, 'nome', d.nome, 'lat', d.lat, 'lng', d.lng, 'criado_em', d.criado_em)
        from public.destinos d where d.participante_id = v_part.id and d.encerrado_em is null
       order by d.criado_em desc limit 1)
  );
end;
$$;

revoke execute on function public.pode_excluir_registro(uuid, uuid), public.nome_responsavel_atual(), public.vertices_validos(jsonb),
  public.salvar_setor(uuid, uuid, jsonb), public.excluir_setor(uuid), public.salvar_ponto(uuid, uuid, jsonb),
  public.excluir_ponto(uuid), public.definir_destino(uuid, text, double precision, double precision, uuid),
  public.encerrar_destino(uuid), public.mapa_do_participante(uuid)
  from public, anon;
grant execute on function public.pode_excluir_registro(uuid, uuid), public.nome_responsavel_atual(), public.vertices_validos(jsonb),
  public.salvar_setor(uuid, uuid, jsonb), public.excluir_setor(uuid), public.salvar_ponto(uuid, uuid, jsonb),
  public.excluir_ponto(uuid), public.definir_destino(uuid, text, double precision, double precision, uuid),
  public.encerrar_destino(uuid), public.mapa_do_participante(uuid)
  to authenticated;

-- Quando os dados de uma operação são apagados (retenção vencida, "Apagar dados
-- agora" ou encerramento com "apagar ao encerrar"), setores, pontos e destinos
-- dela também são apagados. Excluir a operação apaga tudo em cascata.
create or replace function public.apagar_areas_da_operacao()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.dados_apagados_em is not null and old.dados_apagados_em is null then
    delete from public.destinos where operacao_id = new.id;
    delete from public.pontos_interesse where operacao_id = new.id;
    delete from public.setores where operacao_id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists operacoes_apagar_areas on public.operacoes;
create trigger operacoes_apagar_areas after update of dados_apagados_em on public.operacoes
  for each row execute function public.apagar_areas_da_operacao();
revoke execute on function public.apagar_areas_da_operacao() from public, anon, authenticated;

-- Tempo real para os painéis (mudanças aparecem sem recarregar).
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['setores', 'pontos_interesse', 'destinos'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then
        null;
      end;
    end loop;
  end if;
end;
$$;
