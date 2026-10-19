// Domínio puro (ADR-001 §7): JobTextNormalizer, DeterministicPreFilter, FactResolver, ScoringEngine...
// Só `import type` de @trampo/contracts e arquivos do próprio domínio; sem rede, relógio, aleatoriedade
// nem zod em runtime (preset domainPurity + dependency-cruiser). Primeiro conteúdo: F1-DOM-01.
export {};
