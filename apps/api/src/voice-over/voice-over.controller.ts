import { Body, Controller, Get, Param, Post, Put, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { PublicUser } from "../auth/public-user";
import { GenerateVoiceOverDto, SaveVoiceOverScriptDto } from "./dto/voice-over.dto";
import { VoiceOverService } from "./voice-over.service";

@UseGuards(JwtAuthGuard)
@Controller("projects/:projectId/voice-over")
export class VoiceOverController {
  constructor(private readonly voiceOver: VoiceOverService) {}

  // Which speech backends this server can actually use, and what is
  // missing for the ones it can't. Behind the project guard rather than
  // public because it names server-side configuration.
  @Get("providers")
  providers() {
    return this.voiceOver.providers();
  }

  @Get("script")
  getScript(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string) {
    return this.voiceOver.getScript(user.id, projectId);
  }

  @Put("script")
  saveScript(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @Body() dto: SaveVoiceOverScriptDto) {
    return this.voiceOver.saveScript(user.id, projectId, dto);
  }

  @Post("jobs")
  generate(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @Body() dto: GenerateVoiceOverDto) {
    return this.voiceOver.generate(user.id, projectId, dto);
  }

  @Get("jobs")
  list(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string) {
    return this.voiceOver.list(user.id, projectId);
  }

  @Get("jobs/:jobId")
  get(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @Param("jobId") jobId: string) {
    return this.voiceOver.get(user.id, projectId, jobId);
  }

  @Post("jobs/:jobId/cancel")
  cancel(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @Param("jobId") jobId: string) {
    return this.voiceOver.cancel(user.id, projectId, jobId);
  }
}
