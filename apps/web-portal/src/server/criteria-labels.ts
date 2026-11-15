// Rótulos fixos do formulário de critérios (ADR-028 D5 e D7): um título por campo do contrato e um texto por opção dos
// enums fechados. O tipo exige um rótulo para cada opção: um enum novo no contrato derruba o typecheck e o teste.
import type { CriteriaField, FORM_OPTIONS } from "./criteria-form";

type Labels<K extends keyof typeof FORM_OPTIONS> = Readonly<Record<(typeof FORM_OPTIONS)[K][number], string>>;

export const FIELD_LABELS: Readonly<Record<CriteriaField, string>> = Object.freeze({
  workModel: "Modelo de trabalho",
  seniority: "Senioridade",
  contractType: "Tipo de contrato",
  salary: "Pretensão salarial",
  location: "Localização (vagas híbridas ou presenciais)",
  stack: "Tecnologias",
  languages: "Idiomas",
  benefits: "Benefícios",
  redFlagTolerance: "Sinais de alerta da vaga",
  notes: "Observações (não entram na nota)",
  criterios: "Critérios",
});

export const OPTION_LABELS: {
  readonly [K in Exclude<keyof typeof FORM_OPTIONS, "ufs" | "niceToHaveWeight" | "importance">]: Labels<K>;
} & { readonly importance: Readonly<Record<string, string>> } = Object.freeze({
  workModel: { remoto: "Remoto", hibrido: "Híbrido", presencial: "Presencial" },
  seniority: { estagio: "Estágio", junior: "Júnior", pleno: "Pleno", senior: "Sênior", especialista: "Especialista", lideranca: "Liderança" },
  contractType: { clt: "CLT", pj: "PJ", cooperado: "Cooperado", estagio: "Estágio", temporario: "Temporário" },
  currency: { BRL: "Real (BRL)", USD: "Dólar (USD)", EUR: "Euro (EUR)", ARS: "Peso argentino (ARS)" },
  period: { hora: "por hora", mes: "por mês", ano: "por ano" },
  benefits: {
    plano_saude: "Plano de saúde",
    plano_odontologico: "Plano odontológico",
    vale_refeicao: "Vale-refeição",
    vale_alimentacao: "Vale-alimentação",
    auxilio_home_office: "Auxílio home office",
    auxilio_educacao: "Auxílio educação",
    bem_estar_academia: "Bem-estar ou academia",
    plr_bonus: "PLR ou bônus",
    participacao_societaria: "Participação societária",
    previdencia_privada: "Previdência privada",
    seguro_vida: "Seguro de vida",
    auxilio_creche: "Auxílio creche",
    horario_flexivel: "Horário flexível",
    folga_aniversario: "Folga no aniversário",
    outro: "Outro",
  },
  languages: {
    ingles: "Inglês",
    espanhol: "Espanhol",
    frances: "Francês",
    alemao: "Alemão",
    italiano: "Italiano",
    mandarim: "Mandarim",
    japones: "Japonês",
    portugues: "Português",
    outro: "Outro idioma",
  },
  levels: { basico: "Básico", intermediario: "Intermediário", avancado: "Avançado", fluente: "Fluente", nativo: "Nativo" },
  signals: {
    salario_omitido: "Salário omitido",
    escopo_excessivo: "Escopo excessivo",
    sobreaviso_nao_remunerado: "Sobreaviso não remunerado",
    teste_tecnico_longo: "Teste técnico longo",
    multiplas_funcoes: "Várias funções num cargo só",
    linguagem_vaga: "Linguagem vaga",
    pressao_excessiva: "Pressão excessiva",
  },
  tolerances: { ignorar: "Ignorar", alertar: "Só alertar", penalizar: "Tirar pontos", eliminatorio: "Eliminar a vaga" },
  scopes: { somente_obrigatoria: "Só quando a tecnologia é exigida", qualquer_mencao: "Em qualquer menção" },
  importance: {
    eliminatorio: "Eliminatório (fora disso, a vaga cai)",
    obrigatorio: "Obrigatório",
    ponderado_1: "Peso 1",
    ponderado_2: "Peso 2",
    ponderado_3: "Peso 3",
    ponderado_4: "Peso 4",
    ponderado_5: "Peso 5",
    ignorar: "Ignorar",
  },
});
