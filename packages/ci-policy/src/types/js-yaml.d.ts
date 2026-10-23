// Declaração mínima do js-yaml 4.3.2 (ADR-019 D7): só o que a política usa. Sem @types/js-yaml,
// para não trazer pacote novo. O retorno é `unknown`, e quem lê valida a forma.
declare module "js-yaml" {
  export interface Schema {
    readonly __brand: "js-yaml.Schema";
  }
  export const CORE_SCHEMA: Schema;
  export function load(text: string, options?: { readonly schema?: Schema; readonly filename?: string }): unknown;
}
