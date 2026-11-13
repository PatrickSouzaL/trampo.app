// Consultas de catálogo do test:db (ADR-018 D3) e o que cada uma deve devolver. Cada consulta devolve UMA linha
// com um array JSON, para o psql em modo `--tuples-only --no-align` entregar algo que o JSON.parse lê inteiro.
// Ficam aqui, separadas da suíte, para a simulação local da migration rodar exatamente o mesmo SQL.

/** As tabelas do D2. Toda tabela do `public`, inclusive uma futura, precisa de RLS ligada e forçada. */
export const PUBLIC_TABLES = Object.freeze(["analyses", "analysis_feedback", "user_criteria"]);

/** RLS de toda relação comum ou particionada do `public`. */
export const RLS_CATALOG_SQL = `
select coalesce(json_agg(json_build_object(
  'table', c.relname, 'rls', c.relrowsecurity, 'force', c.relforcerowsecurity
) order by c.relname), '[]')
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p');
`;

/**
 * Todo privilégio que anon, authenticated e service_role têm em tabela do `public`, inclusive o herdado de PUBLIC
 * e o concedido só numa coluna (`has_any_column_privilege`): um grant de coluna a anon também derruba o teste.
 */
export const PRIVILEGES_SQL = `
select coalesce(json_agg(json_build_object(
  'role', r.role, 'table', c.relname, 'privilege', p.privilege
) order by r.role, c.relname, p.privilege), '[]')
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join (values ('anon'), ('authenticated'), ('service_role')) as r (role)
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'))
  as p (privilege)
where n.nspname = 'public' and c.relkind in ('r', 'p')
  and case
    when p.privilege in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
      then has_any_column_privilege(r.role, c.oid, p.privilege)
    else has_table_privilege(r.role, c.oid, p.privilege)
  end;
`;

/** O D3: só authenticated, só o necessário. Em ordem de papel, tabela e privilégio, como o `PRIVILEGES_SQL`. */
export const EXPECTED_PRIVILEGES = Object.freeze([
  { role: "authenticated", table: "analyses", privilege: "INSERT" },
  { role: "authenticated", table: "analyses", privilege: "SELECT" },
  { role: "authenticated", table: "analysis_feedback", privilege: "INSERT" },
  { role: "authenticated", table: "analysis_feedback", privilege: "SELECT" },
  { role: "authenticated", table: "analysis_feedback", privilege: "UPDATE" },
  { role: "authenticated", table: "user_criteria", privilege: "INSERT" },
  { role: "authenticated", table: "user_criteria", privilege: "SELECT" },
  { role: "authenticated", table: "user_criteria", privilege: "UPDATE" },
]);

/** Toda policy do `public`, com o texto do `using` e do `with check` como o Postgres o guarda. */
export const POLICIES_SQL = `
select coalesce(json_agg(json_build_object(
  'table', tablename, 'name', policyname, 'cmd', cmd, 'roles', roles, 'permissive', permissive,
  'using', qual, 'check', with_check
) order by tablename, policyname), '[]')
from pg_policies
where schemaname = 'public';
`;

const OWNER = "( SELECT auth.uid() AS uid) = user_id";

/** Uma policy por comando, só para authenticated, sempre pelo dono (`(select auth.uid()) = user_id`). */
export const EXPECTED_POLICIES = Object.freeze([
  { table: "analyses", name: "analyses_insert", cmd: "INSERT", roles: ["authenticated"], permissive: "PERMISSIVE", using: null, check: `(${OWNER})` },
  { table: "analyses", name: "analyses_select", cmd: "SELECT", roles: ["authenticated"], permissive: "PERMISSIVE", using: `(${OWNER})`, check: null },
  { table: "analysis_feedback", name: "analysis_feedback_insert", cmd: "INSERT", roles: ["authenticated"], permissive: "PERMISSIVE", using: null, check: `(${OWNER})` },
  { table: "analysis_feedback", name: "analysis_feedback_select", cmd: "SELECT", roles: ["authenticated"], permissive: "PERMISSIVE", using: `(${OWNER})`, check: null },
  { table: "analysis_feedback", name: "analysis_feedback_update", cmd: "UPDATE", roles: ["authenticated"], permissive: "PERMISSIVE", using: `(${OWNER})`, check: `(${OWNER})` },
  { table: "user_criteria", name: "user_criteria_insert", cmd: "INSERT", roles: ["authenticated"], permissive: "PERMISSIVE", using: null, check: `(${OWNER})` },
  { table: "user_criteria", name: "user_criteria_select", cmd: "SELECT", roles: ["authenticated"], permissive: "PERMISSIVE", using: `(${OWNER})`, check: null },
  { table: "user_criteria", name: "user_criteria_update", cmd: "UPDATE", roles: ["authenticated"], permissive: "PERMISSIVE", using: `(${OWNER})`, check: `(${OWNER})` },
]);

/** Quantas linhas do usuário `:'uid'` sobram em cada tabela (a prova do cascade). */
export const ROWS_OF_USER_SQL = `
select json_build_array(json_build_object(
  'user_criteria', (select count(*) from public.user_criteria where user_id = :'uid'),
  'analyses', (select count(*) from public.analyses where user_id = :'uid'),
  'analysis_feedback', (select count(*) from public.analysis_feedback where user_id = :'uid')
));
`;

/**
 * Tamanho da coluna `criteria` do usuário `:'uid'`: `stored` como o TOAST a guardou (comprimida ou não) e `plain`
 * sem compressão, que é o que o check de 16 KiB mede (o check roda na linha nova, antes do TOAST).
 */
export const CRITERIA_SIZE_SQL = `
select json_build_object(
  'stored', pg_column_size(criteria),
  'plain', pg_column_size(criteria::text::jsonb)
)
from public.user_criteria
where user_id = :'uid';
`;

/** Exclusão da conta no Auth, como a API de admin fará no F1-PORTAL-03 (a prova completa do SR-16 é de lá). */
export const DELETE_AUTH_USER_SQL = `delete from auth.users where id = :'uid';`;

// F1-DB-02 (ADR-026): o Custom Access Token Hook. O schema fica fora do PostgREST, e a função só serve ao GoTrue.

export const HOOK_SCHEMA = "trampo_hooks";
export const HOOK_FUNCTION = "custom_access_token";

/** Toda função do schema do hook, com o que o D1 fixa: invoker, stable, search_path vazio, plpgsql e `(jsonb) → jsonb`. */
export const HOOK_FUNCTIONS_SQL = `
select coalesce(json_agg(json_build_object(
  'name', p.proname, 'args', pg_get_function_identity_arguments(p.oid), 'returns', pg_get_function_result(p.oid),
  'language', l.lanname, 'definer', p.prosecdef, 'volatility', p.provolatile, 'config', p.proconfig
) order by p.proname), '[]')
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_language l on l.oid = p.prolang
where n.nspname = 'trampo_hooks';
`;

export const EXPECTED_HOOK_FUNCTIONS = Object.freeze([
  {
    name: HOOK_FUNCTION,
    args: "event jsonb",
    returns: "jsonb",
    language: "plpgsql",
    definer: false,
    volatility: "s",
    config: ['search_path=""'],
  },
]);

/** Quantas relações (tabela, visão, sequência) o schema do hook tem: nenhuma. */
export const HOOK_RELATIONS_SQL = `
select json_build_object('relacoes', count(*))
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'trampo_hooks';
`;

/**
 * A ACL do schema e a da função, sem as entradas do dono. `PUBLIC` aparece como grantee 0. Sem ACL gravada, vale o
 * padrão do Postgres (`acldefault`), que na função inclui o `execute` de `PUBLIC`: é o que o `revoke` tira.
 */
export const HOOK_ACL_SQL = `
select json_build_object(
  'schema', (
    select coalesce(json_agg(json_build_object(
      'grantee', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end, 'privilege', a.privilege_type
    ) order by a.grantee, a.privilege_type), '[]')
    from pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
    where n.nspname = 'trampo_hooks' and a.grantee <> n.nspowner
  ),
  'function', (
    select coalesce(json_agg(json_build_object(
      'grantee', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end, 'privilege', a.privilege_type
    ) order by a.grantee, a.privilege_type), '[]')
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where n.nspname = 'trampo_hooks' and a.grantee <> p.proowner
  )
);
`;

/** O D5: só o `supabase_auth_admin`, com `usage` no schema e `execute` na função. */
export const EXPECTED_HOOK_ACL = Object.freeze({
  schema: [{ grantee: "supabase_auth_admin", privilege: "USAGE" }],
  function: [{ grantee: "supabase_auth_admin", privilege: "EXECUTE" }],
});

/** O privilégio efetivo (com herança e `PUBLIC`) de cada papel no schema e na função do hook. */
export const HOOK_PRIVILEGES_SQL = `
select coalesce(json_agg(json_build_object(
  'role', r.role,
  'usage', has_schema_privilege(r.role, 'trampo_hooks', 'USAGE'),
  'execute', has_function_privilege(r.role, 'trampo_hooks.custom_access_token(jsonb)', 'EXECUTE')
) order by r.role), '[]')
from (values ('anon'), ('authenticated'), ('service_role'), ('supabase_auth_admin')) as r (role);
`;

export const EXPECTED_HOOK_PRIVILEGES = Object.freeze([
  { role: "anon", usage: false, execute: false },
  { role: "authenticated", usage: false, execute: false },
  { role: "service_role", usage: false, execute: false },
  { role: "supabase_auth_admin", usage: true, execute: true },
]);

/** Dono da função, dono de `auth.sessions`, a leitura do `supabase_auth_admin` nela e a RLS (ligada, sem forçar). */
export const HOOK_OWNERSHIP_SQL = `
select json_build_object(
  'functionOwner', (
    select pg_get_userbyid(p.proowner) from pg_proc p
    where p.oid = 'trampo_hooks.custom_access_token(jsonb)'::regprocedure
  ),
  'sessionsOwner', (select tableowner from pg_tables where schemaname = 'auth' and tablename = 'sessions'),
  'sessionsSelect', has_table_privilege('supabase_auth_admin', 'auth.sessions', 'SELECT'),
  'sessionsRls', (select c.relrowsecurity from pg_class c where c.oid = 'auth.sessions'::regclass),
  'sessionsForcedRls', (select c.relforcerowsecurity from pg_class c where c.oid = 'auth.sessions'::regclass)
);
`;

/** O texto da função como o Postgres o guarda e o md5 dele (a restauração do teste de falha fechada confere o md5). */
export const HOOK_DEFINITION_SQL = `
select json_build_object(
  'definition', pg_get_functiondef('trampo_hooks.custom_access_token(jsonb)'::regprocedure),
  'md5', md5(pg_get_functiondef('trampo_hooks.custom_access_token(jsonb)'::regprocedure))
);
`;

/** A função chamada direto com o evento `:'event'` (texto JSON). */
export const HOOK_CALL_SQL = `
select json_build_object('saida', trampo_hooks.custom_access_token(:'event'::jsonb));
`;

/** A função chamada com o evento nulo do SQL. */
export const HOOK_CALL_NULL_SQL = `
select json_build_object('saida', trampo_hooks.custom_access_token(null::jsonb));
`;

/**
 * A função chamada com a sessão `:'sid'` com exatamente `:'age'` segundos, numa transação só: o `now()` não anda
 * entre o `update` e a chamada, então o limite é exato. O `rollback` devolve a data da sessão.
 */
export const HOOK_CALL_AT_AGE_SQL = `
begin;
update auth.sessions set created_at = now() - make_interval(secs => :'age'::double precision) where id = :'sid'::uuid;
select json_build_object('saida', trampo_hooks.custom_access_token(:'event'::jsonb));
rollback;
`;

/** A função chamada com a sessão `:'sid'` sem data (a coluna aceita nulo). */
export const HOOK_CALL_WITHOUT_DATE_SQL = `
begin;
update auth.sessions set created_at = null where id = :'sid'::uuid;
select json_build_object('saida', trampo_hooks.custom_access_token(:'event'::jsonb));
rollback;
`;

/** Envelhece de verdade (com `commit`) a sessão `:'sid'`: `created_at` passa a ser `:'age'` segundos atrás. */
export const AGE_SESSION_SQL = `
with aged as (
  update auth.sessions set created_at = now() - make_interval(secs => :'age'::double precision)
  where id = :'sid'::uuid
  returning id
)
select json_build_object('linhas', count(*)) from aged;
`;

/**
 * Uma instrução rodada com `set local role :"papel"`, devolvendo o SQLSTATE do último erro (`00000` sem erro) e o
 * papel que a transação viu. O script desliga o ON_ERROR_STOP: se o `set local role` falhar, o `visto` não existe, o
 * `select` final quebra e nada é impresso (o JSON.parse do teste falha, em vez de aceitar um 42501 do lugar errado).
 */
export function sqlStateAsRoleSql(statement: string): string {
  return `
\\set ON_ERROR_STOP off
begin;
set local role :"papel";
select current_user as visto \\gset
${statement}
rollback;
select json_build_object('sqlstate', :'LAST_ERROR_SQLSTATE', 'papel', :'visto');
`;
}

/**
 * A função trocada por uma que lança (falha fechada, ADR-026 condição 3), com o SQLSTATE `:'estado'`. Mesma
 * assinatura e mesmos atributos: o `create or replace` mantém o dono e os grants.
 */
export const BREAK_HOOK_SQL = `
select format(
  'create or replace function trampo_hooks.custom_access_token(event jsonb) returns jsonb language plpgsql stable '
  'security invoker set search_path = '''' as $f$ begin raise exception ''falha simulada do hook'' using errcode = %L; end; $f$',
  :'estado'
) as troca \\gset
:troca;
select json_build_object('trocada', true);
`;
