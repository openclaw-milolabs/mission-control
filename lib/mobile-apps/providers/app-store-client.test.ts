import { describe, expect, it } from "vitest";
import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair } from "jose";
import { createAppStoreConnectJwt } from "@/lib/mobile-apps/providers/app-store-client";

async function testKeyPem(): Promise<string> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return exportPKCS8(privateKey);
}

describe("createAppStoreConnectJwt", () => {
  it("signs an ES256 token with kid header and the required claims", async () => {
    const pem = await testKeyPem();
    const token = await createAppStoreConnectJwt({
      issuerId: "issuer-123",
      keyId: "KEYABC",
      privateKeyPem: pem,
    });

    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe("KEYABC");
    expect(header.typ).toBe("JWT");

    const payload = decodeJwt(token);
    expect(payload.iss).toBe("issuer-123");
    expect(payload.aud).toBe("appstoreconnect-v1");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    // Token lifetime must be short (Apple rejects > 20 min); keep well under.
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(20 * 60);
  });
});
