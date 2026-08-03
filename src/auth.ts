import { createRemoteJWKSet, jwtVerify } from "jose";
export interface Principal {
  subjectId: string;
  service?: boolean;
}
export type Authenticator = (
  authorization: string | undefined,
) => Promise<Principal>;
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function createAuthenticator(
  environment: NodeJS.ProcessEnv = process.env,
): Authenticator {
  const issuer =
    environment.KEYCLOAK_ISSUER ?? "http://keycloak:8080/realms/algaguard";
  const audience = environment.KEYCLOAK_AUDIENCE ?? "algaguard-api";
  const jwksUrl =
    environment.KEYCLOAK_JWKS_URL ?? `${issuer}/protocol/openid-connect/certs`;
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  const serviceClients = new Set(
    (environment.SERVICE_CLIENT_IDS ?? "algaguard-device-service")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return async (authorization) => {
    const token = /^Bearer ([^ ]+)$/.exec(authorization ?? "")?.[1];
    if (!token) throw new HttpError(401, "Bearer token required");
    try {
      const payload = (await jwtVerify(token, jwks, { issuer, audience }))
        .payload;
      if (!payload.sub) throw new HttpError(401, "Token subject required");
      const clientId =
        typeof payload.azp === "string"
          ? payload.azp
          : typeof payload.client_id === "string"
            ? payload.client_id
            : undefined;
      return {
        subjectId: payload.sub,
        service: Boolean(clientId && serviceClients.has(clientId)),
      };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(401, "Bearer token invalid");
    }
  };
}
