-- F1-API-06 (ADR-031 D2 e D3; T55). A gravação das análises: o banco força o relógio das duas tabelas e o teto por
-- usuário, e a retenção de 90 dias roda por uma função agendada no pg_cron. O dono grava direto no PostgREST com o
-- próprio JWT (a publishable é pública), então as regras moram aqui, não na API.
-- Idempotente: cada gatilho é removido antes de criado, as funções são `create or replace` e o job tem nome fixo,
-- então reaplicar o arquivo inteiro restaura o original. Aplicar no projeto real é HITL, nunca `supabase db push`.

-- D2: o índice do teto (e da exportação, do mais novo para o mais velho) e o da retenção.
create index if not exists analyses_user_id_created_at_idx on public.analyses (user_id, created_at);
create index if not exists analyses_created_at_idx on public.analyses (created_at);

-- D2: o relógio é do banco (um created_at mandado pelo cliente tiraria a linha da retenção) e o teto é de 100 linhas
-- por usuário em 24 horas corridas, o dobro da cota diária da API. O advisory lock por usuário serializa as gravações
-- dele, então o teto é exato também sob concorrência. Invoker: a contagem vê só o que a RLS mostra a quem grava, e a
-- policy de insert exige o mesmo user_id. O PT429 vira HTTP 429 no PostgREST.
create or replace function public.analyses_before_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_cap constant integer := 100;
  v_count integer;
begin
  new.created_at := now();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('trampo.analyses:' || new.user_id::text, 0));
  select count(*) into v_count
    from public.analyses as a
    where a.user_id = new.user_id and a.created_at > now() - interval '24 hours';
  if v_count >= v_cap then
    raise exception using errcode = 'PT429', message = 'analises_limite_diario';
  end if;
  return new;
end
$$;

drop trigger if exists analyses_before_insert on public.analyses;
create trigger analyses_before_insert
  before insert on public.analyses
  for each row execute function public.analyses_before_insert();

-- D2: o updated_at do feedback também é do banco, na inserção e na atualização.
create or replace function public.analysis_feedback_touch()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists analysis_feedback_touch on public.analysis_feedback;
create trigger analysis_feedback_touch
  before insert or update on public.analysis_feedback
  for each row execute function public.analysis_feedback_touch();

-- D3: a retenção. Apaga as análises com mais de 90 dias (estritamente), das mais velhas para as mais novas, no máximo
-- p_limit por execução, e devolve quantas apagou; o feedback vai junto pela FK composta. Invoker: quem roda é o job do
-- pg_cron, como postgres (que tem BYPASSRLS). Nenhuma chave de alto privilégio na API.
create or replace function public.purge_expired_analyses(p_limit integer default 5000)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_retention constant interval := make_interval(days => 90);
  v_count integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 50000 then
    raise exception using errcode = '22023', message = 'limite_fora_da_faixa';
  end if;
  delete from public.analyses as a
    where a.id in (
      select e.id
        from public.analyses as e
        where e.created_at < now() - v_retention
        order by e.created_at
        limit p_limit
        for update skip locked
    );
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- Nenhum papel do PostgREST executa as três funções (os gatilhos rodam sem o EXECUTE de quem grava).
revoke all on function public.analyses_before_insert() from public, anon, authenticated, service_role;
revoke all on function public.analysis_feedback_touch() from public, anon, authenticated, service_role;
revoke all on function public.purge_expired_analyses(integer) from public, anon, authenticated, service_role;

-- D3: o agendamento, de hora em hora, com o limite de 5.000 por execução. O cron.schedule com nome substitui o job
-- de mesmo nome: reaplicar não duplica.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('trampo-retencao-analises', '17 * * * *', 'select public.purge_expired_analyses(5000)');
