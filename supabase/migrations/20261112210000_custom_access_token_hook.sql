-- F1-DB-02 (ADR-026; ADR-004 D5; T9, T48 e SR-21). Custom Access Token Hook do Supabase Auth: o GoTrue chama esta
-- função dentro da transação de TODA emissão de token (troca, login e renovação), e ela recusa a sessão com mais de
-- 24 h. A idade máxima passa a valer também para a sessão criada fora do BFF. Idempotente: rodar de novo deixa o
-- mesmo estado. Nenhuma tabela muda. Aplicar no projeto real e ligar o hook no painel é o HITL-040, nunca
-- `supabase db push` pela equipe; a migration sozinha não liga nada.

-- Schema próprio, fora do `public` e fora de `[api] schemas`: o PostgREST não o serve a papel nenhum.
create schema if not exists trampo_hooks;

-- security invoker: quem chama é o supabase_auth_admin, que já é dono de auth.sessions (nenhum privilégio emprestado).
-- search_path vazio e nomes qualificados; stable, porque a função só lê (o Postgres recusa escrita em função stable).
create or replace function trampo_hooks.custom_access_token(event jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  -- A mesma idade máxima do AUTH_SESSION_MAX_AGE_SECONDS da API (padrão 86.400 s); o test:db prende os dois números.
  -- make_interval(secs) guarda só segundos: não depende do fuso nem do horário de verão.
  v_max_age constant interval := make_interval(secs => 86400);
  v_claims jsonb := event -> 'claims';
  v_session_id text := v_claims ->> 'session_id';
  v_created_at timestamptz;
begin
  -- Evento fora da forma que o GoTrue monta: não é um "não" a esta sessão, é desvio de formato. Falha fechada com
  -- 500: ninguém recebe token, e a API responde 503 (mantém a sessão do cliente), sem laço de relogin (T30). Evento
  -- nulo, sem claims ou com claims que não é objeto cai aqui também: o `->>` só acha a chave num objeto. A forma do
  -- session_id é conferida antes do cast, porque esta função nunca lança por dado de entrada.
  if v_session_id is null
    or v_session_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then
    return jsonb_build_object(
      'error', jsonb_build_object('http_code', 500, 'message', 'evento do hook fora do formato esperado')
    );
  end if;

  select s.created_at into v_created_at
  from auth.sessions as s
  where s.id = v_session_id::uuid;

  -- Sessão que não existe, sem data, ou com mais de 86.400 s: recusa. Sempre pelo objeto `error` com 403 e mensagem
  -- fixa e não vazia (sem ela o GoTrue não vê erro), nunca por `raise exception`: o corpo de erro do Postgres não tem
  -- `error_code`, e a API leria indisponibilidade (503 sem fim) em vez de recusa (401).
  if v_created_at is null or v_created_at < now() - v_max_age then
    return jsonb_build_object(
      'error', jsonb_build_object('http_code', 403, 'message', 'sessao acima da idade maxima')
    );
  end if;

  -- O GoTrue (v2.197.0) só liga o `jwt.MarshalSingleStringAsArray = false` dentro do SignJWT, e o evento deste hook é
  -- montado antes: no 1º token depois de cada partida do processo, o `aud` chega como lista de uma string só. Ela volta
  -- como a string, que é o que o GoTrue emite sem o hook e o que o verificador da API exige (ADR-013 D4; emenda do
  -- ADR-026 D2). Lista vazia, com mais de um item ou com item que não é string volta como veio. Os `if` aninhados
  -- garantem a ordem: o `jsonb_array_length` só roda numa lista, e a função nunca lança por dado de entrada.
  if jsonb_typeof(v_claims -> 'aud') = 'array' then
    if jsonb_array_length(v_claims -> 'aud') = 1 and jsonb_typeof(v_claims -> 'aud' -> 0) = 'string' then
      v_claims := jsonb_set(v_claims, '{aud}', v_claims -> 'aud' -> 0);
    end if;
  end if;

  -- Fora isso, as claims voltam como vieram: o hook não acrescenta nem tira claim.
  return jsonb_build_object('claims', v_claims);
end;
$$;

-- Grants mínimos (ADR-026 D5). Toda função nasce com execute para PUBLIC: o revoke vem antes do grant. Nenhum grant
-- em auth.sessions (o supabase_auth_admin é o dono) e nenhuma policy.
revoke all on schema trampo_hooks from public, anon, authenticated, service_role;
revoke all on function trampo_hooks.custom_access_token(jsonb) from public, anon, authenticated, service_role;
grant usage on schema trampo_hooks to supabase_auth_admin;
grant execute on function trampo_hooks.custom_access_token(jsonb) to supabase_auth_admin;
