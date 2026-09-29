/*
 * Cloudflare Turnstile, in front of every sign-in code.
 *
 * A code is an email vrc.page sends to an address someone typed. Without a
 * check, a script can make the site send thousands of them, to strangers, on
 * vrc.page's sending reputation. The widget runs in the browser (the website
 * holds its site key) and hands the form a token; this trades that token with
 * Cloudflare for a yes or no before anything is sent.
 */

const SITE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Named on the widget and checked on the answer, so a token made for another form can't be spent here. */
const ACTION = 'sign-in';

/** Long enough for a slow answer, short enough that nobody waits on a hang. */
const TIMEOUT_MS = 10_000;

type SiteVerifyAnswer = {
  success?: boolean;
  action?: string;
  hostname?: string;
  'error-codes'?: string[];
  metadata?: { result_with_testing_key?: boolean };
};

/** What Cloudflare's error codes actually mean for this setup. */
const WHY: Record<string, string> = {
  'invalid-input-secret': 'TURNSTILE_SECRET_KEY is not a valid secret. Check it reached the container whole.',
  'invalid-input-response': 'The token is not valid for this secret. The site key and the secret must come from the SAME Turnstile widget.',
  'timeout-or-duplicate': 'The token was already spent or is older than five minutes.',
  'bad-request': 'Cloudflare could not read the request.',
  'missing-input-response': 'No token was sent with the form.',
  'missing-input-secret': 'No secret was sent to Cloudflare.',
};

/**
 * "unavailable" means there is no verdict at all: no secret on this server,
 * or Cloudflare didn't answer. Both fail closed.
 */
export async function passesBotCheck(
  secret: string | null,
  token: string,
  ip: string | null,
): Promise<'passed' | 'failed' | 'unavailable'> {
  if (!secret) {
    console.error('No sign-in code was sent: TURNSTILE_SECRET_KEY is not set.');
    return 'unavailable';
  }
  // Cloudflare caps tokens at 2048 characters. Anything empty or longer is not one.
  if (!token || token.length > 2048) return 'failed';

  let answer: SiteVerifyAnswer;
  try {
    const response = await fetch(SITE_VERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    answer = (await response.json()) as SiteVerifyAnswer;
  } catch (error) {
    console.error('Checking the Turnstile token failed.', error);
    return 'unavailable';
  }

  if (answer.success !== true) {
    // Cloudflare says exactly why, and without this the refusal is silent:
    // the page shows "couldn't confirm you're not a bot" and the server logs
    // nothing at all, which is a bad hour to spend.
    const codes = answer['error-codes'] ?? [];
    const explained = codes.map((code) => WHY[code] ?? code).join(' ');
    console.error(`Turnstile refused a token${codes.length ? ` (${codes.join(', ')})` : ''}. ${explained}`);
    return 'failed';
  }
  // The test keys answer without an action. Real ones always carry one.
  if (!answer.metadata?.result_with_testing_key && answer.action !== ACTION) {
    console.error(`Turnstile passed a token for action ${JSON.stringify(answer.action)}, but this form only accepts ${JSON.stringify(ACTION)}.`);
    return 'failed';
  }
  return 'passed';
}
