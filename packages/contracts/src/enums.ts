import { z } from 'zod';

/*
 * Convenção: chaves em inglês camelCase; valores de enum de domínio em pt-BR
 * snake_case sem acento (como no Blueprint); códigos ISO e ids de provedor como no padrão.
 * Enum fechado = superfície de injection reduzida (Blueprint §2).
 */

export const SeniorityLevelSchema = z.enum(['estagio', 'junior', 'pleno', 'senior', 'especialista', 'lideranca']);
export type SeniorityLevel = z.infer<typeof SeniorityLevelSchema>;

export const WorkModelSchema = z.enum(['remoto', 'hibrido', 'presencial']);
export type WorkModel = z.infer<typeof WorkModelSchema>;

export const ContractTypeSchema = z.enum(['clt', 'pj', 'cooperado', 'estagio', 'temporario']);
export type ContractType = z.infer<typeof ContractTypeSchema>;

export const CurrencySchema = z.enum(['BRL', 'USD', 'EUR']);
export type Currency = z.infer<typeof CurrencySchema>;

export const SalaryPeriodSchema = z.enum(['hora', 'mes', 'ano']);
export type SalaryPeriod = z.infer<typeof SalaryPeriodSchema>;

/** Sinais semânticos de alerta. Vêm do LLM (ou da Camada 1 quando o sinal é objetivo). */
export const RedFlagSignalSchema = z.enum([
  'salario_omitido',
  'escopo_excessivo',
  'sobreaviso_nao_remunerado',
  'teste_tecnico_longo',
  'multiplas_funcoes',
  'linguagem_vaga',
]);
export type RedFlagSignal = z.infer<typeof RedFlagSignalSchema>;

export const BenefitCategorySchema = z.enum([
  'plano_saude',
  'plano_odontologico',
  'vale_refeicao',
  'vale_alimentacao',
  'auxilio_home_office',
  'auxilio_educacao',
  'bem_estar_academia',
  'plr_bonus',
  'participacao_societaria',
  'previdencia_privada',
  'seguro_vida',
  'auxilio_creche',
  'horario_flexivel',
  'folga_aniversario',
  'outro',
]);
export type BenefitCategory = z.infer<typeof BenefitCategorySchema>;

export const LanguageCodeSchema = z.enum([
  'ingles',
  'espanhol',
  'frances',
  'alemao',
  'italiano',
  'mandarim',
  'japones',
  'portugues',
  'outro',
]);
export type LanguageCode = z.infer<typeof LanguageCodeSchema>;

export const LanguageLevelSchema = z.enum(['basico', 'intermediario', 'avancado', 'fluente', 'nativo']);
export type LanguageLevel = z.infer<typeof LanguageLevelSchema>;

export const BrazilUfSchema = z.enum([
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
]);
export type BrazilUf = z.infer<typeof BrazilUfSchema>;

/** Origem da captura. `texto_colado` = fallback manual (Blueprint §3, D10). */
export const PlatformSchema = z.enum(['linkedin', 'gupy', 'generico', 'texto_colado']);
export type Platform = z.infer<typeof PlatformSchema>;

/**
 * Provedores de extração habilitados (ADR-001 §5.5). Adicionar provedor = ADR + gate do
 * golden dataset. `ollama` só em dev/evals.
 */
export const LlmProviderIdSchema = z.enum(['groq', 'cloudflare_workers_ai', 'google_ai_studio', 'ollama']);
export type LlmProviderId = z.infer<typeof LlmProviderIdSchema>;
