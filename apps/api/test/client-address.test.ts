// Balde do endereço do cliente (ADR-014 D4): IPv4, IPv4 mapeado, IPv6 pelo /64 e balde único de inválidos.
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import { INVALID_ADDRESS_BUCKET, clientAddressBucket } from "../src/presentation/edge/client-address.js";

describe("clientAddressBucket", () => {
  test.each([
    ["203.0.113.7", "v4:203.0.113.7"],
    ["127.0.0.1", "v4:127.0.0.1"],
    ["::ffff:203.0.113.7", "v4:203.0.113.7"],
    ["::FFFF:203.0.113.7", "v4:203.0.113.7"],
    ["2001:db8:85a3:8d3:1319:8a2e:370:7348", "v6:2001:db8:85a3:8d3::/64"],
    ["2001:0DB8:85A3:08D3:1319:8A2E:0370:7348", "v6:2001:db8:85a3:8d3::/64"],
    ["2001:db8:85a3:8d3::1", "v6:2001:db8:85a3:8d3::/64"],
    ["2001:db8::1", "v6:2001:db8:0:0::/64"],
    ["2001:db8:1::", "v6:2001:db8:1:0::/64"],
    ["::1", "v6:0:0:0:0::/64"],
    ["::", "v6:0:0:0:0::/64"],
    ["fe80::1%eth0", "v6:fe80:0:0:0::/64"],
    ["::203.0.113.7", "v6:0:0:0:0::/64"],
    ["64:ff9b::203.0.113.7", "v6:64:ff9b:0:0::/64"],
    ["2001:db8:a:b:c:d:203.0.113.7", "v6:2001:db8:a:b::/64"],
    // "::" no meio: os zeros que faltam entram no lugar certo, e o IPv4 embutido conta como dois grupos.
    ["2001:db8::1:2:3:4:5", "v6:2001:db8:0:1::/64"],
    ["2001:db8::5:6:7:1.2.3.4", "v6:2001:db8:0:5::/64"],
    // A zona não pode impedir que o IPv4 mapeado vire IPv4.
    ["::ffff:198.51.100.9%eth0", "v4:198.51.100.9"],
  ])("%s → %s", (ip, bucket) => {
    expect(clientAddressBucket(ip)).toBe(bucket);
  });

  test.each([[""], ["não é ip"], ["999.1.1.1"], ["1.2.3"], ["::ffff:999.1.1.1"], ["2001:db8:::1"], ["%eth0"], ["<script>"]])(
    "inválido (%j) cai no balde único",
    (ip) => {
      expect(clientAddressBucket(ip)).toBe(INVALID_ADDRESS_BUCKET);
    },
  );

  test("propriedade: dois endereços do mesmo /64 caem no mesmo balde; /64 diferentes, em baldes diferentes", () => {
    const group = fc.integer({ min: 0, max: 0xffff }).map((n) => n.toString(16));
    fc.assert(
      fc.property(fc.array(group, { minLength: 4, maxLength: 4 }), fc.array(group, { minLength: 4, maxLength: 4 }), fc.array(group, { minLength: 4, maxLength: 4 }), (prefix, a, b) => {
        const left = clientAddressBucket([...prefix, ...a].join(":"));
        expect(left).toBe(clientAddressBucket([...prefix, ...b].join(":")));
        expect(left).toMatch(/^v6:[0-9a-f]{1,4}(:[0-9a-f]{1,4}){3}::\/64$/);
        const otherPrefix = [...prefix];
        otherPrefix[3] = ((Number.parseInt(prefix[3] ?? "0", 16) + 1) % 0x10000).toString(16);
        expect(clientAddressBucket([...otherPrefix, ...a].join(":"))).not.toBe(left);
      }),
      { numRuns: 1_000 },
    );
  });

  test("propriedade: o balde cabe no limite de 64 caracteres do guarda", () => {
    fc.assert(
      fc.property(fc.oneof(fc.ipV4(), fc.ipV6(), fc.ipV4Extended(), fc.string()), (ip) => {
        expect(clientAddressBucket(ip).length).toBeLessThanOrEqual(64);
      }),
      { numRuns: 1_000 },
    );
  });
});
