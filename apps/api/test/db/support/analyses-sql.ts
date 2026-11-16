// F1-API-06 (ADR-031 D2 e D3): o catálogo e as consultas da gravação das análises, do teto por usuário e da retenção.
// Tudo roda como `postgres` pelo psql da pilha local; as variáveis entram como `:'nome'`.

export const ANALYSES_FUNCTIONS = Object.freeze(["analyses_before_insert", "analysis_feedback_touch", "purge_expired_analyses"]);
export const RETENTION_JOB = "trampo-retencao-analises";

/** As três funções em `public`, com o que o D2 e o D3 fixam: invoker, volatile, search_path vazio, plpgsql, dono postgres. */
export const ANALYSES_FUNCTIONS_SQL = `
select coalesce(json_agg(json_build_object(
  'name', p.proname, 'args', pg_get_function_identity_arguments(p.oid), 'returns', pg_get_function_result(p.oid),
  'language', l.lanname, 'definer', p.prosecdef, 'volatility', p.provolatile, 'config', p.proconfig,
  'owner', pg_get_userbyid(p.proowner)
) order by p.proname), '[]')
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_language l on l.oid = p.prolang
where n.nspname = 'public' and p.proname in ('analyses_before_insert', 'analysis_feedback_touch', 'purge_expired_analyses');
`;

const INVOKER = { language: "plpgsql", definer: false, volatility: "v", config: ['search_path=""'], owner: "postgres" } as const;

export const EXPECTED_ANALYSES_FUNCTIONS = Object.freeze([
  { name: "analyses_before_insert", args: "", returns: "trigger", ...INVOKER },
  { name: "analysis_feedback_touch", args: "", returns: "trigger", ...INVOKER },
  { name: "purge_expired_analyses", args: "p_limit integer", returns: "integer", ...INVOKER },
]);

/** Os gatilhos das duas tabelas: um por evento, sempre `BEFORE` e por linha. */
export const ANALYSES_TRIGGERS_SQL = `
select coalesce(json_agg(json_build_object(
  'table', t.event_object_table, 'name', t.trigger_name, 'event', t.event_manipulation,
  'timing', t.action_timing, 'orientation', t.action_orientation, 'statement', t.action_statement
) order by t.event_object_table, t.trigger_name, t.event_manipulation), '[]')
from information_schema.triggers t
where t.event_object_schema = 'public' and t.event_object_table in ('analyses', 'analysis_feedback');
`;

/** Quem executa cada função (PUBLIC é o grantee 0; o dono fica de fora) e o privilégio efetivo de cada papel. */
export const ANALYSES_ACL_SQL = `
select json_build_object(
  'acl', (
    select coalesce(json_agg(json_build_object(
      'name', p.proname, 'grantee', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
    ) order by p.proname, a.grantee), '[]')
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace,
    aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where n.nspname = 'public'
      and p.proname in ('analyses_before_insert', 'analysis_feedback_touch', 'purge_expired_analyses')
      and a.grantee <> p.proowner
  ),
  'purge', (
    select json_object_agg(r.role, has_function_privilege(r.role, 'public.purge_expired_analyses(integer)', 'EXECUTE'))
    from (values ('anon'), ('authenticated'), ('service_role')) as r (role)
  )
);
`;

export const EXPECTED_ANALYSES_ACL = Object.freeze({
  acl: [],
  purge: { anon: false, authenticated: false, service_role: false },
});

/** O texto das duas funções com constantes, como o Postgres o guarda. */
export const ANALYSES_DEFINITIONS_SQL = `
select json_build_object(
  'cap', pg_get_functiondef('public.analyses_before_insert()'::regprocedure),
  'purge', pg_get_functiondef('public.purge_expired_analyses(integer)'::regprocedure)
);
`;

/** O job da retenção no pg_cron. */
export const RETENTION_JOB_SQL = `
select coalesce(json_agg(json_build_object(
  'schedule', j.schedule, 'command', j.command, 'active', j.active, 'username', j.username
)), '[]')
from cron.job j
where j.jobname = 'trampo-retencao-analises';
`;

/** Planta `:'n'` análises do usuário `:'uid'` como `postgres` (o gatilho roda em cada linha) e devolve quantas ele tem. */
export const PLANT_ANALYSES_SQL = `
insert into public.analyses (id, user_id, decision_path, verdict, score)
select gen_random_uuid(), :'uid'::uuid, 'extracao_llm', 'neutro', 50 from generate_series(1, :'n'::int);
select json_build_object('linhas', count(*)) from public.analyses where user_id = :'uid'::uuid;
`;

/** Envelhece (com `commit`) a análise `:'id'`: o `created_at` passa a ser `now() - :'idade'`. */
export const AGE_ANALYSIS_SQL = `
with aged as (
  update public.analyses set created_at = now() - :'idade'::interval where id = :'id'::uuid returning id
)
select json_build_object('linhas', count(*)) from aged;
`;

/** Envelhece (com `commit`) as `:'n'` análises mais novas do usuário `:'uid'`. */
export const AGE_NEWEST_SQL = `
with aged as (
  update public.analyses set created_at = now() - :'idade'::interval
  where id in (select id from public.analyses where user_id = :'uid'::uuid order by created_at desc limit :'n'::int)
  returning id
)
select json_build_object('linhas', count(*)) from aged;
`;

/** O relógio da linha: `true` se o `created_at` da análise e o `updated_at` do feedback ficaram no último minuto. */
export const ROW_CLOCK_SQL = `
select json_build_object(
  'analise', (select created_at > now() - interval '1 minute' and created_at <= now() from public.analyses where id = :'id'::uuid),
  'feedback', (select updated_at > now() - interval '1 minute' and updated_at <= now() from public.analysis_feedback where analysis_id = :'id'::uuid)
);
`;

/** A função de retenção chamada como `postgres` (o papel do job), com o limite `:'limite'`. */
export const PURGE_SQL = `select json_build_object('apagadas', public.purge_expired_analyses(:'limite'::int));`;

/** Quantas das análises `:'ids'` (separadas por vírgula) e dos feedbacks delas ainda existem. */
export const SURVIVORS_SQL = `
select json_build_object(
  'analises', (select count(*) from public.analyses where id = any(string_to_array(:'ids', ',')::uuid[])),
  'feedback', (select count(*) from public.analysis_feedback where analysis_id = any(string_to_array(:'ids', ',')::uuid[]))
);
`;

/** O feedback da análise `:'id'`, como o dono o vê. */
export const FEEDBACK_ROW_SQL = `
select coalesce((select json_build_object('user_id', user_id, 'agreement', agreement, 'reason', reason)
  from public.analysis_feedback where analysis_id = :'id'::uuid), 'null'::json);
`;

/** Apaga (como `postgres`) as análises `:'ids'`: a linha da borda não pode virar velha numa rodada seguinte. */
export const DELETE_ANALYSES_SQL = `
with gone as (delete from public.analyses where id = any(string_to_array(:'ids', ',')::uuid[]) returning id)
select json_build_object('linhas', count(*)) from gone;
`;
