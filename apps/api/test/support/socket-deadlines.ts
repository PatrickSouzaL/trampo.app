// Prazo folgado dos testes de socket real que provam protocolo ou fluxo, não prazo (QA-02). A primeira chamada de
// fetch de um processo custa de 5 a 10 vezes as seguintes (~100 ms com a CPU disputada, medido na sessão do QA-02),
// e esses testes herdavam os prazos de produção (150 a 300 ms). Os prazos de produção continuam provados pelo
// FakeClock e pelos testes de "lento" e "travado" em socket real, que mantêm os prazos curtos.
export const HAPPY_PATH_TIMEOUT_MS = 3_000;
