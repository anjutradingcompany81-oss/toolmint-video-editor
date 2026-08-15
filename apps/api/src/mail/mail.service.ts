export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

// Provider-independent boundary: swapping in Postmark/SES/Resend later means
// writing one adapter here, never touching the code that calls MailService.
export abstract class MailService {
  abstract send(message: MailMessage): Promise<void>;
}
