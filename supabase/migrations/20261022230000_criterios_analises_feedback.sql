-- F1-DB-01 parte 3 (ADR-018 D2 e D3; SR-15). Tabelas, checks, RLS forçada e privilégios mínimos na MESMA
-- migration (uma transação): nenhuma tabela existe, nem por um instante, sem RLS ou com o grant padrão que o
-- Supabase dá a anon e authenticated em tabela nova do public. Só forward: corrigir isto depois de aplicado é
-- escrever outra migration. Aplicar no projeto real é o HITL-023, nunca `supabase db push` pela equipe.

-- A1: perfil e critérios, uma linha por usuário. A pretensão salarial mora só no cifrado (AES-256-GCM no app,
-- ADR-018 D4), e é cifrada sempre, inclusive o null, para a coluna não revelar quem informou pretensão.
create table public.user_criteria (
  user_id uuid primary key references auth.users (id) on delete cascade,
  schema_version smallint not null
    constraint user_criteria_schema_version check (schema_version = 1),
  criteria jsonb not null
    constraint user_criteria_criteria_objeto check (jsonb_typeof(criteria) = 'object')
    -- A pretensão nunca fica em claro, nem por engano; a versão mora só em schema_version (o adapter recusa as
    -- duas chaves na leitura, ADR-018 §3.2).
    constraint user_criteria_sem_salary check (not (criteria ? 'salary'))
    constraint user_criteria_sem_schema_version check (not (criteria ? 'schemaVersion'))
    constraint user_criteria_criteria_tamanho check (pg_column_size(criteria) <= 16384),
  -- Envelope s1.<kid>.<iv>.<cifrado>.<tag> em base64url, o mesmo padrão do SalaryCipher. O Postgres limita a
  -- repetição a 255, então o cifrado de 1 a 342 caracteres vira {1,255} seguido de {0,87}.
  salary_ciphertext text not null
    constraint user_criteria_salary_envelope check (
      char_length(salary_ciphertext) <= 1024
      and salary_ciphertext ~ '^s1\.[a-z0-9]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{1,255}[A-Za-z0-9_-]{0,87}\.[A-Za-z0-9_-]{22}$'
    ),
  updated_at timestamptz not null default now()
);

-- A9: o registro mínimo para o feedback (T38). Sem texto, título, empresa nem textHash da vaga: o histórico de
-- vagas que alguém olha é dado comportamental. Retenção de 90 dias entra com o F1-API-06; até lá, fica vazia.
create table public.analyses (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  decision_path text not null
    constraint analyses_decision_path check (
      decision_path in ('triagem_deterministica', 'cache_jobfacts', 'extracao_llm', 'fallback_deterministico')
    ),
  verdict text not null
    constraint analyses_verdict check (
      verdict in ('altamente_recomendado', 'recomendado', 'neutro', 'baixo_alinhamento', 'foge')
    ),
  score smallint not null
    constraint analyses_score check (score between 0 and 100),
  -- Alvo da FK composta do feedback.
  constraint analyses_id_user_id unique (id, user_id)
);

create index analyses_user_id_idx on public.analyses (user_id);

-- A9: um feedback por análise, atualizável (T38 item 2). A FK composta impõe no próprio banco que o feedback e a
-- análise têm o MESMO dono; a policy não precisa de subconsulta.
create table public.analysis_feedback (
  analysis_id uuid primary key,
  user_id uuid not null,
  agreement text not null
    constraint analysis_feedback_agreement check (agreement in ('concordo', 'discordo')),
  -- Nulo é permitido (o contrato aceita reason null), e o check só olha valor presente.
  reason text
    constraint analysis_feedback_reason check (
      reason in ('nota_alta_demais', 'nota_baixa_demais', 'fato_extraido_errado', 'veredito_errado', 'outro')
    ),
  updated_at timestamptz not null default now(),
  constraint analysis_feedback_mesmo_dono foreign key (analysis_id, user_id)
    references public.analyses (id, user_id) on delete cascade
);

-- D3: RLS ligada e FORÇADA (vale até para o dono da tabela) em todas as tabelas.
alter table public.user_criteria enable row level security;
alter table public.user_criteria force row level security;
alter table public.analyses enable row level security;
alter table public.analyses force row level security;
alter table public.analysis_feedback enable row level security;
alter table public.analysis_feedback force row level security;

-- D3: revoke explícito ANTES dos grants. O service_role também sai (refinamento do [APPSEC]): ele tem BYPASSRLS,
-- e a chave secret só serve à exclusão de conta pela API de admin do Auth (ADR-018 D5), que apaga por cascade
-- sem privilégio nestas tabelas. Uma secret vazada não lê critério nem cifrado pelo PostgREST.
revoke all on table public.user_criteria, public.analyses, public.analysis_feedback
  from public, anon, authenticated, service_role;

-- Só o necessário a authenticated. Delete só por cascade na exclusão de conta; anon não recebe nada.
grant select, insert, update on table public.user_criteria to authenticated;
grant select, insert on table public.analyses to authenticated;
grant select, insert, update on table public.analysis_feedback to authenticated;

-- Uma policy por comando, só para authenticated. O (select auth.uid()) avalia uma vez por consulta.
create policy user_criteria_select on public.user_criteria
  for select to authenticated
  using ((select auth.uid()) = user_id);
create policy user_criteria_insert on public.user_criteria
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy user_criteria_update on public.user_criteria
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy analyses_select on public.analyses
  for select to authenticated
  using ((select auth.uid()) = user_id);
create policy analyses_insert on public.analyses
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy analysis_feedback_select on public.analysis_feedback
  for select to authenticated
  using ((select auth.uid()) = user_id);
create policy analysis_feedback_insert on public.analysis_feedback
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy analysis_feedback_update on public.analysis_feedback
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
