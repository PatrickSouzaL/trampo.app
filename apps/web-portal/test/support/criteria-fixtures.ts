// Critérios de teste do portal (ADR-028): um `UserCriteria` completo, com todas as seções preenchidas e uma pretensão
// canário (o número que nunca pode aparecer numa URL, num log ou num aviso, condição 10 do [APPSEC]).
import type { UserCriteria } from "@trampo/contracts/user-criteria";

/** A pretensão canário: um valor que não aparece em mais nada do teste. */
export const SALARY_CANARY = 73_519.87;
/** A forma do canário como texto (o que um vazamento mostraria). */
export const SALARY_CANARY_TEXT = "73519";

export function fullCriteria(): UserCriteria {
  return {
    schemaVersion: 1,
    workModel: { accepted: ["remoto", "hibrido"], importance: { level: "ponderado", weight: 4 } },
    seniority: { accepted: ["pleno", "senior"], importance: { level: "obrigatorio" } },
    contractType: { accepted: ["clt", "pj"], importance: { level: "ponderado", weight: 2 } },
    salary: { minimum: SALARY_CANARY, currency: "BRL", period: "mes", importance: { level: "eliminatorio" } },
    location: { acceptedUfs: ["SP", "PR"], acceptedCities: ["Curitiba", "São Paulo"], importance: { level: "ponderado", weight: 1 } },
    stack: {
      mustHave: ["TypeScript", "Node.js"],
      niceToHave: ["PostgreSQL", "C#"],
      dealBreakers: ["COBOL"],
      dealBreakerScope: "qualquer_mencao",
      niceToHaveWeight: 3,
    },
    languages: { proficiencies: [{ language: "ingles", level: "avancado" }, { language: "espanhol", level: "basico" }], importance: { level: "ponderado", weight: 5 } },
    benefits: { desired: ["plano_saude", "horario_flexivel"], importance: { level: "ignorar" } },
    redFlagTolerance: {
      salario_omitido: "alertar",
      escopo_excessivo: "penalizar",
      sobreaviso_nao_remunerado: "eliminatorio",
      teste_tecnico_longo: "ignorar",
      multiplas_funcoes: "alertar",
      linguagem_vaga: "alertar",
      pressao_excessiva: "penalizar",
    },
    notes: "Prefiro times pequenos.\nSem viagens.",
  };
}
