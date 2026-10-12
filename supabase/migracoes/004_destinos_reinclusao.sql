-- =====================================================================
-- 11. DESTINO RECEBIDO PELO PARTICIPANTE E REINCLUSÃO DE PARTICIPANTES
--     (migração 004 — idempotente; pode ser executada sozinha num banco que
--      já tem a migração 003, ou junto com o schema.sql completo)
--
--  Destinos
--   * O participante passa a LER o próprio destino (política RLS restrita a
--     participante_id do próprio usuário). Isso permite o Supabase Realtime
--     entregar o destino na hora (postgres_changes respeita o RLS). Nenhuma
--     outra política foi afrouxada: ele não lê destinos de outras pessoas.
--   * destinos.recebido_em: o celular confirma que recebeu e mostrou o destino
--     (função confirmar_destino). O painel mostra "Recebido no celular às…".
--
--  Remoção e reinclusão
--   * Remover / liberar NÃO apaga o cadastro nem a trilha: só desvincula
--     (removido = true). Fica registrado quem removeu e quando.
--   * reincluir_participante: só um responsável da operação, com a operação
--     ativa. Reativa o MESMO registro (sem duplicar), limpa a saída liberada e
--     o pedido de saída. O celular percebe sozinho e oferece "Voltar para a busca".
--   * participacao_eventos: histórico de remoções, liberações e reinclusões.
-- =====================================================================

alter table public.participantes add column if not exists removido_em timestamptz;
alter table public.participantes add column if not exists removido_por_nome text;
alter table public.participantes add column if not exists reincluido_em timestamptz;
alter table public.participantes add column if not exists reincluido_por_nome text;

alter table public.destinos add column if not exists recebido_em timestamptz;

create table if not exists public.participacao_eventos (
  id               bigint generated always as identity primary key,
  operacao_id      uuid not null references public.operacoes(id) on delete cascade,
  participante_id  uuid not null references public.participantes(id) on delete cascade,
  evento           text not null check (evento in ('removido', 'liberado', 'reincluido')),
  por              uuid references auth.users(id) on delete set null,
  por_nome         text,
  em               timestamptz not null default now()
);
create index if not exists participacao_eventos_part_idx on public.participacao_eventos (participante_id, em);

alter table public.participacao_eventos enable row level security;
drop policy if exists participacao_eventos_ler on public.participacao_eventos;
create policy participacao_eventos_ler on public.participacao_eventos
  for select to authenticated using (public.dono_operacao(operacao_id));
revoke all on public.participacao_eventos from anon;
revoke insert, update, delete, truncate on public.participacao_eventos from authenticated;
grant select on public.participacao_eventos to authenticated;

-- O participante lê SOMENTE o próprio destino (para o tempo real e para a recuperação).
drop policy if exists destinos_ler_participante on public.destinos;
create policy destinos_ler_participante on public.destinos
  for select to authenticated using (public.eh_meu_participante(participante_id));

-- Remover: desvincula sem apagar. Encerra o destino ativo dele.
create or replace function public.remover_participante(p_participante uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_nome text := coalesce(public.nome_responsavel_atual(), 'responsável');
begin
  select * into v_part from public.participantes where id = p_participante and tipo <> 'responsavel';
  if not found or not public.dono_operacao(v_part.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  if v_part.removido then
    return;   -- já removido: nada a fazer
  end if;
  update public.participantes
     set removido = true, rastreando = false, removido_em = now(), removido_por_nome = v_nome
   where id = p_participante;
  update public.destinos set encerrado_em = now(), encerrado_por = 'participante removido'
   where participante_id = p_participante and encerrado_em is null;
  insert into public.participacao_eventos (operacao_id, participante_id, evento, por, por_nome)
  values (v_part.operacao_id, v_part.id, 'removido', auth.uid(), v_nome);
end;
$$;

-- Liberar a saída: igual à remoção, mas registra que foi a pedido do participante.
create or replace function public.liberar_participante(p_participante uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_nome text := coalesce(public.nome_responsavel_atual(), 'responsável');
begin
  select * into v_part from public.participantes where id = p_participante and tipo <> 'responsavel';
  if not found or not public.dono_operacao(v_part.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  if v_part.liberado_em is not null then
    return;
  end if;
  update public.participantes
     set liberado_em = now(), removido = true, rastreando = false,
         removido_em = coalesce(removido_em, now()), removido_por_nome = v_nome
   where id = p_participante;
  update public.destinos set encerrado_em = now(), encerrado_por = 'saída liberada'
   where participante_id = p_participante and encerrado_em is null;
  insert into public.participacao_eventos (operacao_id, participante_id, evento, por, por_nome)
  values (v_part.operacao_id, v_part.id, 'liberado', auth.uid(), v_nome);
end;
$$;

-- Reincluir: só responsável da operação, operação ativa. Reativa o mesmo registro.
create or replace function public.reincluir_participante(p_participante uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_part public.participantes%rowtype;
  v_status text;
  v_nome text := public.nome_responsavel_atual();
begin
  select * into v_part from public.participantes where id = p_participante and tipo <> 'responsavel';
  if not found or v_nome is null or not public.dono_operacao(v_part.operacao_id) then
    raise exception 'sem_permissao';
  end if;
  select status into v_status from public.operacoes where id = v_part.operacao_id;
  if v_status <> 'ativa' then
    raise exception 'operacao_encerrada';
  end if;
  if not v_part.removido then
    raise exception 'participante_ativo';
  end if;
  update public.participantes
     set removido = false, liberado_em = null, rastreando = false,
         saida_solicitada_em = null, saida_motivo = null,
         reincluido_em = now(), reincluido_por_nome = v_nome
   where id = p_participante
  returning * into v_part;
  insert into public.participacao_eventos (operacao_id, participante_id, evento, por, por_nome)
  values (v_part.operacao_id, v_part.id, 'reincluido', auth.uid(), v_nome);
  return row_to_json(v_part);
end;
$$;

-- O celular confirma que recebeu (e mostrou) o destino. Só o próprio participante.
create or replace function public.confirmar_destino(p_destino uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v public.destinos%rowtype;
begin
  update public.destinos d
     set recebido_em = coalesce(d.recebido_em, now())
    from public.participantes p
   where d.id = p_destino
     and d.participante_id = p.id
     and p.user_id = auth.uid()
     and not p.removido
  returning d.* into v;
  if not found then
    raise exception 'sem_permissao';
  end if;
  return json_build_object('id', v.id, 'recebido_em', v.recebido_em, 'encerrado_em', v.encerrado_em);
end;
$$;

-- Destino ativo do próprio participante (recuperação depois de recarregar ou
-- reconectar; não depende do mapa). Mesmas verificações de mapa_do_participante.
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
                             'criado_em', d.criado_em, 'recebido_em', d.recebido_em)
      from public.destinos d
     where d.participante_id = v_part.id and d.encerrado_em is null
     order by d.criado_em desc limit 1);
end;
$$;

revoke execute on function public.reincluir_participante(uuid), public.confirmar_destino(uuid), public.meu_destino(uuid)
  from public, anon;
grant execute on function public.reincluir_participante(uuid), public.confirmar_destino(uuid), public.meu_destino(uuid)
  to authenticated;
-- remover_participante e liberar_participante mantêm as permissões que já tinham
-- (create or replace não altera os GRANTs); reforçado aqui por segurança:
revoke execute on function public.remover_participante(uuid), public.liberar_participante(uuid) from public, anon;
grant execute on function public.remover_participante(uuid), public.liberar_participante(uuid) to authenticated;

-- Tempo real: destinos já estão publicados (migração 003). Garante de novo.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      execute 'alter publication supabase_realtime add table public.destinos';
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;

-- Faz o PostgREST reconhecer as funções novas imediatamente.
notify pgrst, 'reload schema';
