import { Body, Controller, HttpCode, Inject, Logger, Post, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { forgotUsernameRequestSchema, type GenericAccepted } from "@threatready/contracts";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Request } from "express";
import { Public } from "../authz/authz.js";
import { ClientIpThrottlerGuard, clientIp } from "../common/throttle.js";
import { CONFIG, type Config } from "../config.js";
import { DB, type Db } from "../db/db.js";
import { users } from "../db/schema.js";
import { dispatch, EMAIL_PORT, type EmailPort } from "../email/email.port.js";
import { usernameReminderEmail } from "../email/templates.js";
import { ZodBody } from "../common/zod.js";
import { CaptchaService } from "./captcha.service.js";

const PER_EMAIL_WINDOW_MS = 60 * 60 * 1000;
const PER_EMAIL_MAX = 3;

@Controller("account")
@UseGuards(ClientIpThrottlerGuard)
export class AccountController {
  private readonly logger = new Logger("Account");
  /** Stops mail-bombing one inbox. In-process is enough for one API task (ADD L11/L12). */
  private readonly perEmail = new Map<string, number[]>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EMAIL_PORT) private readonly email: EmailPort,
    @Inject(CONFIG) private readonly config: Config,
    private readonly captcha: CaptchaService,
  ) {}

  /**
   * Forgot username. Same response, status and (near) timing whether or not
   * the email is registered; the username is only ever delivered to the inbox.
   */
  @Post("forgot-username")
  @Public()
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async forgotUsername(@Body(ZodBody(forgotUsernameRequestSchema)) body: { email: string }, @Req() req: Request): Promise<GenericAccepted> {
    const ip = clientIp(req);
    await this.captcha.assertHuman(req.header("x-captcha-response") ?? undefined, ip);

    const email = body.email;
    if (!this.allowForEmail(email)) return { accepted: true };

    const [user] = await this.db
      .select({ username: users.displayUsername, normalized: users.username, verified: users.emailVerified })
      .from(users)
      .where(and(eq(users.email, email), isNotNull(users.username), eq(users.isAnonymous, false)))
      .limit(1);

    const name = user?.username ?? user?.normalized;
    if (user && name && user.verified) {
      dispatch(this.email, usernameReminderEmail(email, name, `${this.config.WEB_ORIGIN}/?username=${encodeURIComponent(name)}`), this.logger);
    }
    return { accepted: true };
  }

  private allowForEmail(email: string): boolean {
    const now = Date.now();
    const recent = (this.perEmail.get(email) ?? []).filter((t) => now - t < PER_EMAIL_WINDOW_MS);
    if (recent.length >= PER_EMAIL_MAX) {
      this.perEmail.set(email, recent);
      return false;
    }
    recent.push(now);
    this.perEmail.set(email, recent);
    if (this.perEmail.size > 10_000) this.perEmail.clear();
    return true;
  }
}
