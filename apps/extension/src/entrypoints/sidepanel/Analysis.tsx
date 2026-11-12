// Partes da análise no Side Panel (F1-EXT-04 parte 1; ADR-025). Só texto via React: nenhum innerHTML,
// nenhum <a>, nenhum href (o lint barra). O que chega aqui já passou pelo WorkerToPanelSchema.
import type { AnalysisReport, ReportItem } from "@trampo/contracts/analysis-report";
import type { ApiError } from "@trampo/contracts/api";

import type { AnaliseView, BloqueioAnalise } from "../../panel/panel-state";
import {
  ANALYZE_BLOCKED_TEXTS,
  DECISION_PATH_LABELS,
  DIMENSION_LABELS,
  ERROR_TEXTS,
  OUTCOME_LABELS,
  STAGE_LABELS,
  SENDING_TEXT,
  STAGE_ORDER,
  VERDICT_LABELS,
  WARNING_LABELS,
  describeStage,
  formatPoints,
  formatRetry,
  type Stage,
} from "../../panel/texts";

export function Consent({ onAccept }: { onAccept: () => void }) {
  return (
    <section data-consentimento="pendente" aria-labelledby="consentimento-titulo">
      <h2 id="consentimento-titulo">Antes da primeira análise</h2>
      <p>Para dar a nota, o texto desta vaga sai do seu navegador:</p>
      <ul>
        <li>vai para o servidor do Trampo;</li>
        <li>e, de lá, para um provedor de inteligência artificial, que lê a vaga para extrair os fatos usados na nota.</li>
      </ul>
      <p>O endereço da página não é enviado. O seu perfil e os seus critérios não vão para a IA.</p>
      <p>Nada é enviado sem você pedir a análise. Você pode retirar este consentimento quando quiser.</p>
      <button type="button" onClick={onAccept}>
        Concordo, pode enviar quando eu pedir
      </button>
    </section>
  );
}

/**
 * "Analisar vaga" e "Reanalisar com IA", pelo portão do analyzeBlock (ADR-004 D12): desabilitados, com o motivo, sem a
 * API, o consentimento ou a sessão. O clique só avisa o App, que despacha a ação e posta o `analisar` (ADR-025 §6.4).
 */
export function AnalyzeButton({ label, bloqueio, onClick }: { label: string; bloqueio: BloqueioAnalise | null; onClick: () => void }) {
  return (
    <div data-acao={label}>
      <button type="button" disabled={bloqueio !== null} aria-describedby={bloqueio === null ? undefined : "analise-bloqueada"} onClick={onClick}>
        {label}
      </button>
      {bloqueio !== null && (
        <p id="analise-bloqueada" className="nota" data-bloqueio={bloqueio}>
          {ANALYZE_BLOCKED_TEXTS[bloqueio]}
        </p>
      )}
    </div>
  );
}

/** O "enviando", entre o clique aceito e o 1º estágio do stream (ADR-025 §6.4 D20 e D21). */
export function Sending() {
  return (
    <section data-analise="enviando" aria-live="polite">
      <p>{SENDING_TEXT}</p>
    </section>
  );
}

function stageStatus(etapa: Stage, atual: Stage): "feita" | "atual" | "pendente" {
  const diff = STAGE_ORDER.indexOf(etapa) - STAGE_ORDER.indexOf(atual);
  return diff < 0 ? "feita" : diff === 0 ? "atual" : "pendente";
}

export function Progress({ analise }: { analise: Extract<AnaliseView, { estado: "andamento" }> }) {
  return (
    <section data-analise="andamento" aria-live="polite">
      <p>{describeStage(analise.etapa, analise.elapsedMs)}</p>
      <ol className="etapas">
        {STAGE_ORDER.map((etapa) => (
          <li key={etapa} data-etapa={stageStatus(etapa, analise.etapa)}>
            {STAGE_LABELS[etapa]}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ErrorNotice({ error }: { error: ApiError }) {
  // O `message` do servidor não é exibido: o texto sai do catálogo, pelo código (ADR-025 D5).
  const { titulo, acao } = ERROR_TEXTS[error.code];
  const retry = formatRetry(error.retryAfterSeconds);
  return (
    <section data-analise="erro" data-erro={error.code} role="alert">
      <p>
        <strong>{titulo}</strong>
      </p>
      <p>{acao}</p>
      {retry !== null && <p>{retry}</p>}
      {error.requestId !== null && <p className="nota">Código do pedido: {error.requestId}</p>}
    </section>
  );
}

function Items({ titulo, itens, lista }: { titulo: string; itens: readonly ReportItem[]; lista: string }) {
  if (itens.length === 0) return null;
  return (
    <section data-lista={lista}>
      <h3>{titulo}</h3>
      <ul>
        {itens.map((item) => (
          <li key={item.dimension}>
            <strong>{DIMENSION_LABELS[item.dimension]}:</strong> {item.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Report({ report }: { report: AnalysisReport }) {
  return (
    <article data-analise="concluida" aria-labelledby="relatorio-titulo">
      <h2 id="relatorio-titulo">
        Nota <span data-nota>{report.score}</span> de 100
      </h2>
      <p data-veredito={report.verdict}>
        <strong>{VERDICT_LABELS[report.verdict]}</strong>
      </p>
      {report.dealBreakerHit && <p data-eliminatorio>Um dos seus critérios eliminatórios não foi atendido.</p>}
      <p data-resumo>{report.summary}</p>
      {report.warnings.length > 0 && (
        <ul data-avisos className="avisos">
          {report.warnings.map((w) => (
            <li key={w}>{WARNING_LABELS[w]}</li>
          ))}
        </ul>
      )}
      <Items titulo="Pontos fortes" itens={report.strengths} lista="fortes" />
      <Items titulo="Pontos de atenção" itens={report.redFlags} lista="atencao" />
      <Items titulo="A vaga não informa" itens={report.missingInfo} lista="faltando" />
      <section data-lista="composicao">
        <h3>Como a nota foi composta</h3>
        <ul>
          {report.breakdown.map((entry) => (
            <li key={entry.dimension}>
              <strong>
                {DIMENSION_LABELS[entry.dimension]}: {OUTCOME_LABELS[entry.outcome]} ({formatPoints(entry.points)})
              </strong>
              <br />
              {entry.explanation}
            </li>
          ))}
        </ul>
      </section>
      <p className="nota">{DECISION_PATH_LABELS[report.decisionPath]}</p>
      <p className="nota">Código da análise: {report.analysisId}</p>
    </article>
  );
}
