// Área da sessão no Side Panel (F1-EXT-05b, 05b-3; ADR-004 D12). Só texto via React e só botões, nunca link. O texto
// sai do describeSession e os botões, do sessionActions: o botão que a lógica não oferece não existe na tela. Depois do
// login, nada mostra conta nem provedor (residual "conta trocada", ADR-004 §3).
import { AUTH_PROVIDERS, type AuthProvider } from "../../messaging/protocol";
import { sessionActions, type PanelState } from "../../panel/panel-state";
import { SESSION_ACTION_LABELS, SIGN_IN_LABELS, describeSession } from "../../panel/texts";

interface Botao {
  readonly chave: string;
  readonly rotulo: string;
  readonly clique: () => void;
}

interface SessionProps {
  state: PanelState;
  onEntrar: (provedor: AuthProvider) => void;
  /** "Sair da conta" e "Tentar sair de novo" mandam o mesmo `sair` (D11.5). */
  onSair: () => void;
}

export function Session({ state, onEntrar, onSair }: SessionProps) {
  const texto = describeSession(state);
  if (texto === null) return null;
  // "entrar" vira um botão por provedor da lista, na ordem da AUTH_PROVIDERS.
  const botoes = sessionActions(state).flatMap((acao): Botao[] =>
    acao === "entrar"
      ? AUTH_PROVIDERS.map((provedor) => ({ chave: provedor, rotulo: SIGN_IN_LABELS[provedor], clique: () => onEntrar(provedor) }))
      : [{ chave: acao, rotulo: SESSION_ACTION_LABELS[acao], clique: onSair }],
  );
  return (
    <section data-sessao="" aria-live="polite">
      <p>{texto.estado}</p>
      {texto.erro !== null && (
        <div data-sessao-erro="">
          <p>
            <strong>{texto.erro.titulo}</strong>
          </p>
          <p>{texto.erro.acao}</p>
        </div>
      )}
      {botoes.length > 0 && (
        <p className="acoes">
          {botoes.map(({ chave, rotulo, clique }) => (
            <button key={chave} type="button" onClick={clique}>
              {rotulo}
            </button>
          ))}
        </p>
      )}
    </section>
  );
}
