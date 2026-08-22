import { Body, Controller, Get, Header, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { PublicUser } from "../auth/public-user";
import { CompositionService } from "./composition.service";
import { compositionSchema } from "./composition.schema";
import { toSrt, toVtt } from "../render/subtitles.util";

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

  // Sidecar caption files, served as plain text so the browser can save
  // them directly. Generated from the saved cues, so what downloads is
  // exactly what the timeline holds (and what burn-in would draw).
  @Get("subtitles.srt")
  @Header("Content-Type", "text/plain; charset=utf-8")
  async srt(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string) {
    // The stored composition is an untyped JSON column; parse it so the
    // cues are validated (and defaults filled) before serialising.
    const { composition } = await this.composition.get(user.id, projectId);
    const parsed = compositionSchema.parse(composition);
    return toSrt(parsed.subtitles);
  }

  @Get("subtitles.vtt")
  @Header("Content-Type", "text/vtt; charset=utf-8")
  async vtt(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string) {
    // The stored composition is an untyped JSON column; parse it so the
    // cues are validated (and defaults filled) before serialising.
    const { composition } = await this.composition.get(user.id, projectId);
    const parsed = compositionSchema.parse(composition);
    return toVtt(parsed.subtitles);
  }
}
