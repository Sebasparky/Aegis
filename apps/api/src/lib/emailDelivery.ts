export type EmailDeliveryProvider = "resend" | "dev_console";

export interface SendVerificationOtpEmailArgs {
  to_email: string;   // full email — used only here, never stored or returned
  otp: string;        // raw code — used only here, never returned from any route
  session_id: string; // for log correlation only
}

export interface EmailDeliveryResult {
  provider: EmailDeliveryProvider;
  delivery_mode: "email" | "dev_console";
  provider_message_id?: string;
}

export async function sendVerificationOtpEmail(
  args: SendVerificationOtpEmailArgs,
): Promise<EmailDeliveryResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const provider = process.env.EMAIL_DELIVERY_PROVIDER;

  if (provider === "resend" && apiKey) {
    const { Resend } = await import("resend");
    const client = new Resend(apiKey);
    const from = process.env.EMAIL_FROM ?? "Antigen <onboarding@resend.dev>";
    const result = await client.emails.send({
      from,
      to: args.to_email,
      subject: "Your Antigen verification code",
      html: `<p>Your Antigen verification code is <strong>${args.otp}</strong>. It expires in 10 minutes. Do not share this code.</p>`,
    });
    return {
      provider: "resend",
      delivery_mode: "email",
      provider_message_id: (result.data as { id?: string } | null)?.id,
    };
  }

  console.log(`[email_otp OTP] session=${args.session_id} otp=${args.otp}`);
  return { provider: "dev_console", delivery_mode: "dev_console" };
}
