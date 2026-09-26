/*
 * Resend, over fetch.
 *
 * Sending an email is one POST, so there is no SDK here: a dependency that
 * wraps one endpoint is a dependency to keep up to date for nothing.
 */

const ENDPOINT = 'https://api.resend.com/emails';

export type Outgoing = {
  from: string;
  to: string;
  replyTo: string | null;
  subject: string;
  html: string;
  text: string;
  /** Resend refuses a second send with the same key for 24 hours, so a retry can't double-send. */
  idempotencyKey: string;
  /** List-Unsubscribe and friends: real headers on the message, not content. */
  headers?: Record<string, string>;
};

export type SendResult =
  | { ok: true; id: string }
  /** `retry` marks the failures worth trying again: rate limits and Resend being down. */
  | { ok: false; error: string; retry: boolean };

/** Their errors come back as JSON; a proxy or an outage may not. */
async function describe(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(body) as { message?: unknown; name?: unknown };
    if (typeof parsed.message === 'string') return `${response.status} ${parsed.name ?? ''} ${parsed.message}`.trim();
  } catch {
    /* not JSON */
  }
  return `${response.status} ${body.slice(0, 500) || response.statusText}`;
}

export async function sendThroughResend(apiKey: string, message: Outgoing, timeoutMs = 10_000): Promise<SendResult> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': message.idempotencyKey,
      },
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.headers ? { headers: message.headers } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // No answer at all: the network, DNS, or the timeout above.
    return { ok: false, error: error instanceof Error ? error.message : String(error), retry: true };
  }

  if (!response.ok) {
    // 429 is their rate limit (two a second by default); 5xx is their side.
    return { ok: false, error: await describe(response), retry: response.status === 429 || response.status >= 500 };
  }

  const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
  if (typeof body?.id !== 'string') return { ok: false, error: 'Resend accepted the message without giving it an id.', retry: false };
  return { ok: true, id: body.id };
}
