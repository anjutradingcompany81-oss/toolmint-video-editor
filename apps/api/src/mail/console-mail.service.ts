import { Injectable, Logger } from "@nestjs/common";
import { MailMessage, MailService } from "./mail.service";

// Dev-only stand-in: logs the message instead of sending it, so
// verification/reset links are visible in the API console before a real
// provider is wired up.
@Injectable()
export class ConsoleMailService implements MailService {
  private readonly logger = new Logger("Mail");

  async send(message: MailMessage): Promise<void> {
    this.logger.log(`To: ${message.to} | Subject: ${message.subject}\n${message.text}`);
  }
}
