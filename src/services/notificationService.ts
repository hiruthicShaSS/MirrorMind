export interface PocReadyNotificationInput {
  sessionId: string;
  idea: string;
  title: string;
  aiStudioLink: string;
  recipientEmail?: string;
  userId?: string;
  techStack: string[];
  prUrl?: string;
  futureChanges?: string[];
  referenceLinks?: string[];
}

export interface NotificationResult {
  attempted: boolean;
  sent: boolean;
  channels: string[];
  details: string[];
}

function parseStack(techStack: string[]): string {
  return (techStack || []).map((s) => s.trim()).filter(Boolean).join(", ");
}

async function sendWebhookNotification(input: PocReadyNotificationInput): Promise<string | null> {
  const webhookUrl = (process.env.POC_READY_WEBHOOK_URL ?? "").trim();
  if (!webhookUrl) return null;

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event: "poc_ready",
      sessionId: input.sessionId,
      userId: input.userId ?? null,
      recipientEmail: input.recipientEmail ?? null,
      title: input.title,
      aiStudioLink: input.aiStudioLink,
      idea: input.idea,
      techStack: input.techStack,
      prUrl: input.prUrl ?? null,
      futureChanges: input.futureChanges ?? [],
      referenceLinks: input.referenceLinks ?? [],
      createdAt: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Webhook failed (${response.status}): ${body.slice(0, 200)}`);
  }

  return "webhook";
}

async function sendResendEmail(input: PocReadyNotificationInput): Promise<string | null> {
  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  const from = (process.env.POC_READY_EMAIL_FROM ?? "").trim();
  const to = (input.recipientEmail ?? "").trim();
  if (!apiKey || !from || !to) return null;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `POC ready: ${input.title}`,
      text: [
        "Your AI-generated POC is ready.",
        "",
        `Title: ${input.title}`,
        `Idea: ${input.idea}`,
        `Stack: ${parseStack(input.techStack)}`,
        input.prUrl ? `PR: ${input.prUrl}` : "",
        input.futureChanges?.length
          ? `Future changes required:\n- ${input.futureChanges.join("\n- ")}`
          : "",
        input.referenceLinks?.length
          ? `Reference apps:\n- ${input.referenceLinks.join("\n- ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend email failed (${response.status}): ${body.slice(0, 200)}`);
  }

  return "email";
}

export async function notifyPocReady(input: PocReadyNotificationInput): Promise<NotificationResult> {
  const channels: string[] = [];
  const details: string[] = [];

  let attempted = false;
  let sent = false;

  const attempts: Array<{ name: string; fn: () => Promise<string | null> }> = [
    { name: "webhook", fn: () => sendWebhookNotification(input) },
    { name: "email", fn: () => sendResendEmail(input) },
  ];

  for (const attempt of attempts) {
    try {
      const result = await attempt.fn();
      if (result) {
        attempted = true;
        sent = true;
        channels.push(result);
        details.push(`${attempt.name}:sent`);
      }
    } catch (error) {
      attempted = true;
      details.push(`${attempt.name}:failed:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!attempted) {
    details.push("no-notification-channel-configured");
  }

  return { attempted, sent, channels, details };
}
