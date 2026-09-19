/** Ask for a sign-in code. */
export class SignInCodeRequest {
  /** The address to send the code to. */
  email!: string;
  /** The Turnstile token from the sign-in form's widget. */
  botCheckToken!: string;
}

/** Ask for another code to the address a pending token names. */
export class ResendSignInCodeRequest {
  pendingToken!: string;
}

/** A sign-in waiting for its code. */
export class PendingSignIn {
  /**
   * The address, dated when its code went out and signed:
   * `<sent at ms>.<signature>.<email>`. Keep it (the website uses an httpOnly
   * cookie) and hand it back to resend without another bot check. Valid as
   * long as the code.
   */
  pendingToken!: string;
  /** False inside the resend cooldown: the code sent moments ago still stands. */
  sent!: boolean;
  /** Seconds before another code can be sent. */
  resendIn!: number;
}

/** Sign in with a code. A first sign-in creates the account. */
export class SignInRequest {
  email!: string;
  /** The digits from the email; anything else in it is ignored. */
  code!: string;
}

/** Where Discord or GitHub should send someone back. */
export class SocialSignInRequest {
  /** A path on the website, such as /dashboard. */
  callbackURL!: string;
  /** A path on the website; the provider's `error` is added to its query. */
  errorCallbackURL!: string;
}

/** Where to send someone back after connecting a provider. */
export class SocialLinkRequest {
  /** A path on the website; on failure it gets an `error` query parameter. */
  callbackURL!: string;
}

/** The provider's page to send the browser to. */
export class ProviderRedirect {
  url!: string;
}

/** The signed-in account. */
export class SessionInfo {
  accountId!: string;
  /** The account's own address, for its settings. Never shown anywhere public. */
  email!: string;
}

/** Which sign-in providers this server offers. */
export class Providers {
  discord!: boolean;
  github!: boolean;
}

export class SignInMethod {
  /** Offered on this server. */
  configured!: boolean;
  /** Attached to the signed-in account. */
  connected!: boolean;
}

/** The signed-in account's ways to sign in, besides the email code every account has. */
export class SignInMethods {
  discord!: SignInMethod;
  github!: SignInMethod;
}

/** Move the account to a new address. */
export class EmailChangeRequest {
  newEmail!: string;
}

export class EmailChangeStarted {
  /** Seconds before another code can be sent to this address. */
  resendIn!: number;
}

/** Confirm a new address with the code sent to it. */
export class EmailChangeConfirmRequest {
  newEmail!: string;
  code!: string;
}
