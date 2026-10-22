// Balde do endereço do cliente para o limite por IP (ADR-014 D4). O `request.ip` do Fastify já respeita o
// `trustProxy` do ADR-007. IPv4 mapeado em IPv6 vira IPv4; IPv6 conta pelo prefixo /64 (quem tem um /64 troca de
// endereço à vontade); o que não é IP cai num balde único. O balde só vai ao Redis dentro de um HMAC (SR-17).
import { isIPv4, isIPv6 } from "node:net";

export const INVALID_ADDRESS_BUCKET = "invalido";
const MAPPED_V4_PREFIX = "::ffff:";

const groups = (part: string): string[] => (part === "" ? [] : part.split(":"));
// Um IPv4 embutido no fim ocupa dois grupos de 16 bits.
const width = (parts: readonly string[]): number => parts.reduce((sum, part) => sum + (part.includes(".") ? 2 : 1), 0);

/** Os 4 primeiros grupos de 16 bits (o /64) de um IPv6 já validado, sem zeros à esquerda. */
function ipv6Prefix64(address: string): string {
  const cut = address.indexOf("::");
  let full: string[];
  if (cut === -1) {
    full = groups(address);
  } else {
    const left = groups(address.slice(0, cut));
    const right = groups(address.slice(cut + 2));
    full = [...left, ...Array<string>(8 - width(left) - width(right)).fill("0"), ...right];
  }
  return full
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":");
}

export function clientAddressBucket(ip: string): string {
  // O identificador de zona (`%eth0`) não muda quem é o cliente.
  const zone = ip.indexOf("%");
  const address = (zone === -1 ? ip : ip.slice(0, zone)).toLowerCase();
  if (address.startsWith(MAPPED_V4_PREFIX) && isIPv4(address.slice(MAPPED_V4_PREFIX.length))) {
    return `v4:${address.slice(MAPPED_V4_PREFIX.length)}`;
  }
  if (isIPv4(address)) return `v4:${address}`;
  if (isIPv6(address)) return `v6:${ipv6Prefix64(address)}::/64`;
  return INVALID_ADDRESS_BUCKET;
}
