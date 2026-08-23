import { Body, Controller, Get, Header, Param, Post, StreamableFile, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { PublicUser } from "../auth/public-user";
import { CreateExportDto } from "./dto/create-export.dto";
import { WatermarkPreviewDto } from "./dto/watermark-preview.dto";
import { RenderService } from "./render.service";
import { WatermarkPreviewService } from "./watermark-preview.service";

@UseGuards(JwtAuthGuard)
@Controller("projects/:projectId/exports")
export class RenderController {
  constructor(
    private readonly render: RenderService,
    private readonly watermarkPreview: WatermarkPreviewService,
  ) {}

  // One real frame with the removal filter applied. A POST because the
  // regions being tried out are sent in the body - they are usually not
  // saved yet, since the point is to see the result before committing.
  @Post("watermark-preview")
  @Header("Content-Type", "image/png")
  @Header("Cache-Control", "no-store")
  async watermarkPreviewFrame(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @Body() dto: WatermarkPreviewDto) {
    const png = await this.watermarkPreview.renderFrame(user.id, projectId, dto.timeMs, dto.regions);
    // StreamableFile, not the raw Buffer: Nest would otherwise run the
    // buffer through its JSON serializer and send {"type":"Buffer",...}
    // instead of the image bytes.
    return new StreamableFile(png);
  }

  @Post()
  create(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @Body() dto: CreateExportDto) {
    return this.render.createExport(user.id, projectId, dto.resolution, dto.quality, dto.outputFileName);
  }

  @Get()
  list(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string) {
    return this.render.list(user.id, projectId);
  }

  @Get(":jobId")
  get(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @Param("jobId") jobId: string) {
    return this.render.get(user.id, projectId, jobId);
  }

  @Post(":jobId/cancel")
  cancel(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @Param("jobId") jobId: string) {
    return this.render.cancel(user.id, projectId, jobId);
  }
}
