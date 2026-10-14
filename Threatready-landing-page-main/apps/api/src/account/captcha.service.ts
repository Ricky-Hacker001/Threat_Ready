import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { CONFIG, type Config } from "../config.js";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Turnstile check for our own (non-Better-Auth) public endpoints. Better Auth's
 * captcha plugin covers its endpoints; this mirrors it, failing closed.
 */
@Injectable()
export class CaptchaService {
  private readonly logger = new Logger("Captcha");

  constructor(@Inject(CONFIG) private readonly config: Config) {}

  get enabled(): boolean {
    return !!this.config.turnstile;
  }

  async assertHuman(token: string | undefined, ip: string | undefined): Promise<void> {
    const t = this.config.turnstile;
    if (!t) return;
    if (!token) throw new BadRequestException({ code: "MISSING_CAPTCHA", message: "Complete the verification check" });

    const body = new URLSearchParams({ secret: t.secretKey, response: token });
    if (ip) body.set("remoteip", ip);
    try {
      const res = await fetch(t.verifyUrl ?? SITEVERIFY, { method: "POST", body, signal: AbortSignal.timeout(10_000) });
      const data = (await res.json()) as { success?: boolean };
      if (data.success === true) return;
    } catch (err) {
      this.logger.warn(`siteverify failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    throw new BadRequestException({ code: "CAPTCHA_FAILED", message: "Verification failed. Try again." });
  }
}
