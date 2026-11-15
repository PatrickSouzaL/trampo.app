-- F1-PORTAL-03 (ADR-029 D1, D2 e D6; SR-16). Exclusão da própria conta sem service_role nem chave secret: a API chama
-- esta função por RPC do PostgREST com o JWT do usuário, e ela apaga a conta de quem chama, e só ela. Idempotente:
-- rodar de novo deixa o mesmo estado. Nenhuma tabela muda. Aplicar no projeto real é HITL, nunca `supabase db push`
-- pela equipe.

-- security definer: o dono (postgres) tem DELETE em auth.users, auth.flow_state e auth.audit_log_entries, e o papel
-- authenticated não tem privilégio nenhum nelas. search_path vazio e nomes qualificados. Sem parâmetro: o alvo é
-- sempre o `sub` do JWT que o PostgREST já verificou, e nada do pedido escolhe outra conta.
create or replace function public.delete_own_account()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  -- O mesmo número do ACCOUNT_RECENT_LOGIN_SECONDS do contrato; o test:db prende os dois.
  -- O intervalo montado por segundos guarda só segundos: não depende do fuso nem do horário de verão.
  v_recent_login constant interval := make_interval(secs => 600);
  v_uid uuid := (select auth.uid());
  v_session_id text := (select auth.jwt()) ->> 'session_id';
  v_created_at timestamptz;
begin
  -- Sem usuário no JWT não há conta a apagar. Não deveria acontecer: anon não tem execute.
  if v_uid is null then
    raise exception 'pedido sem usuario autenticado' using errcode = '28000';
  end if;

  -- Idempotência: o access do usuário apagado ainda vale por até 900 s, e repetir o pedido não é erro.
  if not exists (select 1 from auth.users as u where u.id = v_uid) then
    return 'ja_excluida';
  end if;

  -- Login recente (ADR-029 D6): a sessão DESTE token e DESTE usuário precisa ter nascido há no máximo 600 s. A data
  -- da sessão só nasce num login de verdade; o access renovado não a muda. Conferido aqui porque esta função é
  -- alcançável direto pelo PostgREST, com a chave publishable, que é pública. A forma do session_id é conferida
  -- antes do cast: a função nunca lança por dado de entrada.
  if v_session_id is null
    or v_session_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then
    return 'login_antigo';
  end if;

  select s.created_at into v_created_at
  from auth.sessions as s
  where s.id = v_session_id::uuid and s.user_id = v_uid;

  if v_created_at is null or v_created_at < now() - v_recent_login then
    return 'login_antigo';
  end if;

  -- Os dois lugares do auth que não têm FK para auth.users e ficariam para trás: o fluxo PKCE (com os tokens do
  -- provedor) e a trilha de auditoria (com o e-mail no payload).
  delete from auth.flow_state as f where f.user_id = v_uid;
  delete from auth.audit_log_entries as a where a.payload ->> 'actor_id' = v_uid::text;

  -- O cascade leva o resto: identidades, sessões, refresh tokens, MFA e as três tabelas do public.
  delete from auth.users as u where u.id = v_uid;

  return 'excluida';
end;
$$;

-- Toda função nasce com execute para PUBLIC: o revoke vem antes do grant. Só authenticated executa.
revoke all on function public.delete_own_account() from public, anon, authenticated, service_role;
grant execute on function public.delete_own_account() to authenticated;
