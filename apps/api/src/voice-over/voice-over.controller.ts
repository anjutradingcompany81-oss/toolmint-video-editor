import { Body, Controller, Get, Param, Post, Put, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { PublicUser } from "../auth/public-user";
import { GenerateScriptDto, GenerateVoiceOverDto, PreviewVoiceDto, SaveVoiceOverScriptDto } from "./dto/voice-over.dto";
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

  // Whether this server can write a script from a prompt at all — checked
  // up front so the UI can explain a missing setting instead of only
  // finding out after the user has typed a prompt and clicked Generate.
  @Get("script-gen-status")
  scriptGenStatus() {
    return this.voiceOver.scriptGenStatus();
  }

  @Post("generate-script")
  generateScript(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @Body() dto: GenerateScriptDto) {
    return this.voiceOver.generateScript(user.id, projectId, dto);
  }

  // A short spoken sample so a voice can be auditioned before writing any
  // real script — raw WAV bytes, not JSON, since this is audio to play
  // immediately rather than a resource with an id.
  //
  // @Res() WITHOUT passthrough, and res.send() rather than a return value:
  // with passthrough (or a plain return), Nest's own response pipeline
  // still owns the body and JSON-serializes it — a returned Buffer comes
  // out as `{"type":"Buffer","data":[...]}` instead of audio bytes
  // (confirmed live, not just a theoretical concern). Taking over the
  // response directly is what actually sends raw bytes.
  @Post("preview-voice")
  async previewVoice(
    @Res() res: Response,
    @CurrentUser() user: PublicUser,
    @Param("projectId") projectId: string,
    @Body() dto: PreviewVoiceDto,
  ) {
    const wav = await this.voiceOver.previewVoice(user.id, projectId, dto);
    res.set({ "Content-Type": "audio/wav", "Content-Length": String(wav.length) });
    res.send(wav);
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
