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
