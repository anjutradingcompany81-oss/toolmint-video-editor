import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { PublicUser } from "../auth/public-user";
import { CreateExportDto } from "./dto/create-export.dto";
import { RenderService } from "./render.service";

@UseGuards(JwtAuthGuard)
@Controller("projects/:projectId/exports")
export class RenderController {
  constructor(private readonly render: RenderService) {}

  @Post()
  create(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @Body() dto: CreateExportDto) {
    return this.render.createExport(user.id, projectId, dto.sceneId, dto.resolution);
  }

  @Get()
  list(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string) {
    return this.render.list(user.id, projectId);
  }

  @Get(":jobId")
  get(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @Param("jobId") jobId: string) {
    return this.render.get(user.id, projectId, jobId);
  }
}
