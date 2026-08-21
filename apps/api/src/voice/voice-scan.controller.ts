import { Body, Controller, Get, Param, Post, Patch, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { PublicUser } from "../auth/public-user";
import { CreateVoiceScanDto } from "./dto/create-voice-scan.dto";
import { BatchMarkResultsDto, MarkResultDto } from "./dto/mark-result.dto";
import { UpdateTranscriptLineDto } from "./dto/update-transcript-line.dto";
import { VoiceScanService } from "./voice-scan.service";

@UseGuards(JwtAuthGuard)
@Controller("projects/:projectId/voice-scans")
export class VoiceScanController {
  constructor(private readonly voiceScans: VoiceScanService) {}

  @Post()
  create(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @Body() dto: CreateVoiceScanDto) {
    return this.voiceScans.createScan(user.id, projectId, dto);
  }

  @Get()
  list(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string) {
    return this.voiceScans.list(user.id, projectId);
  }

  @Get(":jobId")
  get(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @Param("jobId") jobId: string) {
    return this.voiceScans.get(user.id, projectId, jobId);
  }

  @Get(":jobId/results")
  results(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @Param("jobId") jobId: string) {
    return this.voiceScans.results(user.id, projectId, jobId);
  }

  @Get(":jobId/transcript")
  transcript(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @Param("jobId") jobId: string) {
    return this.voiceScans.transcript(user.id, projectId, jobId);
  }

  @Patch(":jobId/transcript-line")
  updateTranscriptLine(
    @CurrentUser() user: PublicUser,
    @Param("projectId") projectId: string,
    @Param("jobId") jobId: string,
    @Body() dto: UpdateTranscriptLineDto,
  ) {
    return this.voiceScans.updateTranscriptLine(user.id, projectId, jobId, dto.mediaAssetId, dto.sourceStartMs, dto.text);
  }

  @Post(":jobId/cancel")
  cancel(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @Param("jobId") jobId: string) {
    return this.voiceScans.cancel(user.id, projectId, jobId);
  }

  @Post(":jobId/pause")
  pause(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @Param("jobId") jobId: string) {
    return this.voiceScans.pause(user.id, projectId, jobId);
  }

  @Post(":jobId/resume")
  resume(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @Param("jobId") jobId: string) {
    return this.voiceScans.resume(user.id, projectId, jobId);
  }

  @Post(":jobId/results/:resultId/mark")
  markResult(
    @CurrentUser() user: PublicUser,
    @Param("projectId") projectId: string,
    @Param("jobId") jobId: string,
    @Param("resultId") resultId: string,
    @Body() dto: MarkResultDto,
  ) {
    return this.voiceScans.markResult(user.id, projectId, jobId, resultId, dto);
  }

  @Get(":jobId/batch-preview")
  batchPreview(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @Param("jobId") jobId: string) {
    return this.voiceScans.batchPreview(user.id, projectId, jobId);
  }

  @Post(":jobId/batch-mark")
  batchMark(
    @CurrentUser() user: PublicUser,
    @Param("projectId") projectId: string,
    @Param("jobId") jobId: string,
    @Body() dto: BatchMarkResultsDto,
  ) {
    return this.voiceScans.batchMark(user.id, projectId, jobId, dto);
  }
}
