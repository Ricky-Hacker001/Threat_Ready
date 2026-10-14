import { Controller, Get, HttpCode, NotFoundException, Param, Post } from "@nestjs/common";
import { featureKeySchema, type FeatureKey, type FeatureState, type LaunchResponse, type Me } from "@threatready/contracts";
import { CurrentPrincipal, RequirePermission, type Principal } from "../authz/authz.js";
import { FeaturesService } from "./features.service.js";

function parseKey(raw: string): FeatureKey {
  const parsed = featureKeySchema.safeParse(raw);
  if (!parsed.success) throw new NotFoundException({ code: "NOT_FOUND", message: "Unknown feature" });
  return parsed.data;
}

@Controller()
export class FeaturesController {
  constructor(private readonly features: FeaturesService) {}

  @Get("me")
  @RequirePermission("me:read")
  async me(@CurrentPrincipal() p: Principal): Promise<Me> {
    return {
      user: { id: p.userId, username: p.username, email: p.email, isTrial: p.isTrial, isAdmin: p.isAdmin },
      orgId: p.orgId,
      role: p.role,
      plan: p.plan,
      features: await this.features.states(p),
    };
  }

  @Get("features/:key")
  @RequirePermission("feature:read")
  state(@CurrentPrincipal() p: Principal, @Param("key") key: string): Promise<FeatureState> {
    return this.features.state(p, parseKey(key));
  }

  @Post("features/:key/launch")
  @HttpCode(201)
  @RequirePermission("feature:launch")
  launch(@CurrentPrincipal() p: Principal, @Param("key") key: string): Promise<LaunchResponse> {
    return this.features.launch(p, parseKey(key));
  }

  @Get("launches/:id")
  @RequirePermission("launch:read")
  getLaunch(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.features.getLaunch(p, id);
  }
}
