-- =====================================================================
-- 12. MODO DE DESLOCAMENTO DO DESTINO (rota a pé, por trilha ou de carro)
--     (migração 005 — idempotente; exige a 003 e a 004)
--
--  destinos.modo: como o participante deve ir até o destino. O celular usa esse
--  modo para pedir a rota por caminhos reais (/api/rota) e o participante pode
--  trocar na tela. Nada é apagado; destinos antigos ficam como 'a_pe'.
-- =====================================================================

alter table public.destinos add column if not exists modo text not null default 'a_pe';
alter table public.destinos drop constraint if exists destinos_modo_check;
alter table public.destinos add constraint destinos_modo_check check (modo in ('a_pe', 'trilha', 'carro'));

-- A função ganha o parâmetro p_modo (opcional). A versão de 5 parâmetros é
-- substituída; chamadas antigas continuam funcionando (p_modo = 'a_pe').
drop function if exists public.definir_destino(uuid, text, double precision, double precision, uuid);

create or replace function public.definir_destino(p_participante uuid, p_nome text, p_lat double precision,
                                                  p_lng double precision, p_ponto uuid default null,
                                                  p_modo text default 'a_pe')
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
  if coalesce(p_modo, 'a_pe') not in ('a_pe', 'trilha', 'carro') then
    raise exception 'dados_invalidos';
  end if;
  if p_ponto is not null and not exists (select 1 from public.pontos_interesse where id = p_ponto and operacao_id = v_part.operacao_id) then
    raise exception 'dados_invalidos';
  end if;

  update public.destinos set encerrado_em = now(), encerrado_por = 'substituído por novo destino'
   where participante_id = v_part.id and encerrado_em is null;
  insert into public.destinos (operacao_id, participante_id, nome, lat, lng, ponto_id, enviado_por, enviado_por_nome, modo)
  values (v_part.operacao_id, v_part.id, btrim(p_nome), p_lat, p_lng, p_ponto, auth.uid(), v_nome_resp, coalesce(p_modo, 'a_pe'))
  returning * into v_d;
  return row_to_json(v_d);
end;
$$;

create or replace function public.meu_destino(p_participante uuid)
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
  return (
    select json_build_object('id', d.id, 'nome', d.nome, 'lat', d.lat, 'lng', d.lng,
                             'criado_em', d.criado_em, 'recebido_em', d.recebido_em, 'modo', d.modo)
      from public.destinos d
     where d.participante_id = v_part.id and d.encerrado_em is null
     order by d.criado_em desc limit 1);
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
                                        'lat', p.lat, 'lng', p.lng) order by p.criado_em)
        from public.pontos_interesse p
       where p.operacao_id = v_part.operacao_id and p.categoria in ('ENCONTRO', 'RISCO')), '[]'::json),
    'destino', (
      select json_build_object('id', d.id, 'nome', d.nome, 'lat', d.lat, 'lng', d.lng, 'criado_em', d.criado_em, 'modo', d.modo)
        from public.destinos d where d.participante_id = v_part.id and d.encerrado_em is null
       order by d.criado_em desc limit 1)
  );
end;
$$;

revoke execute on function public.definir_destino(uuid, text, double precision, double precision, uuid, text),
  public.meu_destino(uuid), public.mapa_do_participante(uuid) from public, anon;
grant execute on function public.definir_destino(uuid, text, double precision, double precision, uuid, text),
  public.meu_destino(uuid), public.mapa_do_participante(uuid) to authenticated;

notify pgrst, 'reload schema';
