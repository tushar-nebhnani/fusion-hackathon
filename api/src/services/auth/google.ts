import { OAuth2Client } from "google-auth-library";
import { AppError } from "../../errors/app-error.js";

// What the API keeps from a verified Google ID token
export interface GoogleIdentity {
  // Google's stable account id; the email can change, this cannot
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  // The Google Workspace domain that manages the account (the `hd` claim);
  // null for a consumer account, even one made with a work address
  hostedDomain?: string | null;
}

export interface GoogleVerifier {
  // Rejects with INVALID_CREDENTIAL when the token is not a valid one for this app
  verify(credential: string): Promise<GoogleIdentity>;
}

export function invalidCredential(): AppError {
  return new AppError("Google sign-in could not be verified", 401, "INVALID_CREDENTIAL");
}

// Checks the signature, expiry, issuer and audience of the ID token that
// the Sign in with Google button hands to the browser.
export function createGoogleVerifier(clientId: string): GoogleVerifier {
  const client = new OAuth2Client();

  return {
    async verify(credential) {
      const ticket = await client
        .verifyIdToken({ idToken: credential, audience: clientId })
        .catch((error: unknown) => {
          // Google's signing keys could not be downloaded: not the caller's fault
          if (error instanceof Error && error.message.startsWith("Failed to retrieve")) {
            throw new AppError("Google sign-in is unavailable, try again", 503, "AUTH_UNAVAILABLE");
          }
          throw invalidCredential();
        });
      const payload = ticket.getPayload();
      if (!payload?.email) throw invalidCredential();
      return {
        sub: payload.sub,
        email: payload.email,
        emailVerified: payload.email_verified === true,
        name: payload.name ?? null,
        picture: payload.picture ?? null,
        hostedDomain: payload.hd?.toLowerCase() ?? null,
      };
    },
  };
}
