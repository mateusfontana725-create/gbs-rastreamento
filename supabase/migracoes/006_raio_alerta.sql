-- =====================================================================
-- 13. RAIO DE ALERTA DOS PONTOS (alarme de proximidade, como no AlpineQuest)
--     (migração 006 — idempotente; exige a 005)
--
--  pontos_interesse.raio_m (opcional, 10 m a 5 km): em áreas de risco, quem
--  entra no círculo recebe um alerta no celular e o painel é avisado.
--  Sem valor, vale o padrão do aplicativo (100 m). Nada é apagado.
-- =====================================================================

alter table public.pontos_interesse add column if not exists raio_m double precision;
alter table public.pontos_interesse drop constraint if exists pontos_interesse_raio_check;
alter table public.pontos_interesse add constraint pontos_interesse_raio_check check (raio_m is null or raio_m between 10 and 5000);

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
  if p_dados ? 'raio_m' then v_p.raio_m := nullif(p_dados->>'raio_m', '')::double precision; end if;
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

  if v_p.raio_m is not null and v_p.raio_m not between 10 and 5000 then
    raise exception 'dados_invalidos';
  end if;
  v_p.atualizado_em := now();
  v_p.atualizado_por_nome := v_nome_resp;
  if p_id is null then
    insert into public.pontos_interesse select v_p.*;
  else
    update public.pontos_interesse set categoria = v_p.categoria, titulo = v_p.titulo, descricao = v_p.descricao,
           lat = v_p.lat, lng = v_p.lng, foto_id = v_p.foto_id, raio_m = v_p.raio_m, atualizado_em = v_p.atualizado_em,
           atualizado_por_nome = v_p.atualizado_por_nome
     where id = v_p.id;
  end if;
  return row_to_json(v_p);
end;
$$;

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
                                        'lat', p.lat, 'lng', p.lng, 'raio_m', p.raio_m) order by p.criado_em)
        from public.pontos_interesse p
       where p.operacao_id = v_part.operacao_id and p.categoria in ('ENCONTRO', 'RISCO')), '[]'::json),
    'destino', (
      select json_build_object('id', d.id, 'nome', d.nome, 'lat', d.lat, 'lng', d.lng, 'criado_em', d.criado_em, 'modo', d.modo)
        from public.destinos d where d.participante_id = v_part.id and d.encerrado_em is null
       order by d.criado_em desc limit 1)
  );
end;
$$;

notify pgrst, 'reload schema';
