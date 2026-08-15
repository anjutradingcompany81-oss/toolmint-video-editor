import { Global, Module } from "@nestjs/common";
import { MailService } from "./mail.service";
import { ConsoleMailService } from "./console-mail.service";

@Global()
@Module({
  providers: [{ provide: MailService, useClass: ConsoleMailService }],
  exports: [MailService],
})
export class MailModule {}
