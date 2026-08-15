import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { PublicUser } from "../auth/public-user";
import { CompositionService } from "./composition.service";

@UseGuards(JwtAuthGuard)
@Controller("projects/:projectId/composition")
export class CompositionController {
  constructor(private readonly composition: CompositionService) {}

  @Get()
  get(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string) {
    return this.composition.get(user.id, projectId);
  }

  @HttpCode(200)
  @Post()
  save(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @Body() body: unknown) {
    return this.composition.save(user.id, projectId, body);
  }
}
