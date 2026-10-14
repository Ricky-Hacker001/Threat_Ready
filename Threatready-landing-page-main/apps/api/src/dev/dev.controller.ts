import { Controller, Get, Inject, Query } from "@nestjs/common";
import { Public } from "../authz/authz.js";
import { EMAIL_PORT, LogEmailAdapter, type EmailPort } from "../email/email.port.js";

/**
 * Local-only mailbox so OTP flows can be tested without SES.
 * Registered only when EMAIL_DRIVER=log, which config refuses in production.
 */
@Controller("dev")
export class DevController {
  constructor(@Inject(EMAIL_PORT) private readonly email: EmailPort) {}

  @Get("mailbox")
  @Public()
  mailbox(@Query("to") to?: string) {
    if (!(this.email instanceof LogEmailAdapter)) return [];
    const box = this.email.outbox;
    return (to ? box.filter((m) => m.to === to.toLowerCase()) : box).map(({ to, subject, text, kind, at }) => ({
      to,
      subject,
      text,
      kind,
      at,
    }));
  }
}
