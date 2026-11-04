# Próximo passo: a Trilha S3b (abrir o HITL-035), numa sessão nova

## O que acabou de ser entregue (2026-11-04)

### HITL-034 fechado: desenho da autenticação aprovado
- "HITL-034: aprovado com as recomendações": valem as 14 respostas recomendadas do ADR-004 §7 (BFF, 24 h, 4 h, logout `global`, limitador local, falha fechada etc.).
- O ADR-004 continua `proposto` até o HITL-035, o pré-spike manual (P4 a P8) e o spike (§6.2). Nenhum código de autenticação ainda.

### Trilha D2d: "ver mais" fechado no LinkedIn logado (ADR-023 D13)
- **Decisão:** opção (b). O *clamp* de linhas da própria descrição do `li2` não corta mais; o resto da regra de descarte (D4) continua valendo dentro dela, e o *clamp* em qualquer outro lugar continua cortando. Sem clicar no "ver mais" e sem mudar a página. A opção (a), aviso no painel, foi descartada, e o painel não mudou.
- **Resultado:** `linkedin-08` de 382 para 3.324 caracteres, com os 3 trechos recolhidos. Nas 3 páginas logadas, toda linha da descrição está no texto.
- **Clone com `innerText`: vetado pelo `[APPSEC]`.** No Edge, o `innerText` de um clone fora do documento ignora o CSS e trouxe o canário com `display:none`. Inserir o clone na página seria mutação do DOM.
- **DOM Clobbering:** um `<form>` que sombreia `scrollHeight` faz a conta dar `NaN`, e tudo vira `cortado` (o lado seguro, com teste). Nenhum nó novo, e o teto de 50.000 nós não muda.
- **Bancada E2E corrigida:** o CSS das fixtures com `href` relativo era abortado sob `/jobs/...`. Os E2E do LinkedIn logado, da Gupy e da Solides rodavam sem o CSS da plataforma.
- **Prova:** unidade 180/180 com 100%; `test:browser` 145/145 com a cobertura de bloco de 100%; E2E 38/38 no build de produção, e a prova negativa derruba o teste novo; mutação 13/13; depcruise e turbo 21/21 em série. Nenhuma chamada a provedor.
- **Intermitência do E2E:** 3 falhas `sem_acesso` em 12 rodadas, depois 14 rodadas seguidas sem falha. A causa não foi provada e está no BACKLOG como QA-04.

### Antes (ainda valendo)
- **Trilhas D2a a D2c:** fixtures reais e extratores `li1`, `li2`, `gu1` e `so1`.
- **Trilha W1:** `rpd` da Workers AI pelo p95 medido.
- **Trilha L1:** cadeia Groq → Workers AI → determinístico ligada no `main.ts`. Pendência do próximo prompt (`p4`): "`null` quando a vaga não declara experiência" em `yearsExperienceMin` (spike-metrics §2.11).
- **Trilhas F e G:** captura no Service Worker e UI do Side Panel, ainda sem enviar à API.

### Pendências do humano
- Nenhuma aberta agora. A S3b abre o HITL-035 (ação externa: par de chaves, anel da selagem e painel do Supabase). Nenhum segredo vai para o cofre.
- **Inconsistência do cofre a esclarecer no HITL-035:** os runbooks `supabase-setup`, `upstash-redis` e `regiao-custo-zero` não existem em `base/03-infra-runbook/`.
- O push continua não autorizado. Já são vários commits locais no `spike/s1-extraction`. Quando quiser, autorize o push e o PR.

---

## Como usar: trilhas

**Regra de ouro:** nenhuma trilha da tabela gasta cota de LLM. A API chama o Groq de verdade quando sobe, então quem subir a API localmente para testar à mão gasta cota real.

| Trilha | Sessão | Gasta cota? | Espera |
|---|---|---|---|
| **S3b** | Abrir o HITL-035 (par de chaves da extensão, anel de chaves da selagem, configuração do Auth no painel do Supabase) e escrever o runbook `base/03-infra-runbook/auth-extensao.md`, sem nenhum valor de segredo, mais o roteiro do pré-spike manual (P4 a P8). Sem código de produto | não | nada (termina num HITL) |
| **F1-AUTH-00 → F1-API-07 → F1-EXT-05a/b/c → F1-SEC-01** | Implementação do ADR-004, uma trilha por vez (contratos, BFF na API, Service Worker e manifesto, painel, E2E com IdP falso, threat model v2) | não | HITL-034, HITL-035 e o pré-spike manual (P4 a P8) |

**O que vem depois:**
- **HITL-035 fechado e pré-spike feito:** começa a F1-AUTH-00 (contratos), a primeira trilha de implementação do ADR-004.
- **F1-EXT-05a concluída:** o envio à API (F1-EXT-04 parte 2) vira trilha.

**Cuidados para as trilhas não se atrapalharem:**
1. **Uma sessão por vez nesta pasta.** Todas usam o mesmo branch e o mesmo `STATE.md`.
2. **Nenhuma sessão muda `EXTRACTION_PROMPT_VERSION` ou `LLM_OUTPUT_GUARD_VERSION`** sem um HITL mandar. O próximo prompt (`p4`) carrega a linha do `null` de `yearsExperienceMin` e passa pelo aceite completo (§8.1 por efeito, §8.3 com ruído).
3. **Nenhuma trilha chama provedor.** Para testar a API à mão, lembre que ela agora gasta cota do Groq.
4. **O avaliador do S-1 tem a equivalência de nome** (`stackKey` no `score.ts`). Ninguém muda a regra sem refazer o relatório de todas as versões e o `s1-effect.json`.
5. **O critério de stack é o efeito na nota** (golden-dataset-spec §8.1), e o **§8.3 tem o ruído**. Cada aceite novo de prompt ou guard roda o `S1_MODE=effect` e, se cair mais de 2 pp, o `S1_MODE=noise`.
6. **A cadeia de produção passa pelo `composeProductionApp`.** Provedor novo ou troca de modelo exige o gate do golden dataset antes (T28).
7. **Testes novos de socket real seguem o QA-02**, com o prazo folgado de `test/support/socket-deadlines.ts`.
8. **Fixtures reais:** qualquer fixture nova ou alterada passa de novo pelo runbook fixtures-dom §2 a §4 e pelas emendas do §8 (script fora do repositório, varredura antes do `git add`, commit próprio). O trecho proibido precisa existir na página e não pode aparecer na raiz da vaga; o recolhido (com "ver mais" fechado) precisa entrar no texto (ADR-023 D13).
9. **O extrator é um só** (`job-extractor.ts`, ADR-023 D11 e D12):
   - a regra de descarte (D4) vale para todas as plataformas, e qualquer mudança nela passa pelo `test:browser` inteiro, com a cobertura de 100% e a mutação;
   - cada seletor de plataforma tem a sua versão (`li2` logado, `li1` público, `gu1`, `so1`); seletor novo ganha versão nova e precisa de fixture real no gate;
   - o *clamp* só deixa de cortar na própria raiz de uma versão com `verMais` (hoje só o `li2`, D13); estender isso a outra raiz passa pelo `[APPSEC]`;
   - **depois que o envio à API existir, qualquer mudança no D4 muda todas as versões**;
   - o texto da vaga não vai ao painel (ADR-024 D4), link é proibido por lint, e erro sai do catálogo pelo `code` (ADR-025).
10. **A autenticação segue o ADR-004 (desenho aprovado no HITL-034, com as 14 recomendações):** o token só no Service Worker; o painel nunca lê `storage` nem recebe token; o extrator nunca recebe nada da sessão.
    - **O envio à API (F1-EXT-04 parte 2)**, quando virar trilha, só envia com `consent.isGranted()` e com sessão, e um teste prova isso. O `source` leva `platform` e `extractorVersion`, a base do monitoramento dos seletores (spike-metrics §3.4 e §3.5).
11. **Mudança de contrato atualiza o cofre na mesma tarefa** (DOC-01): a §4 do `contratos-zod` é regerada do `src/`, e a §9 ganha uma linha.
12. **E2E com fixture real:** cada teste de plataforma usa uma URL própria (o `clickAction` acha a aba pela URL), e a rota serve o CSS pelo nome do arquivo. Intermitência de `sem_acesso` vai para o QA-04.
13. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

---

## Próximo prompt (sessão nova)

```text
Equipe, sigam em ciclo estrito. Trilha S3b do next-step: abrir o HITL-035 do ADR-004 (HITL-034 aprovado com as recomendações).
1. [ORCHESTRATOR]: leiam STATE.md, HITL-QUEUE (HITL-034), ADR-004 §1.2, §1.4 (P4 a P8, P18), §6.2, D15 e a Q9/Q10 aprovadas.
2. [ARCHITECT] + [APPSEC]: escrevam o runbook base/03-infra-runbook/auth-extensao.md (parte 1: par RSA da extensão fora do repositório, TRAMPO_EXTENSION_KEY só com a pública, CORS_ALLOWED_ORIGINS, anel de chaves da selagem; parte 2: itens do D15 no painel do Supabase, desligar novos cadastros depois da conta do autor, conferir o Custom Access Token Hook no Free) e o roteiro do pré-spike manual (P4 a P8), sem nenhum valor de segredo e sem código de produto.
3. [SCRIBE]: abram o HITL-035 na HITL-QUEUE (com a pergunta sobre os runbooks supabase-setup, upstash-redis e regiao-custo-zero), atualizem BACKLOG, STATE e SESSION-LOG, e reescrevam o next-step mantendo as trilhas. Commit local só do next-step. Parada obrigatória no HITL-035.
```
