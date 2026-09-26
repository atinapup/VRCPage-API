/*
 * Codes that were printed rather than sent.
 *
 * With no email sender configured (development, or a production build being
 * tried locally) MailService prints each message to the API's terminal. It
 * also drops any code here, so the website's /dev/vrchat page can show it
 * without anyone having to read the server log.
 *
 * Nothing in a deployment reaches this: production refuses to start without a
 * sender unless it is explicitly told to print.
 */

export type CodePurpose = 'sign-in' | 'change-email';

export type SentCode = { email: string; code: string; purpose: CodePurpose; sentAt: string };

/** Which templates carry a code, and what the development page calls it. */
const PURPOSES: Record<string, CodePurpose> = {
  sign_in_code: 'sign-in',
  email_change_code: 'change-email',
};

const recent: SentCode[] = [];

/** The last few codes printed, newest first, for GET /v1/dev/codes. */
export function recentCodes(): SentCode[] {
  return [...recent];
}

/** Remember a printed code, if this template had one. */
export function notePrintedCode(template: string, email: string, props: Record<string, unknown>): void {
  const purpose = PURPOSES[template];
  if (!purpose || typeof props.code !== 'string') return;
  recent.unshift({ email, code: props.code, purpose, sentAt: new Date().toISOString() });
  recent.length = Math.min(recent.length, 10);
}
