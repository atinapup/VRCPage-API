export type CodePurpose = 'sign-in' | 'change-email';

export type SentCode = { email: string; code: string; purpose: CodePurpose; sentAt: string };

const WHAT: Record<CodePurpose, string> = {
  'sign-in': 'sign-in code',
  'change-email': 'code to confirm a new email address',
};

/** The last few codes printed, newest first, for GET /v1/dev/codes. */
const recent: SentCode[] = [];

export function recentCodes(): SentCode[] {
  return [...recent];
}

/**
 * How a code reaches the person who asked for it.
 *
 * Email sending arrives with Resend. Until then the code is printed in the
 * terminal running the API, which is where someone testing locally is already
 * looking. Where printing isn't allowed (production) this throws: a form that
 * says "code sent" while the code goes nowhere is the worst thing a sign-in
 * page can do.
 */
export function deliverCode(print: boolean, email: string, code: string, purpose: CodePurpose): void {
  if (!print) throw new Error('Codes cannot be delivered: no email sender is configured.');

  console.info(`\n  vrc.page ${WHAT[purpose]} for ${email}: ${code}\n  Printed here because email sending is not connected yet.\n`);
  recent.unshift({ email, code, purpose, sentAt: new Date().toISOString() });
  recent.length = Math.min(recent.length, 10);
}
